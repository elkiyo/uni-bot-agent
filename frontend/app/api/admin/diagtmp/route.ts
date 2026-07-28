import { NextResponse } from "next/server";
import { Store } from "@/lib/keeper/store";
import { rcRlpRebalanceViaX402 } from "@/lib/keeper/unilab";

// ONE-OFF: real paid query to uni-lab.xyz (x402, operator's own USDC) for a
// hypothetical "periodic" rebalance quote on vault 0x55CB44A1...947D19 — RC
// method (E1=0), D1 recentered with the vault's REAL recenterMarginBps (2%,
// confirmed on-chain, not the 5% assumed earlier in the conversation). See
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
    currentLiquidityUsd: 74.82, // A1
    amountToRecoverUsd: 75.69, // B1
    currentPriceVolatileAsset: 1915.48, // C1
    newLowerBound: 1877.17, // D1 — 2% below C1
    reinvestmentAmountUsd: 0, // E1 — periodic, no reserve reinjection
  };

  try {
    const resp = await rcRlpRebalanceViaX402(record.uniLabApiKey, params, VAULT, CHAIN_ID);
    return NextResponse.json({ params, response: resp });
  } catch (err) {
    return NextResponse.json({ params, error: String(err) }, { status: 500 });
  }
}
