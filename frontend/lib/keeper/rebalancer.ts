import "server-only";
import { BaseError, ContractFunctionRevertedError, parseEventLogs, type Abi, type Address, type Log } from "viem";
import { publicClient, operatorAccount } from "./wallet";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi, sendTaggedTx } from "./serverContracts";
import { rcRlpRebalanceViaX402, type RcRlpRebalanceResponse } from "./unilab";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "../priceMath";
import { estimatePositionAmounts, sizeInitialSwap, sizeRebalanceSwap, ensureFeeCoverage, targetRawRatio } from "./swapMath";
import { POOL, WETH, USDT, SWAP_ROUTER02 } from "../addresses";
import { Store } from "./store";
import { logEvent, logUniLabCall } from "./logger";
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

// Deliberately NOT the regenerated platformConfigAbi — that ABI matches the
// CURRENT PlatformConfig source, which no longer declares rebalanceFee (see
// PlatformConfig.sol, removed 2026-07-16). Vaults cloned before that removal
// still point at an OLD PlatformConfig deployment that DOES have this
// function; a minimal hand-written fragment lets viem encode the call for
// them regardless of what the current source looks like. On a vault cloned
// after the removal, the call reaches a real PlatformConfig contract that
// genuinely has no such function (no fallback() either) and reverts — same
// signal, caught the same way, by currentRebalanceFee's own fallback below.
const legacyRebalanceFeeAbi = [
  { type: "function", name: "rebalanceFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** Live rebalanceFee (token0/USDT, 6 decimals) — only nonzero on vaults
 * whose PlatformConfig still has this field (see legacyRebalanceFeeAbi
 * above). Vaults cloned after the flat fee's removal resolve to 0, making
 * ensureFeeCoverage a no-op for them, which is correct — they have nothing
 * left to guarantee payment for. */
async function currentRebalanceFee(platformConfig: Address): Promise<bigint> {
  return (
    (await publicClient
      .readContract({ address: platformConfig, abi: legacyRebalanceFeeAbi, functionName: "rebalanceFee" })
      .catch(() => 0n)) as bigint
  );
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
    const [positionTokenId, idleUsdt, positionManager, maxSlippageBps] = await Promise.all([
      vault.read.positionTokenId() as Promise<bigint>,
      vault.read.investableUsdt() as Promise<bigint>,
      vault.read.positionManager() as Promise<Address>,
      vault.read.maxSlippageBps() as Promise<bigint>,
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

    const amountOutMinimum = await minAmountOutForSwap(vaultAddress, swap, maxSlippageBps);
    const swapIx = { token0ToToken1: swap.token0ToToken1, amountIn: swap.amountIn, amountOutMinimum };
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
 * Real slippage floor for a swap the keeper is about to send, honoring the
 * vault owner's own maxSlippageBps risk setting — every keeper-initiated
 * swap in this file passed amountOutMinimum: 0n until now, meaning Uniswap
 * would accept ANY execution price, no matter how bad (a manipulated block,
 * a thin/illiquid moment, MEV) with zero protection. Quotes the exact swap
 * about to be sent (same quoteExactInputSingle used for sizing) and applies
 * the owner's tolerance on top — if the pool can't deliver at least this
 * much, Uniswap itself reverts the swap rather than executing it at a worse
 * price, and the keeper's own simulateAttempt gate catches that before
 * spending gas on a doomed send.
 */
async function minAmountOutForSwap(
  vaultAddress: Address,
  swap: { token0ToToken1: boolean; amountIn: bigint },
  maxSlippageBps: bigint,
): Promise<bigint> {
  if (swap.amountIn === 0n) return 0n;
  const [tokenIn, tokenOut] = swap.token0ToToken1 ? [USDT, WETH] : [WETH, USDT];
  const quotedOut = await quoteExactInputSingle(vaultAddress, tokenIn, tokenOut, swap.amountIn);
  return (quotedOut * (10_000n - maxSlippageBps)) / 10_000n;
}

/**
 * Real slippage floor for a rebalance-path swap — for the rebalance-path
 * swaps ONLY (runRebalanceViaUniLab / runRebalanceExitTop), where
 * minAmountOutForSwap's standalone router quote can't be used. Root cause,
 * confirmed on-chain 2026-07-16 (vault 0xFee70486...4A4b3A, NFT #199598): a
 * rebalance's swap sells WETH/USDT that is still locked inside the OLD
 * position and only gets released by decreaseLiquidity()+collect(), the
 * first steps of the real rebalance() transaction — a standalone quote
 * simulated *before* that transaction sees the vault's current (near-zero)
 * idle balance, not the post-close balance, so it reverts with "STF" every
 * time. Tried replacing it with a spot-price-derived estimate (2026-07-17)
 * instead — also wrong, confirmed on-chain: it ignores real price impact
 * (only the pool's flat fee is predictable in advance; a ~$150 trade here
 * measured ~0.85% total cost against a ~0.3% fee), so the computed floor
 * was tighter than any real execution could satisfy and every rebalance
 * reverted with Uniswap's own "Too little received".
 *
 * Instead, binary-searches the REAL rebalance() call itself via `buildArgs`
 * (which plugs a candidate amountOutMinimum into the same args the caller
 * is about to send) — since decreaseLiquidity+collect+swap+mint all run
 * atomically inside that one simulated call, the tokens being sold DO exist
 * by the time the swap step runs, sidestepping the balance problem, while
 * still reflecting the pool's real depth/price impact/fee exactly like a
 * genuine quote would. Converges to the real achievable output within the
 * search precision, then applies the owner's maxSlippageBps tolerance on
 * top of that discovered real price. Returns null if the swap can't
 * execute at all regardless of price (a structural revert, e.g. an already
 * stale range) — the caller should skip the cycle without sending.
 */
async function minAmountOutForRebalanceSwap(
  vaultAddress: Address,
  buildArgs: (amountOutMinimum: bigint) => readonly unknown[],
  swap: { token0ToToken1: boolean; amountIn: bigint },
  ethPriceUsd: number,
  maxSlippageBps: bigint,
): Promise<bigint | null> {
  if (swap.amountIn === 0n) return 0n;
  if (!(await wouldSucceed(vaultAddress, "rebalance", buildArgs(0n)))) return null;

  // Generous upper bound for the search range — pre-fee, pre-impact spot
  // conversion, always >= the real achievable output.
  const spotEstimate = swap.token0ToToken1
    ? BigInt(Math.ceil(((Number(swap.amountIn) * 1e-6) / ethPriceUsd) * 1e18))
    : BigInt(Math.ceil(Number(swap.amountIn) * 1e-18 * ethPriceUsd * 1e6));

  let lo = 0n;
  let hi = spotEstimate;
  const precision = spotEstimate / 2000n || 1n; // ~0.05% of the estimate
  for (let i = 0; i < 12 && hi - lo > precision; i++) {
    const mid = (lo + hi + 1n) / 2n;
    // eslint-disable-next-line no-await-in-loop -- sequential probes of the same contract, deliberately not parallelized
    if (await wouldSucceed(vaultAddress, "rebalance", buildArgs(mid))) lo = mid;
    else hi = mid - 1n;
  }
  return (lo * (10_000n - maxSlippageBps)) / 10_000n;
}

/**
 * Shrinks a token0->token1 (USDT->WETH) swap, if needed, so its OWN price
 * impact can't push the pool past the target range — confirmed root cause
 * of a real production case, 2026-07-17 (vault 0xFee70486...4A4b3A, a ~1.8%-
 * wide range): a swap sized purely for the PRE-swap target ratio moved price
 * enough to exit the range within the same transaction, minting 100%
 * one-sided and leaving the rest as dust. Recovery needed a SECOND
 * corrective swap ~24 minutes later (once price drifted back on its own),
 * which cost real fee+slippage on both trades for no reason a same-tx fix
 * couldn't have avoided.
 *
 * Uses real on-chain quotes rather than replicating Uniswap's tick-crossing
 * math analytically — a few rounds of "quote the candidate, check where it
 * lands, shrink if it's outside" converges well enough for a sizing
 * heuristic (see this file's own precision philosophy). Only handles the
 * token0->token1 direction because that's the only one sizeInitialSwap ever
 * produces.
 */
async function capSwapWithinRange(
  vaultAddress: Address,
  amountIn: bigint,
  tickLower: number,
  tickUpper: number,
): Promise<bigint> {
  if (amountIn === 0n) return amountIn;
  const lo = Math.min(tickLower, tickUpper);
  const hi = Math.max(tickLower, tickUpper);
  // Keep the estimated post-swap price at least this many ticks inside the
  // range — plain safety margin so ordinary price drift before the tx
  // confirms doesn't immediately push it back out.
  const SAFETY_MARGIN_TICKS = 10;

  let candidate = amountIn;
  for (let i = 0; i < 6; i++) {
    if (candidate === 0n) return 0n;
    let amountOut: bigint;
    try {
      amountOut = await quoteExactInputSingle(vaultAddress, USDT, WETH, candidate);
    } catch {
      return candidate; // can't quote a smaller size either — use what we have
    }
    const execRate = Number(amountOut) / Number(candidate); // this trade's own realized WETH-raw-per-USDT-raw rate
    if (!Number.isFinite(execRate) || execRate <= 0) return candidate;
    const estimatedTick = tickFromEthPrice(1 / (execRate * 1e-12));

    if (estimatedTick >= lo + SAFETY_MARGIN_TICKS && estimatedTick <= hi - SAFETY_MARGIN_TICKS) {
      return candidate; // safely inside the range, done
    }
    candidate = candidate / 2n; // overshot the range — halve and re-check
  }
  return candidate;
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
 * (quotedOut/guessIn) instead of the spot price.
 *
 * Each correction re-derives targetRawRatio at the tick THIS candidate's own
 * quote would actually land the pool at, not the pre-swap tick — confirmed
 * on-chain 2026-07-17 (vault 0x4323F627...b71f9F, a ~3.6%-wide range): a
 * single correction using the pre-swap tick barely moved the naive guess at
 * all ($82.93 -> $83.12 sent), because a swap that size moves this narrow
 * range's tick enough that the pre-swap ratio and the actual post-swap ratio
 * differ by ~1.7x — 38% of the deposit ($34 of ~$145) was left as WETH dust,
 * needing two extra sweepIdleDust cycles (~10 min) to fully reinvest. Each
 * loop iteration uses the PREVIOUS candidate's own quote to estimate where
 * its swap would land, recomputes the target ratio there, and re-solves —
 * bounded (4 rounds) and stops once a candidate barely moves, same
 * diminishing-returns shape as capSwapWithinRange's own loop right after it.
 * Still an approximation (this pool's marginal rate isn't perfectly linear
 * within a round), so sweepIdleDust()/the independent monitor retry remain
 * the backstop for whatever's left — just with much less for them to clean
 * up. Finally capped by capSwapWithinRange so it can never overshoot the
 * target range's own boundary, on top of that.
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

  const investable = Number(input.availableToken0Raw);
  let candidate = guess.amountIn;

  try {
    for (let i = 0; i < 4; i++) {
      if (candidate === 0n) break;
      const realAmountOut = await quoteExactInputSingle(vaultAddress, USDT, WETH, candidate);
      const execRate = Number(realAmountOut) / Number(candidate); // WETH raw per USDT raw, actually observed
      if (!Number.isFinite(execRate) || execRate <= 0) break;

      // Where THIS candidate's own swap would actually leave the pool —
      // same estimation capSwapWithinRange uses below — so the ratio we
      // solve against reflects the post-swap state, not the pre-swap one.
      const estimatedTick = tickFromEthPrice(1 / (execRate * 1e-12));
      const rawRatio = targetRawRatio({ currentTick: estimatedTick, tickLower: input.tickLower, tickUpper: input.tickUpper });
      if (!Number.isFinite(rawRatio) || rawRatio <= 0) break;

      // Solve x*execRate / (investable - x) = rawRatio for x.
      const corrected = (rawRatio * investable) / (execRate + rawRatio);
      if (!Number.isFinite(corrected) || corrected <= 0) break;

      const next = BigInt(Math.floor(Math.min(corrected, investable)));
      const converged = next === candidate || (candidate > 0n && (next > candidate ? next - candidate : candidate - next) * 200n < candidate);
      candidate = next;
      if (converged) break;
    }
  } catch (err) {
    logEvent({ level: "warn", msg: "quote-corrected swap sizing failed, using naive estimate", err: String(err) });
    candidate = guess.amountIn;
  }

  const cappedAmountIn = await capSwapWithinRange(vaultAddress, candidate, input.tickLower, input.tickUpper);
  return { token0ToToken1: true, amountIn: cappedAmountIn };
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
  const [targetTickLower, targetTickUpper, investableUsdt, maxSlippageBps] = await Promise.all([
    vault.read.targetTickLower() as Promise<number>,
    vault.read.targetTickUpper() as Promise<number>,
    vault.read.investableUsdt() as Promise<bigint>,
    vault.read.maxSlippageBps() as Promise<bigint>,
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

  const initAmountOutMinimum = await minAmountOutForSwap(vaultAddress, swapIx, maxSlippageBps);
  const initArgs = [
    { token0ToToken1: swapIx.token0ToToken1, amountIn: swapIx.amountIn, amountOutMinimum: initAmountOutMinimum },
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
 * B1 for uni-lab: the TOTAL USD capital ever committed to this vault's LP
 * position — the original investment plus every reinjection since, on
 * either path (inside a rebalance() cycle, or a standalone
 * reinjectIntoPosition() top-up). Has to be read from on-chain events: the
 * contract never persists investmentAmountUsd anywhere, it only appears once
 * in the TargetConfigured event at configure time (see PLAN.md). Only the
 * FIRST TargetConfigured counts as real capital — VaultDetail.tsx's
 * reconfigure flow resends a later TargetConfigured with investableUsdt (the
 * vault's idle balance at that moment) in that same field, not a new
 * deposit, so treating "latest wins" would silently replace the real
 * investment with an unrelated idle-balance snapshot.
 */
const EVENT_SCAN_CHUNK = 5_000n; // forno.celo.org's eth_getLogs range cap — see lib/getLogsChunked.ts

async function getCumulativeInvestmentUsd(vaultAddress: Address, fromBlock: bigint): Promise<number> {
  const latestBlock = await publicClient.getBlockNumber();
  const logs: Log[] = [];
  let from = fromBlock;
  while (from <= latestBlock) {
    const to = from + EVENT_SCAN_CHUNK > latestBlock ? latestBlock : from + EVENT_SCAN_CHUNK;
    logs.push(...(await publicClient.getLogs({ address: vaultAddress, fromBlock: from, toBlock: to })));
    from = to + 1n;
  }
  const events = parseEventLogs({ abi: rangeVaultAbi, logs });

  let originalInvestmentRaw: bigint | undefined;
  let totalReinjectedRaw = 0n;
  for (const ev of events) {
    const args = ev.args as Record<string, unknown>;
    if (ev.eventName === "TargetConfigured" && originalInvestmentRaw === undefined) {
      originalInvestmentRaw = args.investmentAmountUsd as bigint;
    } else if (ev.eventName === "Rebalanced") {
      totalReinjectedRaw += args.reinjectedAmount as bigint;
    } else if (ev.eventName === "ReinjectedIntoPosition") {
      totalReinjectedRaw += args.amount as bigint;
    }
  }

  return Number((originalInvestmentRaw ?? 0n) + totalReinjectedRaw) * 1e-6; // both raw USDT, 6 decimals
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
  const [
    positionTokenId,
    reinjectionCap,
    positionManager,
    reserveBalance,
    idleInvestableUsdt,
    idleWeth,
    recenterMarginBps,
    platformConfig,
    maxSlippageBps,
  ] = await Promise.all([
    vault.read.positionTokenId() as Promise<bigint>,
    vault.read.reinjectionAmount() as Promise<bigint>, // owner's per-cycle ceiling — see RangeVault.sol
    vault.read.positionManager() as Promise<Address>,
    vault.read.reserveBalance() as Promise<bigint>,
    vault.read.investableUsdt() as Promise<bigint>, // dust left idle from a PRIOR cycle — see availableToken0Raw below
    publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [vaultAddress] }) as Promise<bigint>, // WETH-side counterpart of idleInvestableUsdt — see availableToken1Raw below
    // Falls back to the platform's old hardcoded 5% for vaults cloned from
    // an implementation that predates this field — that call reverts
    // outright (RangeVault has no fallback()), not just "returns 0", so a
    // bare read here would break every pre-existing vault's keeper cycle.
    (vault.read.recenterMarginBps() as Promise<bigint>).catch(() => 500n),
    vault.read.platformConfig() as Promise<Address>, // for currentRebalanceFee — see ensureFeeCoverage below
    vault.read.maxSlippageBps() as Promise<bigint>,
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
  // recenterMarginBps is the owner-set "how far below live price" for a
  // from-scratch floor (RangeVault.sol) — 500 == 5%, same shape as
  // maxSlippageBps/maxRangeDeviationBps elsewhere in this file.
  const newLowerPrice = stillInRangeForPeriodicPin
    ? ethPriceFromTick(floorTick)
    : ethPrice * (1 - Number(recenterMarginBps) / 10_000); // D1
  // Set below, from uni-lab's real answer — there is no local fallback for
  // the real mint (explicit product decision, 2026-07-16): if uni-lab can't
  // be reached or gives nothing usable, the cycle returns before this is
  // ever read. A local zero-margin guess used to live here as a fallback and
  // reliably minted a position that was already out of range the moment
  // price moved at all before the tx confirmed — confirmed in production
  // 2026-07-16 (vault 0x8Ed2ad9f...42737C88).
  let newUpperPrice: number;

  const { amount0Raw: closedAmount0Raw, amount1Raw: closedAmount1Raw } = estimatePositionAmounts({
    liquidity,
    currentTick: tick,
    tickLower: posTickLower,
    tickUpper: posTickUpper,
  });
  const positionValueUsd = closedAmount0Raw * 1e-6 + closedAmount1Raw * 1e-18 * ethPrice;

  // Reinjection this cycle: only when recovering from a genuine
  // out-of-range-bottom break — a periodic cycle (whether still in range, or
  // the stale-floor case caught by stillInRangeForPeriodicPin above) never
  // reinjects. No more alternation (removed per explicit product decision,
  // 2026-07-16 — the prior Supabase-bookkept oscillation is gone): every
  // out-of-range-bottom cycle reinjects up to the cap, bounded by both the
  // owner's per-cycle ceiling and by what's actually sitting in reserve.
  const reinjectAmount =
    reason === "out-of-range-bottom" ? (reinjectionCap < reserveBalance ? reinjectionCap : reserveBalance) : 0n;

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

  // Real swap sizing helper, reused for the actual mint below once uni-lab's
  // range is known — no probe/guessed range fed through this anymore (see
  // the fresh state re-check right below).
  const buildSwapIx = (tickLower: number, tickUpper: number) =>
    sizeRebalanceSwap({
      currentTick: tick,
      newTickLower: tickLower,
      newTickUpper: tickUpper,
      availableToken0Raw,
      availableToken1Raw,
      ethPriceUsd: ethPrice,
    });

  // Free, real-data re-check of the gates that DON'T depend on the new range
  // (NoPosition/RebalanceLimitReached/TooSoonToRebalance) — right before
  // paying uni-lab, no guessed price or range involved anywhere (explicit
  // product decision, 2026-07-16: the old pre-payment probe simulated
  // rebalance() with a locally-invented ceiling just to exercise these
  // checks — replaced with plain view reads of the same state the contract
  // itself checks). monitor.ts already verified these a moment earlier in
  // the same tick; this closes the small remaining race window (the RPC
  // reads above, between monitor's check and here) for free, before spending
  // real money.
  const [rebalanceCount, maxRebalances, lastRebalanceTimestamp, minRebalanceInterval] = await Promise.all([
    vault.read.rebalanceCount() as Promise<bigint>,
    vault.read.maxRebalances() as Promise<bigint>,
    vault.read.lastRebalanceTimestamp() as Promise<bigint>,
    vault.read.minRebalanceInterval() as Promise<bigint>,
  ]);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (
    positionTokenId === 0n ||
    rebalanceCount >= maxRebalances ||
    nowSec < lastRebalanceTimestamp + minRebalanceInterval
  ) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "vault state changed since monitor's check — skipping cycle without paying uni-lab",
      positionTokenId: positionTokenId.toString(),
      rebalanceCount: rebalanceCount.toString(),
      maxRebalances: maxRebalances.toString(),
    });
    return;
  }

  const reinjectionUsd = Number(reinjectAmount) / 1e6; // E1 = what the keeper is actually doing this cycle

  // B1: always the vault's ENTIRE committed capital (original investment +
  // every reinjection to date), never just the current position's live
  // value — even on a still-in-range periodic cycle. The position's USD
  // value moves with price inside the range (impermanent-loss-style), so it
  // can sit below what was actually invested even while genuinely in range;
  // using positionValueUsd here would understate B1 and feed uni-lab a
  // "amount to recover" smaller than the real capital at stake.
  const amountToRecoverUsd = await getCumulativeInvestmentUsd(vaultAddress, BigInt(record.createdAtBlock));

  const baseParams = {
    currentLiquidityUsd: positionValueUsd,
    amountToRecoverUsd,
    currentPriceVolatileAsset: ethPrice,
    newLowerBound: newLowerPrice,
    reinvestmentAmountUsd: reinjectionUsd,
  };

  // x402-only (2026-07-15) — the operator's own USDC pays uni-lab directly,
  // no vault budget involved at all. Confirmed working end-to-end on-chain,
  // see HACKATHON.md "Track 2 — x402". The retired on-chain
  // payUniLabFee()+tx_hash path is gone.
  //
  // No local fallback for the actual mint (explicit product decision,
  // 2026-07-16): the ceiling on a real rebalance — periodic or
  // out-of-range-bottom — must come from uni-lab's live simulation. If x402
  // fails, uni-lab is unreachable, or the response has no usable field, the
  // pool is left exactly as-is this cycle rather than minting against a
  // local guess — the guess was confirmed to reliably produce a position
  // that's already out of range on arrival (vault 0x8Ed2ad9f...42737C88,
  // 2026-07-16, see note above).
  let resp: RcRlpRebalanceResponse | undefined;
  try {
    resp = await rcRlpRebalanceViaX402(record.uniLabApiKey, baseParams, vaultAddress);
  } catch (err) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rc-rlp-rebalance (x402) call failed — skipping cycle, no local fallback for the real mint",
      err: String(err),
    });
    return;
  }

  // Confirmed schema (2026-07-13, from a real 200 response — see the
  // keeper_unilab_calls audit trail in Supabase): the upper bound is nested
  // under `calculation`, and the field name itself differs by mode — RLP
  // (E1>0) uses new_upper_bound_with_rlp, RC (E1=0) uses new_upper_bound_usd.
  const calc = (resp as Record<string, unknown>).calculation as Record<string, unknown> | undefined;
  const upper = calc?.new_upper_bound_with_rlp ?? calc?.new_upper_bound_usd;
  if (typeof upper !== "number" || upper <= newLowerPrice) {
    // rcRlpRebalanceViaX402 already logged this call as ok:true (it got a
    // real HTTP 200) — log a second, ok:false row here so the vault's
    // frontend alert (which reads the LATEST keeper_unilab_calls row per
    // vault) can tell "API reachable but gave us nothing usable" apart from
    // a genuine success, without VaultDetail.tsx having to know this
    // endpoint's response schema itself.
    await logUniLabCall({
      vault: vaultAddress,
      endpoint: "rc-rlp-rebalance (x402, unusable response)",
      request: baseParams,
      httpStatus: 200,
      response: resp,
      ok: false,
      durationMs: 0,
      error: "response had no usable new_upper_bound_with_rlp/new_upper_bound_usd",
    });
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rc-rlp-rebalance responded but no usable upper bound — skipping cycle, no local fallback for the real mint",
      response: resp,
    });
    return;
  }
  newUpperPrice = upper;

  // Higher USD price of ETH = lower tick in this pool, so the converted bounds
  // come out swapped — sort them, Uniswap requires tickLower < tickUpper.
  const tickA = alignToTickSpacing(tickFromEthPrice(newLowerPrice), spacing);
  const tickB = alignToTickSpacing(tickFromEthPrice(newUpperPrice), spacing);
  const newTickLower = Math.min(tickA, tickB);
  const newTickUpper = Math.max(tickA, tickB);

  // Re-size the swap against the FINAL range (uni-lab's own answer) — this is
  // the fix for the dust bug: without a real swap here, rebalance() mints
  // with whatever ratio came out of the OLD position, leaving the mismatched
  // side unused.
  //
  // Then guarantee the (possibly zero, on a post-removal vault) flat fee is
  // payable — see ensureFeeCoverage's own docstring.
  const rebalanceFee = await currentRebalanceFee(platformConfig);
  const finalSwap = ensureFeeCoverage(
    buildSwapIx(newTickLower, newTickUpper),
    availableToken0Raw,
    rebalanceFee,
    ethPrice,
  );
  const buildFinalArgs = (amountOutMinimum: bigint) =>
    [
      newTickLower,
      newTickUpper,
      { token0ToToken1: finalSwap.token0ToToken1, amountIn: finalSwap.amountIn, amountOutMinimum },
      reinjectAmount,
      0n,
      0n,
    ] as const;

  // Real gate, using uni-lab's actual computed range instead of the earlier
  // local guess — the probe above only ever checked our own estimate, and
  // never validated what actually gets sent. uni-lab is already paid at this
  // point either way; this only prevents burning gas on a doomed send.
  const finalAmountOutMinimum = await minAmountOutForRebalanceSwap(
    vaultAddress,
    buildFinalArgs,
    finalSwap,
    ethPrice,
    maxSlippageBps,
  );
  if (finalAmountOutMinimum === null) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rebalance reverts on uni-lab's real range — skipping send (uni-lab already paid this cycle)",
      newTickLower,
      newTickUpper,
    });
    return;
  }
  const finalArgs = buildFinalArgs(finalAmountOutMinimum);
  if (!(await hasEnoughOperatorGas(vaultAddress, { functionName: "rebalance", args: finalArgs }))) {
    return;
  }

  const hash = await sendTaggedTx(vaultAddress, rangeVaultAbi as Abi, "rebalance", finalArgs);
  await publicClient.waitForTransactionReceipt({ hash });

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
 * runInitPosition(): fresh bounds `recenterMarginBps` under /
 * `exitTopCeilingMarginBps` above the live price, both owner-set
 * (RangeVault.sol). No reinjection here either — same as every reason other
 * than out-of-range-bottom (see runRebalanceViaUniLab's reinjectAmount).
 */
async function runRebalanceExitTop(vaultAddress: Address): Promise<void> {
  const vault = vaultContract(vaultAddress);
  const [
    positionTokenId,
    positionManager,
    idleInvestableUsdt,
    idleWeth,
    recenterMarginBps,
    exitTopCeilingMarginBps,
    platformConfig,
    maxSlippageBps,
  ] = await Promise.all([
    vault.read.positionTokenId() as Promise<bigint>,
    vault.read.positionManager() as Promise<Address>,
    vault.read.investableUsdt() as Promise<bigint>, // dust left idle from a prior cycle — see runRebalanceViaUniLab
    publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [vaultAddress] }) as Promise<bigint>,
    // Same fallback as runRebalanceViaUniLab, same reason: these two revert
    // outright on a vault cloned from an implementation that predates them.
    (vault.read.recenterMarginBps() as Promise<bigint>).catch(() => 500n),
    (vault.read.exitTopCeilingMarginBps() as Promise<bigint>).catch(() => 300n),
    vault.read.platformConfig() as Promise<Address>, // for currentRebalanceFee — see ensureFeeCoverage below
    vault.read.maxSlippageBps() as Promise<bigint>,
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

  const newLowerPrice = ethPrice * (1 - Number(recenterMarginBps) / 10_000);
  const newUpperPrice = ethPrice * (1 + Number(exitTopCeilingMarginBps) / 10_000);

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
  // keeps growing. Then guarantee the (possibly zero) flat fee is payable —
  // see ensureFeeCoverage's own docstring.
  const availableToken0Raw = BigInt(Math.floor(closedAmount0Raw)) + idleInvestableUsdt;
  const rebalanceFee = await currentRebalanceFee(platformConfig);
  const swapIx = ensureFeeCoverage(
    sizeRebalanceSwap({
      currentTick: tick,
      newTickLower,
      newTickUpper,
      availableToken0Raw,
      availableToken1Raw: BigInt(Math.floor(closedAmount1Raw)) + idleWeth,
      ethPriceUsd: ethPrice,
    }),
    availableToken0Raw,
    rebalanceFee,
    ethPrice,
  );

  const buildRebalanceArgs = (amountOutMinimum: bigint) =>
    [
      newTickLower,
      newTickUpper,
      { token0ToToken1: swapIx.token0ToToken1, amountIn: swapIx.amountIn, amountOutMinimum },
      0n, // no reinjection — from-scratch rebuild, like initPosition()
      0n,
      0n,
    ] as const;

  const exitTopAmountOutMinimum = await minAmountOutForRebalanceSwap(
    vaultAddress,
    buildRebalanceArgs,
    swapIx,
    ethPrice,
    maxSlippageBps,
  );
  if (exitTopAmountOutMinimum === null) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rebalance (exit-top rebuild) simulation reverts — skipping cycle",
    });
    return;
  }
  const rebalanceArgs = buildRebalanceArgs(exitTopAmountOutMinimum);

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
