import { NextResponse } from "next/server";
import { Store } from "@/lib/keeper/store";
import { rcRlpRebalanceViaX402 } from "@/lib/keeper/unilab";

// ONE-OFF: real paid query to uni-lab.xyz (x402, operator's own USDC) for a
// hypothetical "out-of-range-bottom" rebalance quote on vault
// 0x55CB44A1...947D19 — A1 evaluated AT the position's real lower bound
// (100% WETH, not today's live price), B1 including this cycle's $25
// reserve reinjection (E1), D1 recentered 5% below that same lower-bound
// price. Verified against real on-chain state (see conversation). Delete
// this route right after use.
const VAULT = "0x55CB44A17602F885a2f947281cCFDa72A2947D19";
const CHAIN_ID = 42161;

export async function GET() {
  const store = new Store(CHAIN_ID);
  const record = await store.getVault(VAULT);
  if (!record?.uniLabApiKey) {
    return NextResponse.json({ error: "no uniLabApiKey on record for this vault" }, { status: 400 });
  }

  const params = {
    currentLiquidityUsd: 113.51, // A1 — closed position's value at its own lower bound
    amountToRecoverUsd: 145.373482, // B1 — includes this cycle's $25 reinjection
    currentPriceVolatileAsset: 1786.53, // C1 — price AT the lower bound, not today's live price
    newLowerBound: 1697.2, // D1 — 5% below that same lower-bound price
    reinvestmentAmountUsd: 25, // E1
  };

  try {
    const resp = await rcRlpRebalanceViaX402(record.uniLabApiKey, params, VAULT, CHAIN_ID);
    return NextResponse.json({ params, response: resp });
  } catch (err) {
    return NextResponse.json({ params, error: String(err) }, { status: 500 });
  }
}
