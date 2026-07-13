import { encodeFunctionData, getContract, type Abi, type Address, type Hex } from "viem";
import { publicClient, walletClient } from "./wallet.js";
import { withAttribution } from "./attribution.js";
import RangeVaultAbi from "./abi/RangeVault.json" with { type: "json" };
import VaultFactoryAbi from "./abi/VaultFactory.json" with { type: "json" };
import PlatformConfigAbi from "./abi/PlatformConfig.json" with { type: "json" };

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
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
] as const;

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
] as const;

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
] as const;

function client() {
  if (!walletClient) throw new Error("OPERATOR_PRIVATE_KEY not set — cannot send transactions");
  return walletClient;
}

export function vaultContract(address: Address) {
  return getContract({
    address,
    abi: RangeVaultAbi as Abi,
    client: { public: publicClient, wallet: client() },
  });
}

export function factoryContract(address: Address) {
  return getContract({
    address,
    abi: VaultFactoryAbi as Abi,
    client: { public: publicClient, wallet: client() },
  });
}

export function platformConfigContract(address: Address) {
  return getContract({
    address,
    abi: PlatformConfigAbi as Abi,
    client: { public: publicClient },
  });
}

/**
 * Sends a contract call with the ERC-8021 attribution tag appended to calldata
 * (see attribution.ts — the suffix is a no-op until ATTRIBUTION_TAG is set, per
 * the deliberate decision in PLAN.md to register the hackathon project last).
 * All keeper-initiated transactions should go through this rather than the
 * viem `getContract().write.*` sugar, which doesn't expose a calldata hook.
 */
export async function sendTaggedTx(
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<Hex> {
  const wallet = client();
  const baseData = encodeFunctionData({ abi, functionName, args });
  const data = withAttribution(baseData);
  return wallet.sendTransaction({ to: address, data, account: wallet.account!, chain: wallet.chain });
}
