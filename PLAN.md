# Plan: uni-bot-agent — Plataforma multi-tenant de vaults no-custodiales para Uniswap V3 en Celo (Track 1)

**Nombre del proyecto: `uni-bot-agent`** (usar este nombre en el registro del hackathon vía `celobuilders.xyz`, en el repo de GitHub, y en el `agent_name` que cada vault manda a `uni-lab.xyz` al registrarse).

## Context

El usuario participa en el **Agentic Payments & DeFAI Hackathon** de Celo (kickoff 7 jul, deadline **20 jul 9am GMT** — quedan ~8 días, ganadores 24 jul). Extraje el contenido completo del hackathon desde la API interna de Notion (tracks, FAQ, las 19 ideas curadas) porque no renderiza vía fetch normal.

Datos clave del hackathon:
- **Track 1 — Most Revenue Generated ($3,000: $2000/$1000):** gana el proyecto que genere más **volumen on-chain real** en Celo, medido por transacciones con el *attribution tag* (ERC-8021) del proyecto.
- Registro del proyecto vía `npx skills add https://celobuilders.xyz` (nombre + repo GitHub + Telegram) → devuelve el attribution tag. **Regla del hackathon:** "the leaderboard only counts transactions that carry your tag" y las transacciones mandadas antes de registrar quedan invisibles para siempre en los tracks on-chain (Track 1 y Track 2) — no hay forma de tagear en retrospectiva.
  - **Decisión explícita del usuario (confirmada tras avisarle el costo):** el registro del proyecto en celobuilders.xyz se hace **al final**, no día 1 — asumiendo conscientemente que el volumen generado durante el desarrollo/testing/operación previos al registro **no va a contar** para el leaderboard de Track 1. Esto es distinto del registro **por-vault** en uni-lab.xyz (ver abajo), que sí sucede continuamente desde que se crea cada vault.
- Entrega (20 jul) por el mismo skill: descripción, demo, post en X, link ERC-8004.
- Revisión manual anti-sybil/wash-trading — el volumen tiene que tener lógica económica real.

### Evolución de la idea (resumen de todas las rondas de la conversación)

