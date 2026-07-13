import "dotenv/config";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";

const rpcUrl = process.env.CELO_RPC_URL ?? "https://forno.celo.org";

export const publicClient = createPublicClient({
  chain: celo,
  transport: http(rpcUrl),
});

function loadOperatorAccount() {
  const key = process.env.OPERATOR_PRIVATE_KEY;
  if (!key) return undefined;
  return privateKeyToAccount(key as `0x${string}`);
}

export const operatorAccount = loadOperatorAccount();

export const walletClient = operatorAccount
  ? createWalletClient({
      account: operatorAccount,
      chain: celo,
      transport: http(rpcUrl),
    })
  : undefined;
