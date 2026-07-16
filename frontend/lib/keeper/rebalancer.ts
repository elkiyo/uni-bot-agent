import "server-only";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address } from "viem";
import { publicClient, operatorAccount } from "./wallet";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi, sendTaggedTx } from "./serverContracts";
import { rcRlpRebalanceViaX402, type RcRlpRebalanceResponse } from "./unilab";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "../priceMath";
import { estimatePositionAmounts, sizeInitialSwap, sizeRebalanceSwap, targetRawRatio } from "./swapMath";
import { POOL, WETH, USDT, SWAP_ROUTER02 } from "../addresses";
import { Store } from "./store";
import { logEvent } from "./logger";
import { rangeVaultAbi, erc20Abi, swapRouter02Abi } from "../contracts";

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

const GAS_SAFETY_MULTIPLIER_PCT = 130n; // 30% buffer over the current estimate, for gas-price drift between check and send

/**
 * Real gas-cost estimate against the operator's actual CELO balance — NOT
 * covered by `wouldSucceed`'s free simulation, which never checks funds.
 * Missing this check is exactly how a vault burned 0.8 USDT of its uni-lab
 * budget on 2026-07-14, back when uni-lab was still paid on-chain per vault
 * (retired 2026-07-15 in favor of x402 — see HACKATHON.md "Track 2 — x402"):
 * with the operator low on CELO, the cheap payment call kept succeeding
 * while the much heavier rebalance() that had to follow kept reverting for
 * insufficient funds. Still worth checking before rebalance() itself for the
 * same reason — no point letting the (now free, x402-paid) uni-lab call
 * succeed if the operator can't afford to act on its answer.
 */
async function hasEnoughOperatorGas(
  vaultAddress: Address,
  mainCall: { functionName: string; args: readonly unknown[] },
): Promise<boolean> {
  if (!operatorAccount) return false;
  const [gasPrice, balance, mainGas] = await Promise.all([
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: operatorAccount.address }),
    publicClient.estimateContractGas({
      address: vaultAddress,
      abi: rangeVaultAbi as Abi,
      functionName: mainCall.functionName,
      args: mainCall.args as unknown[],
      account: operatorAccount.address,
    }),
  ]);

  const estimatedCost = (mainGas * gasPrice * GAS_SAFETY_MULTIPLIER_PCT) / 100n;
  if (balance < estimatedCost) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: `operator CELO balance too low to complete ${mainCall.functionName} — skipping cycle`,
      balance: balance.toString(),
      estimatedCost: estimatedCost.toString(),
    });
    return false;
  }
  return true;
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
  return (await simulateAttempt(vaultAddress, functionName, args)).ok;
}

/**
 * Same simulation as `wouldSucceed`, but keeps the decoded custom-error name
 * instead of collapsing everything to a boolean — needed by the periodic
 * rebalance path below to tell "genuinely blocked" (NoPosition,
 * RebalanceLimitReached, TooSoonToRebalance, ...) apart from "our own local
 * range guess tripped RangeTooFarFromMarket, uni-lab's real answer might not."
 */
