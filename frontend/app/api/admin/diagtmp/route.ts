import { NextResponse } from "next/server";
import { Store } from "@/lib/keeper/store";
import { rcRlpRebalanceViaX402 } from "@/lib/keeper/unilab";

// ONE-OFF: real paid query to uni-lab.xyz (x402, operator's own USDC) for a
// hypothetical "out-of-range-bottom" rebalance quote on vault
// 0x55CB44A1...947D19 — simplified this time: ALL new capital entering this
// cycle (pending investable top-up + reserve reinjection) folded directly
// into A1, E1 sent as 0 (uses uni-lab's RC module instead of RLP). See
// conversation for the full derivation. Delete this route right after use.
const VAULT = "0x55CB44A17602F885a2f947281cCFDa72A2947D19";
const CHAIN_ID = 42161;

export async function GET() {
  const store = new Store(CHAIN_ID);
  const record = await store.getVault(VAULT);
  if (!record?.uniLabApiKey) {
    return NextResponse.json({ error: "no uniLabApiKey on record for this vault" }, { status: 400 });
  }

  const params = {
    currentLiquidityUsd: 168.63, // A1 — old position + pending investable + reserve, all folded in
    amountToRecoverUsd: 175.52, // B1
    currentPriceVolatileAsset: 1786.53, // C1 — price at the lower bound
    newLowerBound: 1697.2, // D1
    reinvestmentAmountUsd: 0, // E1 — simplified, not sent separately this time
  };

  try {
    const resp = await rcRlpRebalanceViaX402(record.uniLabApiKey, params, VAULT, CHAIN_ID);
    return NextResponse.json({ params, response: resp });
  } catch (err) {
    return NextResponse.json({ params, error: String(err) }, { status: 500 });
  }
}
