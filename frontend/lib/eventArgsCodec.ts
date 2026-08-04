import type { Abi } from "viem";

/**
 * JSON (and therefore Postgres jsonb) can't hold a bigint — every bigint
 * value in a parsed event's `args` gets stringified before it's written to
 * indexed_events.args. Recurses so a struct-typed arg (a tuple/array field)
 * doesn't silently keep an un-serializable bigint nested inside it.
 */
export function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(args, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

/**
 * Inverse of serializeArgs — walks the event's own ABI definition and
 * converts every uintN/intN-typed top-level field back from its stringified
 * form to a real bigint, so a consumer that expects viem's normal
 * parseEventLogs shape (real bigints, not strings) keeps working unchanged
 * against data that came from the indexed_events cache instead of a live
 * RPC log. None of this platform's own events emit a struct/tuple-typed
 * argument (SwapInstruction et al. are only ever function inputs, never
 * indexed as event args), so only top-level fields need handling.
 */
export function deserializeArgs(abi: Abi, eventName: string, raw: Record<string, unknown>): Record<string, unknown> {
  const eventDef = abi.find((item) => item.type === "event" && item.name === eventName) as
    | { inputs: readonly { name: string; type: string }[] }
    | undefined;
  if (!eventDef) return raw;

  const result: Record<string, unknown> = { ...raw };
  for (const input of eventDef.inputs) {
    const value = result[input.name];
    if (/^u?int\d*$/.test(input.type) && typeof value === "string") {
      result[input.name] = BigInt(value);
    }
  }
  return result;
}

/**
 * `(args.x as bigint | undefined) ?? 0n` is a compile-time-only assertion —
 * it does NOT coerce at runtime. When an event isn't declared on the ABI
 * passed to useVaultEventLogs, deserializeArgs above returns raw (still
 * stringified) args, so a numeric field can arrive as a non-nullish STRING
 * that slips straight past that `?? 0n` fallback. VaultDetail.tsx's own
 * vaultIsCompoundContract race (see that file's own docstring) means every
 * compound-only-event consumer on that page CAN render at least once with
 * the standard ABI before the async compound probe resolves — confirmed
 * live, 2026-08-04: useVaultCumulativeInvestment's `total` silently became
 * a string via `bigint += string` (JS coerces via concatenation instead of
 * throwing), and the crash only surfaced later at VaultDetail.tsx's
 * `formatUnits(cumulativeInvestmentRaw, ...)`, far from the real cause.
 * Every consumer of a possibly-not-on-this-ABI event field should coerce
 * through this instead of trusting the assertion.
 */
export function toBigIntSafe(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && v !== "") {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  return 0n;
}
