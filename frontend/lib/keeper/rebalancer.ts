import "server-only";
import type { Abi, Address } from "viem";
import { publicClient, operatorAccount } from "./wallet";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi, sendTaggedTx } from "./serverContracts";
import { rcRlpRebalance, getPricing } from "./unilab";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "../priceMath";
import { estimatePositionAmounts, sizeInitialSwap, sizeRebalanceSwap } from "./swapMath";
import { POOL } from "../addresses";
import { Store } from "./store";
import { logEvent } from "./logger";
import { rangeVaultAbi } from "../contracts";

async function currentTick(): Promise<number> {
  const [, tick] = (await publicClient.readContract({
    address: POOL,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, number, number, number, number, boolean];
  return tick;
}

async function tickSpacing(): Promise<number> {
  return (await publicClient.readContract({
    address: POOL,
    abi: uniswapV3PoolAbi,
    functionName: "tickSpacing",
  })) as number;
}

/**
 * Pays uni-lab.xyz (a real on-chain USDT transfer from the vault's own budget —
 * see PLAN.md) and waits for the confirmation the API requires as proof of
 * payment before it will answer. Queries the live price first — uni-lab's
 * pricing isn't fixed (confirmed 2026-07-14: a hardcoded 0.5 USDT 402'd
 * against a real 0.2 USDT price), so this never assumes a number.
 */
async function payUniLabAndGetTxHash(vaultAddress: Address): Promise<{ hash: `0x${string}`; amountRaw: bigint }> {
  const pricing = await getPricing();
  const amountRaw = BigInt(Math.round(pricing.price_usdt * 1e6));
  const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "payUniLabFee", [amountRaw]);
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, amountRaw };
}

/**
 * Dry-runs a vault call as the operator, WITHOUT sending anything. Used as a
 * gate before payUniLabFee: the payment is real money out of the vault's budget,
 * and if the follow-up operation would revert anyway (as happened with the
 * inverted-ticks vault — 10 cycles burned the entire 5 USDT budget on payments
 * whose calculations could never be used), paying first is throwing money away.
 */
async function wouldSucceed(
  vaultAddress: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<boolean> {
  try {
    await publicClient.simulateContract({
      address: vaultAddress,
      abi: rangeVaultAbi as Abi,
      functionName,
      args: args as unknown[],
      account: operatorAccount?.address,
    });
    return true;
  } catch {
    return false;
  }
}

export async function runInitPosition(vaultAddress: Address, store: Store): Promise<void> {
  const record = await store.getVault(vaultAddress);
  // No uni-lab dependency here anymore (see below) — a vault can build its
  // initial position even before its uni-lab registration lands. Rebalances
  // still require the api_key, checked separately in runRebalance.
  if (!record) {
    logEvent({ level: "error", vault: vaultAddress, msg: "vault not found in store, skipping initPosition" });
    return;
  }

  const vault = vaultContract(vaultAddress);
  const [targetTickLower, targetTickUpper, investableUsdt] = await Promise.all([
    vault.read.targetTickLower() as Promise<number>,
    vault.read.targetTickUpper() as Promise<number>,
    vault.read.investableUsdt() as Promise<bigint>,
  ]);

  const tick = await currentTick();
  const ethPrice = ethPriceFromTick(tick);

  // Sized entirely locally — the standard Uniswap V3 balanced-deposit ratio
  // for [tickLower, tickUpper] at the current price. Used to call uni-lab's
  // /pool-setup-initial here too, paid out of the vault's own budget, but
  // that response was never actually used (it only got logged) even when it
  // succeeded — this same formula was always what got sent. Paying for a
  // consultation whose answer is discarded either way is a real cost to the
  // owner for zero benefit, so initPosition no longer calls uni-lab at all;
  // only rebalance() does, where the API's answer (the new upper bound)
  // genuinely drives the outcome. See PLAN.md.
  const swapIx = sizeInitialSwap({
    currentTick: tick,
    tickLower: targetTickLower,
    tickUpper: targetTickUpper,
    availableToken0Raw: investableUsdt,
    ethPriceUsd: ethPrice,
  });

  const initArgs = [
    { token0ToToken1: swapIx.token0ToToken1, amountIn: swapIx.amountIn, amountOutMinimum: 0n },
    0n,
    0n,
  ] as const;

  if (!(await wouldSucceed(vaultAddress, "initPosition", initArgs))) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "initPosition simulation reverts — skipping cycle (check vault config)",
    });
    return;
  }

  const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "initPosition", initArgs);
  await publicClient.waitForTransactionReceipt({ hash });

  await store.upsertVault({ ...record, positionInitialized: true });
  logEvent({ level: "info", vault: vaultAddress, msg: "position initialized", txHash: hash });
}

