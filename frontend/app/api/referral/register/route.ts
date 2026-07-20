import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { getSession } from "@/lib/auth/getSession";
import { insertReferral } from "@/lib/referrals/db";
import { rateLimit } from "@/lib/referrals/rateLimit";

/**
 * The security-critical endpoint (see Promtp_sis_referrers/promt_sis_ref.md
 * §2): `referred` is ALWAYS taken from the verified session, never from the
 * request body — accepting it from the client is exactly the bug that let
 * P2Pmoney's first version create fake referrals.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!rateLimit(`referral-register:${session.wallet}`, 10, 60_000).ok) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const referrer = body?.referrer;
  const referred = session.wallet; // never from body — see docstring above

  if (typeof referrer !== "string" || !isAddress(referrer)) {
    return NextResponse.json({ error: "invalid_referrer" }, { status: 400 });
  }
  if (referrer.toLowerCase() === referred.toLowerCase()) {
    return NextResponse.json({ error: "cannot_refer_self" }, { status: 400 });
  }

  const result = await insertReferral(referrer, referred);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, alreadyReferred: result.alreadyReferred });
}
