import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { arbitrum } from "wagmi/chains";
import { uniswapV3PoolAbi, positionManagerAbi } from "@/lib/contracts";

const VAULT = "0x55CB44A17602F885a2f947281cCFDa72A2947D19" as const;
const PM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" as const;

const vaultAbi = [
  { type: "function", name: "pool", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function",
    name: "positionTokenId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export async function GET() {
  const client = createPublicClient({ chain: arbitrum, transport: http(process.env.ARBITRUM_CLIENT_RPC_URL) });

  const tokenId = (await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "positionTokenId" })) as bigint;
  const pool = (await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "pool" })) as `0x${string}`;

  const position = (await client.readContract({
    address: PM,
    abi: positionManagerAbi,
    functionName: "positions",
    args: [tokenId],
  })) as readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint];

  const [, , , , , tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1] =
    position;

  // Exact same multicall batch VaultDetail.tsx's feeGrowthReads issues.
  const results = await client.multicall({
    contracts: [
      { address: pool, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal0X128" },
      { address: pool, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal1X128" },
      { address: pool, abi: uniswapV3PoolAbi, functionName: "ticks", args: [tickLower] },
      { address: pool, abi: uniswapV3PoolAbi, functionName: "ticks", args: [tickUpper] },
    ],
  });

  return NextResponse.json({
    tokenId: tokenId.toString(),
    pool,
    tickLower,
    tickUpper,
    liquidity: liquidity.toString(),
    feeGrowthInside0LastX128: feeGrowthInside0LastX128.toString(),
    feeGrowthInside1LastX128: feeGrowthInside1LastX128.toString(),
    tokensOwed0: tokensOwed0.toString(),
    tokensOwed1: tokensOwed1.toString(),
    multicallResults: results.map((r) => ({
      status: r.status,
      result: r.status === "success" ? (Array.isArray(r.result) ? r.result.map(String) : String(r.result)) : undefined,
      error: r.status === "failure" ? String(r.error) : undefined,
    })),
  });
}