async function simulateAttempt(
  vaultAddress: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<{ ok: boolean; errorName?: string }> {
  try {
    await publicClient.simulateContract({
      address: vaultAddress,
      abi: rangeVaultAbi as Abi,
      functionName,
      args: args as unknown[],
      account: operatorAccount?.address,
    });
    return { ok: true };
  } catch (err) {
    const reverted =
      err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
    const errorName = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    return { ok: false, errorName };
  }
}

const DUST_SWEEP_MIN_USD = 1; // not worth the gas below this

/**
 * Best-effort follow-up after a mint: if there's dust left over that the
 * contract's own automatic same-ratio top-up (`_sweepDustIntoPosition`)
 * couldn't use — typically because a prior swap overshot badly enough to
 * leave dust that's almost entirely one token, with nothing to pair it
 * with — swap and add it for real via `sweepIdleDust()`. Confirmed
 * necessary in production 2026-07-16 (vault 0x982b8435...c47505: ~$67 of
 * WETH stranded after initPosition() with zero matching USDT). Never blocks
 * the caller — errors are logged, not thrown, since the mint/rebalance this
 * runs after already succeeded by the time this executes.
 */
export async function maybeSweepIdleDust(vaultAddress: Address): Promise<void> {
  try {
    const vault = vaultContract(vaultAddress);
    const [positionTokenId, idleUsdt, positionManager] = await Promise.all([
      vault.read.positionTokenId() as Promise<bigint>,
      vault.read.investableUsdt() as Promise<bigint>,
      vault.read.positionManager() as Promise<Address>,
    ]);
    if (positionTokenId === 0n) return;

    const [idleWeth, tick, position] = await Promise.all([
      publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vaultAddress],
      }) as Promise<bigint>,
      currentTick(),
      publicClient.readContract({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: "positions",
        args: [positionTokenId],
      }) as Promise<
        readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
      >,
    ]);
    const [, , , , , tickLower, tickUpper] = position;
    const ethPrice = ethPriceFromTick(tick);

    const idleUsdValue = Number(idleUsdt) * 1e-6 + Number(idleWeth) * 1e-18 * ethPrice;
    if (idleUsdValue < DUST_SWEEP_MIN_USD) return;

    const swap = sizeRebalanceSwap({
      currentTick: tick,
      newTickLower: tickLower,
      newTickUpper: tickUpper,
      availableToken0Raw: idleUsdt,
      availableToken1Raw: idleWeth,
      ethPriceUsd: ethPrice,
    });
    if (swap.amountIn === 0n) return;

    const swapIx = { token0ToToken1: swap.token0ToToken1, amountIn: swap.amountIn, amountOutMinimum: 0n };
    const args = [swapIx, 0n, 0n] as const;

    const check = await simulateAttempt(vaultAddress, "sweepIdleDust", args);
    if (!check.ok) {
      logEvent({
        level: "warn",
        vault: vaultAddress,
        msg: "sweepIdleDust simulation reverts — skipping",
        errorName: check.errorName,
        idleUsdValue,
      });
      return;
    }
    if (!(await hasEnoughOperatorGas(vaultAddress, { functionName: "sweepIdleDust", args }))) {
      return;
    }

    const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "sweepIdleDust", args);
    await publicClient.waitForTransactionReceipt({ hash });
    logEvent({ level: "info", vault: vaultAddress, msg: "swept idle dust", idleUsdValue, txHash: hash });
  } catch (err) {
    logEvent({ level: "warn", vault: vaultAddress, msg: "maybeSweepIdleDust failed, ignoring", err: String(err) });
  }
}

/** Real amountOut for a hypothetical swap, reflecting this specific pool's
 * actual current depth/price impact — unlike the constant-spot-price
 * assumption everywhere else in this file. Simulates SWAP_ROUTER02's own
 * exactInputSingle (via eth_call, never committed) as `vaultAddress` itself,
 * rather than using Uniswap's Quoter contract: the Quoter's pool lookup is
 * an offline CREATE2 computation against a hardcoded init-code hash that
 * doesn't match Celo's real deployed pool bytecode (confirmed 2026-07-16 —
 * every call to it reverts), while the router looks the pool up through the
 * real factory, same as any real swap would. Needs `vaultAddress` (not just
 * any account) because the simulated call still checks real token
 * balance/allowance — only the vault itself has both. */
async function quoteExactInputSingle(
  vaultAddress: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: SWAP_ROUTER02,
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [{ tokenIn, tokenOut, fee: 3000, recipient: vaultAddress, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    account: vaultAddress,
  });
  return result;
}

/**
 * Same target as sizeInitialSwap, corrected for the swap's own price impact
 * using a real quote instead of assuming the pre-swap spot price holds all
 * the way through. sizeInitialSwap alone reliably leaves a large one-sided
 * leftover in this pool's real (thin) depth — confirmed repeatedly in
 * production 2026-07-16 (e.g. vault 0x721e1B69...C94C37: ~$94 of WETH left
 * unswept after initPosition, ~38% of the deposit).
 *
 * Method: size a first guess the old way, get a REAL quote for exactly that
 * amount, then solve directly in raw-unit space for the swap size that
 * would actually balance the position — using the range's true target
 * ratio (targetRawRatio) against the OBSERVED execution rate
 * (quotedOut/guessIn) instead of the spot price. This is a linear
 * approximation around the first guess (the pool's marginal rate does shift
 * a little between the guess and the corrected amount), so it's not exact —
 * sweepIdleDust()/the independent monitor retry stay as the backstop for
 * whatever's left, same as before, just with much less for them to clean up.
 */
