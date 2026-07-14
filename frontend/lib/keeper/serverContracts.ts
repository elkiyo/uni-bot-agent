import "server-only";
import { encodeFunctionData, getContract, type Abi, type Address, type Hex } from "viem";
import { publicClient, walletClient } from "./wallet";
import { withAttribution } from "./attribution";
import { rangeVaultAbi, vaultFactoryAbi, uniswapV3PoolAbi, positionManagerAbi } from "../contracts";

export { uniswapV3PoolAbi, positionManagerAbi };

function client() {
  if (!walletClient) throw new Error("OPERATOR_PRIVATE_KEY not set — cannot send transactions");
  return walletClient;
}

export function vaultContract(address: Address) {
  return getContract({
    address,
    abi: rangeVaultAbi,
    client: { public: publicClient, wallet: client() },
  });
}

export function factoryContract(address: Address) {
  return getContract({
    address,
    abi: vaultFactoryAbi,
    client: { public: publicClient, wallet: client() },
  });
}

/**
 * Sends a contract call with the ERC-8021 attribution tag appended to calldata
 * (see attribution.ts). All keeper-initiated transactions go through this
 * rather than viem's `getContract().write.*` sugar, which doesn't expose a
 * calldata hook.
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
