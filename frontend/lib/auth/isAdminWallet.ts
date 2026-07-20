import "server-only";
import { deployedChains } from "../chains";
import { getChainRuntime } from "../keeper/wallet";
import { platformConfigAbi } from "../contracts";

/**
 * Server-side counterpart to app/admin/page.tsx's client-side
 * `isPlatformOwner` check (PlatformConfig.owner() === connected wallet).
 * There is still no DB/env admin flag anywhere in this project — "admin" is,
 * and stays, whoever owns PlatformConfig on-chain — this just re-derives the
 * same fact from the server so money-moving endpoints (referral liquidation,
 * admin overview) don't have to trust a client-supplied flag.
 */
export async function isAdminWallet(wallet: `0x${string}`): Promise<boolean> {
  const results = await Promise.all(
    deployedChains().map(async (chain) => {
      if (!chain.platformConfigAddress) return false;
      try {
        const owner = await getChainRuntime(chain).publicClient.readContract({
          address: chain.platformConfigAddress,
          abi: platformConfigAbi,
          functionName: "owner",
        });
        return typeof owner === "string" && owner.toLowerCase() === wallet.toLowerCase();
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}
