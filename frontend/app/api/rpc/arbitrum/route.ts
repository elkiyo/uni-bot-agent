export const runtime = "nodejs";

/**
 * Server-side proxy for Arbitrum JSON-RPC calls — keeps the RPC provider's
 * API key (ARBITRUM_CLIENT_RPC_URL, server-only env var — currently Alchemy)
 * out of the browser bundle entirely. The client (see wagmi.ts's transports)
 * points its Arbitrum viem transport at this same-origin route instead of
 * the provider directly; this just forwards the JSON-RPC body verbatim and
 * relays the response back.
 *
 * Same-origin also incidentally sidesteps the arb1.arbitrum.io CORS
 * flakiness that motivated the original public-RPC fallback (see wagmi.ts).
 *
 * Deliberately a SEPARATE env var from ARBITRUM_RPC_URL (lib/chains.ts's
 * server-side rpcUrl, used by the keeper/indexer for their own
 * eth_getLogs-heavy scans — see lib/dashboard/indexer.ts) — confirmed in
 * production 2026-07-24 that sharing one var between them is a real cost
 * bug, not just a naming nitpick: pointing ARBITRUM_RPC_URL at the public
 * RPC (needed for the indexer's large getLogs ranges, which Alchemy's free
 * tier caps at 10 blocks) silently ALSO redirected every live client read
 * through this proxy onto that same public, rate-limited endpoint, which
 * measurably drove up request volume (and Vercel's billed function
 * invocations/observability events) once real traffic hit it — this proxy's
 * own multicall/eth_call traffic never needed the large-range getLogs
 * headroom in the first place, so it has no reason to share the indexer's
 * RPC choice.
 */
export async function POST(req: Request): Promise<Response> {
  const upstream = process.env.ARBITRUM_CLIENT_RPC_URL || process.env.ARBITRUM_RPC_URL;
  if (!upstream) {
    return Response.json({ error: "ARBITRUM_CLIENT_RPC_URL not configured" }, { status: 500 });
  }

  const body = await req.text();
  const upstreamRes = await fetch(upstream, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await upstreamRes.text();
  return new Response(text, {
    status: upstreamRes.status,
    headers: { "Content-Type": "application/json" },
  });
}
