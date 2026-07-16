# Agente rebalanceador — fix del límite inferior de rango

**Fecha:** 2026-07-16
**Vault de referencia usado en todo el diagnóstico:** `0x721e1B69A7187a2A2BFFD1A726f951A801C94C37` (NFT de posición #199469, pool USDT/WETH 0.3%)
**Deploy aplicado:** `npx vercel --prod` desde la raíz del repo → `https://uni-bot-agent-gules.vercel.app` (deployment `dpl_4mnogDLcBh7VDZDE1GUxEizN3TqG`)

## 1. Síntoma original

El vault quedó **fuera de rango por el límite inferior** (posición 100% WETH, 0% USDT) y no rebalanceaba solo. Estado on-chain al momento del diagnóstico:

- Rango de la posición: `[$1900.79, $1912.23]` (ticks `[200760, 200820]`)
- Precio real: `$1870.81` (tick `200979`) — por debajo del piso
- `lastRebalanceTimestamp` con ~5 horas de atraso, pese a `periodicRebalanceInterval = 720s` (12 min)

## 2. Causa raíz

`monitor.ts` decide si toca rebalancear en este orden: primero chequea si el ciclo **periódico** está vencido, y solo si no lo está, chequea si la posición está **fuera de rango**. Cuando las dos cosas coinciden (que es justamente lo que pasa cuando un vault lleva mucho tiempo sin poder rebalancear), gana `"periodic"` — y esa rama de `rebalancer.ts` estaba diseñada asumiendo que la posición **sigue en rango** (pin del piso viejo, solo se recentra el techo).

Con el precio ya por debajo del piso, esa asunción es falsa: el rango "nuevo" que se armaba con el piso viejo pinneado seguía sin contener el precio real, así que la ratio objetivo daba 100% WETH otra vez — idéntica a lo que ya había. `sizeRebalanceSwap` calculaba correctamente `amountIn = 0` (no hace falta swap para igualar un objetivo que ya es 100% WETH), así que nunca se generaba USDT. Sin USDT, `rebalance()` revertía en el contrato con `InsufficientInvestableBalance` al intentar pagar la comisión de plataforma (cobrada en token0/USDT). El keeper capturaba ese revert en su simulación previa y **saltaba el ciclo en silencio** — sin mandar tx, sin alertar a nadie. Confirmado reproduciendo la llamada real con `cast call` contra el contrato en Celo mainnet.

## 3. Fixes aplicados (en orden de revisión)

### 3.1 — D1 (piso) no se pinnea si el precio ya rompió el piso viejo

`rebalancer.ts` — `stillInRangeForPeriodicPin = reason === "periodic" && tick <= floorTick`. Solo si esto da `true` se pinnea D1 al piso existente; si no, D1 se recentra a `precio_actual * 0.95`, igual que un `out-of-range-bottom` genuino — sin importar si el motivo que disparó el ciclo fue `"periodic"` o `"out-of-range-bottom"`.

### 3.2 — Reinyección (E1): sin alternancia, solo en `out-of-range-bottom`

Se sacó la alternancia que el keeper llevaba en Supabase (`reinjectionActive`, ciclo sí/no en cada rebalanceo). Ahora `reinjectAmount` es puramente función de `reason`: `> 0` solo cuando `reason === "out-of-range-bottom"` (tope = `min(reinjectionAmount del owner, reserveBalance)`), `0` en cualquier otro caso. El mismo valor alimenta tanto el E1 que se le manda a uni-lab como el monto real reinyectado on-chain — quedan sincronizados por construcción.

### 3.3 — B1 (monto a recuperar): capital acumulado real, no el valor actual de la posición

El contrato **nunca persiste** `investmentAmountUsd` — solo lo emite una vez en el evento `TargetConfigured`. B1 ahora se calcula escaneando eventos on-chain del vault (`getCumulativeInvestmentUsd` en `rebalancer.ts`):

```
B1 = investmentAmountUsd del PRIMER TargetConfigured
   + suma de reinjectedAmount de TODOS los eventos Rebalanced
   + suma de amount de TODOS los eventos ReinjectedIntoPosition
```

Dos decisiones de diseño importantes acá:

- **Solo el primer `TargetConfigured` cuenta como capital real.** `VaultDetail.tsx` reenvía un `TargetConfigured` posterior cuando el owner reconfigura el vault, pero manda `investableUsdt` (el balance idle del momento) en el campo `investmentAmountUsd` — no es un depósito nuevo. Tomar "el último" habría reemplazado la inversión real por un número sin relación.
- **B1 se usa siempre**, tanto en `periodic` como en `out-of-range-bottom` — el valor USD de la posición puede estar por debajo de lo invertido incluso estando genuinamente en rango (por el movimiento de precio dentro del canal), así que usar `positionValueUsd` ahí subestimaría B1.

### 3.4 — Sin fallback local para el mint real; sin precio inventado en ningún lado

Antes, si uni-lab no respondía (x402 caído, sin fondos, etc.), el código minteaba igual usando `precio_actual * 1.003` como techo de respaldo — eso generó posiciones que nacían fuera de rango (caso confirmado, vault `0x8Ed2ad9f...42737C88`). Ahora:

- Si el pago x402 falla → se loguea y se corta el ciclo (`return`), la pool queda tal cual.
- Si uni-lab responde 200 pero sin un `new_upper_bound_with_rlp`/`new_upper_bound_usd` usable → mismo corte.
- El "probe" que existía para pre-chequear la llamada (usando un rango inventado) se eliminó por completo. En su lugar, justo antes de pagarle a uni-lab, se re-leen gratis (sin simular nada) `positionTokenId`, `rebalanceCount`/`maxRebalances` y `lastRebalanceTimestamp`/`minRebalanceInterval` directo del contrato — cierra la ventana de carrera entre el chequeo de `monitor.ts` y el pago real, sin inventar ningún número.

### 3.5 — Alerta en el frontend cuando la API no se puede consultar

No hizo falta tabla nueva: se reutiliza `keeper_unilab_calls` (el audit trail que ya usaba `/admin`). Se agregó un `logUniLabCall` extra para el caso "200 pero sin techo usable" (antes solo quedaba en logs de Vercel). Ruta nueva `app/api/vault/[address]/alert/route.ts` lee la última llamada de uni-lab para ese vault puntual; si fue `ok:false`, el banner rojo se prende en `VaultDetail.tsx`. Se apaga solo cuando la próxima llamada tiene éxito — no hay flag de "resuelto" que mantener aparte.

## 4. Validación con la API real (no simulada)

Con los datos reales del vault de referencia al momento de la prueba:

```json
// request (baseParams reales calculados por el código)
{ "A1": 227.040594, "B1": 248.5, "C1": 1864.272394, "D1": 1779.394557, "E1": 0, "blockchain": "celo" }
```

Respuesta real de `POST /rc-rlp-rebalance` (pago x402 confirmado on-chain, tx `0xb71286e5...af0dcae`, operador `0xAe3921825fEC520cADa98EB0790BC91a61d4286b`):

```json
{
  "success": true,
  "calculation": {
    "module": "RC",
    "new_upper_bound_usd": 2319.93,
    "final_range_width_percent": 23.3,
    "pool_devaluation_usd": -21.46,
    "pool_devaluation_percent": -8.64,
    "price_range": { "current_price": 1864.272394, "min_price": 1779.394557, "max_price": 2319.93 },
    "pool_setup": {
      "volatile_token_amount": 0.09963119, "volatile_token_usd": 185.74, "volatile_token_percent": 81.81,
      "stable_token_amount": 41.3, "stable_token_usd": 41.3, "stable_token_percent": 18.19,
      "total_position_usd": 227.04
    },
    "token_amounts_at_bounds": { "token_amount_at_lower_limit": 0.12230732, "token_amount_usd_at_upper_limit": 248.5 }
  }
}
```

**Hallazgo importante:** el comentario viejo del código decía que uni-lab "siempre echoea C1 con 0% de margen" como techo. Con B1 corregido, la respuesta real muestra `new_upper_bound_usd = $2319.93`, un 24% arriba de C1 ($1864.27) — no el mismo precio. Ese supuesto viejo estaba basado en pruebas con un B1 mal calculado; con el B1 real, uni-lab devuelve una respuesta genuinamente distinta y útil. El comentario correspondiente en `rebalancer.ts` quedó desactualizado y conviene revisarlo en una próxima pasada.

**Nuevo rango resultante**, convertido a ticks (`tickSpacing = 60`):

| | USD | Tick |
|---|---|---|
| Piso (D1, sin cambios respecto al piso viejo) | $1779.39 | 201480 |
| Techo (respuesta real de uni-lab) | $2319.93 | 198840 |

`newTickLower = 198840`, `newTickUpper = 201480` — el par que efectivamente se le pasa a `rebalance()`.

## 5. Archivos tocados

- `frontend/lib/keeper/rebalancer.ts` — toda la lógica descrita en la sección 3
- `frontend/lib/keeper/monitor.ts` — ya traía el chequeo de out-of-range-bottom/periodic y el sweep de dust (sin cambios en esta sesión, incluido acá como contexto porque es lo que decide qué `reason` dispara `rebalancer.ts`)
- `frontend/app/api/vault/[address]/alert/route.ts` — **nuevo**, expone la alerta por vault
- `frontend/app/vault/[address]/VaultDetail.tsx` — banner de alerta

Snapshot completo de cada uno en [`code/`](code/) tal como quedaron desplegados a producción en la fecha de este documento.

## 6. Pendiente / a seguir de cerca

- El escaneo de eventos de `getCumulativeInvestmentUsd` recorre el historial completo del vault (desde `createdAtBlock`) en cada ciclo que llega a llamar a uni-lab. Para un vault viejo con muchos rebalanceos esto crece linealmente — si se vuelve lento/costoso, cachear el resultado (o el delta desde el último escaneo) en Supabase.
- El comentario en `rebalancer.ts` sobre "uni-lab siempre echoea C1 con 0% margen" quedó desactualizado tras la prueba real de la sección 4 — actualizarlo la próxima vez que se toque ese bloque.
- Confirmar en el próximo tick real (cron cada 5 min vía cron-job.org) que el vault de referencia mintea efectivamente `[198840, 201480]` y que el banner de alerta nunca se prendió en el proceso.
