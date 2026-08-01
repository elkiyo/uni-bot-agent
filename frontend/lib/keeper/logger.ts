import "server-only";
import { supabase } from "./supabaseClient";

/** Vercel captures stdout per-invocation as the function's logs — this is the
 * production equivalent of the old events.log file (see SCALING.md). */
export function logEvent(event: Record<string, unknown>) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  console.log(line);
}

export interface UniLabCallLog {
  vault: string;
  // Which chain the VAULT lives on (for admin filtering) — not necessarily
  // where the payment itself settled, which is always Celo regardless (see
  // unilab.ts's own docstring). Defaults to Celo for callers that predate
  // multichain support.
  chainId?: number;
  endpoint: string;
  request: Record<string, unknown>;
  httpStatus: number;
  response: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Full audit trail of every uni-lab.xyz query — request body, HTTP status,
 * raw response (or error), and latency. This is the paid API the agent's
 * design revolves around (autorange.md), so keeping every request/response pair
 * is what makes a rebalance decision reconstructable after the fact.
 * Persisted to the keeper_unilab_calls Postgres table (schema.sql) since the
 * function's filesystem doesn't survive invocations.
 */
export async function logUniLabCall(call: UniLabCallLog): Promise<void> {
  console.log(
    `[uni-lab] ${call.endpoint} vault=${call.vault} status=${call.httpStatus} ok=${call.ok} (${call.durationMs}ms)`,
  );
  try {
    const { error } = await supabase()
      .from("keeper_unilab_calls")
      .insert({
        vault: call.vault,
        chain_id: call.chainId ?? 42220,
        endpoint: call.endpoint,
        request: call.request,
        http_status: call.httpStatus,
        response: call.response,
        ok: call.ok,
        duration_ms: call.durationMs,
        error: call.error ?? null,
      });
    if (error) console.error("logUniLabCall: failed to persist to supabase", error);
  } catch (err) {
    // Best-effort: never let audit logging break the keeper tick.
    console.error("logUniLabCall: failed to persist to supabase", err);
  }
}

/**
 * Feeds rebalancer.ts's x402 circuit breaker (see store.ts#setX402CircuitBreakerUntil):
 * counts x402 failures logged via logUniLabCall in the last `windowMs`,
 * across ALL vaults — x402 breaking is a property of uni-lab.xyz's Celo-side
 * facilitator, not any one vault, so this deliberately isn't vault-scoped.
 * Reuses the existing keeper_unilab_calls audit trail instead of a separate
 * counter — no extra write path to keep in sync.
 */
export async function recentX402FailureCount(windowMs: number): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const { count, error } = await supabase()
    .from("keeper_unilab_calls")
    .select("id", { count: "exact", head: true })
    .eq("endpoint", "rc-rlp-rebalance (x402)")
    .eq("ok", false)
    .gte("created_at", since);
  if (error) throw error;
  return count ?? 0;
}
