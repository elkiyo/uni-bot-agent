# CLAUDE.md — uni-bot-agent / AutoRange

Bitácora viva del proyecto: arquitectura, decisiones tomadas (y por qué), estado actual, y pendientes. Se actualiza en cada sesión — es la fuente de verdad antes que la memoria dispersa en `autorange.md` (plan original del hackathon), `SCALING.md` y `HACKATHON.md`, que quedan como historia, no como referencia activa.

## Qué es esto

Plataforma no-custodial de vaults para Uniswap V3: cualquiera crea su propio vault desde `/create`, deposita, y un agente (keeper) lo rebalancea automáticamente dentro de los límites que el owner configura. El owner nunca pierde custodia — el vault separa `owner` (deposita/retira/configura) de `operator` (solo puede rebalancear dentro de los guardrails). uni-lab.xyz calcula el rango de rebalanceo (`/rc-rlp-rebalance`), pagado vía x402 por el operador.

Multi-chain: **Celo** (original) y **Arbitrum** (agregado después, con soporte de reserva de gas que Celo no tiene).

## Arquitectura de contratos

Por chain existen (potencialmente) dos factories, cada una con su propia implementación de vault clonada vía EIP-1167:

- **Estándar**: `VaultFactory.sol`/`RangeVault.sol` (Celo), `VaultFactoryArb.sol`/`RangeVaultArb.sol` (Arbitrum).
- **Interés compuesto** (Arbitrum only, deployada 2026-07-26): `VaultFactoryArbCompound.sol`/`RangeVaultArbCompound.sol` — mismo comportamiento que la estándar más reinyección de comisiones (`autoCompoundFees`, reclamo manual o programado por %/tiempo) y depósitos flexibles (`depositToken()` con cualquier token, no solo el stable). Nunca se edita `RangeVaultArb.sol` para agregar esto — siempre se forkea a un contrato nuevo (mismo patrón para cualquier variante futura).

**Direcciones actuales (Arbitrum)**:
- Factory estándar: `0x93590F9a18Ed444dD90ECBeCA094aa9367452472`
- Factory compuesto: `0x1f03Ea1C82ce4D44355D5d02C730620Fa6038B22` (impl `0xC75b31044C779f377a0B557c5C5922aB9b8401a0`, deploy block `487963866`)
- `PlatformConfig` compartida (ver decisión abajo): `0xCF281b7bc1dEd843542008a577D7bdaa8F41B0Cb`

### PlatformConfig — una por chain, no por par ni por tipo de vault

**Decisión (2026-07-26)**: `PlatformConfig` (operador por defecto, tope de depósito, performance fee, fee de creación, tesorería) vive **una instancia por chain**, compartida por todas las factories/vaults de esa chain (estándar y compuesto incluidos). No se fragmenta por par (USDC/WETH vs LINK/USDT, etc.) ni por tipo de vault salvo que haya una razón de negocio deliberada y puntual para lo segundo.

**Por qué**: cada `PlatformConfig` es un contrato más para trackear, una sección más en el admin, más superficie para que algo quede desincronizado. Fragmentar por combinación de chain×par×tipo escala mal. La factory de interés compuesto ya fue deployada reutilizando la `PlatformConfig` existente de Arbitrum a propósito (`DeployArbCompound.s.sol`).

**Limitación conocida**: `platformConfig` es `immutable` tanto en la factory como en cada vault — se fija una sola vez al deployar y no tiene setter. Si en algún momento se decide que interés compuesto SÍ necesita economía propia (fee de performance distinto, por ejemplo), hace falta: (1) deployar una `PlatformConfig` nueva, (2) re-deployar `VaultFactoryArbCompound` apuntando a ella (la actual no se puede reapuntar), (3) actualizar `chains.ts`/env vars, (4) extender el admin para editar dos `PlatformConfig` separadas. Los vaults ya creados con la config vieja se quedan con ella para siempre (también immutable por vault).

### Multi-par

Los contratos ya son 100% genéricos — `createVault(pool, stableToken, volatileToken, fee)` acepta cualquier par, y cada vault guarda su propio `token0`/`token1`/`stableIsToken0` como getters públicos. El trabajo de generalización (2026-07-25) vivió enteramente en frontend/keeper: cada vault resuelve y cachea su propio par (`lib/keeper/pairInfo.ts` del lado del keeper, `lib/useVaultPairInfo.ts` del lado del frontend) en vez de asumir el par default de la chain. `lib/chains.ts` tiene `supportedPairs: SupportedPair[]` listo para cuando se cure un segundo par real — hoy solo tiene el par default de cada chain, no hay UI de selector en `/create` todavía (no vale la pena armarla para una lista de un solo elemento).

### B1/A1 (uni-lab.xyz)

