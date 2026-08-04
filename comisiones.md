# Comisiones del vault — cómo se cobran, dónde quedan y qué significan

Explica las 3 categorías que aparecen en **"Historial desglosado de comisiones"** (la tarjeta `FeesHistory` en la página de cada vault), qué evento on-chain dispara cada una, y si cuentan o no hacia B1 (capital invertido).

## Las 3 categorías

Toda comisión de Uniswap que el vault cobra sigue **exactamente uno** de estos 3 caminos — nunca se mezclan, nunca se cuentan dos veces:

### 1. Manual

Vos apretaste el botón **"Cobrar comisiones"** a propósito. El contrato emite `FeesCollected`. La plata llega directo a tu wallet en esa misma transacción, pagando vos mismo el gas.

### 2. Auto

El **keeper** (el agente que corre cada ~5 min) disparó un `rebalance()` normal — porque el precio salió del rango, o porque tocaba el ciclo periódico configurado. Al cerrar la posición vieja para abrir la nueva, el contrato cobra las comisiones acumuladas de Uniswap en el camino. Si `autoCompoundFees` está **apagado**, esa comisión se te manda directo a la wallet en la misma transacción, sin que vos hicieras nada. El contrato emite `LpFeesPaidToOwner`.

### 3. Reinyectado (interés compuesto)

Igual que los dos casos anteriores (cobro manual o durante un rebalanceo automático), pero con `autoCompoundFees` **prendido**. En vez de mandarte la plata, el contrato la pliega de vuelta a la posición — más capital trabajando, en vez de un pago a tu wallet. El contrato emite `FeesReinjected`.

## Tabla resumen

| Categoría | Quién lo dispara | Evento on-chain | ¿A dónde va la plata? | ¿Pagás gas vos? |
|---|---|---|---|---|
| Manual | Vos (botón "Cobrar comisiones") | `FeesCollected` | Tu wallet | Sí |
| Auto | El keeper, durante un rebalanceo | `LpFeesPaidToOwner` | Tu wallet | No (lo reembolsa `gasReserveBalance`) |
| Reinyectado | Cualquiera de los dos, con `autoCompoundFees` ON | `FeesReinjected` | De vuelta a la posición | Depende de quién disparó el cobro |

Además, en **cualquiera** de los 3 casos, la misma transacción también emite:

- **`PerformanceFeeCollected`** — el corte de la plataforma (performance fee), que sale de la comisión bruta ANTES de que se decida el destino (manual/auto/reinyectado). Se muestra como columna aparte en la tabla, matcheado por `tx_hash`.
- **`KeeperGasReimbursed`** — solo cuando fue el keeper quien disparó el cobro (auto o reinyectado vía rebalanceo automático), el vault le reembolsa su gas desde `gasReserveBalance`. Se muestra junto con el % que ese gas representó sobre el valor cobrado/reinyectado — en rojo si fue 100% o más (el gas se comió todo o más de lo que se generó).

## ¿Dónde queda el registro?

Los eventos on-chain (`FeesCollected`, `LpFeesPaidToOwner`, `FeesReinjected`, `PerformanceFeeCollected`, `KeeperGasReimbursed`) se indexan en Supabase por el indexer del dashboard (una pasada por ciclo del keeper, ~5 min) y quedan disponibles vía `/api/dashboard/events`. Desde ahí alimentan:

- **`FeesHistory`** (`frontend/app/vault/[address]/FeesHistory.tsx`) — la tabla desglosada con las 3 categorías, totales, comisión de plataforma y costo de gas.
- **`useVaultFeesSummary`** — el hook que alimenta la tarjeta agregada "Rendimiento de comisiones" (solo totales, sin desglose fila por fila).

## ¿Cuenta hacia B1 (capital invertido)?

- **Manual / Auto → NO cuentan hacia B1.** Es plata que sale del vault hacia vos — un *retorno*, no capital nuevo. B1 no sube ni baja por esto (nunca fue parte del capital invertido).
- **Reinyectado → SÍ cuenta hacia B1** (`FeesReinjected.netFeeUsd`). Al plegarse de vuelta a la posición, se convierte en capital real trabajando — la misma regla que un depósito nuevo.

Esta es la única de las 3 categorías que aumenta el capital invertido acumulado; las otras dos son puro retorno cobrado.

## "Comisiones generadas" (stat viejo) vs. "Total" (tarjeta nueva) — por qué no coinciden

Son dos números que miden cosas distintas a propósito, no un bug:

| | "Comisiones generadas" | "Total" (`FeesHistory`) |
|---|---|---|
| ¿Incluye el corte de plataforma? | **No** — solo lo que llegó al owner (Manual + Auto + Reinyectado) | **Sí** — suma también `PerformanceFeeCollected` |
| ¿Cómo valúa la pata en WETH cobrada? | Al precio de **HOY** (`ethPriceFromTick` con el tick actual) | Al precio **histórico** de cada evento (el que el indexador calculó en el momento exacto de esa tx) |

