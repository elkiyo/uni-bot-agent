# agent

The keeper: discovers vaults from `VaultFactory`, registers each new one with
uni-lab.xyz, and runs `initPosition()`/`rebalance()` when a vault needs it. Never
holds vault principal — see `../PLAN.md`.

## Setup

```bash
npm install
cp .env.example .env
```

Required env vars (see `.env.example`):
- `CELO_RPC_URL` — defaults to `https://forno.celo.org`
- `OPERATOR_PRIVATE_KEY` — the keeper wallet; must be `PlatformConfig.defaultOperator`
  (or a vault owner's chosen override) to actually send transactions. Leave unset to
  run read-only.
- `ATTRIBUTION_TAG` — left unset during development by design (see `PLAN.md`
  "Context": the hackathon project registers last, so early transactions go
  untagged on purpose).
- `FACTORY_ADDRESS` — set once `VaultFactory` is deployed.

## Run

```bash
npm run dev      # keeper daemon: discovers vaults, ticks every 5 minutes
npm run cli status
npm run cli force-init <vaultAddress>
npm run cli force-rebalance <vaultAddress>
```

## Module map

| File | Responsibility |
|---|---|
| `wallet.ts` | viem clients (public + wallet, from `OPERATOR_PRIVATE_KEY`) |
| `attribution.ts` | ERC-8021 tag suffix on every keeper tx |
| `contracts.ts` | Typed contract handles + `sendTaggedTx` (calldata + attribution) |
| `addresses.ts` | Every externally-sourced address/constant, see `../PLAN.md` for provenance |
| `store.ts` | JSON-file state: known vaults, their uni-lab `api_key`, event-scan cursor |
| `discovery.ts` | Scans `VaultCreated` events, registers new vaults with uni-lab.xyz |
| `unilab.ts` | Thin client for `pool-setup-initial` / `rc-rlp-rebalance` |
| `priceMath.ts` / `swapMath.ts` | Tick↔price conversion, swap sizing heuristics (off-chain only — the contract doesn't trust these, see inline docs) |
| `monitor.ts` | Free on-chain check: does this vault need `initPosition`/`rebalance` right now? |
| `rebalancer.ts` | Orchestrates `payUniLabFee()` → uni-lab API call → `initPosition`/`rebalance` |
| `cli.ts` / `index.ts` | Entry points |

## Known simplification (documented, not hidden)

`initPosition`/`rebalance` are called with `amount0Min`/`amount1Min` = 0 for now —
no on-chain slippage floor yet on the mint side (the swap itself does carry a
floor). Fine for the amounts and Foundry-fork testing done so far; before running
this against real, larger deposits it needs a real quote-based minimum (e.g. via
`QuoterV2` or the same uni-lab response) wired in.
