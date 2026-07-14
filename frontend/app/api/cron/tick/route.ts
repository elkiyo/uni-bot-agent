import { NextResponse } from "next/server";
import { runTick } from "../../../../lib/keeper/tick";

export const runtime = "nodejs";
// Hobby plan default+max is 300s with Fluid compute — a tick over a handful of
// vaults (a few RPC reads + at most a couple of tx confirmations) fits well
// inside this, but stays generous so a slow Celo RPC round-trip doesn't 504.
export const maxDuration = 120;

/**
 * Triggered every 5 minutes by a GitHub Actions schedule (see
 * .github/workflows/keeper-cron.yml) rather than Vercel's own Cron Jobs,
 * which on the Hobby plan only fire once a day — see SCALING.md for why.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runTick();
    return NextResponse.json(summary);
  } catch (err) {
    console.error("tick failed", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
