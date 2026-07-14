# Escalado — estado actual y roadmap

Qué está en producción hoy, qué es el eslabón débil, y en qué orden escalar. Ver
`PLAN.md` para el diseño de base.

## Estado actual (hackathon)

| Pieza | Dónde corre | Estado |
|---|---|---|
| Contratos (`PlatformConfig`, `VaultFactory`, `RangeVault`) | Celo mainnet | ✅ Inmutables, no requieren infra |
| Frontend | Vercel (`uni-bot-agent-gules.vercel.app`) | ✅ Serverless, escala solo |
| Keeper (`frontend/lib/keeper/` + `POST /api/cron/tick`) | Vercel (mismo proyecto que el frontend) | ✅ Ya no depende de la Mac — ver abajo |
| Disparo del tick cada 5 min | cron-job.org (externo) | ✅ Gratis, confirmado disparando cada 5 min de verdad — ver nota abajo (GitHub Actions se probó primero y no sirvió) |
| Deploy a producción en cada push a `main` | GitHub Actions (`.github/workflows/deploy.yml`) | ✅ No usa la integración nativa de Git de Vercel — ver nota abajo |
| Estado del keeper (vaults, api_keys de uni-lab, último bloque escaneado, log de consultas a uni-lab) | Supabase/Postgres (Vercel Marketplace, tier gratis) | ✅ Persiste entre invocaciones serverless |
| `agent/` (Node local, node-cron) | — | 🗄️ Superseded — se mantiene solo como herramienta de debug manual, ver abajo |
| uni-lab.xyz API | Vercel (infra propia, aparte) | ✅ |

## Keeper: por qué terminó así (no depende del PC)

El usuario pidió explícitamente sacar el keeper de su Mac y moverlo a
GitHub+Vercel. La opción obvia — Cron Jobs nativos de Vercel — **no sirve tal
cual en el plan Hobby**: están limitados a **una vez por día** (cualquier
expresión más frecuente falla al deployar, no es solo imprecisión). Confirmado
contra la doc oficial de Vercel el 2026-07-13.

Arquitectura elegida (decisión explícita del usuario entre esto y upgrade a
Vercel Pro $20/mes): **un disparador externo pega al tick, Vercel lo ejecuta.**

```
cron-job.org (cada 5 min)
  → POST https://uni-bot-agent-gules.vercel.app/api/cron/tick
     (Authorization: Bearer $CRON_SECRET)
  → frontend/app/api/cron/tick/route.ts
  → frontend/lib/keeper/tick.ts: discoverAndRegisterVaults + checkVault + runInitPosition/runRebalance
  → estado en Supabase/Postgres (frontend/lib/keeper/store.ts, schema en lib/keeper/schema.sql)
```

- **Costo: $0.** Sin upgrade de plan, sin VPS.
- **Por qué cron-job.org y no GitHub Actions:** el primer intento usó un
  `schedule: cron: "*/5 * * * *"` en `.github/workflows/keeper-cron.yml`.
  Confirmado con `gh run list` que en 10+ horas solo disparó ~7 veces (cada
  1.5–2h en vez de cada 5 min) — es el throttling documentado que GitHub
  aplica a scheduled workflows en repos de bajo tráfico, no un bug del YAML.
  cron-job.org (servicio dedicado, gratis) sí cumple la cadencia real,
  confirmado revisando `vercel logs` con timestamps exactos. El workflow de
  GitHub quedó solo como disparo manual de respaldo (`workflow_dispatch`,
  sin `schedule`) para forzar un tick desde la pestaña Actions sin necesitar
  entrar a cron-job.org.
- **Gotcha real que costó diagnosticar:** al configurar cron-job.org, dos
  errores en cadena — (1) el método quedó en GET por defecto en vez de POST
  (405), (2) el header se cargó con el token pelado, sin el prefijo `Bearer `
  (401). Ambos se ven clarísimo en `vercel logs <deployment> --since 1h` (o en
  el historial de ejecuciones del propio cron-job.org) por el código de
  estado HTTP exacto — no hace falta adivinar.
