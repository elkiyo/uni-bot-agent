// Chain-specific addresses/pools/fee-tiers now live in chains.ts (per-chain
// ChainDef, keyed by chain id) — this file only keeps the handful of
// constants that are genuinely NOT per-chain, plus flat re-exports of Celo's
// own values for the few places that intentionally haven't gone
// chain-aware yet (docs/page.tsx's static copy).
import { CHAINS } from "./chains";
import { celo } from "viem/chains";

const CELO_CHAIN = CHAINS[celo.id];

export const USDT = CELO_CHAIN.stableToken;
export const WETH = CELO_CHAIN.volatileToken;
export const POOL = CELO_CHAIN.pool;
export const FEE_TIER = CELO_CHAIN.feeTier;
export const POSITION_MANAGER = CELO_CHAIN.positionManager;
export const SWAP_ROUTER02 = CELO_CHAIN.swapRouter02;
export const UNISWAP_V3_FACTORY = CELO_CHAIN.uniswapV3Factory;
export const CANDIDATE_SWAP_FEE_TIERS = CELO_CHAIN.candidateSwapFeeTiers;
export const FACTORY_DEPLOY_BLOCK = CELO_CHAIN.factoryDeployBlock;
export const FACTORY_ADDRESS = CELO_CHAIN.factoryAddress;
export const PLATFORM_CONFIG_ADDRESS = CELO_CHAIN.platformConfigAddress;

// USDC on Celo — NOT the pool's stablecoin (that's USDT above), only relevant
// as what the operator holds to pay uni-lab.xyz via x402 (see
// HACKATHON.md "Track 2 — x402"). Used to show the operator's own
// balance/health on /admin — real incident 2026-07-16: the operator ran out
// of CELO gas mid-session and every rebalance/sweep silently stalled for
// hours before anyone noticed. Stays Celo-specific: uni-lab payment always
// happens from the Celo side of the operator wallet regardless of which
// chain a given vault lives on (see unilab.ts).
export const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;

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
