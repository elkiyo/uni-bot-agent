import { NextResponse } from "next/server";
import type { Address } from "viem";
import { getChain, deployedChains } from "@/lib/chains";
import { getChainRuntime } from "@/lib/keeper/wallet";
import { Store } from "@/lib/keeper/store";
import { computeOwnerRebalanceParams } from "@/lib/keeper/rebalancer";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const chainId = body?.chainId;
  const address = body?.address;
  if (typeof chainId !== "number" || typeof address !== "string") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const chainDef = deployedChains().find((c) => c.id === chainId) ?? getChain(chainId);
  if (!chainDef.compoundVaultAbi) {
    return NextResponse.json({ error: "chain_has_no_compound_vaults" }, { status: 400 });
  }
  const chain = getChainRuntime(chainDef);
  const store = new Store(chain.id);
  try {
    const result = await computeOwnerRebalanceParams(chain, address as Address, store, chainDef.compoundVaultAbi);
    return NextResponse.json({ ok: true, result: JSON.parse(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error ? err.stack : undefined,
      errorName: err instanceof Error ? err.name : undefined,
    });
  }
}
