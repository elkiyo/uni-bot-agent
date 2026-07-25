import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/keeper/supabaseClient";

export const runtime = "nodejs";

/**
 * Read-only feed of every vault the keeper currently finds unable to cover
 * its own gas reimbursement (gas_reserve_empty_since not null — see
 * schema.sql and rebalancer.ts's hasEnoughOperatorGas()). The vault itself
 * keeps operating either way (protecting owner capital wins over reimbursing
 * the operator, see PLAN.md), so without this feed the operator silently
 * eats the gas cost of every action on these vaults with zero visibility.
 * Unauthenticated for the same reason /api/admin/unilab-calls is: nothing
 * sensitive in this table, gated client-side by the admin page's own
 * PlatformConfig.owner() check.
 */
export async function GET() {
  const { data, error } = await supabase()
    .from("keeper_vaults")
    .select("chain_id, address, kind, gas_reserve_empty_since")
    .not("gas_reserve_empty_since", "is", null)
    .order("gas_reserve_empty_since", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ vaults: data });
}
