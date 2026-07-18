import type { Abi } from "viem";
import RangeVaultAbi from "./abi/RangeVault.json";
import VaultFactoryAbi from "./abi/VaultFactory.json";
import RangeVaultArbAbi from "./abi/RangeVaultArb.json";
import VaultFactoryArbAbi from "./abi/VaultFactoryArb.json";
import PlatformConfigAbi from "./abi/PlatformConfig.json";

// Cast through Abi (rather than leaving the plain JSON-inferred type) so wagmi's
// contract config types — which expect the real viem Abi shape — accept these.
//
// rangeVaultAbi/vaultFactoryAbi are Celo's contracts — RangeVault.sol/VaultFactory.sol,
// completely unmodified by the Arbitrum work below. rangeVaultArbAbi/vaultFactoryArbAbi
// are Arbitrum's own fork (RangeVaultArb.sol/VaultFactoryArb.sol — see that file's class
// docstring for why it's a separate contract). Deliberately two distinct ABI pairs, not
// one shared "superset" — every chain-specific component reads the right one off
// `chain.vaultAbi`/`chain.factoryAbi` (see chains.ts) instead of importing these directly.
export const rangeVaultAbi = RangeVaultAbi as Abi;
export const vaultFactoryAbi = VaultFactoryAbi as Abi;
export const rangeVaultArbAbi = RangeVaultArbAbi as Abi;
export const vaultFactoryArbAbi = VaultFactoryArbAbi as Abi;
export const platformConfigAbi = PlatformConfigAbi as Abi;

export const uniswapV3PoolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "tickSpacing",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount0", type: "int256", indexed: false },
      { name: "amount1", type: "int256", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
    ],
  },
  // Below: enough of IUniswapV3PoolState to compute a position's LIVE
  // uncollected fees client-side (feeGrowthInside math) — see
  // lib/positionMath.ts's uncollectedFeesRaw. positions() alone only exposes
  // tokensOwed0/1, which is stale between mint/burn/collect calls.
  {
    type: "function",
    name: "feeGrowthGlobal0X128",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "feeGrowthGlobal1X128",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "ticks",
    stateMutability: "view",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
      { name: "tickCumulativeOutside", type: "int56" },
      { name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { name: "secondsOutside", type: "uint32" },
      { name: "initialized", type: "bool" },
    ],
  },
] as const;

// Just enough of the Uniswap V3 Factory to look up every fee-tier pool for a
// pair — used to pick the deepest one for a swap's own route, independent of
// whichever pool a vault's LP position lives in. See SwapInstruction.fee's
// docstring in RangeVault.sol for why this exists.
export const uniswapV3FactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

// Uniswap V3 SwapRouter02 — just enough to simulate exactInputSingle for a
// real, price-impact-aware quote (see addresses.ts's note on why this is
// used instead of Uniswap's own Quoter). Server-side only.
export const swapRouter02Abi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// Uniswap V3 NonfungiblePositionManager — just the two views the vault detail
// page needs: full position data, and the on-chain-generated NFT art (tokenURI
// returns a base64 JSON whose `image` is a base64 SVG rendered by the contract).
export const positionManagerAbi = [
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

// ERC20 fragment big enough for the deposit flow (approve + balanceOf + decimals).
export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
