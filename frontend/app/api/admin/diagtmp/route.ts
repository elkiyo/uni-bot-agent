import { NextResponse } from "next/server";
import { Store } from "@/lib/keeper/store";
import { rcRlpRebalanceViaX402 } from "@/lib/keeper/unilab";

// ONE-OFF: two real paid queries to uni-lab.xyz (x402, operator's own USDC)
// for vault 0x55CB44A1...947D19 — same underlying scenario (out-of-range-
// bottom, pending investable + reserve reinjecting), parametrized two ways
// to check whether both converge to the same new_upper_bound:
//   RLP: A1=old position only, B1=historical only, E1=new capital this cycle
//   RC:  A1=old position+new capital, B1=historical+new capital, E1=0
// Delete this route right after use.
const VAULT = "0x55CB44A17602F885a2f947281cCFDa72A2947D19";
const CHAIN_ID = 42161;

export async function GET() {
  const store = new Store(CHAIN_ID);
  const record = await store.getVault(VAULT);
  if (!record?.uniLabApiKey) {
    return NextResponse.json({ error: "no uniLabApiKey on record for this vault" }, { status: 400 });
  }

  const rlpParams = {
    currentLiquidityUsd: 113.62,
    amountToRecoverUsd: 120.511832,
    currentPriceVolatileAsset: 1786.53,
    newLowerBound: 1697.2,
    reinvestmentAmountUsd: 55.011683,
  };

  const rcParams = {
    currentLiquidityUsd: 168.631683,
    amountToRecoverUsd: 175.523515,
    currentPriceVolatileAsset: 1786.53,
    newLowerBound: 1697.2,
    reinvestmentAmountUsd: 0,
  };

  try {
    const rlpResp = await rcRlpRebalanceViaX402(record.uniLabApiKey, rlpParams, VAULT, CHAIN_ID);
    const rcResp = await rcRlpRebalanceViaX402(record.uniLabApiKey, rcParams, VAULT, CHAIN_ID);
    return NextResponse.json({ rlpParams, rlpResp, rcParams, rcResp });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