async function sizeInitialSwapAccurate(
  vaultAddress: Address,
  input: {
    currentTick: number;
    tickLower: number;
    tickUpper: number;
    availableToken0Raw: bigint;
    ethPriceUsd: number;
  },
): Promise<{ token0ToToken1: true; amountIn: bigint }> {
  const guess = sizeInitialSwap(input);
  if (guess.amountIn === 0n) return guess;

  try {
    const realAmountOut = await quoteExactInputSingle(vaultAddress, USDT, WETH, guess.amountIn);
    const rawRatio = targetRawRatio(input);
    if (!Number.isFinite(rawRatio) || rawRatio <= 0) return guess;

    const execRate = Number(realAmountOut) / Number(guess.amountIn); // WETH raw per USDT raw, actually observed
    if (!Number.isFinite(execRate) || execRate <= 0) return guess;

    // Solve x*execRate / (investable - x) = rawRatio for x.
    const investable = Number(input.availableToken0Raw);
    const corrected = (rawRatio * investable) / (execRate + rawRatio);
    if (!Number.isFinite(corrected) || corrected <= 0) return guess;

    return { token0ToToken1: true, amountIn: BigInt(Math.floor(Math.min(corrected, investable))) };
  } catch (err) {
    logEvent({ level: "warn", msg: "quote-corrected swap sizing failed, using naive estimate", err: String(err) });
    return guess;
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

  // Sized locally, corrected against a real Uniswap Quoter call for the
  // swap's own price impact (see sizeInitialSwapAccurate) — the standard
  // Uniswap V3 balanced-deposit ratio for [tickLower, tickUpper] at the
  // current price, adjusted for what this specific swap actually does to
  // that price in this pool's real depth. Used to call uni-lab's
  // /pool-setup-initial here too, paid out of the vault's own budget, but
  // that response was never actually used (it only got logged) even when it
  // succeeded — this same formula was always what got sent. Paying for a
  // consultation whose answer is discarded either way is a real cost to the
  // owner for zero benefit, so initPosition no longer calls uni-lab at all;
  // only rebalance() does, where the API's answer (the new upper bound)
  // genuinely drives the outcome. See PLAN.md.
  const swapIx = await sizeInitialSwapAccurate(vaultAddress, {
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

  if (!(await hasEnoughOperatorGas(vaultAddress, { functionName: "initPosition", args: initArgs }))) {
    return;
  }

  const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "initPosition", initArgs);
  await publicClient.waitForTransactionReceipt({ hash });

  await store.upsertVault({ ...record, positionInitialized: true });
  logEvent({ level: "info", vault: vaultAddress, msg: "position initialized", txHash: hash });

  await maybeSweepIdleDust(vaultAddress);
}

/**
 * Case 1 (still in range, periodic forced cycle) and Case 2 (broke out below
 * the floor) both go through uni-lab's /rc-rlp-rebalance — the only
 * difference between them is where D1 (the floor we propose) comes from.
 * Confirmed directly against the API (2026-07-14): its response never
 * derives D1 on its own — `min_price` in the response always echoes back
 * whatever D1 was sent, and `new_upper_bound_with_rlp`/`new_upper_bound_usd`
 * always echoes back C1 (the live price, zero headroom above it — that's the
 * calculator's own profit-taking design, not a bug to buffer around). So:
 *   - Case 1 (periodic): D1 stays exactly what the EXISTING position's floor
 *     already is — untouched, not recentered. Only the ceiling moves, to the
 *     live price.
 *   - Case 2 (out-of-range-bottom): D1 is freshly set to 5% under the live
 *     price, same as a from-scratch rebuild.
 * Case 3 (out-of-range-top) is handled separately below (runRebalanceExitTop)
 * — it never calls uni-lab at all, since a position that broke out above is
 * already ~100% stable and there's no split left to compute.
 */
async function runRebalanceViaUniLab(
  vaultAddress: Address,
  store: Store,
  reason: "periodic" | "out-of-range-bottom",
): Promise<void> {
  const record = await store.getVault(vaultAddress);
  if (!record?.uniLabApiKey) {
    logEvent({ level: "error", vault: vaultAddress, msg: "no uni-lab api key on record, skipping rebalance" });
    return;
  }

  const vault = vaultContract(vaultAddress);
  const [positionTokenId, reinjectionCap, positionManager, reserveBalance, idleInvestableUsdt, idleWeth] =
    await Promise.all([
    vault.read.positionTokenId() as Promise<bigint>,
    vault.read.reinjectionAmount() as Promise<bigint>, // owner's per-cycle ceiling — see RangeVault.sol
    vault.read.positionManager() as Promise<Address>,
    vault.read.reserveBalance() as Promise<bigint>,
    vault.read.investableUsdt() as Promise<bigint>, // dust left idle from a PRIOR cycle — see availableToken0Raw below
    publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [vaultAddress] }) as Promise<bigint>, // WETH-side counterpart of idleInvestableUsdt — see availableToken1Raw below
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

  // IMPORTANT: in this pool a HIGHER tick means a LOWER USD price (token1/
  // token0 inversion) — so the position's numerically-lower tick
  // (posTickLower) is actually the USD-price CEILING, and posTickUpper is
  // the USD-price FLOOR.
  const floorTick = Math.max(posTickLower, posTickUpper); // higher tick = lower USD price

  // Pin D1 to the existing floor only when the position is still genuinely
  // in range — a periodic cycle firing at the same moment the position has
  // ALSO already broken below its floor must recenter like a real
  // out-of-range-bottom cycle instead. Otherwise the "new" range still needs
  // the same ~100%-token1 ratio as what's already held: sizeRebalanceSwap
  // correctly computes amountIn=0, no USDT is ever produced, and rebalance()
  // reverts trying to pay the token0-denominated platform fee
  // (InsufficientInvestableBalance) — silently blocking every cycle forever.
  // Confirmed in production 2026-07-16, vault 0x721e1B69...C94C37: stuck for
  // 5+ hours, no tx sent, no alert.
  const stillInRangeForPeriodicPin = reason === "periodic" && tick <= floorTick;
  const newLowerPrice = stillInRangeForPeriodicPin ? ethPriceFromTick(floorTick) : ethPrice * 0.95; // D1
  // C1 fallback, only used if uni-lab's real answer below is unavailable
  // (x402 failure, non-200, or no usable field). A zero-margin fallback
  // (ceiling == price at calculation time) reliably mints a position that's
  // already out of range the moment price moves at all before the tx
  // confirms — confirmed in production 2026-07-16 (vault 0x8Ed2ad9f...
  // 42737C88: x402 returned 402, fell back to this, minted, and the position
  // was out of range within the same cron tick). 0.3% headroom is enough to
  // absorb normal price drift across a ~5s confirmation without meaningfully
  // changing what a legitimate periodic recenter is trying to do.
  let newUpperPrice = ethPrice * 1.003;

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
  // reinjected this cycle, plus any dust already sitting idle from a PRIOR
  // cycle — both sides, not just token0. The contract's own mint() reads
  // the vault's full token0/token1 balances (token0 minus reserveBalance),
  // so it already tries to use old dust too — but only succeeds if the SWAP
  // was sized for the true total. Leaving either side out here means the
  // swap ratio is only ever correct for the freshly-closed position, so old
  // dust can never enter the mint's ratio and just keeps growing every cycle
  // instead of shrinking — confirmed in production 2026-07-15 for the
  // token0 case (vault 0x8Ed2ad9f...42737C88: $88.56 idle against a $61
  // position after 2 rebalances) and 2026-07-16 for token1 (vault
  // 0x721e1B69...C94C37: a periodic rebalance left ~$7.6 of WETH stranded
  // right after sweepIdleDust() had just cleaned up the SAME vault, because
  // this swap sizing only ever accounted for the token0 side of leftover
  // dust). Platform-fee dust (step 4, paid in token0) is small enough to
  // skip modeling here — the swap only needs to get the token0/token1 RATIO
  // right, not the exact wei amount, since Uniswap's mint() only uses what
  // the range needs.
  const availableToken0Raw = BigInt(Math.floor(closedAmount0Raw)) + reinjectAmount + idleInvestableUsdt;
  const availableToken1Raw = BigInt(Math.floor(closedAmount1Raw)) + idleWeth;

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

  const probeArgs = (() => {
    const tickA = alignToTickSpacing(tickFromEthPrice(newLowerPrice), spacing);
    const tickB = alignToTickSpacing(tickFromEthPrice(newUpperPrice), spacing);
    const probeTickLower = Math.min(tickA, tickB);
    const probeTickUpper = Math.max(tickA, tickB);
    const probeSwap = buildSwapIx(probeTickLower, probeTickUpper);
    return [
      probeTickLower,
      probeTickUpper,
      { token0ToToken1: probeSwap.token0ToToken1, amountIn: probeSwap.amountIn, amountOutMinimum: 0n },
      reinjectAmount,
      0n,
      0n,
    ] as const;
  })();

  const probeCheck = await simulateAttempt(vaultAddress, "rebalance", probeArgs);

  // RangeTooFarFromMarket on the PROBE isn't a real block: probeArgs' ceiling
  // is our own local fallback guess (current price), not uni-lab's actual
  // calculation — and the periodic path deliberately pins the old floor and
  // only recenters the ceiling, so this guess can land further from market
  // than the contract's maxRangeDeviationBps tolerance even when uni-lab's
  // real RC/RLP answer (queried below) would clear it fine. Confirmed in
  // production 2026-07-15: this guess-based gate silently blocked periodic
  // cycles on 3 vaults forever, never once asking uni-lab for the real
  // number. Any other revert here (NoPosition, RebalanceLimitReached,
  // TooSoonToRebalance, insufficient swap liquidity, ...) is a genuine block
  // unrelated to the ceiling guess, so it still short-circuits before paying.
  const probeBlockedByRangeGuessOnly = !probeCheck.ok && probeCheck.errorName === "RangeTooFarFromMarket";
  if (!probeCheck.ok && !probeBlockedByRangeGuessOnly) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rebalance simulation reverts — skipping cycle without paying uni-lab",
      errorName: probeCheck.errorName,
    });
    return;
  }

  // Rebalance-only gas check, upfront — guards against wasting the x402
  // payment on a cycle whose final rebalance() call can't actually be sent
  // for lack of CELO gas. Skipped when the probe itself would revert (the
  // guess-only case above): estimateContractGas throws on a call that would
  // revert, so there's nothing useful to estimate from probeArgs here — gas
  // gets checked below instead, once uni-lab's real range is known.
  if (!probeBlockedByRangeGuessOnly) {
    if (!(await hasEnoughOperatorGas(vaultAddress, { functionName: "rebalance", args: probeArgs }))) {
      return;
    }
  }

  const reinjectionUsd = Number(reinjectAmount) / 1e6; // E1 = what the keeper is actually doing this cycle
  const baseParams = {
    currentLiquidityUsd: positionValueUsd,
    amountToRecoverUsd: positionValueUsd,
    currentPriceVolatileAsset: ethPrice,
    newLowerBound: newLowerPrice,
    reinvestmentAmountUsd: reinjectionUsd,
  };

  // x402-only (2026-07-15) — the operator's own USDC pays uni-lab directly,
  // no vault budget involved at all. Confirmed working end-to-end on-chain,
  // see HACKATHON.md "Track 2 — x402". The retired on-chain
  // payUniLabFee()+tx_hash path is gone; if x402 fails (operator out of
  // USDC, uni-lab/facilitator issue) the cycle just proceeds with the
  // fallback width estimate below instead of paying twice for one answer.
  let resp: RcRlpRebalanceResponse | undefined;
  try {
    resp = await rcRlpRebalanceViaX402(record.uniLabApiKey, baseParams, vaultAddress);
  } catch (err) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rc-rlp-rebalance (x402) call failed, using symmetric-width estimate",
      err: String(err),
    });
  }

  if (resp) {
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
  const finalArgs = [
    newTickLower,
    newTickUpper,
    { token0ToToken1: finalSwap.token0ToToken1, amountIn: finalSwap.amountIn, amountOutMinimum: 0n },
    reinjectAmount,
    0n,
    0n,
  ] as const;

  // Real gate, using uni-lab's actual computed range instead of the earlier
  // local guess — the probe above only ever checked our own estimate, and
  // never validated what actually gets sent. uni-lab is already paid at this
  // point either way; this only prevents burning gas on a doomed send.
  const finalCheck = await simulateAttempt(vaultAddress, "rebalance", finalArgs);
  if (!finalCheck.ok) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rebalance reverts on uni-lab's real range — skipping send (uni-lab already paid this cycle)",
      errorName: finalCheck.errorName,
      newTickLower,
      newTickUpper,
    });
    return;
  }
  if (!(await hasEnoughOperatorGas(vaultAddress, { functionName: "rebalance", args: finalArgs }))) {
    return;
  }

  const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "rebalance", finalArgs);
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

  await maybeSweepIdleDust(vaultAddress);
}

