import { NextResponse } from "next/server";
import { Store } from "@/lib/keeper/store";
import { rcRlpRebalanceViaX402 } from "@/lib/keeper/unilab";

// ONE-OFF: real paid query to uni-lab.xyz (x402, operator's own USDC) for a
// hypothetical owner-forced rebalance (ownerRebalance()) on vault
// 0x7186CE90...4D78c7 — A1/B1/C1/D1 computed by hand against real on-chain
// state and verified against forceRecenter's own formula (see conversation).
// RC method: E1=0, reserve is $0 anyway so nothing to reinject. Delete this
// route right after use.
const VAULT = "0x7186CE90dE92D6B6412eA79b8f3c2964c34D78c7";
const CHAIN_ID = 42161;

export async function GET() {
  const store = new Store(CHAIN_ID);
  const record = await store.getVault(VAULT);
  if (!record?.uniLabApiKey) {
    return NextResponse.json({ error: "no uniLabApiKey on record for this vault" }, { status: 400 });
  }

  const params = {
    currentLiquidityUsd: 512.8449, // A1 — position principal + idle WETH dust
    amountToRecoverUsd: 511.978018, // B1
    currentPriceVolatileAsset: 1918.6372, // C1
    newLowerBound: 1880.2645, // D1 — recentered via recenterMarginBps (2%), forceRecenter-style
    reinvestmentAmountUsd: 0, // E1 — reserve is $0
  };

  try {
    const resp = await rcRlpRebalanceViaX402(record.uniLabApiKey, params, VAULT, CHAIN_ID);
    return NextResponse.json({ params, response: resp });
  } catch (err) {
    return NextResponse.json({ params, error: String(err) }, { status: 500 });
  }
}
