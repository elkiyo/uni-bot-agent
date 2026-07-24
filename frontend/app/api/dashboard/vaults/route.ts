import { NextResponse } from "next/server";
import { getIndexedVaults } from "@/lib/dashboard/indexedVaultsRepo";

export const runtime = "nodejs";

/**
 * Vault directory (VaultCreated history) for one chain, straight from the
 * indexer's cache — see lib/dashboard/indexer.ts. Replaces the client-side
 * full-history eth_getLogs scan that used to run in every visitor's browser
 * on every cold load of the Vault/Dashboard pages (lib/dashboard/
 * vaultDirectory.ts). Cached at the edge for a minute since the indexer
 * itself only refreshes once per keeper tick (~5 min) — refetching sooner
 * than that from a page's own polling would only ever return the same rows.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chainParam = searchParams.get("chain");
  if (!chainParam) {
    return NextResponse.json({ error: "chain query param is required" }, { status: 400 });
  }

  try {
    const vaults = await getIndexedVaults(Number(chainParam));
    return NextResponse.json(vaults, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