/**
 * Case 3 (out-of-range-top): price broke above the position's ceiling, which
 * — given the calculator's zero-headroom-above design — means the position
 * is already ~100% stable. There's no split left to compute, so this skips
 * uni-lab entirely (no payment) and rebuilds locally, same shape as
 * runInitPosition(): fresh bounds 5% under / 3% above the live price. No
 * reinjection here either — this is a from-scratch rebuild, not a periodic
 * cycle, so the reserve/reinjection alternation (record.reinjectionActive)
 * is left untouched for the next in-range cycle to pick back up.
 */
async function runRebalanceExitTop(vaultAddress: Address): Promise<void> {
  const vault = vaultContract(vaultAddress);
  const [positionTokenId, positionManager, idleInvestableUsdt, idleWeth] = await Promise.all([
    vault.read.positionTokenId() as Promise<bigint>,
    vault.read.positionManager() as Promise<Address>,
    vault.read.investableUsdt() as Promise<bigint>, // dust left idle from a prior cycle — see runRebalanceViaUniLab
    publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [vaultAddress] }) as Promise<bigint>,
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

  const newLowerPrice = ethPrice * 0.95;
  const newUpperPrice = ethPrice * 1.03;

  // Higher USD price of ETH = lower tick in this pool, so the converted
  // bounds come out swapped — sort them, Uniswap requires tickLower < tickUpper.
  const tickA = alignToTickSpacing(tickFromEthPrice(newLowerPrice), spacing);
  const tickB = alignToTickSpacing(tickFromEthPrice(newUpperPrice), spacing);
  const newTickLower = Math.min(tickA, tickB);
  const newTickUpper = Math.max(tickA, tickB);

  const { amount0Raw: closedAmount0Raw, amount1Raw: closedAmount1Raw } = estimatePositionAmounts({
    liquidity,
    currentTick: tick,
    tickLower: posTickLower,
    tickUpper: posTickUpper,
  });

  // Same fix as runRebalanceViaUniLab: fold in any dust already idle from a
  // prior cycle, both sides, or it never enters the swap ratio and just
  // keeps growing.
  const swapIx = sizeRebalanceSwap({
    currentTick: tick,
    newTickLower,
    newTickUpper,
    availableToken0Raw: BigInt(Math.floor(closedAmount0Raw)) + idleInvestableUsdt,
    availableToken1Raw: BigInt(Math.floor(closedAmount1Raw)) + idleWeth,
    ethPriceUsd: ethPrice,
  });

  const rebalanceArgs = [
    newTickLower,
    newTickUpper,
    { token0ToToken1: swapIx.token0ToToken1, amountIn: swapIx.amountIn, amountOutMinimum: 0n },
    0n, // no reinjection — from-scratch rebuild, like initPosition()
    0n,
    0n,
  ] as const;

  if (!(await wouldSucceed(vaultAddress, "rebalance", rebalanceArgs))) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rebalance (exit-top rebuild) simulation reverts — skipping cycle",
    });
    return;
  }

  if (!(await hasEnoughOperatorGas(vaultAddress, { functionName: "rebalance", args: rebalanceArgs }))) {
    return;
  }

  const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "rebalance", rebalanceArgs);
  await publicClient.waitForTransactionReceipt({ hash });

  logEvent({
    level: "info",
    vault: vaultAddress,
    msg: "rebalanced",
    reason: "out-of-range-top",
    newTickLower,
    newTickUpper,
    reinjectAmount: "0",
    txHash: hash,
  });

  await maybeSweepIdleDust(vaultAddress);
}

export async function runRebalance(
  vaultAddress: Address,
  store: Store,
  reason: "periodic" | "out-of-range-top" | "out-of-range-bottom",
): Promise<void> {
  if (reason === "out-of-range-top") {
    await runRebalanceExitTop(vaultAddress);
    return;
  }
  await runRebalanceViaUniLab(vaultAddress, store, reason);
}