export async function runRebalance(vaultAddress: Address, store: Store, reason: string): Promise<void> {
  const record = await store.getVault(vaultAddress);
  if (!record?.uniLabApiKey) {
    logEvent({ level: "error", vault: vaultAddress, msg: "no uni-lab api key on record, skipping rebalance" });
    return;
  }

  const vault = vaultContract(vaultAddress);
  const [positionTokenId, reinjectionCap, positionManager, reserveBalance] = await Promise.all([
    vault.read.positionTokenId() as Promise<bigint>,
    vault.read.reinjectionAmount() as Promise<bigint>, // owner's per-cycle ceiling — see RangeVault.sol
    vault.read.positionManager() as Promise<Address>,
    vault.read.reserveBalance() as Promise<bigint>,
  ]);

  const [tick, spacing, position] = await Promise.all([
    currentTick(),
    tickSpacing(),
    publicClient.readContract({
      address: positionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [positionTokenId],
    }) as Promise<
      readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
    >,
  ]);

  const [, , , , , posTickLower, posTickUpper, liquidity] = position;
  const ethPrice = ethPriceFromTick(tick);

  // Anchor D1 (the new lower bound we propose to uni-lab) to the CURRENT
  // position's width, recentered on today's price — not the owner's original
  // configureTarget() range. uni-lab's simulation is meant to be the source
  // of truth for each cycle's range on its own terms (see PLAN.md /
  // SCALING.md); an earlier "anti-drift" attempt anchored to the original
  // target instead, which just fought the API's own answer every cycle.
  //
  // IMPORTANT: in this pool a HIGHER tick means a LOWER USD price (token1/
  // token0 inversion) — so the position's numerically-lower tick
  // (posTickLower) is actually the USD-price CEILING, and posTickUpper is
  // the USD-price FLOOR. floorTick/ceilTick below are named for what they
  // mean in price terms, not by which contract field they came from,
  // specifically to avoid re-introducing that mix-up.
  const floorTick = Math.max(posTickLower, posTickUpper); // higher tick = lower USD price
  const ceilTick = Math.min(posTickLower, posTickUpper); // lower tick = higher USD price
  const posCenterTick = (floorTick + ceilTick) / 2;
  const downTicks = floorTick - posCenterTick; // USD downside distance, expressed in ticks
  const upTicks = posCenterTick - ceilTick; // USD upside distance, expressed in ticks

  const newFloorTick = tick + downTicks; // recentered floor: higher tick = lower price, so we ADD to go down
  const newCeilTickFallback = tick - upTicks; // recentered ceiling fallback

  const { amount0Raw: closedAmount0Raw, amount1Raw: closedAmount1Raw } = estimatePositionAmounts({
    liquidity,
    currentTick: tick,
    tickLower: posTickLower,
    tickUpper: posTickUpper,
  });
  const positionValueUsd = closedAmount0Raw * 1e-6 + closedAmount1Raw * 1e-18 * ethPrice;

  // Reinjection this cycle: the contract no longer tracks or forces an
  // alternating pattern (see PLAN.md) — the keeper decides, bookkeeping its
  // own alternation in Supabase (record.reinjectionActive) so consecutive
  // cycles still oscillate the way the original design intended, without the
  // contract enforcing it. Capped by both the owner's per-cycle ceiling and
  // by what's actually sitting in reserve — never more than either allows.
  const wantsToReinjectThisCycle = !record.reinjectionActive;
  const reinjectAmount = wantsToReinjectThisCycle
    ? reinjectionCap < reserveBalance
      ? reinjectionCap
      : reserveBalance
    : 0n;

  // What decreaseLiquidity+collect will hand back, plus whatever gets
  // reinjected this cycle. Platform-fee dust (step 4, paid in token0) is
  // small enough to skip modeling here — the swap only needs to get the
  // token0/token1 RATIO right, not the exact wei amount, since Uniswap's
  // mint() only uses what the range needs.
  const availableToken0Raw = BigInt(Math.floor(closedAmount0Raw)) + reinjectAmount;
  const availableToken1Raw = BigInt(Math.floor(closedAmount1Raw));

  const newLowerPrice = ethPriceFromTick(newFloorTick); // the USD floor — this is D1
  let newUpperPrice = ethPriceFromTick(newCeilTickFallback); // USD ceiling fallback, may be replaced by uni-lab's answer below

  // Gate before paying: simulate with the locally computed range and a real
  // swap sizing (the API may adjust the upper bound afterwards, but if even
  // this reverts — broken config, exhausted budget, cooldown — the uni-lab
  // fee would be wasted).
  const buildSwapIx = (tickLower: number, tickUpper: number) =>
    sizeRebalanceSwap({
      currentTick: tick,
      newTickLower: tickLower,
      newTickUpper: tickUpper,
      availableToken0Raw,
      availableToken1Raw,
      ethPriceUsd: ethPrice,
    });

  {
    const tickA = alignToTickSpacing(tickFromEthPrice(newLowerPrice), spacing);
    const tickB = alignToTickSpacing(tickFromEthPrice(newUpperPrice), spacing);
    const probeTickLower = Math.min(tickA, tickB);
    const probeTickUpper = Math.max(tickA, tickB);
    const probeSwap = buildSwapIx(probeTickLower, probeTickUpper);
    const probeArgs = [
      probeTickLower,
      probeTickUpper,
      { token0ToToken1: probeSwap.token0ToToken1, amountIn: probeSwap.amountIn, amountOutMinimum: 0n },
      reinjectAmount,
      0n,
      0n,
    ] as const;
    if (!(await wouldSucceed(vaultAddress, "rebalance", probeArgs))) {
      logEvent({
        level: "warn",
        vault: vaultAddress,
        msg: "rebalance simulation reverts — skipping cycle without paying uni-lab",
      });
      return;
    }
  }

  const { hash: payTxHash } = await payUniLabAndGetTxHash(vaultAddress);

  try {
    const reinjectionUsd = Number(reinjectAmount) / 1e6; // E1 = what the keeper is actually doing this cycle
    const resp = await rcRlpRebalance(
      record.uniLabApiKey,
      {
        currentLiquidityUsd: positionValueUsd,
        amountToRecoverUsd: positionValueUsd,
        currentPriceVolatileAsset: ethPrice,
        newLowerBound: newLowerPrice,
        reinvestmentAmountUsd: reinjectionUsd,
        txHash: payTxHash,
      },
      vaultAddress,
    );
    // Confirmed schema (2026-07-13, from a real 200 response — see the
    // keeper_unilab_calls audit trail in Supabase): the upper bound is nested
    // under `calculation`, and the field name itself differs by mode — RLP
    // (E1>0) uses new_upper_bound_with_rlp, RC (E1=0) uses new_upper_bound_usd.
    // The earlier top-level upper_bound/newUpperBound guess never matched
    // anything, so the API's answer was silently never used.
    const calc = (resp as Record<string, unknown>).calculation as Record<string, unknown> | undefined;
    const upper = calc?.new_upper_bound_with_rlp ?? calc?.new_upper_bound_usd;
    if (typeof upper === "number" && upper > newLowerPrice) newUpperPrice = upper;
    else {
      logEvent({
        level: "warn",
        vault: vaultAddress,
        msg: "rc-rlp-rebalance responded but no usable upper bound found, using fallback",
        response: resp,
      });
    }
  } catch (err) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rc-rlp-rebalance call failed, using symmetric-width estimate",
      err: String(err),
    });
  }

  // Higher USD price of ETH = lower tick in this pool, so the converted bounds
  // come out swapped — sort them, Uniswap requires tickLower < tickUpper.
  const tickA = alignToTickSpacing(tickFromEthPrice(newLowerPrice), spacing);
  const tickB = alignToTickSpacing(tickFromEthPrice(newUpperPrice), spacing);
  const newTickLower = Math.min(tickA, tickB);
  const newTickUpper = Math.max(tickA, tickB);

  // Re-size the swap against the FINAL range (uni-lab's answer may have moved
  // the upper bound from the probe's fallback estimate) — this is the fix for
  // the dust bug: without a real swap here, rebalance() mints with whatever
  // ratio came out of the OLD position, leaving the mismatched side unused.
  const finalSwap = buildSwapIx(newTickLower, newTickUpper);

  const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "rebalance", [
    newTickLower,
    newTickUpper,
    { token0ToToken1: finalSwap.token0ToToken1, amountIn: finalSwap.amountIn, amountOutMinimum: 0n },
    reinjectAmount,
    0n,
    0n,
  ]);
  await publicClient.waitForTransactionReceipt({ hash });

  // Persist the keeper's own alternation bookkeeping for next cycle — the
  // contract has no memory of this anymore (see PLAN.md).
  await store.upsertVault({ ...record, reinjectionActive: wantsToReinjectThisCycle });

  logEvent({
    level: "info",
    vault: vaultAddress,
    msg: "rebalanced",
    reason,
    newTickLower,
    newTickUpper,
    reinjectAmount: reinjectAmount.toString(),
    txHash: hash,
  });
}
