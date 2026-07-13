import type { Abi, Address } from "viem";
import { publicClient, operatorAccount } from "./wallet.js";
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
      abi: RangeVaultAbi as Abi,
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

  const hash = await sendTaggedTx(vaultAddress, RangeVaultAbi as Abi, "initPosition", initArgs);
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

  // Higher USD price of ETH = lower tick in this pool, so the converted bounds
  // come out swapped — sort them, Uniswap requires tickLower < tickUpper.
  const tickA = alignToTickSpacing(tickFromEthPrice(newLowerPrice), spacing);
  const tickB = alignToTickSpacing(tickFromEthPrice(newUpperPrice), spacing);
  const newTickLower = Math.min(tickA, tickB);
  const newTickUpper = Math.max(tickA, tickB);

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
