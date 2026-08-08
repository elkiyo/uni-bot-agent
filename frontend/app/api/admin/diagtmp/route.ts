import { NextResponse } from "next/server";
import { getChain, deployedChains } from "@/lib/chains";
import { Store } from "@/lib/keeper/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const chainId = body?.chainId;
  const address = body?.address;
  if (typeof chainId !== "number" || typeof address !== "string") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const chainDef = deployedChains().find((c) => c.id === chainId) ?? getChain(chainId);
  const store = new Store(chainDef.id);
  try {
    const record = await store.getVault(address.toLowerCase());
    const lastProcessedStandard = await store.getLastProcessedBlock("standard");
    const lastProcessedCompound = await store.getLastProcessedBlock("compound").catch(() => null);
    return NextResponse.json({
      ok: true,
      recordFound: Boolean(record),
      record,
      lastProcessedStandard: lastProcessedStandard.toString(),
      lastProcessedCompound: lastProcessedCompound?.toString(),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
