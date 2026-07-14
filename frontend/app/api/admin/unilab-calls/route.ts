import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/keeper/supabaseClient";

export const runtime = "nodejs";

/**
 * Read-only feed of the uni-lab.xyz call audit trail (see
 * lib/keeper/logger.ts#logUniLabCall / schema.sql#keeper_unilab_calls) for the
 * admin panel. Intentionally unauthenticated: the stored rows are request/
 * response bodies, HTTP status, and tx hashes — no api_keys or private keys
 * ever pass through this table — so the only thing gating this endpoint is
 * that it's linked from a page which itself checks PlatformConfig.owner()
 * client-side. Revisit if this ever needs to carry anything sensitive.
 */
export async function GET() {
  const { data, error } = await supabase()
    .from("keeper_unilab_calls")
    .select("id, vault, endpoint, http_status, ok, duration_ms, request, response, error, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ calls: data });
}
