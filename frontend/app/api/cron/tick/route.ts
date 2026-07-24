import { NextResponse } from "next/server";
import { runTick } from "../../../../lib/keeper/tick";
import { runIndexer } from "../../../../lib/dashboard/indexer";

export const runtime = "nodejs";
// Hobby plan default+max is 300s with Fluid compute. A tick now processes
// every deployed chain sequentially within one invocation (see
// lib/keeper/tick.ts) — 120s was sized for a single chain; bumped to leave
// headroom for a second chain's RPC round-trips without approaching the
// 300s ceiling.
export const maxDuration = 200;

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

    // Refreshes the dashboard read-cache (see lib/dashboard/indexer.ts) —
    // piggybacks on this same 5-minute trigger instead of needing its own
    // cron/ops setup. Awaited (not fire-and-forget) because Vercel freezes
    // a serverless function's execution once its response is sent, so
    // anything after `return` here would not reliably run. Its own
    // try/catch means an indexer bug can never fail the actual trading
    // tick above.
    try {
      await runIndexer();
    } catch (err) {
      console.error("indexer failed", err);
    }

    return NextResponse.json(summary);
  } catch (err) {
    console.error("tick failed", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
