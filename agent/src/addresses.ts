// Verified in PLAN.md — cross-checked against Celopedia, CoinGecko, DefiLlama, and
// direct RPC calls (eth_getCode / factory.getPool) before being trusted here.
export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;
export const WETH = "0xD221812de1BD094f35587EE8E174B07B6167D9Af" as const;
export const POOL = "0x6F42B9D2085a0dEb711C00A460a98B9863ae4897" as const; // USDT/WETH 0.3%
export const FEE_TIER = 3000;

export const POSITION_MANAGER = "0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A" as const;
export const SWAP_ROUTER02 = "0x5615CDAb10dc425a742d643d949a7F474C01abc4" as const;

// Per uni-lab.xyz's API docs (https://uni-lab-xyz.vercel.app/api-docs).
export const UNILAB_PAYMENT_WALLET = "0x4B53D27c81f9E842D50a1940E27B8009B64c615B" as const;
export const UNILAB_FEE_USDT = 500_000n; // 0.5 USDT, 6 decimals
export const UNILAB_BASE_URL = "https://uni-lab.xyz/api/v1";
