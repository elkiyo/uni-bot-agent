# Prompt: Implementar sistema de referidos (basado en P2Pmoney)

Copia y pega este documento completo a Claude en el proyecto destino. Describe la arquitectura exacta de un sistema de referidos ya probado en producción (P2Pmoney, un marketplace P2P sobre Celo) para que lo repliques/adaptes. **Es 100% off-chain** — no toca contratos inteligentes — así que aplica a cualquier app web con wallet-auth y una base de datos Postgres (Supabase o similar).

---

## 0. Contexto y decisión de diseño clave

El sistema de referidos vive completo en **base de datos + backend API + frontend**. Nunca escribe a un smart contract ni mueve fondos on-chain. Las "recompensas" no se calculan ni pagan automáticamente: el admin decide manualmente cuánto pagar a cada referidor, transfiere fondos por fuera del sistema (wallet normal / multisig), y luego **registra ese pago como evidencia auditable** en la base de datos (monto, token, chain, tx_hash de comprobante).

Por qué esta decisión: evita tocar el contrato (menor superficie de auditoría/riesgo), permite iterar rápido en reglas de negocio (criterios de activación, % de comisión, excepciones) sin redeploy, y el volumen que genera cada referido se puede leer directamente on-chain (o de un indexer/cache de eventos) sin necesidad de que el contrato "sepa" nada de referidos.

**Requisitos previos que asumo que tu proyecto ya tiene** (si no los tienes, avísame antes de implementar):
1. Autenticación de wallet tipo SIWE (Sign-In With Ethereum) o equivalente, que emite un JWT firmado con claims `{ wallet: string, is_admin: boolean }`.
2. Una base de datos Postgres con Row Level Security (Supabase, o Postgres + tu propia capa de auth) — o, si no tienes RLS, replica el mismo control de acceso en el código del backend.
3. Un modo de leer actividad/volumen del usuario: directo on-chain vía RPC (viem/ethers) o desde un indexer/cache de eventos ya existente.
4. Next.js API routes (o cualquier backend con endpoints REST) — los ejemplos usan Next.js App Router pero la lógica es portable a Express/Fastify/etc.

---

## 1. Modelo de datos

Dos tablas, sin más:

```sql
-- Relación referidor → referido. Cada wallet referida solo puede tener UN referidor de por vida.
create table referrals (
  id           bigserial primary key,
  referrer     text not null,               -- wallet que invita
  referred     text not null,                -- wallet invitada
  created_at   timestamptz not null default now(),
  activated_at timestamptz null              -- se llena cuando el referido genera actividad real
);
create unique index referrals_referred_unique on referrals (lower(referred));

-- Registro manual de pagos de recompensa hechos por el admin (evidencia, no cálculo automático).
create table referral_liquidations (
  id           bigserial primary key,
  referrer     text not null,
  amount       text not null,                -- string, no numeric: evita perder precisión de display
  token_symbol text not null,
  chain_id     integer not null,
  chain_name   text not null,
  tx_hash      text not null,                -- hash de la transferencia manual, sirve de comprobante
  notes        text null,
  created_at   timestamptz not null default now()
);
```

**Políticas RLS** (si usas Supabase; si no, replica esta lógica en el backend):

```sql
alter table referrals enable row level security;

-- Lectura: el propio referidor, el propio referido, o admin.
create policy ref_select on referrals for select
  using (auth_is_admin() or lower(referrer) = auth_wallet() or lower(referred) = auth_wallet());

-- Alta: solo el propio referido puede insertarse a sí mismo como "referred".
create policy ref_insert_self on referrals for insert
  with check (lower(referred) = auth_wallet());

-- Update (para activated_at): solo el propio referido.
create policy ref_update_self on referrals for update
  using (lower(referred) = auth_wallet())
  with check (lower(referred) = auth_wallet());

alter table referral_liquidations enable row level security;

-- Lectura: el propio referidor o admin. Sin política de INSERT/UPDATE →
-- solo el backend con service role (bypass RLS) puede escribir, nunca el cliente.
create policy refliq_select on referral_liquidations for select
  using (auth_is_admin() or lower(referrer) = auth_wallet());
```

`auth_wallet()` / `auth_is_admin()` son funciones SQL que extraen los claims del JWT (patrón estándar de Supabase con `auth.jwt()`). Si tu stack no es Supabase, simplemente aplica estos mismos checks (¿quién puede leer/escribir qué fila?) como middleware/guard en tus endpoints.

---

## 2. Flujo de captura y registro — ESTO ES LO MÁS IMPORTANTE DE TODO EL SISTEMA

**El punto de seguridad crítico:** nunca confíes en el body del request para saber quién es "el referido". Siempre extráelo del JWT verificado en el servidor. La primera versión de este sistema en producción tuvo dos vulnerabilidades reales por saltarse esta regla — documentadas abajo para no repetirlas.

