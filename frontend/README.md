# frontend

Next.js 16 (App Router) + wagmi v2 + viem + RainbowKit. LP self-service (create/manage
vaults) and the platform admin panel — see `../autorange.md` "frontend/".

## Setup

```bash
npm install
cp .env.local.example .env.local
```

Fill in `.env.local` once `contracts/script/Deploy.s.sol` has been run:

- `NEXT_PUBLIC_FACTORY_ADDRESS`
- `NEXT_PUBLIC_PLATFORM_CONFIG_ADDRESS`
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — free at https://cloud.walletconnect.com;
  without it the app still builds/runs and injected wallets (MetaMask, Rabby, ...) work,
  only the WalletConnect QR/mobile flow needs a real id.

```bash
npm run dev
```

## Pages

| Route | What |
|---|---|
| `/` | "Mis vaults" — lists the connected wallet's vaults via `factory.getVaultsByOwner` |
| `/create` | Create a vault: `createVault` → `configureTarget` → `approve` → `deposit`, sequential txs with on-screen progress |
| `/vault/[address]` | Status (range, ledgers, rebalance count) + owner-only actions: deposit more, withdraw all, pause/unpause, revoke operator, emergency withdraw |
| `/admin` | Gated by `PlatformConfig.owner()` — adjust `rebalanceFee`, `defaultOperator`, `maxDepositUsd` |

## Notes for whoever picks this up next

- **This is Next.js 16**, not 15 — `params` in `page.tsx` are async now (a `Promise`),
  which is why `app/vault/[address]/page.tsx` is a small `async` server component that
  just awaits `params` and hands a plain string to a client component
  (`VaultDetail.tsx`) — all the wagmi hooks live there instead, since hooks need
  `"use client"`. See `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`
  if something here looks like it's fighting the framework — it's very possibly a
  real v16 behavior change, not a mistake.
- ABIs in `lib/abi/` are copied from `contracts/out/*.sol/*.json` (extracted via the
  same approach as `agent/src/abi/`) — regenerate them after any contract change
  rather than hand-editing.
- `lib/priceMath.ts` duplicates `agent/src/priceMath.ts` (small, pure, low drift risk)
  since the frontend and the Node keeper don't share a package.