1. Track 1 + DeFAI cripto-nativo → **solo Uniswap V3** (se descartó Aave), par ETH/stablecoin en Celo.
2. Liquidity Provision real con rebalanceo automático según movimiento de mercado.
3. El cálculo de rangos lo resuelve **uni-lab.xyz**, la herramienta propia del usuario — confirmé que es una **API real** (`https://uni-lab.xyz/api/v1`, docs en `https://uni-lab-xyz.vercel.app/api-docs`), pay-per-query, **0.5 USDT fijos por consulta**, verificados on-chain vía `tx_hash` antes de responder.
4. El agente **no puede tener custodia** de los fondos del LP → arquitectura de contrato con separación `owner` (deposita/retira) / `operator` (solo rebalancea dentro de límites).
5. El operador **cobra un fee por cada rebalanceo**. El owner define su propio tope de gasto (`maxRebalances`); **el precio del fee lo define la plataforma** (ver rol 1 abajo), no cada LP individualmente.
6. **Pivote final (esta ronda):** lo que se construye es un **servicio/plataforma pública**: cualquier persona puede crear su propio vault desde un frontend, configurar su agente, y la plataforma (el equipo del usuario) cobra por cada rebalanceo ejecutado, across todos los vaults. Confirmado explícitamente: alcance = **plataforma pública completa** (no una demo operada solo por ustedes), y **el vault paga directo a uni-lab.xyz** con el USDT que depositó su owner (no el keeper con su propia plata).
7. `initPosition()` la ejecuta el **agente**, no el owner: el owner solo define monto de inversión + rango objetivo; el agente paga a uni-lab, calcula el split de tokens, hace los swaps necesarios, y mintea — todo dentro de los guardrails que fija el owner.
8. Registro **por vault** en uni-lab.xyz (`agent_wallet` = dirección del vault, porque el vault es quien manda el pago) sucede automáticamente **justo después de deployar cada vault nuevo**, no al final del hackathon.
9. **Pool objetivo confirmado:** el usuario dio el pool real donde se va a operar: `https://app.uniswap.org/explore/pools/celo/0x6F42B9D2085a0dEb711C00A460a98B9863ae4897`. Lo consulté directo por RPC (no confié en el link solo) — `token0()`, `token1()`, `fee()`, `liquidity()` y `slot0()` contra `forno.celo.org`:
   - **token0 = USDT** nativo de Celo (`0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, 6 decimales) — el mismo token con el que se le paga a uni-lab.xyz.
   - **token1 = WETH** puenteado de Celo (`0xD221812de1BD094f35587EE8E174B07B6167D9Af`, 18 decimales).
   - **Fee tier = 3000 (0.3%)**.
   - Liquidez on-chain > 0 y precio implícito (via `sqrtPriceX96` y `tick`, cross-checkeado entre ambos) ≈ **$1,778 por ETH**, consistente con el precio de mercado real — confirma que es un pool real y activo, no vacío.
   - **Esto cambia el par de ETH/USDC (que habíamos asumido antes) a ETH/USDT**, y como el pool **ya existe con liquidez real**, se elimina el paso de `factory.createPool()`/`initialize()` — el v1 mintea posiciones directo en este pool existente en vez de crear uno desde cero.

### Los 3 roles del sistema

| Rol | Quién | Qué controla |
|---|---|---|
| **Plataforma / dueño del agente** | El equipo del usuario | `PlatformConfig`: fija `rebalanceFee` (precio por rebalanceo), token de cobro, tesorería. Opera el servicio de keeper. Cobra revenue de todos los vaults. |
| **Owner (LP)** | Cualquier wallet pública | Crea su(s) vault(s) vía el factory, deposita **únicamente USDT** — un solo token, sin necesidad de tener WETH de antemano —, define monto de inversión + rango objetivo + `maxRebalances` (su propio tope de gasto), puede pausar/revocar al operador y retirar en cualquier momento — **solo a sí mismo**. El USDT depositado se reparte en tres propósitos internos (capital invertible, presupuesto de uni-lab, reserva de reinyección) y es el **agente** quien hace el swap a WETH que haga falta, según el split que le devuelve la API de uni-lab. |
| **Operador / keeper** | Wallet(s) que opera la plataforma | Único que puede ejecutar `initPosition()` y `rebalance()`. Nunca puede retirar el principal. Cobra `rebalanceFee` por cada rebalanceo exitoso, tope puesto por el owner del vault, precio puesto por la plataforma. |

### Garantía no-custodial (por qué un owner puede confiar en esto)

- `withdraw()` transfiere **siempre y únicamente al `owner`** de ese vault — dirección fija, no un parámetro. El operador nunca puede ser destinatario de una transferencia de principal.
- `initPosition()` y `rebalance()` solo el operador puede llamarlas, pero todos los fondos y el NFT de posición **se quedan siempre dentro del vault** — el operador nunca es `recipient` en las llamadas a Uniswap.
- El rango que use el operador (inicial o en cada rebalanceo) tiene que calzar con lo que el owner configuró/los límites de desviación — el operador no puede inventar un rango arbitrario.
- El owner puede revocar/cambiar el operador en cualquier momento (kill switch) y tiene una función de emergencia para forzar el cierre de la posición sin depender de nadie.
- La única forma en que el operador recibe plata del vault es el `rebalanceFee`, acotado por `maxRebalances` (tope de cantidad, lo fija el owner) y por `rebalanceFee` (precio unitario, lo fija la plataforma vía `PlatformConfig` — ni el owner ni el operador lo controlan individualmente).

## Arquitectura

```
/contracts   # Foundry — PlatformConfig, VaultFactory (clones), RangeVault
/agent       # Node/TypeScript — keeper multi-vault
/frontend    # Next.js — LP self-service + panel admin de la plataforma
```

### `contracts/`

**`PlatformConfig.sol`** — registro central de configuración de la plataforma, `owner` = el equipo (multisig recomendado, EOA aceptable para el hackathon).
- `rebalanceFee`, `feeToken` — ajustables por `owner` vía `setRebalanceFee()`, `setFeeToken()`.
- `defaultOperator` — la wallet del keeper que se asigna por defecto a cada vault nuevo. **Simplificación respecto a la ronda anterior del plan:** no hay un `treasury` separado — el fee se paga directo a `operator` en cada `rebalance()` (ver tabla de `RangeVault`), y como `defaultOperator` ya es la wallet de la plataforma, ahí es donde se acumula el revenue. Un `treasury` separado quedaría sin uso real en v1, así que se sacó para no tener un parámetro de config que el panel admin muestre pero el contrato no use.
- `maxDepositUsd` — tope global de depósito por vault **mientras el contrato no esté auditado** (mitigación de riesgo, ver sección de riesgos).
- Todos los vaults leen esta config **en vivo** en cada `rebalance()` (no la copian al crearse) — así un cambio de precio de la plataforma aplica a todos los vaults existentes de inmediato. *(Trade-off consciente: más simple de operar, pero un LP no tiene el fee "congelado" al momento de crear su vault — vale la pena decírselo claro en el frontend.)*

**`VaultFactory.sol`** — deploya vaults nuevos usando **clones mínimos (EIP-1167 / `@openzeppelin/contracts/proxy/Clones.sol`)** en vez de bytecode completo por vault — patrón estándar de OpenZeppelin, no es "forkear un vault ajeno", es solo el mecanismo de deployment.
- `createVault(owner, token0, token1, feeTier)` → clona `RangeVault`, llama `initialize(owner, platformConfig, token0, token1, feeTier)`, emite `VaultCreated(owner, vaultAddress, token0, token1, feeTier)`.
- `getVaultsByOwner(address)` — view helper para el frontend.

**`RangeVault.sol`** (clone-initializable, sobre primitivas auditadas de OZ: `Initializable`, `ReentrancyGuardUpgradeable`, `SafeERC20`, `IERC721Receiver` — la lógica de rebalanceo es propia, el boilerplate de seguridad no se reinventa).

| Función | Quién | Qué hace |
|---|---|---|
| `deposit(uint256 totalUsdt, uint256 usdtBudgetAmount, uint256 reserveAmount)` | `owner` | Transfiere **solo USDT** (`totalUsdt`) y lo reparte en tres ledgers internos: `usdtBudget = usdtBudgetAmount` (para pagarle a uni-lab), `reserveBalance = reserveAmount` (para el ciclo de reinyección alternada), y el resto (`totalUsdt - usdtBudgetAmount - reserveAmount`) queda como `investableUsdt`, el capital que el agente va a convertir parcialmente a WETH al armar la posición. **Nota de contabilidad:** aunque todo llega como el mismo token, el contrato debe llevar **tres ledgers internos separados**, para que ninguna función gaste accidentalmente el USDT de otro propósito |
| `configureTarget(uint256 investmentAmountUsd, int24 targetTickLower, int24 targetTickUpper, uint256 maxRebalances, uint256 reinjectionAmount, uint256 periodicRebalanceInterval)` | `owner` | Define qué debe construir el agente, su tope de gasto, el **tope máximo** que el agente puede reinyectar de la reserva en un solo rebalanceo (`reinjectionAmount` — desde 2026-07-14 es un techo, no un monto fijo alternante, ver abajo), y cada cuánto se fuerza un rebalanceo aunque el precio siga en rango |
| `initPosition()` | `operator` | **(2026-07-14: ya no consulta uni-lab.xyz)** Swapea la porción de `investableUsdt` que corresponde a WETH según la fórmula estándar de depósito balanceado de Uniswap V3, calculada 100% localmente (vía SwapRouter02, recipient=vault) → mintea la posición inicial dentro de los bounds que configuró el owner. El NFT queda en el vault. El owner nunca necesitó tener WETH. Se sacó la llamada a `/pool-setup-initial` porque su respuesta nunca se usaba (ni siquiera cuando la consulta tenía éxito) — era un costo real para el owner sin ningún beneficio. `rebalance()` sigue consultando `/rc-rlp-rebalance`, ahí sí la respuesta determina el resultado. |
| `rebalance(int24 newTickLower, int24 newTickUpper, SwapInstruction swapIx, uint256 reinjectAmount, uint256 amount0Min, uint256 amount1Min)` | `operator` | decreaseLiquidity + collect (recipient=vault) → swap real hacia el ratio del nuevo rango (`sizeRebalanceSwap`, ver keeper) → si `reinjectAmount > 0`: lo resta de `reserveBalance` (revierte si excede el tope `reinjectionAmount` o lo que hay en reserva) → mint nueva posición (recipient=vault) → si `rebalanceCount < maxRebalances`, paga `rebalanceFee` (leído de `PlatformConfig`) al `operator`, incrementa `rebalanceCount`; si no, revierte. Rate-limited por `minRebalanceInterval`, forzado por `periodicRebalanceInterval`, rango validado contra `maxRangeDeviationBps`. **`reinjectAmount` lo decide el keeper cada ciclo (ver "Reinyección" abajo) — el contrato ya no fuerza una alternancia.** |
| `closeVault()` | `owner` | **(nuevo, 2026-07-14)** Desactiva el vault para siempre. Revierte a menos que ya esté vacío: sin posición abierta, y los tres ledgers (`investableUsdt`, `usdtBudget`, `reserveBalance`) y los balances reales de token0/token1 en cero. Una vez cerrado (`closed = true`), `deposit`/`configureTarget`/`setRiskParams`/`initPosition`/`rebalance` revierten para siempre; `withdrawAll`/`emergencyWithdrawPosition` siguen siendo llamables (no-op inofensivo, el owner nunca queda bloqueado). |
| `payUniLabFee(uint256 amount)` (interno, llamado por `initPosition`/`rebalance`) | `operator` (indirecto) | Transfiere `amount` (decidido por el keeper, ver nota abajo) de `usdtBudget` a la wallet de pago de uni-lab; revierte si `usdtBudget` no alcanza |
| `withdraw(uint256 shareBps)` / `withdrawAll()` | `owner` | Cierra (parcial o total) la posición y transfiere **solo a `owner`** |
| `setOperator(address)` | `owner` | Override/revoca al operador por defecto de la plataforma (kill switch) |
| `setRiskParams(maxSlippageBps, minRebalanceInterval, maxRangeDeviationBps)` | `owner` | — |
| `pause()` / `unpause()` | `owner` | Bloquea `initPosition()`/`rebalance()` sin afectar `withdraw()` |
| `emergencyWithdrawPosition()` | `owner` | Fuerza el cierre de la posición y devuelve todo, sin depender del operador |
| `onERC721Received(...)` | — | Recibe el NFT de posición de Uniswap V3 |

**Tests obligatorios (Foundry, fork de Celo mainnet, antes de tocar mainnet real):**
- Factory: clones se inicializan correctamente, no se pueden re-inicializar, `getVaultsByOwner` correcto.
- `RangeVault`: operador no puede retirar ni cambiar owner; `initPosition`/`rebalance` revierten si el rango excede `maxRangeDeviationBps` o no calza con `configureTarget`; `rebalance` respeta `minRebalanceInterval` y revierte al superar `maxRebalances`; `withdraw()` solo manda fondos a `owner` (revierte si lo llama otra cuenta); `payUniLabFee` revierte si `usdtBudget` insuficiente; reentrancy en todas las funciones que mueven fondos; `emergencyWithdrawPosition()` funciona con `operator` inválido/revocado; **`rebalance` revierte si `reinjectAmount` excede el tope del owner o lo que hay en `reserveBalance`; `reserveBalance` baja exactamente en `reinjectAmount` y nunca queda negativo; con `reinjectAmount = 0` la reserva queda intacta; un rebalanceo dispara igual si pasó `periodicRebalanceInterval` aunque el precio siga dentro del rango vigente; `closeVault()` revierte si queda posición/fondos, solo puede llamarse una vez, y bloquea depósito/configuración/rebalanceo para siempre después, sin bloquear el retiro.**
- `PlatformConfig`: solo su `owner` puede cambiar `rebalanceFee`/`feeToken`/`maxDepositUsd`; un vault que lee la config en vivo refleja un cambio de fee inmediatamente.

### `agent/` — keeper multi-vault

> **Nota (2026-07-13):** esta sección describe la lógica del keeper tal como
> se diseñó originalmente para correr como proceso Node standalone en
> `agent/`. Esa lógica sigue siendo válida y `agent/` se mantiene para debug
> local, pero **en producción corre portada a `frontend/lib/keeper/`, invocada
> vía `POST /api/cron/tick` y disparada por un cron de GitHub Actions cada 5
> minutos** (no un `node-cron` en un proceso propio) — ver `SCALING.md` para
> el porqué (Vercel Hobby limita sus Cron Jobs nativos a una vez por día) y el
> diagrama completo.

- `wallet.ts` — cuenta del operador de la plataforma (Celo mainnet).
- `attribution.ts` — `toDataSuffix(['range_vault', ATTRIBUTION_TAG])` en cada tx del keeper (código en minúsculas/guion bajo: ERC-8021 solo acepta `[a-z0-9_]`, sin guiones).
- `discovery.ts` — escucha `VaultCreated` del factory (evento + polling de respaldo), mantiene la lista de vaults activos.
- `unilab.ts` — **por cada vault nuevo**, registra el vault como agente en uni-lab (`POST /register-agent` con `agent_wallet = vaultAddress`) apenas se detecta el evento `VaultCreated`, guarda el `api_key` asociado a ese vault.
- `initFlow.ts` — para vaults con `configureTarget` seteado pero sin posición aún: llama `initPosition()`.
- `monitor.ts` — por vault, lee `slot0` (gratis) en loop y decide si vale la pena evaluar un rebalanceo (reglas exactas abajo).
- `rebalancer.ts` — cuando corresponde: llama `/rc-rlp-rebalance` (el vault ya pagó a uni-lab internamente en `initPosition`/`rebalance`, el keeper solo dispara la tx y lee el `tx_hash` resultante para pasárselo a la API) → llama `vault.rebalance(...)`.

#### Reglas de rebalanceo (lo que decide el agente)

**Cuándo dispara (`monitor.ts`, todo gratis, solo lectura de `slot0`) — dos gatillos, cualquiera de los dos dispara:**
1. **Fuera de rango real:** el precio actual del pool ya salió del `[tickLower, tickUpper]` de la posición vigente — ahí la posición dejó de cobrar fees, razón económica real y defendible.
2. **Periódico (`periodicRebalanceInterval`, nuevo):** aunque el precio siga dentro del rango, el vault se rebalancea igual cada X tiempo (configurable, ej. 24h) — **esto es deliberado para generar volumen de forma constante**, no solo reactiva a movimientos de precio. Es la misma práctica que usan gestores activos de liquidez reales (Gamma, Arrakis rebalancean en cron, no solo out-of-range), así que es defendible, pero hay que dejarlo explícito en el demo/README para que no se lea como actividad artificial — la sección "Ciclo de reinyección alternada" de abajo es justamente lo que le da sustancia económica real a cada rebalanceo periódico (mueve capital de verdad, no es un no-op).
3. **Cooldown (`minRebalanceInterval`, piso):** ninguno de los dos gatillos de arriba dispara antes de que pase el tiempo mínimo configurado — evita thrashing. `periodicRebalanceInterval` (techo) siempre debe ser mayor que `minRebalanceInterval` (piso).
4. **Gate de costo:** antes de pagarle a uni-lab (0.5 USDT) + gas + slippage, el agente chequea que el valor de la posición sea suficientemente grande como para que ese costo sea una fracción chica (ej. <2%) del valor rebalanceado — si no, se salta el ciclo, para no comerse un vault chico a puros fees de operación.
5. **Tope duro (`maxRebalances`, ya en el contrato):** si el vault ya llegó a su tope, el agente ni siquiera intenta.

**Cómo elige el nuevo rango, una vez que decide rebalancear:**
- `D1` (nuevo lower bound que propone el agente): se ancla al ancho de la posición **actual** (no al `configureTarget` original — ver nota de 2026-07-14 abajo), recentrado sobre el precio de mercado del momento.
- `E1` (reinversión) lo elige el keeper libremente cada ciclo (ver "Reinyección", abajo) — ya no es una alternancia forzada por el contrato.
- La API devuelve el nuevo upper bound → el agente lo convierte a tick → llama `vault.rebalance(tickLower, tickUpper, swapIx, reinjectAmount, amount0Min, amount1Min)`, con `swapIx` calculado por `sizeRebalanceSwap()` para llevar el balance recuperado (mezcla de USDT+WETH de la posición cerrada) hacia el ratio que pide el nuevo rango — sin este swap real, el token que sobra queda como dust sin invertir (bug real encontrado y corregido el 2026-07-14, ver commit "Fix rebalance leaving ~half the vault's capital undeployed as dust").

> **Nota (2026-07-14):** las dos versiones anteriores de esta sección describían (a) un `D1` anclado al rango original de `configureTarget` ("anti-drift") y (b) una alternancia de reinyección forzada on-chain vía `reinjectionActive`. Ambas se revirtieron a pedido explícito: el `D1` debe reflejar el estado *actual* del vault, no pelear contra la simulación de uni-lab tratando de preservar el ancho original; y la decisión de reinyectar debe ser del agente (informada por la simulación en vivo), no un patrón mecánico que el contrato fuerza. Ver `SCALING.md`/historial de commits para el detalle de cada bug.

#### Reinyección (el keeper decide cuánto, el contrato solo limita)

Ya no hay alternancia forzada on-chain. En cada `rebalance()`, el keeper elige `reinjectAmount` (puede ser `0`) informado por la simulación de uni-lab, y el contrato solo valida dos topes:

- **Tope del owner:** `reinjectAmount` no puede superar `reinjectionAmount` (fijado en `configureTarget`, ahora es un techo por ciclo, no un monto fijo).
- **Lo que hay disponible:** `reinjectAmount` no puede superar `reserveBalance` actual.

Si `reinjectAmount > 0`, se resta de `reserveBalance` y pasa a estar disponible para el nuevo mint — sin contraparte automática de "devolución" (ya no hay ciclo con/sin reinyección forzado; si el keeper quiere reponer la reserva, es porque el owner depositó más, no porque el contrato lo revierta solo).

El keeper (`rebalancer.ts`) guarda su propia bookkeeping de alternancia en Supabase (`keeper_vaults.reinjection_active`) — reproduce el mismo patrón alternado de antes (para seguir generando el volumen real que buscaba el diseño original) pero como decisión propia, no como garantía del contrato. `reserveBalance` se financia como parte de `deposit()` — el owner tiene que depositar de más para cubrirla, además del capital de la posición inicial y el `usdtBudget` de uni-lab.

#### Cierre permanente del vault (`closeVault()`, 2026-07-14)

El owner puede desactivar un vault para siempre una vez que está verificablemente vacío — pensado para el caso "cerré mi posición y no pienso volver a usar este vault, no quiero que quede reactivable por accidente". `closeVault()` revierte a menos que `positionTokenId == 0` y los tres ledgers y los balances reales de token0/token1 sean exactamente cero — el owner tiene que haber llamado `withdrawAll()`/`emergencyWithdrawPosition()` antes. Una vez cerrado, `deposit`/`configureTarget`/`setRiskParams`/`initPosition`/`rebalance` revierten para siempre; los retiros siguen andando (no-op inofensivo sobre un vault vacío). Es **irreversible** y solo aplica a vaults deployados con el factory nuevo — los vaults ya activos en el factory viejo no tienen esta función.

- `logger.ts` — historial de eventos por vault, para el demo y para `agent-stats`.
- `cli.ts` / `index.ts` — arranque del servicio, comandos de status.

### `frontend/`

Next.js + wagmi/viem + RainbowKit (auth = conectar wallet, sin login propio).

- **LP-facing:**
  - "Mis vaults" — lista los vaults del wallet conectado (`factory.getVaultsByOwner`).
  - "Crear vault" — v1 apunta directo al par USDT/WETH del pool `0x6F42...4897` (sin selector de par todavía), monto de inversión, rango de precio, `maxRebalances` → `createVault` → `configureTarget` → `deposit`.
  - "Detalle de vault" — estado (rango vigente, liquidez, fees ganadas, rebalanceos ejecutados), depositar más, retirar, ajustar `maxRebalances`/riesgo, pausar/revocar operador.
- **Panel admin** (gateado por `PlatformConfig.owner()` == wallet conectada):
  - Ajustar `rebalanceFee`, `feeToken`, `maxDepositUsd`, `defaultOperator`.
  - Stats agregadas: vaults totales, rebalanceos totales, revenue acumulado de la plataforma.

### Direcciones y datos verificados

- **Pool objetivo (v1): `0x6F42B9D2085a0dEb711C00A460a98B9863ae4897`** en Celo — USDT/WETH, fee tier 3000 (0.3%), verificado por RPC directo contra `forno.celo.org` (`token0`, `token1`, `fee`, `liquidity`, `slot0`), liquidez real > 0, precio implícito ≈ $1,778/ETH.
- **USDT nativo de Celo (token0 del pool, y moneda de pago de uni-lab):** `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` (6 decimales).
- **WETH puenteado nativo de Celo (token1 del pool):** `0xD221812de1BD094f35587EE8E174B07B6167D9Af` (18 decimales).
- **Wallet de pago de uni-lab.xyz:** `0x4B53D27c81f9E842D50a1940E27B8009B64c615B`. **El precio NO es fijo** — confirmado el 2026-07-14 cuando una llamada real a `/pool-setup-initial` devolvió 402 (esperaba 0.2 USDT, el contrato pagó 0.5 USDT hardcodeados). El precio real y actual se consulta en `GET /api/v1/pricing` (`{"price_usdt": 0.2, "payment_wallet": "0x4B53...", "blockchain": "Celo"}`), sin necesidad de `api_key`. El keeper lo consulta en vivo antes de cada `payUniLabFee()` — ver `lib/keeper/unilab.ts#getPricing`. El contrato ya no tiene ningún monto hardcodeado ni techo — confía en que el keeper consulta bien el precio (decisión explícita, ver historial de commits del 2026-07-14).
- **Contratos Uniswap V3 en Celo** (NonfungiblePositionManager, SwapRouter02 — ya no hace falta el Factory para crear el pool, dado que ya existe) — direcciones sacadas de la doc oficial de Uniswap, **reverificar contra Celopedia** (`npx skills add celo-org/celopedia-skills`) antes de hardcodearlas.
- Endpoints de uni-lab usados: `POST /register-agent` (por vault), `POST /pool-setup-initial` (una vez, en `initPosition`), `POST /rc-rlp-rebalance` (cada `rebalance`). Rate limit 100 req/hora por `api_key`.

### Contratos desplegados en Celo mainnet

**Vigentes (2026-07-16) — `create/page.tsx` solo crea vaults contra este factory; `FACTORY_DEPLOY_BLOCK` en `frontend/lib/addresses.ts` apunta a este deploy:**

| Contrato | Dirección | Notas |
|---|---|---|
| `PlatformConfig` | `0x29380E64B3dcffF36529feA62F982fBbd486855A` | `rebalanceFee` 0.2 USDT, `maxDepositUsd` 1,000 USDT (mismos valores que el deploy anterior) |
| `VaultFactory` | `0x2db821Ec15D959e0ab181aB8A78D046A43FC1918` | |
| `RangeVault` (implementación, clonada por el factory) | `0x0AD47C96B4b8AF64757F1a37Ef6aD66C562E5bE1` | Todo lo del deploy anterior (ver retirados) + `sweepIdleDust(swapIx, amount0Min, amount1Min)` (operator-only): swap correctivo real sobre lo que esté suelto en el vault (fuera de `reserveBalance`) y lo suma a la posición abierta — a diferencia del barrido automático interno (`_sweepDustIntoPosition`, que solo reintenta el sobrante tal cual, sin swap), este sí puede recuperar sobrante 100% de un solo token. El keeper lo llama automáticamente después de cada `initPosition()`/`rebalance()` cuando el sobrante supera ~$1 (`maybeSweepIdleDust` en `rebalancer.ts`) |

Deploy: `forge script script/Deploy.s.sol:Deploy --rpc-url https://forno.celo.org --ledger --mnemonic-indexes 2 --sender 0xBBC5a34000B7655ac469020944D4a550727BD0a4 --broadcast`. Tx de `PlatformConfig`: `0x95df11b31062aeec2cb5bd3ae31be43699b824ef4a9af0f5e3e3647d851f5c81` (bloque 72269257). Tx de `VaultFactory`: `0xfca1a094d60bca9ca129a0a552f8316158285767eb06f6b73a6a2790dc4dd35c` (bloque 72269264).

**Verificados en Celoscan (2026-07-16)** — código fuente público, vía `forge verify-contract --chain 42220 --etherscan-api-key $ETHERSCAN_API_KEY` (Celoscan migró a la API unificada de Etherscan V2, exige key incluso para lectura; key guardada en `contracts/.env`, gitignorado):
- [`PlatformConfig`](https://celoscan.io/address/0x29380e64b3dcfff36529fea62f982fbbd486855a)
- [`VaultFactory`](https://celoscan.io/address/0x2db821ec15d959e0ab181ab8a78d046a43fc1918)
- [`RangeVault`](https://celoscan.io/address/0x0ad47c96b4b8af64757f1a37ef6ad66c562e5be1) (implementación)

**Retirados — el frontend dejó de leerlos (decisión explícita: no vale la pena el soporte multi-factory a cambio de perder visibilidad de vaults viejos en `/vaults`/`/admin`). Los vaults ya creados en estos factories siguen existiendo y operando on-chain, solo dejaron de listarse en la interfaz — accesibles directo en `/vault/0x...` si se conoce la dirección:**

| Factory | Retirado por |
|---|---|
| `0xd61F1BFBeA5132545A0CF6C66956a481966875e4` | Este mismo redeploy (2026-07-16) — huérfana 5 vaults creados ese mismo día, incluidos `0x982b8435...c47505` y `0x8Ed2ad9f...42737C88`, que estaban siendo revisados en vivo |
| `0x6d674B0d1A4bC498866401Ba3F1d2D63C24085a5` | Redeploy del 2026-07-15 |
| `0x3dBFb9f9F4f0CAa02a323e106dB1B73e7d7F01ae` | Visto en `agent/.env` (implementación standalone, no desplegada) — origen/fecha sin confirmar |

## Pasos de implementación (8 días)

1. **Día 1:** `npx skills add celo-org/celopedia-skills` (reverificar direcciones Uniswap) + repo público + Telegram del hackathon. Scaffold Foundry. *(El registro en `celobuilders.xyz` se deja para el final por decisión explícita del usuario — ver Context. El código de `attribution.ts` se construye igual desde el día 1, listo para usar el tag en cuanto exista, pero durante el desarrollo las transacciones van sin tag real.)*
2. **Día 1-2:** `PlatformConfig.sol` + `RangeVault.sol` (lógica + guardrails) + tests en fork de Celo mainnet. No se avanza a mainnet real hasta que estos tests pasen.
3. **Día 2-3:** `VaultFactory.sol` (clones) + tests de integración factory↔vault↔config. Deploy de los 3 contratos a Celo mainnet. ✅ **Hecho** — firmado con Ledger (`forge script script/Deploy.s.sol:Deploy --ledger`, dos transacciones confirmadas on-chain, valores del constructor releídos y verificados contra chain).
   - **Redeploy #2 (2026-07-14)** — agregó `RangeVault.closeVault()` y reinyección keeper-driven (ver secciones arriba). El deploy original (`0xCF281b...`/`0xC419B0...`) queda huérfano: sigue funcionando para el vault que ya tenía (vacío, sin fondos), pero no recibe las funciones nuevas. Direcciones vigentes:
     - `PlatformConfig`: `0x72Ae0D14B1a1053cbb6f9eae87F5748D8540153D`
     - `VaultFactory`: `0x079Ee1401fD5279874aa536bD0380Cec08627333`
     - `RangeVault` implementation: `0xaDc6Bd071F9ce50F76Fba44eaDB536232b9874aa`
   - Nota operativa: el Ledger usaba el índice de derivación 2 (`--mnemonic-indexes 2`), no el 0 por defecto — el primer intento falló porque `--sender` no coincidía con la cuenta activa del dispositivo, y hubo que ubicar el índice correcto con `cast wallet address --ledger --mnemonic-index N`. También hubo errores transitorios de `hidapi` en el transporte USB al Ledger que se resolvieron reintentando — en el redeploy, la causa real fue Ledger Live corriendo en paralelo y compitiendo por la conexión USB; cerrarlo lo resolvió.
4. **Día 3-4:** `agent/` — discovery, registro por vault en uni-lab, `initFlow`, `monitor`, `rebalancer`. Probar end-to-end con **un solo vault y montos mínimos reales**: crear vault → depositar chico → el agente arma la posición inicial → confirmar tag visible en el explorer/leaderboard → forzar un rebalanceo → confirmar que el dinero nunca sale del vault salvo a `owner`.
5. **Día 4-6:** `frontend/` — conectar wallet, crear vault, dashboard, panel admin.
6. **Día 6-7:** plataforma corriendo en vivo — crear algunos vaults de demo (propios y, si se puede, de un par de testers reales) para generar volumen multi-tenant genuino. Monitorear de cerca (contrato sin auditoría + ahora terceros con fondos reales).
7. **Día 7:** `npx skills add https://celobuilders.xyz` → registrar el proyecto `uni-bot-agent` (nombre, repo, Telegram) y obtener el attribution tag real; registrar el proyecto en ERC-8004 vía 8004scan.io; grabar demo + post en X mostrando el flujo completo (crear vault → agente arma la posición → rebalanceo real → panel admin cobrando fees), mención transparente a uni-lab.xyz como infraestructura propia.
8. **Día 8, antes de 20 jul 9am GMT:** entregar vía el skill de Celo Builders.

**Plan de contingencia si el tiempo aprieta (día ~5-6):** los contratos y el keeper sirven igual para operar la plataforma ustedes mismos con un puñado de vaults reales, sin depender de que el frontend público esté pulido — si el flujo de onboarding no está sólido para esa fecha, degradar a "nosotros creamos y operamos los vaults de demo" en vez de arriesgar fondos de terceros en un frontend apurado.

## Verificación

- Tests de Foundry (factory + vault + config) contra fork de Celo mainnet, pasando antes de cualquier deploy real.
- Flujo completo en mainnet con montos mínimos: conectar wallet → crear vault → depositar → el agente arma la posición → rebalanceo real → retirar — confirmando en cada paso que el operador nunca recibe más que su `rebalanceFee` y que `withdraw()` solo paga al `owner`.
- Confirmar que el attribution tag aparece en el explorer/leaderboard de Dune (`dune.com/celo/agentic-payments-defai-hackathon`) antes de dejar el keeper corriendo desatendido.
- Confirmar en el fork de Foundry que `initPosition()` mintea correctamente sobre el pool real `0x6F42...4897` (no hace falta probar `createPool`, ya no aplica).

## Riesgos

- **Timeline muy ajustado para este alcance.** Es la decisión que tomó el usuario a sabiendas del riesgo; el plan de contingencia (operar ustedes mismos si el frontend público no está listo) usa los mismos contratos, así que no se pierde el trabajo si hay que degradar el alcance.
- **Contrato sin auditoría + ahora con fondos de terceros**, no solo propios — mitigar con `maxDepositUsd` bajo en `PlatformConfig` mientras no haya auditoría, y comunicarlo claro en el frontend ("montos experimentales, sin auditar").
- **Fee de plataforma leído en vivo:** un cambio de `rebalanceFee` afecta a todos los vaults existentes al instante — comunicarlo en el frontend para que no sea una sorpresa para los LPs.
- Impermanent loss real sigue siendo un riesgo de mercado normal de dar liquidez concentrada, independiente del contrato.
- **Rebalanceo periódico forzado + revisión anti-sybil de los jueces:** rebalancear aunque el precio siga en rango es una decisión deliberada para generar volumen constante, pero es exactamente el tipo de patrón que la revisión manual de los jueces está buscando. El ciclo de reinyección alternada ayuda (cada rebalanceo mueve capital real, no es un no-op idéntico), pero conviene documentarlo con total transparencia en el README/demo como una estrategia de gestión activa real, con su propia lógica (RC/RLP alternado), no ocultarlo.
- El pool objetivo (`0x6F42...4897`, USDT/WETH 0.3%) ya tiene liquidez real de terceros — las posiciones del vault comparten el pool con otros LPs, no es un entorno aislado; el precio se mueve por la actividad de todo el mercado, no solo la del vault.

## Backlog técnico

Mejoras identificadas en producción. Ver "Contratos desplegados en Celo mainnet" más arriba para lo que ya se resolvió en el redeploy del 2026-07-15.

**Hecho (redeploy 2026-07-15):**
- ~~Barrer el dust de `initPosition`/`rebalance` con `increaseLiquidity()`~~ — confirmado en vivo (2026-07-14, vault `0x79BC1a46...535da`, $200 invertidos, ~$21/10.5% de WETH sin invertir). `_sweepDustIntoPosition()` lo hace ahora automáticamente tras cada mint (best-effort, con `try/catch` — si el precio queda 100% de un lado no revierte el ciclo entero).
- ~~Sacar `usdtBudget`/`payUniLabFee()` del contrato~~ — ya no se usan desde que el operador paga a uni-lab vía x402 (ver "Track 2 — x402" en `HACKATHON.md`).
- **Nuevo, no estaba en este backlog:** `_checkRangeNearMarket` rediseñado (validaba contra un "centro" derivado que rechazaba rebalanceos periódicos legítimos — bloqueaba 3 vaults reales antes de este fix), `withdraw(positionShareBps, fundsShareBps)` (retiro parcial independiente entre posición y fondos idle), `increasePosition()` (el owner suma capital a la posición abierta al instante), `reinjectIntoPosition()` (el operador reinyecta reserva sin cerrar la posición).

**Pendiente:**
- **Protección de slippage real en los swaps.** Hoy todo `SwapInstruction` que arma el keeper usa `amountOutMinimum: 0n` siempre (`sizeInitialSwap`/`sizeRebalanceSwap` en `frontend/lib/keeper/swapMath.ts`) — sin piso, un swap en un pool poco profundo queda expuesto a sandwich attacks sin que el contrato lo detecte. No requiere redeploy de contrato, es un fix del lado del keeper.
- **`requestRebalance()` — trigger manual del owner.** Hoy el owner puede depositar más reserva y subir el tope de reinyección (`configureTarget`), pero no puede forzar que el keeper actúe antes de que se cumpla `periodicRebalanceInterval` o de que el precio salga de rango — solo el `operator` puede llamar `rebalance()`. Agregar una función owner-callable que ponga una bandera on-chain (`rebalanceRequested`), que `monitor.ts` trate como disparador válido en el próximo tick (máx. 5 min), respetando igual `minRebalanceInterval`/`maxRebalances`. Requiere redeploy de contrato — candidata para agrupar con la próxima mejora que sí lo necesite.
