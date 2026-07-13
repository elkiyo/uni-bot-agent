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
| `configureTarget(uint256 investmentAmountUsd, int24 targetTickLower, int24 targetTickUpper, uint256 maxRebalances, uint256 reinjectionAmount, uint256 periodicRebalanceInterval)` | `owner` | Define qué debe construir el agente, su tope de gasto, el monto que alterna entre reserva/posición en cada ciclo, y cada cuánto se fuerza un rebalanceo aunque el precio siga en rango |
| `initPosition()` | `operator` | Paga uni-lab desde `usdtBudget` (`payUniLabFee` interno) → llama `/pool-setup-initial` con `investableUsdt` → **swapea la porción de `investableUsdt` que el split de la API indica que debe quedar en WETH** (vía SwapRouter02, recipient=vault) → mintea la posición inicial con el USDT restante + el WETH recién comprado, dentro de los bounds que configuró el owner. El NFT queda en el vault. El owner nunca necesitó tener WETH. |
| `rebalance(int24 newTickLower, int24 newTickUpper, uint256 amountOutMinimum)` | `operator` | decreaseLiquidity + collect (recipient=vault) → según `reinjectionActive` (lo decide el contrato, no el operador): si toca reinyectar, suma `reinjectionAmount` desde `reserveBalance`; si toca desinyectar, lo devuelve a `reserveBalance` → swap si hace falta (recipient=vault, slippage protegido) → mint nueva posición (recipient=vault) → invierte `reinjectionActive` → si `rebalanceCount < maxRebalances`, paga `rebalanceFee` (leído de `PlatformConfig`) al `operator`, incrementa `rebalanceCount`; si no, revierte. Rate-limited por `minRebalanceInterval`, forzado por `periodicRebalanceInterval`, rango validado contra `maxRangeDeviationBps` |
| `payUniLabFee()` (interno, llamado por `initPosition`/`rebalance`) | `operator` (indirecto) | Transfiere 0.5 USDT fijos de `usdtBudget` a la wallet de pago de uni-lab; revierte si `usdtBudget` no alcanza |
| `withdraw(uint256 shareBps)` / `withdrawAll()` | `owner` | Cierra (parcial o total) la posición y transfiere **solo a `owner`** |
| `setOperator(address)` | `owner` | Override/revoca al operador por defecto de la plataforma (kill switch) |
| `setRiskParams(maxSlippageBps, minRebalanceInterval, maxRangeDeviationBps)` | `owner` | — |
| `pause()` / `unpause()` | `owner` | Bloquea `initPosition()`/`rebalance()` sin afectar `withdraw()` |
| `emergencyWithdrawPosition()` | `owner` | Fuerza el cierre de la posición y devuelve todo, sin depender del operador |
| `onERC721Received(...)` | — | Recibe el NFT de posición de Uniswap V3 |

**Tests obligatorios (Foundry, fork de Celo mainnet, antes de tocar mainnet real):**
- Factory: clones se inicializan correctamente, no se pueden re-inicializar, `getVaultsByOwner` correcto.
- `RangeVault`: operador no puede retirar ni cambiar owner; `initPosition`/`rebalance` revierten si el rango excede `maxRangeDeviationBps` o no calza con `configureTarget`; `rebalance` respeta `minRebalanceInterval` y revierte al superar `maxRebalances`; `withdraw()` solo manda fondos a `owner` (revierte si lo llama otra cuenta); `payUniLabFee` revierte si `usdtBudget` insuficiente; reentrancy en todas las funciones que mueven fondos; `emergencyWithdrawPosition()` funciona con `operator` inválido/revocado; **`reinjectionActive` se invierte en cada `rebalance()` exitoso y el operador no puede forzar qué modo toca; `reserveBalance` sube y baja exactamente en `reinjectionAmount` en ciclos alternados y nunca queda negativo; un rebalanceo dispara igual si pasó `periodicRebalanceInterval` aunque el precio siga dentro del rango vigente.**
- `PlatformConfig`: solo su `owner` puede cambiar `rebalanceFee`/`feeToken`/`maxDepositUsd`; un vault que lee la config en vivo refleja un cambio de fee inmediatamente.