### Paso 1 — Captura del link (sin wallet conectada, sin riesgo)

Cualquier visitante que abre `https://tuapp.com/?ref=0xWalletDelReferidor` guarda ese parámetro en `localStorage`, sin exigir conexión de wallet:

```tsx
const STORAGE_KEY = "referrer_pendiente";

useEffect(() => {
  const ref = searchParams.get("ref");
  if (ref && isAddress(ref) && !localStorage.getItem(STORAGE_KEY)) {
    localStorage.setItem(STORAGE_KEY, ref.toLowerCase());
  }
}, [searchParams]);
```

### Paso 2 — Registro SOLO tras autenticación firmada (SIWE)

El registro real (INSERT en la tabla) se dispara únicamente después de que el visitante conecta su wallet y **firma** el mensaje de autenticación (evento que ya deberías tener en tu flujo SIWE existente). Esto es lo que convierte "wallet visitada" en "prueba criptográfica de identidad":

```tsx
function intentarRegistrarReferido() {
  const referrer = localStorage.getItem(STORAGE_KEY);
  if (!referrer) return;
  const token = getAuthToken(); // JWT ya emitido por tu login SIWE
  if (!token) return; // aún no hay sesión firmada, no hacer nada
  localStorage.removeItem(STORAGE_KEY); // evita reintentos duplicados

  fetch("/api/referral-register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ referrer }), // OJO: no se manda "referred" — lo saca el server del JWT
  }).catch(() => {});
}
// llamar esto en el listener del evento que tu app dispara al completar el login SIWE
```

### Paso 3 — Endpoint de registro (backend, la parte que de verdad importa)

```ts
// POST /api/referral-register
export async function POST(req: Request) {
  const claims = await verifyJWT(bearerTokenFrom(req));
  if (!claims?.wallet) return json({ error: "no_autorizado" }, 401);

  // Rate limit por wallet — evita spam de registros
  if (!rateLimit(`referral-register:${claims.wallet}`, 10, 60_000).ok)
    return json({ error: "demasiadas_solicitudes" }, 429);

  const { referrer } = await req.json();
  const referred = claims.wallet; // <-- CLAVE: viene del JWT verificado, NUNCA del body

  if (!referrer || !isAddress(referrer)) return json({ error: "referrer_invalido" }, 400);
  if (referrer.toLowerCase() === referred.toLowerCase())
    return json({ error: "no_puedes_autoreferirte" }, 400);

  const { error } = await dbAsAdmin() // service role / bypass RLS
    .from("referrals")
    .insert({ referrer: referrer.toLowerCase(), referred: referred.toLowerCase() });

  // 23505 = unique_violation → ya tenía referidor, es idempotente, no es un error real
  if (error && error.code !== "23505") return json({ error: error.message }, 500);

  return json({ ok: true });
}
```

**Bugs reales que tuvo la primera versión — no los repitas:**

1. *Insert directo desde el cliente con clave anónima:* el navegador intentaba insertar directo a la tabla con la clave pública de Supabase. RLS lo bloqueaba (o peor, si RLS estaba mal configurado, lo permitía sin control). **Fix:** el insert siempre pasa por un endpoint de servidor con credenciales privilegiadas (service role), nunca directo desde el cliente.
2. *`referred` venía del body del request:* la primera versión del endpoint aceptaba `{ referrer, referred }` en el body. Cualquiera podía hacer `POST` con dos direcciones inventadas y crear referidos falsos sin haber autenticado nada. **Fix:** `referred` se extrae siempre del JWT verificado en servidor, jamás del payload del cliente.

### Paso 4 — Activación (`activated_at`)

Un registro en `referrals` no cuenta como "referido activo" hasta que esa wallet genera actividad real (la definición de "actividad real" depende de tu producto — en P2Pmoney es "completó una compra"). Dos disparadores redundantes para no perder casos:

1. **Al primer evento de negocio relevante** del usuario (ej. crear su primera orden, hacer su primera compra), dispara una llamada fire-and-forget:
   ```ts
   activateReferral(walletDelUsuario).catch(() => {});
   // UPDATE referrals SET activated_at = now() WHERE referred = X AND activated_at IS NULL
   ```
2. **Auto-activación perezosa al consultar stats:** si al calcular el volumen de un referido (ver §3) resulta que ya tiene actividad > 0 pero `activated_at` seguía `null`, se activa ahí mismo. Esto cubre a usuarios que generan actividad por una vía que no dispara el trigger del punto 1 (ej. "compra" sin pasar por "crear orden").

---

## 3. Cálculo de volumen/actividad generada por cada referido

