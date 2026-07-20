import "server-only";

interface Bucket {
  count: number;
  windowStart: number;
}

// In-memory, best-effort — same caveat as incrementalLogScan.ts's cursor
// Map: doesn't persist across serverless instances/cold starts, but still
// stops a runaway loop from a single warm instance, which is the realistic
// threat for this endpoint (not a distributed attacker).
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { ok: true };
  }
  bucket.count += 1;
  return { ok: bucket.count <= max };
}
