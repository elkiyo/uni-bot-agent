import "server-only";
import { encodeFunctionData, getContract, type Abi, type Address, type Hex } from "viem";
import type { ChainRuntime } from "./wallet";
import { withAttribution } from "./attribution";
import { uniswapV3PoolAbi, positionManagerAbi } from "../contracts";

export { uniswapV3PoolAbi, positionManagerAbi };

function client(chain: ChainRuntime) {
  if (!chain.walletClient) throw new Error("OPERATOR_PRIVATE_KEY not set — cannot send transactions");
  return chain.walletClient;
}

export function vaultContract(chain: ChainRuntime, address: Address) {
  return getContract({
    address,
    abi: chain.vaultAbi,
    client: { public: chain.publicClient, wallet: client(chain) },
  });
}

export function factoryContract(chain: ChainRuntime, address: Address) {
  return getContract({
    address,
    abi: chain.factoryAbi,
    client: { public: chain.publicClient, wallet: client(chain) },
  });
}

/**
 * Sends a contract call with the ERC-8021 attribution tag appended to calldata
 * (see attribution.ts). All keeper-initiated transactions go through this
 * rather than viem's `getContract().write.*` sugar, which doesn't expose a
 * calldata hook.
 */
export async function sendTaggedTx(
  chain: ChainRuntime,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<Hex> {
  const wallet = client(chain);
  const baseData = encodeFunctionData({ abi, functionName, args });
  const data = withAttribution(baseData);
  return wallet.sendTransaction({ to: address, data, account: wallet.account!, chain: wallet.chain });
}
