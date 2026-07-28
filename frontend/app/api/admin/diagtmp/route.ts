import { NextResponse } from "next/server";
import { Store } from "@/lib/keeper/store";
import { rcRlpRebalanceViaX402 } from "@/lib/keeper/unilab";

// ONE-OFF: real paid query to uni-lab.xyz (x402, operator's own USDC) for a
// hypothetical "periodic-pin" rebalance quote on vault 0x55CB44A1...947D19 —
// A1/B1/C1/D1 pre-computed and verified against real on-chain state (see
// conversation). Delete this route right after use.
const VAULT = "0x55CB44A17602F885a2f947281cCFDa72A2947D19";
const CHAIN_ID = 42161;

export async function GET() {
  const store = new Store(CHAIN_ID);
  const record = await store.getVault(VAULT);
  if (!record?.uniLabApiKey) {
    return NextResponse.json({ error: "no uniLabApiKey on record for this vault" }, { status: 400 });
  }

  const params = {
    currentLiquidityUsd: 97.81, // A1
    amountToRecoverUsd: 100.271304, // B1
    currentPriceVolatileAsset: 1875.3, // C1
    newLowerBound: 1861.29, // D1 — existing floor, periodic-pin scenario
    reinvestmentAmountUsd: 0, // E1 — periodic never reinjects
  };

  try {
    const resp = await rcRlpRebalanceViaX402(record.uniLabApiKey, params, VAULT, CHAIN_ID);
    return NextResponse.json({ params, response: resp });
  } catch (err) {
    return NextResponse.json({ params, error: String(err) }, { status: 500 });
  }
}