- **Por qué Supabase y no un KV puro (Redis/Upstash):** se evaluó Upstash
  primero por ser lo más simple para el uso original (un hash + un lock), pero
  se cambió a Supabase porque da tablas reales consultables por SQL — útil
  para eventualmente mostrar en el panel admin el historial de consultas a
  uni-lab (`keeper_unilab_calls`), no solo una lista JSON — con el mismo costo
  de integración (API REST vía PostgREST, sin manejo de conexiones
  persistentes, tan serverless-friendly como Redis). Tablas y función de lock:
  `frontend/lib/keeper/schema.sql` — **hay que correrlo a mano una vez** en el
  SQL Editor de Supabase después de conectar la integración; no se aplica solo.
- **Lock contra ticks superpuestos:** `store.ts#acquireTickLock` llama a una
  función de Postgres (`acquire_tick_lock`, ver schema.sql) que hace un
  `UPDATE ... WHERE expires_at < now()` atómico con TTL de 4 min (menor al
  intervalo de disparo de 5 min). Necesario porque, a diferencia del scheduler
  in-process anterior, ahora el trigger es externo: si un tick se cuelga (RPC
  lento, una tx que tarda en confirmar), el siguiente disparo de GitHub
  Actions no debe arrancar un segundo tick — dos keepers con la misma wallet
  compiten por nonce.
- **Duración de función:** Hobby permite hasta 300s con Fluid Compute
  (confirmado en la doc de Vercel); el route pone `maxDuration = 120`, de sobra
  para varios vaults con confirmaciones de tx incluidas.
- **Precisión real del trigger:** confirmada empíricamente cada 5 min en punto
  con cron-job.org (ver arriba). Sigue sin ser una garantía dura de tiempo
  real como Vercel Pro, pero para un puñado de vaults de hackathon sobra.
