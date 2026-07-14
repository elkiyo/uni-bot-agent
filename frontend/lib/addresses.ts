// Verified in PLAN.md — cross-checked against Celopedia, CoinGecko, DefiLlama, and
// direct RPC calls before being trusted here. Keep in sync with agent/src/addresses.ts
// and contracts/script/Deploy.s.sol.
export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;
export const WETH = "0xD221812de1BD094f35587EE8E174B07B6167D9Af" as const;
export const POOL = "0x6F42B9D2085a0dEb711C00A460a98B9863ae4897" as const; // USDT/WETH 0.3%
export const FEE_TIER = 3000;
export const POSITION_MANAGER = "0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A" as const; // Uniswap V3 NonfungiblePositionManager

// Block the factory was deployed in (2026-07-14 — redeployed again same day
// for dynamic uni-lab pricing + dropping the pool-setup-initial call, see
// PLAN.md) — no vault event can precede it, so it's the safe lower bound for
// event scans.
export const FACTORY_DEPLOY_BLOCK = 72140834n;

// Set once contracts/script/Deploy.s.sol has been run against Celo mainnet.
export const FACTORY_ADDRESS = (process.env.NEXT_PUBLIC_FACTORY_ADDRESS || "") as `0x${string}`;
export const PLATFORM_CONFIG_ADDRESS = (process.env.NEXT_PUBLIC_PLATFORM_CONFIG_ADDRESS || "") as `0x${string}`;

// Per uni-lab.xyz's API docs (https://uni-lab-xyz.vercel.app/api-docs).
export const UNILAB_PAYMENT_WALLET = "0x4B53D27c81f9E842D50a1940E27B8009B64c615B" as const;
// No fixed fee constant here — uni-lab's price isn't fixed (GET
// /api/v1/pricing can change at any time, confirmed 2026-07-14: a hardcoded
// 0.5 USDT 402'd against a real 0.2 USDT price). The keeper queries it live
// right before every payment — see lib/keeper/unilab.ts#getPricing.
// The docs say uni-lab.xyz, but that domain serves only the static site
// (POST /api/v1/* returns 405 from the host) — the live API answers on the
// Vercel domain. Verified 2026-07-13 during the first real registration.
// Server-only lookup (no NEXT_PUBLIC_ prefix — only lib/keeper/* reads this).
export const UNILAB_BASE_URL = process.env.UNILAB_BASE_URL ?? "https://uni-lab-xyz.vercel.app/api/v1";