No hay una tabla de "volumen acumulado" — se calcula en vivo. Adapta la fuente según lo que tenga tu proyecto:

- **Si tienes RPC/contrato on-chain** (como P2Pmoney): por cada referido, consulta el contrato (ej. `getDealsByUser`, `getDeal`) y suma solo las transacciones/eventos relevantes al criterio de negocio (en P2Pmoney: solo cuenta cuando el referido actuó como **comprador** en un deal `Completed`, porque es la actividad que paga fee — sé explícito con tu propio criterio de "qué cuenta").
- **Si tienes un indexer/cache de eventos**, cruza esa tabla contra el mapa `referred → referrer` en memoria — es mucho más rápido que golpear RPC por cada fila, pero verifica que el indexer esté realmente completo/actualizado antes de usarlo como fuente de verdad para pagos (ver nota de inconsistencia en §5).

```ts
// GET /api/referral-stats?referrer=0x...
export async function GET(req: Request) {
  const claims = await verifyJWT(bearerTokenFrom(req));
  if (!claims) return json({ error: "no_autorizado" }, 401);

  const referrer = new URL(req.url).searchParams.get("referrer");
  // Solo puedes ver tus propios stats, salvo que seas admin
  if (!claims.is_admin && claims.wallet !== referrer?.toLowerCase())
    return json({ error: "no_autorizado" }, 403);

  const referrals = await getReferralsByReferrer(referrer); // de la tabla `referrals`
  const liquidations = await getLiquidationsByReferrer(referrer);

  const enriched = await Promise.all(referrals.map(async (r) => {
    const volumeByChain = await fetchVolumeForUser(r.referred); // tu lógica de negocio aquí
    if (!r.activated_at && hasVolume(volumeByChain)) {
      await activateReferral(r.referred); // auto-activación perezosa
    }
    return { ...r, volume_by_chain: volumeByChain };
  }));

  return json({
    referrals: enriched,
    liquidations,
    grand_total_by_token: sumAllTokens(enriched),
    active_count: enriched.filter(r => r.activated_at).length,
    total_count: enriched.length,
  });
}
```

---

## 4. Endpoint de liquidación (pago manual registrado por el admin)

No hay cálculo automático de "cuánto se le debe" a un referidor — es completamente discrecional. El admin ve el volumen generado (§3), decide un monto, transfiere los fondos por fuera del sistema, y registra el pago aquí como evidencia:

```ts
// POST /api/referral-liquidation — solo admin
export async function POST(req: Request) {
  const claims = await verifyJWT(bearerTokenFrom(req));
  if (!claims?.is_admin) return json({ error: "no_autorizado" }, 403);

  const { referrer, amount, token_symbol, chain_id, chain_name, tx_hash, notes } = await req.json();
  if (!referrer || !amount || !token_symbol || !chain_id || !chain_name || !tx_hash)
    return json({ error: "faltan_campos" }, 400);

  await dbAsAdmin().from("referral_liquidations").insert({
    referrer: referrer.toLowerCase(),
    amount: String(amount),
    token_symbol, chain_id: Number(chain_id), chain_name, tx_hash,
    notes: notes ?? null,
  });
  return json({ ok: true });
}
```

---

## 5. Panel de Admin (`/admin/referidos`)

Página protegida (guard client-side redirige si `!claims.is_admin`, más el propio endpoint valida server-side — nunca confíes solo en el guard del cliente).

**Estructura de la página, de arriba a abajo:**

1. **3 tarjetas de métricas globales**: total de wallets que han referido a alguien, total de referidos, total de referidos activos.
2. **Tabla de todos los referidores** (fuente: un endpoint `GET /api/admin/referral-overview` que agrega todo desde la tabla `referrals` + `referral_liquidations`). Columnas: wallet (truncada, con botón copiar), # referidos, # activos, % de activación (badge visual si supera un umbral, ej. ≥50%), volumen generado, total liquidado, fecha del último referido. La fila es clickeable para cargar el detalle.
   - **Importante sobre performance:** carga primero el overview (rápido, solo DB), y dispara en paralelo (`Promise.allSettled`) el fetch de volumen por cada fila (más lento si es on-chain) para no bloquear el render inicial de la tabla.
3. **Buscador manual** por wallet (validación regex de dirección) para cargar el detalle de cualquier referidor sin pasar por la tabla.
4. **Panel de detalle del referidor seleccionado:**
   - Header con volumen total generado (+ equivalente en una moneda de referencia si tu producto maneja varios tokens) y botón de **exportar CSV** (generado client-side con `Blob`, sin necesidad de endpoint extra).
   - Tabla de referidos individuales, expandible por fila: estado (Activo/Registrado según `activated_at`), fecha, y al expandir, desglose de volumen por chain/token.
   - Historial de liquidaciones ya pagadas: fecha, monto+token, chain, link al explorer de bloques usando el `tx_hash` como comprobante, notas.
   - **Formulario de nueva liquidación** con **doble confirmación** (primer click muestra un resumen y pide confirmar explícitamente antes de insertar) — esto es dinero real, evita que un click accidental registre un pago incorrecto.

