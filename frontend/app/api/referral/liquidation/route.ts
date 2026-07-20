import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { getSession } from "@/lib/auth/getSession";
import { insertLiquidation } from "@/lib/referrals/db";

/**
 * No automatic commission calculation — the admin decides an amount, pays it
 * OUTSIDE this system (normal wallet / multisig transfer), and records it
 * here purely as auditable evidence (amount, token, chain, tx_hash).
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: "unauthorized" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const { referrer, amount, tokenSymbol, chainId, chainName, txHash, notes } = body ?? {};

  if (
    typeof referrer !== "string" ||
    !isAddress(referrer) ||
    typeof amount !== "string" ||
    !amount ||
    typeof tokenSymbol !== "string" ||
    !tokenSymbol ||
    typeof chainId !== "number" ||
    typeof chainName !== "string" ||
    !chainName ||
    typeof txHash !== "string" ||
    !txHash
  ) {
    return NextResponse.json({ error: "missing_or_invalid_fields" }, { status: 400 });
  }

  const result = await insertLiquidation({
    referrer,
    amount,
    tokenSymbol,
    chainId,
    chainName,
    txHash,
    notes: typeof notes === "string" && notes ? notes : null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
