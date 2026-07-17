import "server-only";
import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainDef } from "../chains";

function loadOperatorAccount() {
  const key = process.env.OPERATOR_PRIVATE_KEY;
  if (!key) return undefined;
  return privateKeyToAccount(key as `0x${string}`);
}

// A viem Account isn't chain-bound (it's just a keypair) — the SAME EOA signs
// for every configured chain, funded separately per chain (CELO gas + USDC
// on Celo as before, plus native gas on any other chain). Also used directly
// by unilab.ts for x402 payment, which always happens via Celo regardless of
// which chain's vault triggered the rebalance cycle — see its own docstring.
export const operatorAccount = loadOperatorAccount();

export interface ChainRuntime extends ChainDef {
  publicClient: PublicClient;
  walletClient: WalletClient | undefined;
}

const runtimeCache = new Map<number, ChainRuntime>();

/**
 * Per-chain client pair, memoized — replaces the old module-level singleton
 * publicClient/walletClient (hardcoded to Celo) now that the keeper runs
 * against multiple chains in the same process. Every keeper function that
 * used to import publicClient/walletClient directly now receives a
 * ChainRuntime as its first parameter instead.
 */
export function getChainRuntime(chain: ChainDef): ChainRuntime {
  const cached = runtimeCache.get(chain.id);
  if (cached) return cached;

  const publicClient = createPublicClient({
    chain: chain.viemChain,
    transport: http(chain.rpcUrl),
  }) as PublicClient;

  const walletClient = operatorAccount
    ? (createWalletClient({
        account: operatorAccount,
        chain: chain.viemChain,
        transport: http(chain.rpcUrl),
      }) as WalletClient)
    : undefined;

  const runtime: ChainRuntime = { ...chain, publicClient, walletClient };
  runtimeCache.set(chain.id, runtime);
  return runtime;
}