A1 = valor actual de la posición en el momento del rebalanceo (se calcula en vivo). B1 = **todo el capital que efectivamente entró a la posición del vault, contado una sola vez, en el momento en que entra**:
- Depósito: solo `investableAmount` cuenta al momento del depósito. `reserveAmount` NO cuenta todavía (está esperando en la reserva, no en la posición).
- Reinyección (de reserva O de comisiones): cuenta el monto exacto reinyectado, valuado en USD en el momento en que pasa — así se evita el doble conteo (la reserva no se cuenta dos veces: ni al depositarla ni al reinyectarla).
- Retiro: B1 baja en la porción de principal retirado (nunca por comisiones ni por reserva sin reinyectar, que nunca contaron).

Implementado: contrato (`RangeVaultArbCompound.sol`'s `_toStableUsd`, `FeesReinjected.netFeeUsd`, `Withdrawn`/`EmergencyWithdraw.principalUsd`) + keeper (`getCumulativeInvestmentUsd` en `rebalancer.ts`). Verificado contra el historial real de 190 vaults en Arbitrum (2026-07-26) — la diferencia entre B1 viejo y nuevo coincide exactamente con `reinyectado − reserva_depositada − retirado`.

### Visibilidad de gas agotado

El keeper detecta cuando `gasReserveBalance` de un vault no alcanza para cubrir su propio costo de gas (el vault sigue operando igual — proteger el capital del owner gana siempre sobre cobrarle al operador), lo persiste en Supabase (`gas_reserve_empty_since`), y lo muestra como alerta al owner + sección en el admin.

## Interés compuesto — estado actual (beta cerrada)

**Restringido a una sola wallet por ahora**: `0xb0E5ADb84373b30D0F79C3f9E814d13D7125991b`, vía `frontend/lib/compoundBeta.ts` — un allowlist hardcodeado de una línea que gatea el selector en `/create`, el switch/config en `VaultDetail.tsx`, y el badge en `/vaults`. Borrar ese archivo (y sus imports) cuando el feature esté listo para todos.

Al crear un vault de interés compuesto, `autoCompoundFees` se activa automáticamente (llamada extra a `setAutoCompoundFees(true)` después del depósito) — nace activado, no requiere un toggle manual posterior. El switch para prenderlo/apagarlo vive en la página del vault, debajo de "Ver posición en Uniswap" (no arriba en el header).

Vault de prueba existente: `0x55CB44A17602F885a2f947281cCFDa72A2947D19` (owner = la wallet beta de arriba).

## Pendientes / próximos pasos

- **Firma atómica al crear un vault** (hoy son 5 firmas, 6 para interés compuesto): en discusión, no implementado. El diseño requiere un contrato nuevo con una función "bootstrap" que se pueda llamar UNA sola vez, solo por la factory, saltándose el `onlyOwner` normal — es un cambio de superficie de seguridad real, necesita el mismo rigor que el resto del código que maneja plata. Generaliza a cualquier par (LINK/USDT, WBTC/USDC, ETH/DAI, etc.) — lo único que cambia por par es si se logra 1 firma (el stable soporta `permit()` EIP-2612) o 2 (approve + creación atómica). Confirmado: USDC nativo (Arbitrum) y el USDT de Celo SÍ soportan `permit()` real (no el `permit()` no-estándar de DAI). USDT canónico de Ethereum/Arbitrum bridgeado, probablemente no (sin confirmar todavía).
- **PlatformConfig separada para interés compuesto**: decisión tomada de NO fragmentar por ahora (ver arriba) — revisar si en algún momento se justifica economía propia para compounding.
- **Selector de par en `/create`**: base lista (`SupportedPair`, `usePoolMetrics(chain, pair)`), sin UI — esperando a que se cure un segundo par real con liquidez verificada.
- **Migraciones de Supabase**: cada vez que `lib/keeper/schema.sql` gana una columna nueva, hay que correr el `alter table` a mano en el SQL Editor de Supabase (no hay acceso directo desde acá) — y a veces recargar el schema cache de PostgREST (`NOTIFY pgrst, 'reload schema';`) si Supabase no lo detecta solo.
- **Deploys con Ledger**: `forge script --ledger` tiene un bug real conocido (`hidapi error: hid_error is not implemented yet`, [foundry-rs/foundry#2709](https://github.com/foundry-rs/foundry/issues/2709)) — no sirve para deploys con Ledger en este entorno. Workaround que sí funciona: compilar bytecode + argumentos del constructor con `forge inspect ... bytecode` + `cast abi-encode`, y deployar con `cast send --ledger --mnemonic-index N --create <bytecode>` en vez de `forge script`. `cast wallet address --ledger --mnemonic-index N` sirve para encontrar en qué índice del Ledger está la address que se necesita usar, sin firmar nada.
