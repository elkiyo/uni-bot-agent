import "server-only";
import type { Abi, Address } from "viem";
import { publicClient, operatorAccount } from "./wallet";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi, sendTaggedTx } from "./serverContracts";
import { poolSetupInitial, rcRlpRebalance } from "./unilab";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "../priceMath";
import { estimatePositionValueUsd, sizeInitialSwap } from "./swapMath";
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
 * payment before it will answer.
 */
async function payUniLabAndGetTxHash(vaultAddress: Address): Promise<`0x${string}`> {
  const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "payUniLabFee", []);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
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
  if (!record?.uniLabApiKey) {
    logEvent({ level: "error", vault: vaultAddress, msg: "no uni-lab api key on record, skipping initPosition" });
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

  // Gate: don't spend 0.5 USDT of the vault's budget on a uni-lab query whose
  // result can't be acted on (e.g. mis-configured vault → initPosition reverts).
  if (!(await wouldSucceed(vaultAddress, "initPosition", initArgs))) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "initPosition simulation reverts — skipping cycle without paying uni-lab (check vault config)",
    });
    return;
  }

  const payTxHash = await payUniLabAndGetTxHash(vaultAddress);

  try {
    await poolSetupInitial(
      record.uniLabApiKey,
      {
        usdPoolInvestment: Number(investableUsdt) / 1e6,
        currentPriceVolatileAsset: ethPrice,
        minPriceLowerLimit: ethPriceFromTick(targetTickLower),
        maxPriceUpperLimit: ethPriceFromTick(targetTickUpper),
        txHash: payTxHash,
      },
      vaultAddress,
    );
    // Response schema isn't fully pinned down (see unilab.ts) — the locally
    // computed swapIx above is what actually gets sent either way, per the
    // fallback-on-parse-failure design also used in runRebalance below.
  } catch (err) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "pool-setup-initial call failed, proceeding with locally computed swap sizing",
      err: String(err),
    });
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
  const [positionTokenId, reinjectionAmount, positionManager, reinjectionActive, targetTickLower, targetTickUpper] =
    await Promise.all([
      vault.read.positionTokenId() as Promise<bigint>,
      vault.read.reinjectionAmount() as Promise<bigint>,
      vault.read.positionManager() as Promise<Address>,
      vault.read.reinjectionActive() as Promise<boolean>,
      vault.read.targetTickLower() as Promise<number>,
      vault.read.targetTickUpper() as Promise<number>,
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

  // Anchor the "how far from market are my bounds" policy to the owner's
  // ORIGINAL configureTarget() range (targetTickLower/Upper), not the live
  // position's current width. The live position's width can already reflect
  // an asymmetric answer from a prior uni-lab call — reading it back as the
  // seed for the next cycle would let any one-off asymmetry compound forever.
  //
  // IMPORTANT: in this pool a HIGHER tick means a LOWER USD price (token1/
  // token0 inversion, same issue fixed elsewhere in this file) — so the tick
  // that's numerically "lower" (targetTickLower) is actually the USD-price
  // CEILING, and "targetTickUpper" is the USD-price FLOOR. floorTick/ceilTick
  // below are named for what they mean in price terms, not by which contract
  // field they came from, specifically to avoid re-introducing that mix-up.
  const floorTick = Math.max(targetTickLower, targetTickUpper); // higher tick = lower USD price
  const ceilTick = Math.min(targetTickLower, targetTickUpper); // lower tick = higher USD price
  const targetCenterTick = (floorTick + ceilTick) / 2;
  const downTicks = floorTick - targetCenterTick; // USD downside distance, expressed in ticks
  const upTicks = targetCenterTick - ceilTick; // USD upside distance, expressed in ticks

  const newFloorTick = tick + downTicks; // recentered floor: higher tick = lower price, so we ADD to go down
  const newCeilTickFallback = tick - upTicks; // recentered ceiling fallback

  const positionValueUsd = estimatePositionValueUsd({
    liquidity,
    currentTick: tick,
    tickLower: posTickLower,
    tickUpper: posTickUpper,
    ethPriceUsd: ethPrice,
  });

  const newLowerPrice = ethPriceFromTick(newFloorTick); // the USD floor — this is D1
  let newUpperPrice = ethPriceFromTick(newCeilTickFallback); // USD ceiling fallback, may be replaced by uni-lab's answer below

  // Gate before paying: simulate with the locally computed symmetric range (the
  // API may adjust the upper bound afterwards, but if even this reverts —
  // broken config, exhausted budget, cooldown — the 0.5 USDT would be wasted).
  {
    const tickA = alignToTickSpacing(tickFromEthPrice(newLowerPrice), spacing);
    const tickB = alignToTickSpacing(tickFromEthPrice(newUpperPrice), spacing);
    const probeArgs = [
      Math.min(tickA, tickB),
      Math.max(tickA, tickB),
      { token0ToToken1: false, amountIn: 0n, amountOutMinimum: 0n },
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

  const payTxHash = await payUniLabAndGetTxHash(vaultAddress);

  try {
    const reinjectionUsd = reinjectionActive ? 0 : Number(reinjectionAmount) / 1e6; // !active this cycle -> we're about to reinject
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

  const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "rebalance", [
    newTickLower,
    newTickUpper,
    { token0ToToken1: false, amountIn: 0n, amountOutMinimum: 0n },
    0n,
    0n,
  ]);
  await publicClient.waitForTransactionReceipt({ hash });

  logEvent({ level: "info", vault: vaultAddress, msg: "rebalanced", reason, newTickLower, newTickUpper, txHash: hash });
}