- **Variables de entorno del keeper** (Vercel → Project Settings →
  Environment Variables, nunca con prefijo `NEXT_PUBLIC_`): `OPERATOR_PRIVATE_KEY`
  (la misma wallet que ya operaba desde `agent/.env`), `CELO_RPC_URL`,
  `ATTRIBUTION_TAG`, `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (se completan
  solas si se conecta la integración de Supabase desde el Marketplace de
  Vercel — el `service_role` key tiene acceso total, por eso las tablas
  `keeper_*` tienen RLS habilitado sin políticas: solo ese key las puede leer
  o escribir), `CRON_SECRET` (generado con `openssl rand -hex 32`, el mismo
  valor va como secret `CRON_SECRET` en GitHub). Ver
  `frontend/.env.local.example`.
- **Deploy en cada push, sin la integración Git nativa de Vercel:** se intentó
  conectar el repo desde Settings → Git y no funcionó limpio — el repo de
  GitHub (`elkiyo/uni-bot-agent`) y el proyecto de Vercel (team `uni-lab`,
  cuenta `unilabxyz`) son identidades distintas, y la app de GitHub de Vercel
  necesita permiso instalado del lado de la cuenta dueña del repo para verlo
  en el selector — cruzar esos dos permisos no valió la pena pelearlo.
  Solución: `.github/workflows/deploy.yml` corre `vercel deploy --prod` en
  cada push a `main`, autenticado con un token dedicado (`vercel tokens add`,
  guardado como secret `VERCEL_TOKEN` en GitHub) en vez de la conexión Git.
  `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` (no sensibles, están hardcodeados en el
  workflow) le dicen a la CLI qué proyecto deployar sin necesitar un
  `.vercel/project.json` local en el runner de CI.

### `agent/` local: qué hacer con él
No se borró — sigue sirviendo para correr el keeper a mano contra un fork o
para debug interactivo (`npm run start` en `agent/`), y documenta el gotcha de
TCC/launchd por si alguna vez hace falta un daemon local de nuevo. Pero **ya
no es el camino de producción**: la lógica vive duplicada intencionalmente en
`frontend/lib/keeper/` (con `store.ts`/`logger.ts` cambiados a Supabase en vez
de archivos locales, porque las funciones serverless no tienen disco
persistente entre invocaciones). Si se toca la lógica de rebalanceo, hay que
decidir conscientemente si el cambio aplica a un lado, al otro, o a ambos — no
hay sincronización automática entre las dos copias.

### 2. Estado durable (cuando haya >5-10 vaults)
- El estado ya vive en Postgres (Supabase) desde la migración a Vercel — ver
  arriba y `lib/keeper/schema.sql`. Con tablas reales desde el día uno, esto
  ya escala más allá de lo que un JSON plano hubiera aguantado; si el volumen
  crece mucho el próximo paso natural es paginar `keeper_unilab_calls` en vez
  de traerla entera.
- El escaneo de eventos puede reconstruirse desde chain en cualquier momento;
  lo único irrecuperable son las api_keys de uni-lab → eso es lo que importa
  respaldar (Supabase hace backups automáticos incluso en el tier gratis, pero
  conviene un export propio antes de escalar con fondos de terceros).

### 3. Observabilidad (antes de promocionar públicamente)
- `logger.ts` ya emite JSON por línea — apuntarlo a un colector (Axiom/Grafana
  Cloud tienen tiers gratis) y alertar sobre `level: error` recurrente.
- Alerta de saldo: si el CELO del operador baja de ~0.5, avisar (sin gas, el
  keeper queda ciego operativamente aunque siga corriendo).
- El leaderboard de Dune del hackathon + `agent-stats` de uni-lab ya dan
  métricas de negocio gratis.

### 4. Límites de la plataforma (a medida que entra plata real)
- `maxDepositUsd` (hoy 1,000 USDT/vault) es el freno de mano mientras el
  contrato no esté auditado — **no subirlo por demanda; subirlo después de
  auditar**. Es ajustable en vivo desde el panel admin.
- El fee de plataforma también es ajustable en vivo; recordar que aplica a
  todos los vaults existentes al instante (trade-off documentado en PLAN.md).

### 5. Multi-pool y multi-chain (post-hackathon)
- `VaultFactory.createVault(pool, token0, token1, fee)` ya acepta cualquier
  pool — la restricción a USDT/WETH es solo del frontend (un selector de pool
  y validación `factory.getPool` la levanta).
- Ojo: `RangeVault` asume token0 = stablecoin de 6 decimales para su
  contabilidad interna — generalizar eso ANTES de abrir otros pares.
- El keeper ya es multi-vault por diseño; multi-pool solo requiere que
  `monitor.ts`/`rebalancer.ts` lean el pool del vault en vez de la constante.

### 6. Redundancia del keeper (cuando el revenue lo justifique)
- Dos keepers con la misma clave compiten por nonce — no duplicar sin más.
- Camino correcto: un keeper primario + un watchdog que alerte si
  `lastRebalanceTimestamp` de algún vault se atrasa demasiado; failover manual
  o con lock distribuido.
- Alternativa on-chain: permitir a los owners setear su propio operador de
  respaldo (ya soportado: `setOperator`).

## Qué NO hacer
- No subir `maxDepositUsd` sin auditoría del contrato.
- No correr dos keepers con la misma wallet a la vez — esto incluye dejar el
  proceso local de `agent/` (`npm run start &` en la Mac) corriendo al mismo
  tiempo que el cron de Vercel una vez confirmado el corte: compiten por nonce
  del operador. Verificar con `ps aux | grep tsx` / matar el proceso local
  antes de dar por hecha la migración.
- No perder `agent/data/` sin respaldo (api_keys) si todavía se usa el keeper
  local para debug — en producción esto ya vive en Supabase.
- No commitear jamás `agent/.env` ni las env vars del keeper en Vercel
  (`OPERATOR_PRIVATE_KEY`, `CRON_SECRET`) en ningún archivo del repo.
