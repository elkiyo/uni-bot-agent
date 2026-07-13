# contracts

Foundry project. Three contracts:

- **`PlatformConfig.sol`** — platform-wide pricing/config (`rebalanceFee`, `feeToken`,
  `defaultOperator`, `maxDepositUsd`), owned by the platform operator. Vaults read this
  live on every rebalance.
- **`VaultFactory.sol`** — deploys `RangeVault` instances as EIP-1167 minimal clones.
- **`RangeVault.sol`** — one vault == one Uniswap V3 position. `owner` (the LP) deposits/
  withdraws; `operator` (the keeper) can only `initPosition()`/`rebalance()`, and never
  receives anything beyond the platform's `rebalanceFee`, capped by the owner's
  `maxRebalances`. See `../PLAN.md` for the full non-custodial rationale and the
  alternating-reinjection rebalance cycle.

## Setup

```bash
forge install
cp .env.example .env   # CELO_RPC_URL — defaults to https://forno.celo.org
```

## Test

Every test runs against a **live fork of Celo mainnet** — the real deployed Uniswap V3
pool/contracts, no mocks. Nothing touches real funds; `deal()` mints test-only token
balances on the fork.

```bash
CELO_RPC_URL=https://forno.celo.org forge test -vv
```

## Addresses used (Celo mainnet)

| Contract | Address | Source |
|---|---|---|
| USDT/WETH 0.3% pool | `0x6F42B9D2085a0dEb711C00A460a98B9863ae4897` | given by the project owner, cross-verified via direct RPC call (`token0`/`token1`/`fee`/`liquidity`) |
| USDT | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | Celopedia + CoinGecko + DefiLlama |
| WETH (Celo-bridged) | `0xD221812de1BD094f35587EE8E174B07B6167D9Af` | CoinGecko + DefiLlama |
| Uniswap V3 NonfungiblePositionManager | `0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A` | Celopedia (`celo-org/celopedia-skills`), cross-checked `eth_getCode` |
| Uniswap V3 SwapRouter02 | `0x5615CDAb10dc425a742d643d949a7F474C01abc4` | same |
| Uniswap V3 Factory | `0xAfE208a311B21f13EF87E33A90049fC17A7acDEc` | same, cross-checked `getPool(USDT, WETH, 3000)` returns the pool above |

## Notable implementation choices

- **Local Uniswap V3 interfaces** (`src/interfaces/`) instead of importing
  `@uniswap/v3-periphery` directly — that package's `INonfungiblePositionManager.sol`
  imports OpenZeppelin v3.x-era ERC721 interfaces at paths that don't exist in OZ v5,
  which this project uses everywhere else. The local interfaces match the real deployed
  ABI (verified via the fork tests actually minting/collecting real positions).
- **`via_ir = true`** in `foundry.toml` — `RangeVault.rebalance()` has enough local
  variables that the legacy codegen hits "stack too deep"; via-IR handles it cleanly.
- **Pin OZ to a tagged release, not the default branch.** `forge install` without a tag
  grabbed a mid-refactor state of `openzeppelin-contracts-upgradeable` missing
  `ReentrancyGuardUpgradeable.sol` entirely. Both OZ libs are pinned to `v5.1.0`.
