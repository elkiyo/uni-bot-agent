import { NextResponse } from "next/server";
import { supabase } from "@/lib/keeper/supabaseClient";

export const runtime = "nodejs";

// PostgREST (Supabase's REST layer) caps every response at this many rows
// by default (db-max-rows) regardless of how many actually match the
// query — confirmed in production 2026-07-25: this route silently returned
// exactly 1000 rows for a vault list whose real indexed_events count had
// already grown past that, making the Dashboard's aggregated totals
// (Volumen movido, Capital depositado, Comisiones) undercount with no
// error or signal that anything was missing. Paginated in PAGE_SIZE-row
// pages via .range() until a short page confirms there's nothing left.
const PAGE_SIZE = 1000;

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

  const chainId = Number(chainParam);
  const allRows: Record<string, unknown>[] = [];
  for (let page = 0; ; page++) {
    let query = supabase()
      .from("indexed_events")
      .select("*")
      .eq("chain_id", chainId)
      .order("block_number", { ascending: true })
      .order("log_index", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (address) {
      query = query.eq("address", address.toLowerCase());
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: String(error) }, { status: 500 });
    }
    allRows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return NextResponse.json(allRows, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300" },
  });
}
