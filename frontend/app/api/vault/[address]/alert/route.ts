import { NextResponse } from "next/server";
import { supabase } from "../../../../../lib/keeper/supabaseClient";

export const runtime = "nodejs";

interface AlertPayload {
  type: "rebalanceFailed" | "gasReserveDepleted";
  message: string;
  createdAt: string;
  endpoint?: string;
}

/**
 * Per-vault alerts for the owner, derived from state the keeper already
 * maintains — no new write path, this only reads. Two independent sources,
 * both optional, returned together as a list (a vault can have neither, one,
 * or both at once):
 *
 * - rebalanceFailed: same as before this became a list — the MOST RECENT
 *   uni-lab.xyz call for this vault failed (keeper_unilab_calls audit trail,
 *   schema.sql). Clears itself automatically the moment a later call
 *   succeeds — no separate "resolved" flag to maintain.
 * - gasReserveDepleted: keeper_vaults.gas_reserve_empty_since is set (see
 *   schema.sql and rebalancer.ts's hasEnoughOperatorGas()) — the vault's own
 *   gasReserveBalance can no longer cover the operator's gas cost for
 *   actions on this vault. The vault keeps operating regardless (protecting
 *   owner capital wins over reimbursing the operator), so without this the
 *   owner would have no way to know their reserve ran out and top it up.
 */
export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  // chainId is optional (older links / callers that predate multichain) —
  // when present, disambiguates in the (astronomically unlikely but not
  // impossible) case the same vault address exists on two different chains.
  const chainId = new URL(request.url).searchParams.get("chainId");
  const lower = address.toLowerCase();

  let unilabQuery = supabase()
    .from("keeper_unilab_calls")
    .select("endpoint, ok, error, http_status, created_at")
    .eq("vault", lower);
  if (chainId) unilabQuery = unilabQuery.eq("chain_id", Number(chainId));

  let vaultQuery = supabase().from("keeper_vaults").select("gas_reserve_empty_since").eq("address", lower);
  if (chainId) vaultQuery = vaultQuery.eq("chain_id", Number(chainId));

  const [unilabResult, vaultResult] = await Promise.all([
    unilabQuery.order("created_at", { ascending: false }).limit(1).maybeSingle(),
    vaultQuery.maybeSingle(),
  ]);

  if (unilabResult.error) {
    return NextResponse.json({ error: unilabResult.error.message }, { status: 500 });
  }
  if (vaultResult.error) {
    return NextResponse.json({ error: vaultResult.error.message }, { status: 500 });
  }

  const alerts: AlertPayload[] = [];

  const lastCall = unilabResult.data;
  if (lastCall && !lastCall.ok) {
    alerts.push({
      type: "rebalanceFailed",
      message: lastCall.error ?? `uni-lab respondió con estado ${lastCall.http_status}`,
      endpoint: lastCall.endpoint as string,
      createdAt: lastCall.created_at as string,
    });
  }

  const emptySince = vaultResult.data?.gas_reserve_empty_since as string | null | undefined;
  if (emptySince) {
    alerts.push({ type: "gasReserveDepleted", message: "", createdAt: emptySince });
  }

  return NextResponse.json({ alerts });
}
