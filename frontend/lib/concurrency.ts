/**
 * Shared resilience helpers for client-side RPC calls against free, public
 * chain RPCs (forno.celo.org, arb1.arbitrum.io) — no SLA, no dedicated rate
 * limit for this app. Two failure modes matter here: a single call can
 * transiently fail (retry fixes it), and a large burst of concurrent calls
 * can trip a rate limit that a handful wouldn't (bounded concurrency fixes
 * it). Both are used together by getLogsChunked.ts and mintVolume.ts, which
 * is why this is factored out rather than each reimplementing its own.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 400): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/** Maps `items` through `fn`, running at most `concurrency` calls at once —
 * a middle ground between fully sequential (slow) and fully parallel (risks
 * tripping a shared RPC's rate limit with a big burst). */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    batchResults.forEach((r, j) => (results[i + j] = r));
  }
  return results;
}
