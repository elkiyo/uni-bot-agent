import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { getSession } from "@/lib/auth/getSession";
import { getReferralsByReferrer, getLiquidationsByReferrer, activateReferral } from "@/lib/referrals/db";
import { fetchReferredVolume, type ReferredVolume } from "@/lib/referrals/volume";
import { deployedChains } from "@/lib/chains";
import { getChainRuntime } from "@/lib/keeper/wallet";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const referrer = new URL(req.url).searchParams.get("referrer");
  if (!referrer || !isAddress(referrer)) {
    return NextResponse.json({ error: "invalid_referrer" }, { status: 400 });
  }
  if (!session.isAdmin && session.wallet.toLowerCase() !== referrer.toLowerCase()) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [referrals, liquidations] = await Promise.all([
    getReferralsByReferrer(referrer),
    getLiquidationsByReferrer(referrer),
  ]);

  const chains = deployedChains();
  const enriched = await Promise.all(
    referrals.map(async (r) => {
      const referred = r.referred as `0x${string}`;
      const volumeByChain: ReferredVolume[] = await Promise.all(
        chains.map((chain) => fetchReferredVolume(getChainRuntime(chain).publicClient, chain, referred)),
      );
      if (!r.activated_at && volumeByChain.some((v) => v.hasDeposit)) {
        await activateReferral(referred);
        r.activated_at = new Date().toISOString();
      }
      return { ...r, volumeByChain };
    }),
  );

  const grandTotalByToken: Record<string, number> = {};
  for (const r of enriched) {
    for (const v of r.volumeByChain) {
      grandTotalByToken[v.tokenSymbol] = (grandTotalByToken[v.tokenSymbol] ?? 0) + v.totalDeposited;
    }
  }

  return NextResponse.json({
    referrals: enriched,
    liquidations,
    grandTotalByToken,
    activeCount: enriched.filter((r) => r.activated_at).length,
    totalCount: enriched.length,
  });
}
