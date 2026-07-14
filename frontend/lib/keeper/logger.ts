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
 * design revolves around (PLAN.md), so keeping every request/response pair
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
