export const runtime = "nodejs";

/**
 * Server-side proxy for Arbitrum JSON-RPC calls — keeps the NodeReal API key
 * (ARBITRUM_RPC_URL, server-only env var) out of the browser bundle entirely.
 * The client (see wagmi.ts's transports) points its Arbitrum viem transport
 * at this same-origin route instead of NodeReal directly; this request just
 * forwards the JSON-RPC body verbatim and relays the response back.
 *
 * Same-origin also incidentally sidesteps the arb1.arbitrum.io CORS
 * flakiness that motivated the original public-RPC fallback (see wagmi.ts).
 */
export async function POST(req: Request): Promise<Response> {
  const upstream = process.env.ARBITRUM_RPC_URL;
  if (!upstream) {
    return Response.json({ error: "ARBITRUM_RPC_URL not configured" }, { status: 500 });
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
