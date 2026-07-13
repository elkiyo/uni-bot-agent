import type { Abi, Address } from "viem";
import { publicClient } from "./wallet.js";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi, sendTaggedTx } from "./contracts.js";
import { poolSetupInitial, rcRlpRebalance } from "./unilab.js";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "./priceMath.js";
import { estimatePositionValueUsd, sizeInitialSwap } from "./swapMath.js";
import { POOL } from "./addresses.js";
import { Store } from "./store.js";
import { logEvent } from "./logger.js";
import RangeVaultAbi from "./abi/RangeVault.json" with { type: "json" };

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
  const hash = await sendTaggedTx(vaultAddress, RangeVaultAbi as Abi, "payUniLabFee", []);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function runInitPosition(vaultAddress: Address, store: Store): Promise<void> {
  const record = store.getVault(vaultAddress);
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

  const payTxHash = await payUniLabAndGetTxHash(vaultAddress);

  try {
    await poolSetupInitial(record.uniLabApiKey, {
      usdPoolInvestment: Number(investableUsdt) / 1e6,
      currentPriceVolatileAsset: ethPrice,
      minPriceLowerLimit: ethPriceFromTick(targetTickLower),
      maxPriceUpperLimit: ethPriceFromTick(targetTickUpper),
      txHash: payTxHash,
    });
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

  const hash = await sendTaggedTx(vaultAddress, RangeVaultAbi as Abi, "initPosition", [
    { token0ToToken1: swapIx.token0ToToken1, amountIn: swapIx.amountIn, amountOutMinimum: 0n },
    0n,
    0n,
  ]);
  await publicClient.waitForTransactionReceipt({ hash });

  store.upsertVault({ ...record, positionInitialized: true });
  logEvent({ level: "info", vault: vaultAddress, msg: "position initialized", txHash: hash });
}

export async function runRebalance(vaultAddress: Address, store: Store, reason: string): Promise<void> {
  const record = store.getVault(vaultAddress);
  if (!record?.uniLabApiKey) {
    logEvent({ level: "error", vault: vaultAddress, msg: "no uni-lab api key on record, skipping rebalance" });
    return;
  }

  const vault = vaultContract(vaultAddress);
  const [positionTokenId, reinjectionAmount, positionManager, reinjectionActive] = await Promise.all([
    vault.read.positionTokenId() as Promise<bigint>,
    vault.read.reinjectionAmount() as Promise<bigint>,
    vault.read.positionManager() as Promise<Address>,
    vault.read.reinjectionActive() as Promise<boolean>,
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
  const width = posTickUpper - posTickLower; // preserve the owner's configured width across rebalances
  const ethPrice = ethPriceFromTick(tick);

  const positionValueUsd = estimatePositionValueUsd({
    liquidity,
    currentTick: tick,
    tickLower: posTickLower,
    tickUpper: posTickUpper,
    ethPriceUsd: ethPrice,
  });

  // width is in ticks; 1 tick == 1 bps of price (see RangeVault._checkRangeNearMarket).
  const newLowerPrice = ethPrice * (1 - width / 2 / 10_000);
  let newUpperPrice = ethPrice * (1 + width / 2 / 10_000);

  const payTxHash = await payUniLabAndGetTxHash(vaultAddress);

  try {
    const reinjectionUsd = reinjectionActive ? 0 : Number(reinjectionAmount) / 1e6; // !active this cycle -> we're about to reinject
    const resp = await rcRlpRebalance(record.uniLabApiKey, {
      currentLiquidityUsd: positionValueUsd,
      amountToRecoverUsd: positionValueUsd,
      currentPriceVolatileAsset: ethPrice,
      newLowerBound: newLowerPrice,
      reinvestmentAmountUsd: reinjectionUsd,
      txHash: payTxHash,
    });
    const upper = (resp as Record<string, unknown>).upper_bound ?? (resp as Record<string, unknown>).newUpperBound;
    if (typeof upper === "number" && upper > newLowerPrice) newUpperPrice = upper;
  } catch (err) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rc-rlp-rebalance call failed, using symmetric-width estimate",
      err: String(err),
    });
  }

  const newTickLower = alignToTickSpacing(tickFromEthPrice(newLowerPrice), spacing);
  const newTickUpper = alignToTickSpacing(tickFromEthPrice(newUpperPrice), spacing);

  const hash = await sendTaggedTx(vaultAddress, RangeVaultAbi as Abi, "rebalance", [
    newTickLower,
    newTickUpper,
    { token0ToToken1: false, amountIn: 0n, amountOutMinimum: 0n },
    0n,
    0n,
  ]);
  await publicClient.waitForTransactionReceipt({ hash });

  logEvent({ level: "info", vault: vaultAddress, msg: "rebalanced", reason, newTickLower, newTickUpper, txHash: hash });
}
