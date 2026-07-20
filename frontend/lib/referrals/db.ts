import "server-only";
import { supabase } from "../keeper/supabaseClient";

export interface ReferralRow {
  id: number;
  referrer: string;
  referred: string;
  created_at: string;
  activated_at: string | null;
}

export interface ReferralLiquidationRow {
  id: number;
  referrer: string;
  amount: string;
  token_symbol: string;
  chain_id: number;
  chain_name: string;
  tx_hash: string;
  notes: string | null;
  created_at: string;
}

// Postgres unique_violation — see referrals_referred_unique in schema.sql.
const UNIQUE_VIOLATION = "23505";

/**
 * Idempotent: a wallet that already has a referrer keeps its original one
 * (constraint enforced in DB, not here) — a repeat call just reports
 * `alreadyReferred: true` instead of erroring, since the client can't tell
 * in advance whether this is the visitor's first login.
 */
export async function insertReferral(
  referrer: string,
  referred: string,
): Promise<{ ok: true; alreadyReferred: boolean } | { ok: false; error: string }> {
  const { error } = await supabase()
    .from("referrals")
    .insert({ referrer: referrer.toLowerCase(), referred: referred.toLowerCase() });
  if (!error) return { ok: true, alreadyReferred: false };
  if (error.code === UNIQUE_VIOLATION) return { ok: true, alreadyReferred: true };
  return { ok: false, error: error.message };
}

export async function getReferralByReferred(referred: string): Promise<ReferralRow | null> {
  const { data } = await supabase()
    .from("referrals")
    .select("*")
    .eq("referred", referred.toLowerCase())
    .maybeSingle();
  return (data as ReferralRow | null) ?? null;
}

export async function getReferralsByReferrer(referrer: string): Promise<ReferralRow[]> {
  const { data } = await supabase()
    .from("referrals")
    .select("*")
    .eq("referrer", referrer.toLowerCase())
    .order("created_at", { ascending: false });
  return (data as ReferralRow[] | null) ?? [];
}

export async function activateReferral(referred: string): Promise<void> {
  await supabase()
    .from("referrals")
    .update({ activated_at: new Date().toISOString() })
    .eq("referred", referred.toLowerCase())
    .is("activated_at", null);
}

export async function insertLiquidation(row: {
  referrer: string;
  amount: string;
  tokenSymbol: string;
  chainId: number;
  chainName: string;
  txHash: string;
  notes: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase()
    .from("referral_liquidations")
    .insert({
      referrer: row.referrer.toLowerCase(),
      amount: row.amount,
      token_symbol: row.tokenSymbol,
      chain_id: row.chainId,
      chain_name: row.chainName,
      tx_hash: row.txHash,
      notes: row.notes,
    });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function getLiquidationsByReferrer(referrer: string): Promise<ReferralLiquidationRow[]> {
  const { data } = await supabase()
    .from("referral_liquidations")
    .select("*")
    .eq("referrer", referrer.toLowerCase())
    .order("created_at", { ascending: false });
  return (data as ReferralLiquidationRow[] | null) ?? [];
}

export interface ReferrerOverviewRow {
  referrer: string;
  totalReferred: number;
  activeCount: number;
  lastReferredAt: string;
  liquidatedByToken: Record<string, number>;
}

/**
 * DB-only aggregation for the admin overview table (see promt_sis_ref.md §5:
 * "carga primero el overview (rápido, solo DB)") — per-row on-chain volume
 * is fetched separately, in parallel, from the client.
 */
export async function getReferralOverview(): Promise<ReferrerOverviewRow[]> {
  const [{ data: referrals }, { data: liquidations }] = await Promise.all([
    supabase().from("referrals").select("referrer, referred, created_at, activated_at"),
    supabase().from("referral_liquidations").select("referrer, amount, token_symbol"),
  ]);

  const byReferrer = new Map<string, ReferrerOverviewRow>();
  for (const r of (referrals as ReferralRow[] | null) ?? []) {
    const key = r.referrer.toLowerCase();
    const row = byReferrer.get(key) ?? {
      referrer: key,
      totalReferred: 0,
      activeCount: 0,
      lastReferredAt: r.created_at,
      liquidatedByToken: {},
    };
    row.totalReferred += 1;
    if (r.activated_at) row.activeCount += 1;
    if (r.created_at > row.lastReferredAt) row.lastReferredAt = r.created_at;
    byReferrer.set(key, row);
  }

  for (const l of (liquidations as Pick<ReferralLiquidationRow, "referrer" | "amount" | "token_symbol">[] | null) ??
    []) {
    const key = l.referrer.toLowerCase();
    const row = byReferrer.get(key);
    if (!row) continue;
    row.liquidatedByToken[l.token_symbol] = (row.liquidatedByToken[l.token_symbol] ?? 0) + Number(l.amount);
  }

  return [...byReferrer.values()].sort((a, b) => b.totalReferred - a.totalReferred);
}
