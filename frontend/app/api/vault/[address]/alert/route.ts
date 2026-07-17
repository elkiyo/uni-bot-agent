import { NextResponse } from "next/server";
import { supabase } from "../../../../../lib/keeper/supabaseClient";

export const runtime = "nodejs";

/**
 * Per-vault rebalance alert, derived from the same keeper_unilab_calls audit
 * trail the admin panel already reads (schema.sql) — no new table needed. If
 * the MOST RECENT uni-lab call for this vault failed (ok=false — either a
 * genuine x402/HTTP/network failure, or a 200 with no usable
 * new_upper_bound_with_rlp/new_upper_bound_usd field, see rebalancer.ts),
 * the pool didn't get rebalanced that cycle and the owner needs to know.
 * Clears itself automatically the moment a later call succeeds — no
 * separate "resolved" flag to maintain.
 */
export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  // chainId is optional (older links / callers that predate multichain) —
  // when present, disambiguates in the (astronomically unlikely but not
  // impossible) case the same vault address exists on two different chains.
  const chainId = new URL(request.url).searchParams.get("chainId");
  let query = supabase()
    .from("keeper_unilab_calls")
    .select("endpoint, ok, error, http_status, created_at")
    .eq("vault", address.toLowerCase());
  if (chainId) query = query.eq("chain_id", Number(chainId));
  const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.ok) {
    return NextResponse.json({ alert: null });
  }
  return NextResponse.json({
    alert: {
      message: data.error ?? `uni-lab respondió con estado ${data.http_status}`,
      endpoint: data.endpoint as string,
      createdAt: data.created_at as string,
    },
  });
}
