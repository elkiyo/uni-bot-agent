// Verified in PLAN.md — cross-checked against Celopedia, CoinGecko, DefiLlama, and
// direct RPC calls before being trusted here. Keep in sync with agent/src/addresses.ts
// and contracts/script/Deploy.s.sol.
export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;
// USDC on Celo — NOT the pool's stablecoin (that's USDT above), only relevant
// as what the operator holds to pay uni-lab.xyz via x402 (see
// HACKATHON.md "Track 2 — x402"). Used to show the operator's own
// balance/health on /admin — real incident 2026-07-16: the operator ran out
// of CELO gas mid-session and every rebalance/sweep silently stalled for
// hours before anyone noticed.
export const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;
export const WETH = "0xD221812de1BD094f35587EE8E174B07B6167D9Af" as const;
export const POOL = "0x6F42B9D2085a0dEb711C00A460a98B9863ae4897" as const; // USDT/WETH 0.3%
export const FEE_TIER = 3000;
export const POSITION_MANAGER = "0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A" as const; // Uniswap V3 NonfungiblePositionManager
export const SWAP_ROUTER02 = "0x5615CDAb10dc425a742d643d949a7F474C01abc4" as const; // Uniswap V3 SwapRouter02
// Uniswap V3 Factory — read from POOL.factory() and confirmed live 2026-07-17.
// Used to find every fee-tier pool for a pair when picking the deepest one to
// route a swap through (see rebalancer.ts's pickDeepestSwapFee).
export const UNISWAP_V3_FACTORY = "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc" as const;
// Every USDT/WETH fee tier confirmed to exist on Celo mainnet (checked via
// factory.getPool 2026-07-17): 0.01%, 0.05% (deployed but empty — 0
// liquidity, never picked in practice since pickDeepestSwapFee compares real
// liquidity), 0.3% (POOL itself, where every vault's LP position lives). No
// 1% pool exists for this pair (getPool returns the zero address).
export const CANDIDATE_SWAP_FEE_TIERS = [100, 500, 3000] as const;
// Deliberately NOT using Uniswap's own Quoter (0x82825d05...) here — its
// CREATE2 pool-address computation (PoolAddress.computeAddress, hardcoded
// POOL_INIT_CODE_HASH from @uniswap/v3-periphery 1.0.0) doesn't match Celo's
// real deployed pool bytecode hash, confirmed 2026-07-16 via a direct
// eth_call revert. simulateContract'ing SWAP_ROUTER02.exactInputSingle
// itself instead — as the vault's own account, via eth_call, never
// committed — gets the same real price-impact-aware amountOut without
// depending on that offline address computation at all, since the router
// looks the pool up through the real factory. See rebalancer.ts.

// Block the current factory was deployed in (2026-07-16 — added
// sweepIdleDust(), an operator-only corrective-swap dust sweep). No vault
// event from THIS factory can precede it, so it's the safe lower bound for
// event scans. Vaults from any earlier, now-retired factory are out of scope
// for this platform going forward — see PLAN.md for their addresses if ever
// needed.
export const FACTORY_DEPLOY_BLOCK = 72269264n;

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
