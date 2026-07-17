# Agente rebalanceador — fix del límite inferior de rango

**Fecha:** 2026-07-16 (actualizado el mismo día, segunda tanda de cambios en la sección 7)
**Vault de referencia usado en todo el diagnóstico:** `0x721e1B69A7187a2A2BFFD1A726f951A801C94C37` (NFT de posición #199469, pool USDT/WETH 0.3%)
**Deploys aplicados:**
- `npx vercel --prod` (fix original) → `dpl_4mnogDLcBh7VDZDE1GUxEizN3TqG`
- `npx vercel --prod` (fee siempre pagable + compat con vaults viejos) → `dpl_D7FQQqBZbk54DApH9ddeejHG8N5N`
- Commits: `8651641` (fix original), `f47b365` (collectFees/márgenes/performance fee)
- **Pendiente:** redeploy de `VaultFactory`/`PlatformConfig` vía `Deploy.s.sol` (necesita firma con Ledger — ver sección 7.5)

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

## 5. Archivos tocados (fix original)

- `frontend/lib/keeper/rebalancer.ts` — toda la lógica descrita en la sección 3
- `frontend/lib/keeper/monitor.ts` — ya traía el chequeo de out-of-range-bottom/periodic y el sweep de dust (sin cambios en esta sesión, incluido acá como contexto porque es lo que decide qué `reason` dispara `rebalancer.ts`)
- `frontend/app/api/vault/[address]/alert/route.ts` — **nuevo**, expone la alerta por vault
- `frontend/app/vault/[address]/VaultDetail.tsx` — banner de alerta

## 6. Confirmación en producción

`rebalanceCount` del vault de referencia pasó de **16 → 45 → 71** a lo largo de la sesión, sin ningún hueco largo entre rebalanceos desde que se desplegó el fix — la periodicidad de 12 min se sostuvo sola. El vault terminó vacío (`positionTokenId=0`, balances en 0) porque el owner (`0xb0E5ADb8...D7125991b`) llamó `withdrawAll()` y recibió $77.42 USDT + 0.236 WETH — un retiro limpio, no una falla. El comentario en `rebalancer.ts` sobre "uni-lab siempre echoea C1 con 0% margen" (mencionado como desactualizado más abajo) ya se corrigió en el código junto con el resto de la sección 7.

## 7. Segunda tanda de cambios — collectFees(), márgenes ajustables, performance fee

Disparada por tres preguntas del owner: "¿se puede solo cobrar comisiones sin cerrar la posición?", "¿qué otros hardcodeos se pueden dejar ajustables?", y "¿cómo monetizamos el agente a futuro?".

### 7.1 — `collectFees()`: reclamar comisiones sin cerrar la posición

Antes no existía forma de cobrar solo las comisiones de Uniswap sin retirar también una porción de principal (`withdraw()` exige `positionShareBps > 0` para disparar `collect()`). Nueva función en `RangeVault.sol`: llama `positionManager.collect()` **sin** `decreaseLiquidity()` previo — Uniswap V3 solo devuelve lo "debido" a una posición, y sin liquidez recién liberada lo único debido son las comisiones acumuladas, así que por construcción nunca puede tocar principal. `onlyOwner`, funciona incluso pausado. Botón "Reclamar comisiones" en `VaultDetail.tsx`.

### 7.2 — Márgenes de reconstrucción ajustables

`recenterMarginBps` (reemplaza el 5% fijo de D1 al reconstruir desde cero) y `exitTopCeilingMarginBps` (reemplaza el +3% fijo del techo al salir de rango por arriba) pasan a ser parámetros reales de `configureTarget()`, en vez de constantes hardcodeadas en `rebalancer.ts`. También se expusieron como campos editables de verdad `maxSlippageBps`/`minRebalanceInterval`/`maxRangeDeviationBps` — ya eran ajustables on-chain vía `setRiskParams()`, pero el frontend los mandaba hardcodeados (`[500n, 0n, 5000n]`) tanto en `create/page.tsx` como en `VaultDetail.tsx`.

**Compatibilidad hacia atrás — importante:** los vaults ya desplegados (clones EIP-1167 de la implementación vieja) **no tienen** estas funciones nuevas — `RangeVault.sol` no tiene `fallback()`, así que una lectura directa revierte. `rebalancer.ts` lee `recenterMarginBps`/`exitTopCeilingMarginBps` con `.catch(() => 500n / 300n)` para no romper el keeper en vaults viejos. Sin este fallback, desplegar el keeper nuevo habría roto el fix de la sección 3 para todos los vaults existentes.

### 7.3 — `ensureFeeCoverage`: garantizar que el fee de plataforma siempre se pueda pagar

Causa raíz real del bug de la sección 2: si la ratio ideal del rango nuevo da 100% WETH, el swap se llevaba todo el USDT disponible y no quedaba nada para pagar el fee. Nuevo helper en `swapMath.ts` que ajusta el swap final para reservar siempre al menos `rebalanceFee` (leído en vivo de `PlatformConfig`) en token0, convirtiendo desde WETH si hace falta. Aplicado en los dos flujos que llaman `rebalance()` (`runRebalanceViaUniLab` y `runRebalanceExitTop`).

### 7.4 — Performance fee: nueva fuente de ingreso de la plataforma

`PlatformConfig.performanceFeeBps` (default 10%, ajustable en vivo con `setPerformanceFeeBps()`, sin redeploy). Corta ese % de **toda** comisión LP que sale del vault — no solo en `rebalance()`, también en `collectFees()`, `withdraw()` parcial y `withdrawAll()`/`emergencyWithdrawPosition()`, para que no haya forma de esquivarlo retirándose en vez de esperar/reclamar. Nunca toca principal — se calcula sobre `collected - removed` (lo que `decreaseLiquidity()` ya liberó no cuenta). Verificado con un swap real contra el pool forkeado (no mockeado): el split coincide exacto con la fórmula del contrato.

Decisiones tomadas en el camino:
- `collectFees()` SÍ paga performance fee (decisión revertida respecto a la 7.1 original, para no dejar un loophole).
- `withdraw()`/`withdrawAll()`/`emergencyWithdrawPosition()` también, mismo motivo.
- Default 10%, límite duro 100% (`require(newFeeBps <= 10_000)`).

### 7.5 — Qué falta para que esto tome efecto

Los vaults son clones EIP-1167 de una implementación fija (`VaultFactory.implementation`, `immutable`) — agregar funciones al contrato no llega a los vaults ya creados, ni cambiando `PlatformConfig` (mismo problema: `performanceFeeBps` es un state var nuevo, el `PlatformConfig` ya desplegado en `0x29380E64...` no lo tiene). Hace falta correr `contracts/script/Deploy.s.sol` de nuevo — deploya un `PlatformConfig` Y un `VaultFactory` nuevos — firmado con Ledger (`--ledger --sender $PLATFORM_OWNER`), no con una private key en texto. Env vars nuevas: `PERFORMANCE_FEE_BPS` (default 1000 = 10% si no se pasa). Después: actualizar `FACTORY_ADDRESS`/`PLATFORM_CONFIG_ADDRESS` en Vercel y `agent/.env`, y un último `vercel --prod`.

Los cambios de `rebalancer.ts`/`swapMath.ts` (7.3 y el fallback de 7.2) **ya están en producción** — no dependen del redeploy, mejoran vaults existentes sin romper nada.

## 8. Archivos tocados (segunda tanda)

- `contracts/src/RangeVault.sol` — `collectFees()`, `recenterMarginBps`/`exitTopCeilingMarginBps`, `_splitPerformanceFee()` en los 4 puntos de salida de fees
- `contracts/src/PlatformConfig.sol` — `performanceFeeBps` + setter
- `contracts/src/interfaces/IPlatformConfig.sol` — `performanceFeeBps()`
- `contracts/script/Deploy.s.sol` — env var `PERFORMANCE_FEE_BPS`
- `contracts/test/RangeVault.t.sol` — 47 tests (6 nuevos de performance fee, con comisiones reales generadas por un swap contra el fork)
- `frontend/lib/keeper/rebalancer.ts` — lee márgenes con fallback, `ensureFeeCoverage`
- `frontend/lib/keeper/swapMath.ts` — `ensureFeeCoverage`
- `frontend/app/create/page.tsx` — sección "Avanzado" con los 5 campos ajustables
- `frontend/app/vault/[address]/VaultDetail.tsx` — botón "Reclamar comisiones", formulario de límites de riesgo independiente
- `frontend/app/vault/[address]/ActivityFeed.tsx` — eventos `FeesCollected`/`PerformanceFeeCollected`
- `frontend/app/admin/page.tsx` — stat y control de `performanceFeeBps`, desglose de revenue
- `frontend/lib/useVaultFeesSummary.ts` — suma `FeesCollected` además de `LpFeesPaidToOwner`

Snapshot completo de cada archivo relevante en [`code/`](code/), actualizado a la fecha de este documento.

## 9. Pendiente / a seguir de cerca

- El escaneo de eventos de `getCumulativeInvestmentUsd` recorre el historial completo del vault (desde `createdAtBlock`) en cada ciclo que llega a llamar a uni-lab. Para un vault viejo con muchos rebalanceos esto crece linealmente — si se vuelve lento/costoso, cachear el resultado (o el delta desde el último escaneo) en Supabase.
- Redeploy de `VaultFactory`/`PlatformConfig` con Ledger (sección 7.5) — bloquea `collectFees()`, márgenes ajustables y performance fee para vaults nuevos.
- Después del redeploy: decidir si vale la pena ofrecer alguna vía para que vaults viejos "migren" (ej. `withdrawAll()` + recrear desde el factory nuevo) ya que no hay upgrade posible de un clon EIP-1167 existente.
