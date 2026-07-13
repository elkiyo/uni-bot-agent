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
[`PLAN.md`](./PLAN.md) — read that first.

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
  - `PlatformConfig`: [`0xC419B014fA6364B6f71375430042ACf3965E5d55`](https://celoscan.io/address/0xC419B014fA6364B6f71375430042ACf3965E5d55)
  - `VaultFactory`: [`0xCF281b7bc1dEd843542008a577D7bdaa8F41B0Cb`](https://celoscan.io/address/0xCF281b7bc1dEd843542008a577D7bdaa8F41B0Cb)
  - `RangeVault` implementation: [`0xC352dbB3b85a7015717167EC5126D94abc77Ac94`](https://celoscan.io/address/0xC352dbB3b85a7015717167EC5126D94abc77Ac94)
  - All constructor values (owner, defaultOperator, rebalanceFee, feeToken,
    maxDepositUsd, and the factory's positionManager/swapRouter/uniLabPaymentWallet
    links) re-read from chain and confirmed to match after deploy.
- [x] `agent/.env` and `frontend/.env.local` point at the deployed addresses (both
      gitignored — see each package's `.env*.example` for the non-secret template)
- [ ] Hackathon registration (`celobuilders.xyz`) — deliberately last, see `PLAN.md` Context

## Quickstart

```bash
cd contracts && forge install && CELO_RPC_URL=https://forno.celo.org forge test
```

See `contracts/README.md`, `agent/README.md`, and `frontend/README.md` for each piece.
