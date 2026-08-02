import { NextResponse } from "next/server";
import type { Address } from "viem";
import { getChain, deployedChains } from "@/lib/chains";
import { getChainRuntime } from "@/lib/keeper/wallet";
import { vaultContract } from "@/lib/keeper/serverContracts";
import { Store } from "@/lib/keeper/store";
import { computeOwnerRebalanceParams } from "@/lib/keeper/rebalancer";
import { isCompoundBetaWallet } from "@/lib/compoundBeta";

export const runtime = "nodejs";
// uni-lab's x402 round-trip (same call the keeper itself makes) can take a
// few seconds — same order of magnitude as the cron tick, generous headroom.
export const maxDuration = 60;

/**
 * Computes ownerRebalance() parameters for a compound (V2) vault — paid via
 * the operator's own x402 wallet, exactly like every keeper-triggered
 * rebalance (see rebalancer.ts's computeOwnerRebalanceParams, which this
 * just wraps) — and hands them back for the vault's OWNER to sign
 * ownerRebalance() themselves, paying their own gas. No vault state changes
 * here; the only real side effect is the operator's own x402 spend.
 *
 * Gated the same way the entire compound-vault beta already is client-side
 * (isCompoundBetaWallet) — not a cryptographic proof of wallet control
 * (there's no SIWE session wired into this page), but the actual funds-
 * safety boundary is on-chain regardless: ownerRebalance() itself is
 * onlyOwner, so nothing this endpoint returns is usable by anyone but the
 * real owner's wallet. This gate exists only to stop random callers from
 * burning the operator's x402 budget on someone else's vault.
 */
export async function POST(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const body = await request.json().catch(() => null);
  const chainId = body?.chainId;
  const owner = body?.owner;
  if (typeof chainId !== "number" || typeof owner !== "string") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!isCompoundBetaWallet(owner)) {
    return NextResponse.json({ error: "not_authorized" }, { status: 403 });
  }

  const chainDef = deployedChains().find((c) => c.id === chainId) ?? getChain(chainId);
  if (!chainDef.compoundVaultAbi) {
    return NextResponse.json({ error: "chain_has_no_compound_vaults" }, { status: 400 });
  }

  const vaultAddress = address as Address;
  const chain = getChainRuntime(chainDef);

  // The allowlist check above only established "this address IS the beta
  // wallet" — confirm it's also THIS vault's real on-chain owner before
  // spending anything, so a mismatched vault/owner pair fails with a clear
  // error instead of silently computing parameters for someone else's vault
  // (harmless either way — ownerRebalance() itself is onlyOwner — but a
  // confusing dead end for the caller otherwise).
  const vault = vaultContract(chain, vaultAddress, chainDef.compoundVaultAbi);
  let realOwner: Address;
  try {
    realOwner = (await vault.read.owner()) as Address;
  } catch {
    return NextResponse.json({ error: "vault_not_found" }, { status: 404 });
  }
  if (realOwner.toLowerCase() !== owner.toLowerCase()) {
    return NextResponse.json({ error: "not_owner" }, { status: 403 });
  }

  const store = new Store(chain.id);
  const result = await computeOwnerRebalanceParams(chain, vaultAddress, store, chainDef.compoundVaultAbi);
  if (!result.ok) {
    return NextResponse.json({ error: "no_usable_range" }, { status: 502 });
  }

  return NextResponse.json({
    newTickLower: result.newTickLower,
    newTickUpper: result.newTickUpper,
    swapIx: {
      token0ToToken1: result.swapIx.token0ToToken1,
      amountIn: result.swapIx.amountIn.toString(),
      amountOutMinimum: result.swapIx.amountOutMinimum.toString(),
      fee: result.swapIx.fee,
    },
    reinjectAmount: result.reinjectAmount.toString(),
    feePayoutSwapIx: {
      token0ToToken1: result.feePayoutSwapIx.token0ToToken1,
      amountIn: result.feePayoutSwapIx.amountIn.toString(),
      amountOutMinimum: result.feePayoutSwapIx.amountOutMinimum.toString(),
      fee: result.feePayoutSwapIx.fee,
    },
  });
}