Verificado con datos reales del vault `0x880D3D8BC3f3EfCd54E7a8Ab113Ad7336888B049` (7 rebalanceos): "Comisiones generadas" mostraba $50.52, "Total" da $55.92 — la diferencia de $5.41 se descompone en **+$5.59 de corte de plataforma** y **−$0.19 de diferencia de repricing** (precio de hoy vs. precio histórico de cada cobro). Ninguno de los dos está mal: uno responde "¿cuánto ganó el owner, a precio de hoy?", el otro "¿cuánto generó el vault en bruto, en el momento de cada cobro?".

## El toggle "Cobrar comisiones solo en {stable}" (`payoutFeesInStableOnly`)

Preferencia persistente **guardada on-chain por vault**. Solo aplica cuando `autoCompoundFees` está **apagado** (si está prendido, la comisión nunca sale hacia tu wallet — no hay nada que convertir). Cuando está prendido, la pata en WETH de cualquier pago directo a tu wallet se swapea a stable en la misma transacción, en vez de mandarte una mezcla de los dos tokens.

Se aplica en los dos caminos que pagan comisión directo a tu wallet (Manual y Auto), pero cada uno lo lee de un lugar distinto:

- **Auto (rebalanceo/auto-reclamo por umbral)**: el keeper lee el flag on-chain directo del contrato en cada transacción — "configurás una vez y te olvidás", siempre confiable.
- **Manual ("Cobrar comisiones")**: el modal tiene su **propio checkbox interno**, que solo copia el valor del toggle grande al ABRIRSE — no lo relee después. Si tocás el toggle grande y confirmás el modal muy rápido (antes de que la wallet refresque la lectura on-chain), el checkbox puede quedar con el valor viejo y el reclamo sale sin convertir. Por eso, para un cobro manual, hay que revisar el checkbox **dentro del modal en el momento de confirmar** — no alcanza con haber prendido el toggle grande antes.

Este desfase (checkbox del modal desincronizado del toggle grande) fue un bug real encontrado en vivo: un reclamo manual con el toggle grande ya en `true` terminó pagando en ambos tokens sin convertir, porque el checkbox del modal seguía en `false`. Confirmado decodificando la transacción real: `feePayoutSwapIx.amountIn = 0` (sin swap), pese a que `payoutFeesInStableOnly` ya era `true` on-chain.

## Bug real (2026-08-04): "Forzar rebalanceo" fallaba siempre con `payoutFeesInStableOnly` prendido

**Síntoma**: con el toggle prendido, cada click en "Forzar rebalanceo" pagaba una consulta real a uni-lab.xyz (plata real gastada) pero el botón nunca completaba — la ruta `owner-rebalance-params` devolvía `{"error":"no_usable_range"}` (502) todas las veces.

**Causa raíz**: el keeper sizaba `feePayoutSwapIx.amountIn` con la comisión **bruta** (`uncollectedFeesRaw()`, directo de Uniswap, sin descontar nada) — pero el contrato aplica ese swap sobre `netFee0`/`netFee1`, es decir la comisión **ya neta** después de que `_splitPerformanceFee()` le restó el 10% (`performanceFeeBps`) del corte de plataforma. Como el monto a swapear (bruto) siempre era mayor al saldo neto realmente disponible, `_convertPayoutToStable()` revertía con `InvalidSwapInstruction()` — **en el 100% de los intentos**, no de forma intermitente. Esto afectaba tanto a "Forzar rebalanceo" (`computeOwnerRebalanceParams`) como a los rebalanceos automáticos normales del keeper (`runRebalanceViaUniLab`) y al camino de salida por precio fuera de rango (`runRebalanceExitTop`) — cualquier vault con `payoutFeesInStableOnly=true` y `autoCompoundFees=false` podía quedar completamente sin poder rebalancear, ni manual ni automático, mientras hubiera alguna comisión acumulada (casi siempre).

**Corrección**: `frontend/lib/keeper/rebalancer.ts` (los 2 puntos donde se arma `feePayoutSwapIx`) y `frontend/app/vault/[address]/VaultDetail.tsx`'s `handleCollectFees` ahora leen `performanceFeeBps` de `PlatformConfig` y reducen el monto a swapear por ese mismo % antes de armar la instrucción — replicando exactamente el `(fee * bps) / 10_000` que el contrato ya aplica en `_splitPerformanceFee()`. El reclamo manual de comisiones (`handleCollectFees` en el frontend) tenía el mismo bug — corregido con el mismo criterio.
