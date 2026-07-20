# uni-bot-agent

Non-custodial Uniswap V3 concentrated-liquidity vault platform on Celo, built for the
[Agentic Payments & DeFAI Hackathon](https://celoplatform.notion.site/Agentic-Payments-DeFAI-Hackathon-364d5cb803de800c9502d8a384716324)
(Track 1: Most Revenue Generated).

Any LP can deposit USDT into a vault; a keeper agent builds and rebalances a Uniswap V3
position on the [USDT/WETH 0.3% pool](https://app.uniswap.org/explore/pools/celo/0x6F42B9D2085a0dEb711C00A460a98B9863ae4897)
on their behalf — automatically, but **never with custody of the principal**. The agent
consults [uni-lab.xyz](https://uni-lab-xyz.vercel.app/api-docs) (a real, pay-per-query API,
settled in USDT on Celo) for rebalance-range calculations, and charges a platform fee per
rebalance, capped by the vault owner and priced by the platform.

Full design rationale, decision history, and the reasoning behind every guardrail live in
[`autorange.md`](./autorange.md) — read that first.

## Layout

```
/contracts   # Foundry — PlatformConfig, VaultFactory (EIP-1167 clones), RangeVault
/agent       # Node/TypeScript — the keeper: discovers vaults, builds/rebalances positions
/frontend    # Next.js — LP self-service (create/manage vaults) + platform admin panel
```

## Status

- [x] `PlatformConfig`, `RangeVault`, `VaultFactory` — written, compiling, 15/15 tests
      passing against a live Celo mainnet fork (see `contracts/test/`).
- [x] `agent/` keeper loop (discovery, uni-lab integration, monitor, rebalancer) —
      confirmed running against live Celo RPC.
- [x] `frontend/` — Mis vaults, crear vault, detalle de vault, panel admin. Builds,
      lints, and all four routes render.
- [x] **Deployed to Celo mainnet**, Ledger-signed:
  - `PlatformConfig`: [`0xa9527c757c4863De2296a72697ABa9fEa6E0da9D`](https://celoscan.io/address/0xa9527c757c4863De2296a72697ABa9fEa6E0da9D)
  - `VaultFactory`: [`0xa431a0bD0978d872C720cD3E3277e31cd6026e90`](https://celoscan.io/address/0xa431a0bD0978d872C720cD3E3277e31cd6026e90)
  - `RangeVault` implementation: [`0xd3d07BF083239Bb8ff356a8A621Eae5de54B0cB6`](https://celoscan.io/address/0xd3d07BF083239Bb8ff356a8A621Eae5de54B0cB6)
  - All constructor values (owner, defaultOperator, rebalanceFee, feeToken,
    maxDepositUsd, and the factory's positionManager/swapRouter/uniLabPaymentWallet
    links) re-read from chain and confirmed to match after deploy.
- [x] **Deployed to Arbitrum One mainnet** (`RangeVaultArb`/`VaultFactoryArb` — a
  fork of the Celo contracts that generalizes token0/token1 ordering, since
  Uniswap V3 sorts by address and WETH < USDC on Arbitrum, the reverse of USDT <
  WETH on Celo; see `contracts/src/RangeVaultArb.sol` for the full rationale):
  - `PlatformConfig`: [`0xCF281b7bc1dEd843542008a577D7bdaa8F41B0Cb`](https://arbiscan.io/address/0xCF281b7bc1dEd843542008a577D7bdaa8F41B0Cb)
  - `VaultFactoryArb`: [`0x93590F9a18Ed444dD90ECBeCA094aa9367452472`](https://arbiscan.io/address/0x93590F9a18Ed444dD90ECBeCA094aa9367452472)
  - `RangeVaultArb` implementation: [`0x03825Da2629575C57f3b5791ffb6f876Bd62fBF4`](https://arbiscan.io/address/0x03825Da2629575C57f3b5791ffb6f876Bd62fBF4)

  (Note: an earlier Celo-style `VaultFactory`/`RangeVault` pair was deployed to
  Arbitrum first and hit the token-ordering bug described above in production;
  it's abandoned — `VaultFactoryArb` above is the one in use.)
- [x] `agent/.env` and `frontend/.env.local` point at the deployed addresses (both
      gitignored — see each package's `.env*.example` for the non-secret template)
- [ ] Hackathon registration (`celobuilders.xyz`) — deliberately last, see `autorange.md` Context

## Quickstart

```bash
cd contracts && forge install && CELO_RPC_URL=https://forno.celo.org forge test
```

See `contracts/README.md`, `agent/README.md`, and `frontend/README.md` for each piece.
