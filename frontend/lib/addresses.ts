// Verified in PLAN.md — cross-checked against Celopedia, CoinGecko, DefiLlama, and
// direct RPC calls before being trusted here. Keep in sync with agent/src/addresses.ts
// and contracts/script/Deploy.s.sol.
export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;
export const WETH = "0xD221812de1BD094f35587EE8E174B07B6167D9Af" as const;
export const POOL = "0x6F42B9D2085a0dEb711C00A460a98B9863ae4897" as const; // USDT/WETH 0.3%
export const FEE_TIER = 3000;
export const POSITION_MANAGER = "0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A" as const; // Uniswap V3 NonfungiblePositionManager

// Set once contracts/script/Deploy.s.sol has been run against Celo mainnet.
export const FACTORY_ADDRESS = (process.env.NEXT_PUBLIC_FACTORY_ADDRESS || "") as `0x${string}`;
export const PLATFORM_CONFIG_ADDRESS = (process.env.NEXT_PUBLIC_PLATFORM_CONFIG_ADDRESS || "") as `0x${string}`;
