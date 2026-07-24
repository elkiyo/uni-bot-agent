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