### `agent/` — keeper multi-vault

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
- Ancho de rango: usa el mismo ancho porcentual (`RANGE_WIDTH_PCT`) que el owner configuró en `configureTarget` — recentra ese ancho alrededor del precio actual.
- `D1` (nuevo lower bound que propone el agente) = `precio_actual × (1 − RANGE_WIDTH_PCT/2)`.
- `E1` (reinversión) depende del ciclo de reinyección alternada (ver abajo): `0` en los ciclos "sin reinyección", `reinjectionAmount` en los ciclos "con reinyección".
- La API devuelve el nuevo upper bound → el agente lo convierte a tick → llama `vault.rebalance(tickLower, tickUpper, minOut)`.

#### Ciclo de reinyección alternada (para generar más volumen por rebalanceo)

Cada rebalanceo alterna entre dos modos, usando los dos modos que ya expone la API de uni-lab (RC y RLP):

- **Ciclo "con reinyección" (RLP, `E1 = reinjectionAmount`):** al redesplegar la posición, el vault **suma** un monto fijo (`reinjectionAmount`, configurable por vault) sacado de su `reserveBalance` (capital ocioso en USDT que el owner ya depositó pero que no está en la posición activa). Como `reserveBalance` es puro USDT, el agente swapea la porción que corresponda a WETH según el nuevo split antes de mintear — mismo mecanismo que en `initPosition()`. La nueva posición queda con más capital que la anterior. `reserveBalance -= reinjectionAmount`.
- **Ciclo "sin reinyección" (RC, `E1 = 0`):** al redesplegar, el vault **retira** ese mismo `reinjectionAmount` de vuelta al `reserveBalance` antes de mintear la nueva posición, que queda más chica otra vez. `reserveBalance += reinjectionAmount`.
- El vault alterna automáticamente entre estos dos modos en cada rebalanceo exitoso (`reinjectionActive` es un booleano que se invierte cada vez) — así, en dos rebalanceos consecutivos, el capital neto vuelve al mismo punto, pero **cada rebalanceo individual mueve fondos de verdad** (dos llamadas a uni-lab con parámetros distintos, dos transacciones con lógica económica real), en vez de cerrar y volver a abrir exactamente la misma posición.
- **Estado nuevo en el contrato:** `reinjectionAmount` (owner-configurable), `reserveBalance` (se financia como parte de `deposit()` — el owner tiene que depositar de más para cubrir esta reserva, además del capital de la posición inicial y el `usdtBudget` de uni-lab), `reinjectionActive` (bool, lo maneja el contrato, no el operador — así el operador no puede elegir manipular en qué ciclo "toca" reinyectar).

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
- **Wallet de pago de uni-lab.xyz:** `0x4B53D27c81f9E842D50a1940E27B8009B64c615B`, **0.5 USDT fijos por consulta** (confirmado en `https://uni-lab-xyz.vercel.app/api-docs`).
- **Contratos Uniswap V3 en Celo** (NonfungiblePositionManager, SwapRouter02 — ya no hace falta el Factory para crear el pool, dado que ya existe) — direcciones sacadas de la doc oficial de Uniswap, **reverificar contra Celopedia** (`npx skills add celo-org/celopedia-skills`) antes de hardcodearlas.
- Endpoints de uni-lab usados: `POST /register-agent` (por vault), `POST /pool-setup-initial` (una vez, en `initPosition`), `POST /rc-rlp-rebalance` (cada `rebalance`). Rate limit 100 req/hora por `api_key`.

## Pasos de implementación (8 días)

1. **Día 1:** `npx skills add celo-org/celopedia-skills` (reverificar direcciones Uniswap) + repo público + Telegram del hackathon. Scaffold Foundry. *(El registro en `celobuilders.xyz` se deja para el final por decisión explícita del usuario — ver Context. El código de `attribution.ts` se construye igual desde el día 1, listo para usar el tag en cuanto exista, pero durante el desarrollo las transacciones van sin tag real.)*
2. **Día 1-2:** `PlatformConfig.sol` + `RangeVault.sol` (lógica + guardrails) + tests en fork de Celo mainnet. No se avanza a mainnet real hasta que estos tests pasen.
3. **Día 2-3:** `VaultFactory.sol` (clones) + tests de integración factory↔vault↔config. Deploy de los 3 contratos a Celo mainnet.
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
