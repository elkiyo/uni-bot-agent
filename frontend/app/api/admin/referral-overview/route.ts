import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/getSession";
import { getReferralOverview } from "@/lib/referrals/db";

/**
 * DB-only aggregation, deliberately fast (no on-chain reads) — see
 * Promtp_sis_referrers/promt_sis_ref.md §5: the admin table loads this first,
 * then fetches each row's on-chain volume separately/in parallel from the
 * client via /api/referral/stats so the table isn't blocked on RPC latency.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: "unauthorized" }, { status: 403 });

  const overview = await getReferralOverview();
  return NextResponse.json({ overview });
}
