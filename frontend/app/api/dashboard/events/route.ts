import { NextResponse } from "next/server";
import { supabase } from "@/lib/keeper/supabaseClient";

export const runtime = "nodejs";

/**
 * Vault event history for one chain, optionally filtered to a single vault,
 * straight from the indexer's cache — see lib/dashboard/indexer.ts. Replaces
 * the client-side full-history eth_getLogs scan (lib/incrementalLogScan.ts's
 * fetchNewLogs, called from useVaultEventLogs.ts / useProtocolMetrics.ts /
 * mintVolume.ts) that used to run in every visitor's browser on every cold
 * load. `usd_value` is pre-resolved server-side (see indexer.ts) — a mint
 * event (PositionInitialized/Rebalanced) may briefly read back null right
 * after it's first indexed, backfilled within the next tick or two.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chainParam = searchParams.get("chain");
  const address = searchParams.get("address");
  if (!chainParam) {
    return NextResponse.json({ error: "chain query param is required" }, { status: 400 });
  }

  let query = supabase()
    .from("indexed_events")
    .select("*")
    .eq("chain_id", Number(chainParam))
    .order("block_number", { ascending: true })
    .order("log_index", { ascending: true });
  if (address) {
    query = query.eq("address", address.toLowerCase());
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }

  return NextResponse.json(data ?? [], {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300" },
  });
}