**Nota de arquitectura a tener en cuenta si usas un indexer/cache como fuente de volumen para el overview:** si tu `admin/referral-overview` reconstruye volumen desde una tabla de cache/indexer (rápido, sin RPC) pero tu `referral-stats` (usado por la columna de detalle y por el propio usuario) lo calcula directo on-chain, **pueden divergir** si el indexer no está 100% completo. En P2Pmoney esto pasó y se resolvió usando siempre la fuente on-chain (más lenta pero confiable) para cualquier número que el admin vaya a usar para decidir un pago real. Regla general: **la fuente de verdad para decisiones de dinero debe ser la más confiable, no la más rápida** — usa la rápida solo para UI no crítica.

---

## 6. Frontend — vista del usuario (dashboard/perfil)

En la página de perfil del propio usuario, sección "Mis referidos", visible solo si es su propio perfil:

- **Link de referido para compartir:**
  ```tsx
  const referralLink = `${window.location.origin}/?ref=${miWallet}`;
  ```
  Con botón de copiar (`navigator.clipboard.writeText`) y botón de compartir usando la Web Share API nativa si está disponible (`navigator.share`), con fallback a copiar si no.
- **3 stats rápidas:** total de referidos, activos, total liquidado (histórico).
- El fetch a `/api/referral-stats` **debe llevar el JWT en el header Authorization** — es un bug fácil de cometer olvidar el header y que el endpoint devuelva 401 silenciosamente, mostrando la sección vacía sin error visible.
- Lista de referidos con badge de estado, fecha, y desglose de volumen por chain/token con conversión a una unidad de referencia si aplica.

---

## 7. Resumen operativo del flujo completo (para validar tu implementación)

1. Referidor comparte `https://tuapp.com/?ref=0xSuWallet`.
2. Visitante abre el link → `ref` se guarda en `localStorage`, sin exigir wallet conectada todavía.
3. Visitante conecta wallet y firma el login (SIWE u otro esquema ya existente en tu app) → se emite JWT.
4. El evento de "sesión iniciada" dispara el registro: `POST /api/referral-register` con el JWT en el header y `referrer` en el body.
5. El servidor extrae `referred` del JWT (nunca del body), valida, e inserta en `referrals` con credenciales privilegiadas (bypass RLS).
6. Cada wallet solo puede tener **un** referidor de por vida (constraint único en DB, `ON CONFLICT`/código de unique_violation manejado como éxito idempotente).
7. `activated_at` se llena cuando el referido genera la actividad de negocio que definas como "activo" (evento explícito + fallback perezoso al consultar stats).
8. No hay cálculo automático de comisión — el admin decide el monto, paga por fuera del sistema, y registra el pago con `tx_hash` como comprobante auditable.

---

## 8. Parámetros a decidir/configurar en tu proyecto (no hay valores mágicos ocultos, todo es explícito)

| Parámetro | Valor de referencia en P2Pmoney | Dónde vive |
|---|---|---|
| Rate limit de registro | 10 req/min por wallet | middleware del endpoint de registro |
| Criterio de "activo" | actividad > 0 como comprador en un evento completado | lógica del endpoint de stats — **defínelo según tu producto** |
| Unicidad de referido | 1 referidor por wallet, para siempre | constraint único en DB |
| % de comisión | N/A — 100% discrecional del admin, sin automatismo | formulario de liquidación |
| Auth requerida | JWT firmado con claims `{ wallet, is_admin }` | tu capa de auth existente |

---

## Instrucciones para ti, Claude (en el proyecto destino)

1. Antes de escribir código, confirma conmigo: (a) qué usamos como autenticación de wallet (¿ya tenemos JWT con claims de admin?), (b) qué DB usamos y si tiene RLS o si el control de acceso debe ir en el código del backend, (c) cuál es la fuente de volumen/actividad de cada usuario (RPC on-chain, indexer propio, o métrica interna no-cripto), y (d) cuál es el criterio de negocio para "referido activo" en este producto.
2. Implementa en este orden: (1) tablas + RLS/guards, (2) endpoint de registro con el flujo de captura + JWT, (3) endpoint de stats, (4) endpoint de liquidación + panel admin, (5) UI de usuario (link para compartir + dashboard).
3. Replica explícitamente los dos fixes de seguridad de §2 — son el motivo por el que este documento existe: nunca insertes directo desde el cliente, y nunca confíes en `referred` del body de un request.
