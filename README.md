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
- [ ] `agent/` keeper loop (discovery, uni-lab integration, monitor, rebalancer)
- [ ] `frontend/`
- [ ] Mainnet deployment + live operation
- [ ] Hackathon registration (`celobuilders.xyz`) — deliberately last, see `PLAN.md` Context

## Quickstart

```bash
cd contracts && forge install && CELO_RPC_URL=https://forno.celo.org forge test
```

See `contracts/README.md` for contract details. `agent/README.md` will follow once the
keeper loop is built.
