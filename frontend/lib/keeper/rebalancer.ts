import "server-only";
import { BaseError, ContractFunctionRevertedError, parseEventLogs, type Abi, type Address } from "viem";
import { operatorAccount, type ChainRuntime } from "./wallet";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi, sendTaggedTx } from "./serverContracts";
import { rcRlpRebalanceViaX402, type RcRlpRebalanceResponse } from "./unilab";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "../priceMath";
import { estimatePositionAmounts, sizeInitialSwap, sizeRebalanceSwap, ensureFeeCoverage, targetRawRatio } from "./swapMath";

/** Converts the business-level "sell stable / sell volatile" direction into
 * the on-chain SwapInstruction.token0ToToken1 the contract actually needs —
 * the only place this file talks about real token0/token1 at all. Every
 * sizing function above this line works in stable/volatile terms; only the
 * final SwapInstruction literal, right before a tx is sent, needs the real
 * slot. See RangeVault.sol's class docstring and swapMath.ts's own docstring. */
function toToken0ToToken1(sellStable: boolean, chain: ChainRuntime): boolean {
  return sellStable === chain.stableIsToken0;
}
import { Store } from "./store";
import { logEvent, logUniLabCall } from "./logger";
import { erc20Abi, swapRouter02Abi, uniswapV3FactoryAbi } from "../contracts";
import { getLogsChunkedMulti } from "../getLogsChunked";
import { resolveVaultPair, applyVaultPair } from "./pairInfo";

// Takes the VAULT's own pool explicitly — never chain.pool, the chain's
// "default" pool. createVault() lets the owner pick any fee-tier pool for
// the pair, and every call site below already has the vault's own contract
// in scope to read pool() from. Confirmed live 2026-07-19: a real Arbitrum
// vault (0x5cD98eC8...4A5dEcb) sits on the 0.30% pool while chain.pool is
// the 0.05% one — every one of these used to read the wrong pool's price
// for such a vault.
async function currentTick(chain: ChainRuntime, pool: Address): Promise<number> {
  const [, tick] = (await chain.publicClient.readContract({
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, number, number, number, number, boolean];
  return tick;
}

// Same reasoning as currentTick above — a vault on a non-default pool has a
// different real tickSpacing (e.g. 60 for a 0.30% pool vs. 10 for 0.05%);
// aligning a new range to the wrong one would make Uniswap's mint() revert
// (or worse, silently accept ticks that only happen to be common multiples).
async function tickSpacing(chain: ChainRuntime, pool: Address): Promise<number> {
  return (await chain.publicClient.readContract({
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: "tickSpacing",
  })) as number;
}

/**
 * Picks whichever fee-tier pool for this chain's pair has the most live
 * liquidity, to route a swap through — independent of chain.feeTier (the
 * pool every vault's LP position actually lives in). Confirmed in production
 * 2026-07-17 (vault 0xaeFE8a2b...891017F, Celo): a $389 swap cost 1.26%
 * (~$4.86) routed through the position's own 0.3% pool, vs. an estimated
 * 0.03% through this same pair's 0.01% pool — 8.5x more liquidity that day,
 * ~$5.53 cheaper for that exact trade. Falls back to chain.feeTier if the
 * factory lookup fails or every candidate pool is empty/nonexistent — same
 * behavior as before this existed.
 */
async function pickDeepestSwapFee(chain: ChainRuntime): Promise<number> {
  try {
    const pools = await Promise.all(
      chain.candidateSwapFeeTiers.map((fee) =>
        chain.publicClient
          .readContract({
            address: chain.uniswapV3Factory,
            abi: uniswapV3FactoryAbi,
            functionName: "getPool",
            args: [chain.stableToken, chain.volatileToken, fee],
          })
          .then((pool) => ({ fee, pool: pool as Address })),
      ),
    );
    const liquidities = await Promise.all(
      pools.map(({ pool }) =>
        pool === "0x0000000000000000000000000000000000000000"
          ? Promise.resolve(0n)
          : chain.publicClient
              .readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "liquidity" })
              .then((l) => l as bigint)
              .catch(() => 0n),
      ),
    );
    let bestFee = chain.feeTier;
    let bestLiquidity = -1n;
    for (let i = 0; i < pools.length; i++) {
      if (liquidities[i] > bestLiquidity) {
        bestLiquidity = liquidities[i];
        bestFee = pools[i].fee;
      }
    }
    return bestLiquidity > 0n ? bestFee : chain.feeTier;
  } catch (err) {
    logEvent({ level: "warn", msg: "pickDeepestSwapFee failed, falling back to the vault's own pool", err: String(err) });
    return chain.feeTier;
  }
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
async function currentRebalanceFee(chain: ChainRuntime, platformConfig: Address): Promise<bigint> {
  return (
    (await chain.publicClient
      .readContract({ address: platformConfig, abi: legacyRebalanceFeeAbi, functionName: "rebalanceFee" })
      .catch(() => 0n)) as bigint
  );
}

const GAS_SAFETY_MULTIPLIER_PCT = 130n; // 30% buffer over the current estimate, for gas-price drift between check and send

/**
 * Real gas-cost estimate against the operator's actual native-token balance
 * on this chain — NOT covered by `wouldSucceed`'s free simulation, which
 * never checks funds. Missing this check is exactly how a vault burned 0.8
 * USDT of its uni-lab budget on 2026-07-14, back when uni-lab was still paid
 * on-chain per vault (retired 2026-07-15 in favor of x402 — see
 * HACKATHON.md "Track 2 — x402"): with the operator low on CELO, the cheap
 * payment call kept succeeding while the much heavier rebalance() that had
 * to follow kept reverting for insufficient funds. Still worth checking
 * before rebalance() itself for the same reason — no point letting the (now
 * free, x402-paid) uni-lab call succeed if the operator can't afford to act
 * on its answer.
 */
async function hasEnoughOperatorGas(
  chain: ChainRuntime,
  vaultAddress: Address,
  mainCall: { functionName: string; args: readonly unknown[] },
  abi: Abi = chain.vaultAbi as Abi,
): Promise<boolean> {
  if (!operatorAccount) return false;
  const vault = vaultContract(chain, vaultAddress, abi);
  // gasReserveBalance() only exists on the Arbitrum vault family — Celo's
  // RangeVault.sol has no such ledger at all (see this vault's own class
  // docstring and CLAUDE.md's "Arbitrum ... con soporte de reserva de gas
  // que Celo no tiene"). Calling it unconditionally here threw
  // AbiFunctionNotFoundError for EVERY Celo vault's every operator action
  // (rebalance/init/claimFees/sweep, all funnel through this one gate) —
  // confirmed live 2026-07-27: every Celo vault silently unable to
  // rebalance since this check was introduced, the crash caught by tick.ts's
  // per-vault try/catch and only ever console.log'd.
  //
  // `.catch()` on the read itself (not a static abi.some() check) because an
  // EIP-1167 clone's real behavior comes from whatever implementation it was
  // pointed at when created — an Arbitrum vault cloned before this ledger
  // was added to the implementation genuinely reverts on this call too, even
  // though today's RangeVaultArb.json lists it (confirmed live 2026-07-27,
  // vault 0xcb7b1964...e00c22: an old, never-funded vault predating both
  // gasReserveBalance() and stableIsToken0()). Same fallback pattern already
  // used just below for recenterMarginBps/exitTopCeilingMarginBps.
  const [gasPrice, balance, mainGas, gasReserveBalance, pool] = await Promise.all([
    chain.publicClient.getGasPrice(),
    chain.publicClient.getBalance({ address: operatorAccount.address }),
    chain.publicClient.estimateContractGas({
      address: vaultAddress,
      abi,
      functionName: mainCall.functionName,
      args: mainCall.args as unknown[],
      account: operatorAccount.address,
    }),
    (vault.read.gasReserveBalance() as Promise<bigint>).catch(() => undefined),
    vault.read.pool() as Promise<Address>,
  ]);

  const estimatedCost = (mainGas * gasPrice * GAS_SAFETY_MULTIPLIER_PCT) / 100n;
  if (balance < estimatedCost) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: `operator ${chain.viemChain.nativeCurrency.symbol} balance too low to complete ${mainCall.functionName} on ${chain.name} — skipping cycle`,
      balance: balance.toString(),
      estimatedCost: estimatedCost.toString(),
    });
    return false;
  }

  // Vault's OWN gasReserveBalance — a completely separate concept from the
  // operator wallet balance checked above. _reimburseKeeperGas() in the
  // contract never reverts or blocks when this runs dry (protecting the
  // owner's capital wins over reimbursing the operator, see PLAN.md), which
  // used to mean a vault could silently pay the operator $0 forever with no
  // event, no alert, nothing distinguishing it from a normal reimbursement —
  // confirmed invisible across contract/keeper/UI/admin. This is the single
  // convergence point every operator-triggered action (init/rebalance/
  // claimFees/sweep) already passes through, so it's the natural place to
  // detect and persist depletion without duplicating the estimate elsewhere.
  // Approximate on purpose (tick-based spot price, not the contract's exact
  // sqrtPriceX96 fixed-point math) — this only decides whether to raise an
  // alert, the contract's own math stays authoritative for what actually
  // gets paid.
  if (gasReserveBalance !== undefined) {
    try {
      const tick = await currentTick(chain, pool);
      const ethPriceUsd = ethPriceFromTick(tick, chain.stableIsToken0);
      // 1e-18 here is the chain's NATIVE gas token's decimals (an EVM-wide
      // invariant, always 18, unrelated to this vault's own pair) — not
      // chain.volatileDecimals, even though the two happen to coincide on
      // every chain this platform runs on today (ETH is both the gas token
      // and the volatile leg on Arbitrum; ditto CELO/WETH-adjacent on Celo's
      // own _nativeWeiToStableRaw assumption, unchanged here).
      const estimatedCostUsd = Number(estimatedCost) * 1e-18 * ethPriceUsd;
      const gasReserveUsd = Number(gasReserveBalance) * 10 ** -chain.stableDecimals;
      await new Store(chain.id).setGasReserveDepleted(vaultAddress, gasReserveUsd < estimatedCostUsd);
    } catch (err) {
      logEvent({ level: "warn", vault: vaultAddress, msg: "gas-reserve depletion check failed, ignoring", err: String(err) });
    }
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
  chain: ChainRuntime,
  vaultAddress: Address,
  functionName: string,
  args: readonly unknown[],
  abi: Abi = chain.vaultAbi as Abi,
  account?: Address,
): Promise<boolean> {
  return (await simulateAttempt(chain, vaultAddress, functionName, args, abi, account)).ok;
}

/**
 * Same simulation as `wouldSucceed`, but keeps the decoded custom-error name
 * instead of collapsing everything to a boolean — needed by the periodic
 * rebalance path below to tell "genuinely blocked" (NoPosition,
 * RebalanceLimitReached, TooSoonToRebalance, ...) apart from "our own local
 * range guess tripped RangeTooFarFromMarket, uni-lab's real answer might not."
 */
async function simulateAttempt(
  chain: ChainRuntime,
  vaultAddress: Address,
  functionName: string,
  args: readonly unknown[],
  abi: Abi = chain.vaultAbi as Abi,
  account?: Address,
): Promise<{ ok: boolean; errorName?: string }> {
  try {
    await chain.publicClient.simulateContract({
      address: vaultAddress,
      abi,
      functionName,
      args: args as unknown[],
      // Defaults to the operator — right for every existing caller
      // (rebalance()/harvestFees()/etc. are all onlyOperator). Callers
      // simulating an onlyOwner function (ownerRebalance()) must pass the
      // real owner's address here, or the simulation always reverts with
      // NotOwner regardless of whether the tx itself would actually succeed.
      account: account ?? operatorAccount?.address,
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
export async function maybeSweepIdleDust(
  chain: ChainRuntime,
  vaultAddress: Address,
  store: Store,
  abi: Abi = chain.vaultAbi as Abi,
): Promise<void> {
  try {
    chain = applyVaultPair(chain, await resolveVaultPair(chain, vaultAddress, abi, store));
    const vault = vaultContract(chain, vaultAddress, abi);
    const [positionTokenId, idleUsdt, positionManager, maxSlippageBps, pool] = await Promise.all([
      vault.read.positionTokenId() as Promise<bigint>,
      vault.read.investableUsdt() as Promise<bigint>,
      vault.read.positionManager() as Promise<Address>,
      vault.read.maxSlippageBps() as Promise<bigint>,
      vault.read.pool() as Promise<Address>,
    ]);
    if (positionTokenId === 0n) return;

    const [idleWeth, tick, position] = await Promise.all([
      chain.publicClient.readContract({
        address: chain.volatileToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vaultAddress],
      }) as Promise<bigint>,
      currentTick(chain, pool),
      chain.publicClient.readContract({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: "positions",
        args: [positionTokenId],
      }) as Promise<
        readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
      >,
    ]);
    const [, , , , , tickLower, tickUpper] = position;
    const ethPrice = ethPriceFromTick(tick, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals);

    const idleUsdValue = Number(idleUsdt) * 10 ** -chain.stableDecimals + Number(idleWeth) * 10 ** -chain.volatileDecimals * ethPrice;
    if (idleUsdValue < DUST_SWEEP_MIN_USD) return;

    const swap = sizeRebalanceSwap({
      currentTick: tick,
      newTickLower: tickLower,
      newTickUpper: tickUpper,
      availableStableRaw: idleUsdt,
      availableVolatileRaw: idleWeth,
      ethPriceUsd: ethPrice,
      stableIsToken0: chain.stableIsToken0,
      stableDecimals: chain.stableDecimals,
      volatileDecimals: chain.volatileDecimals,
    });
    if (swap.amountIn === 0n) return;

    const swapFee = await pickDeepestSwapFee(chain);
    const amountOutMinimum = await minAmountOutForSwap(chain, vaultAddress, swap, maxSlippageBps, swapFee);
    const swapIx = { token0ToToken1: toToken0ToToken1(swap.sellStable, chain), amountIn: swap.amountIn, amountOutMinimum, fee: swapFee };
    const args = [swapIx, 0n, 0n] as const;

    const check = await simulateAttempt(chain, vaultAddress, "sweepIdleDust", args, abi);
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
    if (!(await hasEnoughOperatorGas(chain, vaultAddress, { functionName: "sweepIdleDust", args }, abi))) {
      return;
    }

    const hash = await sendTaggedTx(chain, vaultAddress, abi, "sweepIdleDust", args);
    await chain.publicClient.waitForTransactionReceipt({ hash });
    logEvent({ level: "info", vault: vaultAddress, msg: "swept idle dust", idleUsdValue, txHash: hash });
  } catch (err) {
    logEvent({ level: "warn", vault: vaultAddress, msg: "maybeSweepIdleDust failed, ignoring", err: String(err) });
  }
}

/**
 * Compound-vault-only (RangeVaultArbCompound.sol): the operator-triggered
 * scheduled/threshold fee claim — monitor.ts's checkFeeClaimDue() already
 * decided this cycle is due, this just executes harvestFees(). Modeled on
 * maybeSweepIdleDust() above (same shape: read position + idle state, size a
 * correction swap, simulate, check gas, send), with two differences:
 *
 * 1. The "available balance" fed to sizeRebalanceSwap is the position's
 *    accrued-but-uncollected tokensOwed0/tokensOwed1 (both legs — Uniswap
 *    accrues fees in both at once, see RangeVaultArbCompound.sol's
 *    _reinjectFees docstring), not an idle ERC20 balance sitting in the
 *    vault — those tokens don't exist as real vault balance until collect()
 *    runs INSIDE harvestFees() itself.
 * 2. Because of (1), amountOutMinimum can't come from a standalone quote
 *    (minAmountOutForSwap) — same reason rebalance()'s own swap can't, see
 *    minAmountOutForRebalanceSwap's docstring. Reuses that same
 *    binary-search-over-the-real-call technique, targeting "harvestFees".
 *
 * The target range for the swap is the position's OWN current
 * [tickLower, tickUpper] — this tops up the existing position, it never
 * rebuilds a new range (that's rebalance()'s job).
 */
export async function runClaimFees(chain: ChainRuntime, vaultAddress: Address, store: Store, abi: Abi): Promise<void> {
  try {
    chain = applyVaultPair(chain, await resolveVaultPair(chain, vaultAddress, abi, store));
    const vault = vaultContract(chain, vaultAddress, abi);
    const [positionTokenId, positionManager, maxSlippageBps, pool] = await Promise.all([
      vault.read.positionTokenId() as Promise<bigint>,
      vault.read.positionManager() as Promise<Address>,
      vault.read.maxSlippageBps() as Promise<bigint>,
      vault.read.pool() as Promise<Address>,
    ]);
    if (positionTokenId === 0n) return;

    const [tick, position] = await Promise.all([
      currentTick(chain, pool),
      chain.publicClient.readContract({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: "positions",
        args: [positionTokenId],
      }) as Promise<
        readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
      >,
    ]);
    const [, , , , , tickLower, tickUpper, , , , tokensOwed0, tokensOwed1] = position;
    const ethPrice = ethPriceFromTick(tick, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals);

    const accruedStableRaw = chain.stableIsToken0 ? tokensOwed0 : tokensOwed1;
    const accruedVolatileRaw = chain.stableIsToken0 ? tokensOwed1 : tokensOwed0;

    const swap = sizeRebalanceSwap({
      currentTick: tick,
      newTickLower: tickLower,
      newTickUpper: tickUpper,
      availableStableRaw: accruedStableRaw,
      availableVolatileRaw: accruedVolatileRaw,
      ethPriceUsd: ethPrice,
      stableIsToken0: chain.stableIsToken0,
      stableDecimals: chain.stableDecimals,
      volatileDecimals: chain.volatileDecimals,
    });

    const swapFee = await pickDeepestSwapFee(chain);
    const buildArgs = (amountOutMinimum: bigint) =>
      [
        { token0ToToken1: toToken0ToToken1(swap.sellStable, chain), amountIn: swap.amountIn, amountOutMinimum, fee: swapFee },
        0n,
        0n,
      ] as const;

    const amountOutMinimum = await minAmountOutForRebalanceSwap(
      chain,
      vaultAddress,
      buildArgs,
      swap,
      ethPrice,
      maxSlippageBps,
      abi,
      "harvestFees",
    );
    if (amountOutMinimum === null) {
      logEvent({ level: "warn", vault: vaultAddress, msg: "harvestFees simulation reverts — skipping cycle" });
      return;
    }
    const args = buildArgs(amountOutMinimum);

    if (!(await hasEnoughOperatorGas(chain, vaultAddress, { functionName: "harvestFees", args }, abi))) {
      return;
    }

    const hash = await sendTaggedTx(chain, vaultAddress, abi, "harvestFees", args);
    await chain.publicClient.waitForTransactionReceipt({ hash });
    logEvent({ level: "info", vault: vaultAddress, msg: "claimed and reinjected fees", txHash: hash });
  } catch (err) {
    logEvent({ level: "error", vault: vaultAddress, msg: "runClaimFees failed", err: String(err) });
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
  chain: ChainRuntime,
  vaultAddress: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<bigint> {
  const { result } = await chain.publicClient.simulateContract({
    address: chain.swapRouter02,
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [{ tokenIn, tokenOut, fee, recipient: vaultAddress, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
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
  chain: ChainRuntime,
  vaultAddress: Address,
  swap: { sellStable: boolean; amountIn: bigint },
  maxSlippageBps: bigint,
  fee: number,
): Promise<bigint> {
  if (swap.amountIn === 0n) return 0n;
  const [tokenIn, tokenOut] = swap.sellStable ? [chain.stableToken, chain.volatileToken] : [chain.volatileToken, chain.stableToken];
  const quotedOut = await quoteExactInputSingle(chain, vaultAddress, tokenIn, tokenOut, swap.amountIn, fee);
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
// `targetFunctionName` defaults to "rebalance" — this same binary-search
// technique also fits harvestFees() (runClaimFees below): collected fees
// only exist in the vault's real balance once collect() runs INSIDE that
// atomic call, same "a standalone quote can't see it" problem this function
// exists to solve for rebalance()'s decreaseLiquidity+collect.
async function minAmountOutForRebalanceSwap(
  chain: ChainRuntime,
  vaultAddress: Address,
  buildArgs: (amountOutMinimum: bigint) => readonly unknown[],
  swap: { sellStable: boolean; amountIn: bigint },
  ethPriceUsd: number,
  maxSlippageBps: bigint,
  abi: Abi = chain.vaultAbi as Abi,
  targetFunctionName: string = "rebalance",
  simulateAsAccount?: Address,
): Promise<bigint | null> {
  if (swap.amountIn === 0n) return 0n;
  if (!(await wouldSucceed(chain, vaultAddress, targetFunctionName, buildArgs(0n), abi, simulateAsAccount))) return null;

  // Generous upper bound for the search range — pre-fee, pre-impact spot
  // conversion, always >= the real achievable output.
  const spotEstimate = swap.sellStable
    ? BigInt(Math.ceil(((Number(swap.amountIn) * 10 ** -chain.stableDecimals) / ethPriceUsd) * 10 ** chain.volatileDecimals))
    : BigInt(Math.ceil(Number(swap.amountIn) * 10 ** -chain.volatileDecimals * ethPriceUsd * 10 ** chain.stableDecimals));

  let lo = 0n;
  let hi = spotEstimate;
  const precision = spotEstimate / 2000n || 1n; // ~0.05% of the estimate
  for (let i = 0; i < 12 && hi - lo > precision; i++) {
    const mid = (lo + hi + 1n) / 2n;
    // eslint-disable-next-line no-await-in-loop -- sequential probes of the same contract, deliberately not parallelized
    if (await wouldSucceed(chain, vaultAddress, targetFunctionName, buildArgs(mid), abi, simulateAsAccount)) lo = mid;
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
  chain: ChainRuntime,
  vaultAddress: Address,
  amountIn: bigint,
  tickLower: number,
  tickUpper: number,
  fee: number,
): Promise<bigint> {
  if (amountIn === 0n) return amountIn;
  const lo = Math.min(tickLower, tickUpper);
  const hi = Math.max(tickLower, tickUpper);
  // Keep the estimated post-swap price at least this many ticks inside the
  // range — plain safety margin so ordinary price drift before the tx
  // confirms doesn't immediately push it back out. Still meaningful even
  // when fee routes through a different pool than the position's own
  // (arbitrage keeps this pair's price in sync across fee tiers for the
  // same underlying pair, so a violent move in any of them is still signal).
  const SAFETY_MARGIN_TICKS = 10;

  let candidate = amountIn;
  for (let i = 0; i < 6; i++) {
    if (candidate === 0n) return 0n;
    let amountOut: bigint;
    try {
      amountOut = await quoteExactInputSingle(chain, vaultAddress, chain.stableToken, chain.volatileToken, candidate, fee);
    } catch {
      return candidate; // can't quote a smaller size either — use what we have
    }
    const execRate = Number(amountOut) / Number(candidate); // this trade's own realized volatile-raw-per-stable-raw rate
    if (!Number.isFinite(execRate) || execRate <= 0) return candidate;
    const rawToHumanExp = chain.stableDecimals - chain.volatileDecimals; // -12 for 6/18, matches the old hardcoded 1e-12
    const estimatedTick = tickFromEthPrice(
      1 / (execRate * 10 ** rawToHumanExp),
      chain.stableIsToken0,
      chain.stableDecimals,
      chain.volatileDecimals,
    );

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
  chain: ChainRuntime,
  vaultAddress: Address,
  input: {
    currentTick: number;
    tickLower: number;
    tickUpper: number;
    availableStableRaw: bigint;
    ethPriceUsd: number;
  },
  fee: number,
): Promise<{ sellStable: true; amountIn: bigint }> {
  const guess = sizeInitialSwap({
    ...input,
    stableIsToken0: chain.stableIsToken0,
    stableDecimals: chain.stableDecimals,
    volatileDecimals: chain.volatileDecimals,
  });
  if (guess.amountIn === 0n) return guess;

  // Only the position's OWN pool (chain.feeTier) is affected by this swap
  // when it routes there too — a swap through a different, deeper pool never
  // touches that pool's reserves, so its tick simply stays at
  // input.currentTick regardless of swap size. Re-estimating a "post-swap
  // tick" from the OTHER pool's execution rate would describe a pool the
  // mint never happens in.
  const sameFeeAsPosition = fee === chain.feeTier;

  const investable = Number(input.availableStableRaw);
  let candidate = guess.amountIn;

  try {
    for (let i = 0; i < 4; i++) {
      if (candidate === 0n) break;
      const realAmountOut = await quoteExactInputSingle(chain, vaultAddress, chain.stableToken, chain.volatileToken, candidate, fee);
      const execRate = Number(realAmountOut) / Number(candidate); // WETH raw per USDT raw, actually observed
      if (!Number.isFinite(execRate) || execRate <= 0) break;

      // Where THIS candidate's own swap would actually leave the MINT pool —
      // same estimation capSwapWithinRange uses below — so the ratio we
      // solve against reflects the post-swap state, not the pre-swap one.
      // Skipped when swapping through a different pool (see above).
      const rawToHumanExp = chain.stableDecimals - chain.volatileDecimals; // -12 for 6/18, matches the old hardcoded 1e-12
      const ratioTick = sameFeeAsPosition
        ? tickFromEthPrice(1 / (execRate * 10 ** rawToHumanExp), chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals)
        : input.currentTick;
      // targetRawRatio always returns amount1Raw/amount0Raw (real Uniswap
      // terms) — volatile/stable only when stableIsToken0 (token0=stable,
      // token1=volatile, true on Celo). On Arbitrum token0=volatile, so this
      // is stable/volatile instead: the RECIPROCAL of execRate's units
      // (always volatile-out/stable-in, chain-agnostic). Solving the
      // equation below with mismatched units silently collapsed `corrected`
      // to ~0 on Arbitrum (confirmed in production 2026-07-17, vault
      // 0x45d5a25A...663E3Be — the "converged" swap size floored to zero,
      // never actually swapping anything, minting fully one-sided into a
      // range that spans the live price and reverting with 0 liquidity).
      const rawRatio = targetRawRatio({ currentTick: ratioTick, tickLower: input.tickLower, tickUpper: input.tickUpper });
      if (!Number.isFinite(rawRatio) || rawRatio < 0) break;
      const volatilePerStableRatio = chain.stableIsToken0 ? rawRatio : 1 / rawRatio;
      if (!Number.isFinite(volatilePerStableRatio) || volatilePerStableRatio <= 0) break;

      // Solve x*execRate / (investable - x) = volatilePerStableRatio for x.
      const corrected = (volatilePerStableRatio * investable) / (execRate + volatilePerStableRatio);
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

  const cappedAmountIn = await capSwapWithinRange(chain, vaultAddress, candidate, input.tickLower, input.tickUpper, fee);
  return { sellStable: true, amountIn: cappedAmountIn };
}

export async function runInitPosition(
  chain: ChainRuntime,
  vaultAddress: Address,
  store: Store,
  abi: Abi = chain.vaultAbi as Abi,
): Promise<void> {
  const record = await store.getVault(vaultAddress);
  // No uni-lab dependency here anymore (see below) — a vault can build its
  // initial position even before its uni-lab registration lands. Rebalances
  // still require the api_key, checked separately in runRebalance.
  if (!record) {
    logEvent({ level: "error", vault: vaultAddress, msg: "vault not found in store, skipping initPosition" });
    return;
  }

  chain = applyVaultPair(chain, await resolveVaultPair(chain, vaultAddress, abi, store, record));
  const vault = vaultContract(chain, vaultAddress, abi);
  const [targetTickLower, targetTickUpper, investableUsdt, maxSlippageBps, pool] = await Promise.all([
    vault.read.targetTickLower() as Promise<number>,
    vault.read.targetTickUpper() as Promise<number>,
    vault.read.investableUsdt() as Promise<bigint>,
    vault.read.maxSlippageBps() as Promise<bigint>,
    vault.read.pool() as Promise<Address>,
  ]);

  const tick = await currentTick(chain, pool);
  const ethPrice = ethPriceFromTick(tick, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals);

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
  // genuinely drives the outcome. See autorange.md.
  const swapFee = await pickDeepestSwapFee(chain);
  const swapIx = await sizeInitialSwapAccurate(
    chain,
    vaultAddress,
    {
      currentTick: tick,
      tickLower: targetTickLower,
      tickUpper: targetTickUpper,
      availableStableRaw: investableUsdt,
      ethPriceUsd: ethPrice,
    },
    swapFee,
  );

  const initAmountOutMinimum = await minAmountOutForSwap(chain, vaultAddress, swapIx, maxSlippageBps, swapFee);
  const initArgs = [
    { token0ToToken1: toToken0ToToken1(swapIx.sellStable, chain), amountIn: swapIx.amountIn, amountOutMinimum: initAmountOutMinimum, fee: swapFee },
    0n,
    0n,
  ] as const;

  if (!(await wouldSucceed(chain, vaultAddress, "initPosition", initArgs, abi))) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "initPosition simulation reverts — skipping cycle (check vault config)",
    });
    return;
  }

  if (!(await hasEnoughOperatorGas(chain, vaultAddress, { functionName: "initPosition", args: initArgs }, abi))) {
    return;
  }

  const hash = await sendTaggedTx(chain, vaultAddress, abi, "initPosition", initArgs);
  await chain.publicClient.waitForTransactionReceipt({ hash });

  await store.upsertVault({ ...record, positionInitialized: true });
  logEvent({ level: "info", vault: vaultAddress, msg: "position initialized", txHash: hash });

  await maybeSweepIdleDust(chain, vaultAddress, store, abi);
}

/**
 * B1 for uni-lab: every dollar that has ever actually entered this vault's
 * working position, counted once, at the moment it enters — the definition
 * settled on in wild-exploring-bumblebee.md after the compound-interest
 * feature made the previous "sum every Deposited event" version wrong (it
 * never counted fee reinjections at all, and counted reserve at the wrong
 * moment). A1 (current position value at rebalance time) is computed
 * elsewhere, live from on-chain position liquidity — this function only ever
 * produces B1.
 *
 * Four kinds of event move the needle, all summed across this vault's full
 * history:
 *   - Deposited.investableAmount ONLY (not reserveAmount) — investable
 *     capital is immediately working; reserveAmount is still just sitting in
 *     reserveBalance, not yet part of the position, so it doesn't count yet.
 *   - Rebalanced.reinjectedAmount / ReinjectedIntoPosition.amount — the
 *     moment reserve actually moves into the position. Already pure stable
 *     units, no conversion needed. This is also what fixes standard
 *     (non-compound) vaults that reinject reserve: the reserve those move
 *     was never counted at deposit time above, so this is the only place it
 *     ever enters B1.
 *   - FeesReinjected.netFeeUsd (compound vaults only — simply absent from a
 *     standard vault's ABI, so this branch never fires for one) — LP fees
 *     reinjected instead of paid out, already converted to stable-raw units
 *     by the contract itself at the moment of reinjection.
 *   - Withdrawn.principalUsd / EmergencyWithdraw.principalUsd, SUBTRACTED —
 *     symmetric to the additions above. Deliberately excludes fees (never
 *     added to B1, so never subtracted either) and un-reinjected reserve
 *     (same reasoning — it was never added). Only present on the compound
 *     ABI today (RangeVaultArbCompound.sol); a standard vault's Withdrawn/
 *     EmergencyWithdraw decode without this field, so a partial withdrawal
 *     from an existing standard vault doesn't yet lower B1 — known
 *     limitation, tracked until RangeVaultArb.sol gets the same fix.
 *
 * Deliberately NOT TargetConfigured.investmentAmountUsd (the original
 * source, before Deposited-summing replaced it): that field is purely
 * informational — nothing on-chain enforces it matches the real deposit —
 * and VaultDetail.tsx's reconfigure flow resends a LATER TargetConfigured
 * with investableUsdt (the vault's idle balance at that moment) in that same
 * field, not a new deposit, which is why only the first occurrence was ever
 * trusted. Confirmed in production 2026-07-18 (vault 0x43cb13B9...972703e):
 * that first TargetConfigured carried investmentAmountUsd=0 (a real on-chain
 * data bug from whatever created the vault, immutable now), silently sending
 * B1=0 to uni-lab.xyz on every rebalance attempt despite a real 420 USDT
 * deposit sitting in the vault — uni-lab's own API docs list "input
 * combination doesn't produce a valid rebalance range" as a real cause of
 * its 500 response, and B1=0 against a real, nonzero position (A1) is
 * exactly that kind of degenerate input. Deposited events don't have this
 * failure mode: the contract itself only ever emits them with the real
 * amounts it just transferFrom'd.
 */
async function getCumulativeInvestmentUsd(
  chain: ChainRuntime,
  vaultAddress: Address,
  fromBlock: bigint,
  abi: Abi = chain.vaultAbi as Abi,
): Promise<number> {
  // Was a hand-rolled chunked scan with no retry — forno.celo.org confirmed
  // flaky in a way plain retry-on-error can't catch (an identical eth_getLogs
  // request for the same range intermittently comes back empty, a
  // "successful" response, not a thrown error — see lib/getLogsChunked.ts's
  // own docstring). Confirmed live 2026-07-19 (vault 0x00a393AB...78F52b):
  // B1 flip-flopped between 0 and its real value (500) across consecutive
  // rebalance attempts minutes apart, sending uni-lab.xyz a degenerate B1=0
  // roughly every other cycle and burning a real x402 payment each time for
  // nothing. getLogsChunkedMulti re-verifies a suspiciously empty chunk
  // before trusting it — the same fix already applied to the dashboard's
  // scans, just missing here since this was its own separate implementation.
  const logs = await getLogsChunkedMulti(chain.publicClient, { address: [vaultAddress], fromBlock, toBlock: "latest" });
  const events = parseEventLogs({ abi, logs });

  let totalRaw = 0n;
  // Tracks PositionIncreased leftovers that were ALREADY counted in full via
  // usdtAmount below, but didn't fold into the NFT that same cycle — sitting
  // in investableUsdt, pooled into the SAME on-chain uncountedInvestable
  // counter a bare deposit()/depositToken() top-up would also use. When a
  // LATER Rebalanced/IdleDustSwept folds that pool in and reports
  // consumedUncounted, this off-chain shadow counter is what lets us tell
  // "this amount was already counted (protect it, don't add again)" apart
  // from "this is a genuine bare top-up being counted for the first time
  // (add it)" — the contract itself can't distinguish the two provenances
  // (uncountedInvestable is a single pooled uint256), so this is the closest
  // off-chain approximation: consume the PositionIncreased-sourced shadow
  // balance FIRST, only counting whatever consumedUncounted exceeds it.
  // Bug found live 2026-07-29 (vault 0x7186CE90...4D78c7): a $10 top-up
  // (usdtAmount=10, consumedUncounted=7.017287 that same cycle) left
  // $2.982713 sitting in investableUsdt, already counted via usdtAmount
  // above — a LATER IdleDustSwept folded part of it in
  // (consumedUncounted=0.221142) and, before this fix, added it to B1 a
  // SECOND time.
  let pendingFromIncreasePosition = 0n;
  for (const ev of events) {
    const args = ev.args as Record<string, unknown>;
    if (ev.eventName === "Deposited") {
      // V1 vaults (no `positionAlreadyExists` field, always undefined here)
      // keep the original behavior: investableAmount counts immediately at
      // deposit time, unconditionally. V2 vaults only count it immediately
      // when there was no position yet — a later top-up instead increments
      // uncountedInvestable on-chain and gets counted below, via
      // consumedUncounted, at the moment it's actually folded into the
      // position (see RangeVaultArbCompoundV2.sol's own docstring on
      // uncountedInvestable for why: sweepIdleDust() can fold a pending
      // top-up into the real position without any V1-era event summing it
      // toward B1 — this is what closes that gap for V2 vaults).
      if ((args.positionAlreadyExists as boolean | undefined) !== true) {
        totalRaw += args.investableAmount as bigint;
      }
    } else if (ev.eventName === "PositionIncreased") {
      // increasePosition()/increasePositionWithToken() ("Sumar a la
      // posición abierta") — always usdtAmount (the FULL amount the owner
      // put in this call), never consumedUncounted. Missing this meant B1
      // silently understated true committed capital by exactly whatever the
      // owner topped up this way — confirmed live 2026-07-27, vault
      // 0x55CB44A1...947D19: a $20 top-up left B1 reporting $100.27 instead
      // of the real $120.27 until this fix.
      //
      // Deliberately NOT consumedUncounted, despite V2 emitting it (2026-07-28
      // correction, same day it was first tried the other way): unlike a
      // bare deposit()/depositToken() call — which never touches the live
      // position in that same tx, so genuinely counts only once folded in
      // later — increasePosition() DOES call increaseLiquidity() in the SAME
      // transaction. The owner's capital leaves their wallet and enters the
      // vault's working capital right then, even if Uniswap's own ratio math
      // could only mint part of it into the NFT this specific call (the rest
      // waits in investableUsdt for the next fold-in) — same "cuenta igual
      // que un depósito" rule this function's own original design settled
      // on for this event, before consumedUncounted briefly changed it.
      // Real vault confirmed this the same day: usdtAmount=10,
      // consumedUncounted=7.017287 — B1 must count the full 10, not 7.02.
      const usdtAmount = args.usdtAmount as bigint;
      totalRaw += usdtAmount;
      // V1 has no consumedUncounted field at all — falls back to usdtAmount
      // (fully "consumed" this same cycle), so leftover is always 0 and this
      // shadow counter never grows for a V1 vault, matching its untouched
      // original behavior exactly.
      const consumedThisCycle = (args.consumedUncounted as bigint | undefined) ?? usdtAmount;
      if (usdtAmount > consumedThisCycle) pendingFromIncreasePosition += usdtAmount - consumedThisCycle;
    } else if (ev.eventName === "Rebalanced" || ev.eventName === "IdleDustSwept") {
      if (ev.eventName === "Rebalanced") totalRaw += args.reinjectedAmount as bigint;
      // V2 only — how much of this cycle's fold-in was previously-pending
      // investable (see uncountedInvestable's own docstring). Protect
      // whatever's still owed to a PositionIncreased leftover (already
      // counted above) FIRST — only the excess, if any, is a genuine
      // never-yet-counted bare deposit()/depositToken() top-up finally
      // folding in.
      const consumed = (args.consumedUncounted as bigint | undefined) ?? 0n;
      const protectedAmount = consumed < pendingFromIncreasePosition ? consumed : pendingFromIncreasePosition;
      pendingFromIncreasePosition -= protectedAmount;
      totalRaw += consumed - protectedAmount;
    } else if (ev.eventName === "ReinjectedIntoPosition") {
      totalRaw += args.amount as bigint;
    } else if (ev.eventName === "FeesReinjected") {
      totalRaw += (args.netFeeUsd as bigint | undefined) ?? 0n;
    } else if (ev.eventName === "Withdrawn" || ev.eventName === "EmergencyWithdraw") {
      totalRaw -= (args.principalUsd as bigint | undefined) ?? 0n;
    }
  }
  if (totalRaw < 0n) totalRaw = 0n; // defensive clamp — should never go negative, guards against any rounding drift

  return Number(totalRaw) * 10 ** -chain.stableDecimals; // raw stable-leg units, this vault's own decimals
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
/**
 * Computes uni-lab-derived rebalance parameters without sending any
 * transaction — shared by runRebalanceViaUniLab (the keeper's own cycle,
 * which sends `rebalance()` itself right after this returns) and
 * computeOwnerRebalanceParams (a new API route hands these back to the
 * vault's owner to sign `ownerRebalance()` with their own wallet). Returns
 * null at every point the keeper's own cycle would have logged-and-skipped
 * — same gates, same uni-lab call, same swap sizing, just without the send.
 *
 * targetFunctionName/simulateAsAccount let the final slippage-search
 * (minAmountOutForRebalanceSwap) simulate against whichever function the
 * caller will actually send, signed by whichever address will actually
 * sign it — required for ownerRebalance() specifically, since it's
 * onlyOwner, not onlyOperator (see simulateAttempt's own docstring).
 */
async function computeRebalanceParams(
  chain: ChainRuntime,
  vaultAddress: Address,
  store: Store,
  reason: "periodic" | "out-of-range-bottom",
  abi: Abi = chain.vaultAbi as Abi,
  targetFunctionName: string = "rebalance",
  simulateAsAccount?: Address,
  // Owner-forced rebalances only (see computeOwnerRebalanceParams) — skips
  // the periodic-pin below even though the position is still in range, so
  // D1 recenters via recenterMarginBps under the LIVE price right now. The
  // whole point of forcing a rebalance is usually "I just changed the
  // margin, apply it now" (or similar) — pinning to the OLD floor (the
  // keeper's own periodic behavior) would silently ignore that until a real
  // out-of-range-bottom break happened on its own, defeating the feature.
  forceRecenter: boolean = false,
): Promise<{
  newTickLower: number;
  newTickUpper: number;
  swapIx: { token0ToToken1: boolean; amountIn: bigint; amountOutMinimum: bigint; fee: number };
  reinjectAmount: bigint;
} | null> {
  const record = await store.getVault(vaultAddress);
  if (!record?.uniLabApiKey) {
    logEvent({ level: "error", vault: vaultAddress, msg: "no uni-lab api key on record, skipping rebalance" });
    return null;
  }

  const vault = vaultContract(chain, vaultAddress, abi);
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
    pool,
  ] = await Promise.all([
    vault.read.positionTokenId() as Promise<bigint>,
    vault.read.reinjectionAmount() as Promise<bigint>, // owner's per-cycle ceiling — see RangeVault.sol
    vault.read.positionManager() as Promise<Address>,
    vault.read.reserveBalance() as Promise<bigint>,
    vault.read.investableUsdt() as Promise<bigint>, // dust left idle from a PRIOR cycle — see availableToken0Raw below
    chain.publicClient.readContract({ address: chain.volatileToken, abi: erc20Abi, functionName: "balanceOf", args: [vaultAddress] }) as Promise<bigint>, // volatile-side counterpart of idleInvestableUsdt — see availableToken1Raw below
    // Falls back to the platform's old hardcoded 5% for vaults cloned from
    // an implementation that predates this field — that call reverts
    // outright (RangeVault has no fallback()), not just "returns 0", so a
    // bare read here would break every pre-existing vault's keeper cycle.
    (vault.read.recenterMarginBps() as Promise<bigint>).catch(() => 500n),
    vault.read.platformConfig() as Promise<Address>, // for currentRebalanceFee — see ensureFeeCoverage below
    vault.read.maxSlippageBps() as Promise<bigint>,
    vault.read.pool() as Promise<Address>,
  ]);

  const [tick, spacing, position] = await Promise.all([
    currentTick(chain, pool),
    tickSpacing(chain, pool),
    chain.publicClient.readContract({
      address: positionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [positionTokenId],
    }) as Promise<
      readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
    >,
  ]);

  const [, , , , , posTickLower, posTickUpper, liquidity] = position;
  const ethPrice = ethPriceFromTick(tick, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals);

  // IMPORTANT: whether a HIGHER tick means a LOWER or HIGHER USD price
  // depends on which real token0/token1 slot the stablecoin landed in —
  // true stableIsToken0 (Celo, USDT<WETH) means higher tick = lower price;
  // false (Arbitrum, WETH<USDC) means the opposite. Uniswap always stores
  // posTickLower < posTickUpper numerically, so the USD-price floor is
  // posTickUpper on Celo but posTickLower on Arbitrum. Confirmed in
  // production 2026-07-17: code that assumed Celo's direction unconditionally
  // would have pinned D1 to the wrong edge of an Arbitrum position entirely.
  const floorTick = chain.stableIsToken0 ? Math.max(posTickLower, posTickUpper) : Math.min(posTickLower, posTickUpper);

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
  const stillInRangeForPeriodicPin = reason === "periodic" && tick <= floorTick && !forceRecenter;
  // recenterMarginBps is the owner-set "how far below live price" for a
  // from-scratch floor (RangeVault.sol) — 500 == 5%, same shape as
  // maxSlippageBps/maxRangeDeviationBps elsewhere in this file.
  const newLowerPrice = stillInRangeForPeriodicPin
    ? ethPriceFromTick(floorTick, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals)
    : ethPrice * (1 - Number(recenterMarginBps) / 10_000); // D1
  // Set below, from uni-lab's real answer — there is no local fallback for
  // the real mint (explicit product decision, 2026-07-16): if uni-lab can't
  // be reached or gives nothing usable, the cycle returns before this is
  // ever read. A local zero-margin guess used to live here as a fallback and
  // reliably minted a position that was already out of range the moment
  // price moved at all before the tx confirmed — confirmed in production
  // 2026-07-16 (vault 0x8Ed2ad9f...42737C88).

  const { amount0Raw: closedAmount0Raw, amount1Raw: closedAmount1Raw } = estimatePositionAmounts({
    liquidity,
    currentTick: tick,
    tickLower: posTickLower,
    tickUpper: posTickUpper,
  });
  // amount0Raw/amount1Raw are Uniswap's real token0/token1 — route to
  // stable/volatile based on this chain's actual order.
  const closedStableRaw = chain.stableIsToken0 ? closedAmount0Raw : closedAmount1Raw;
  const closedVolatileRaw = chain.stableIsToken0 ? closedAmount1Raw : closedAmount0Raw;
  const positionValueUsd = closedStableRaw * 10 ** -chain.stableDecimals + closedVolatileRaw * 10 ** -chain.volatileDecimals * ethPrice;

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
  const availableStableRaw = BigInt(Math.floor(closedStableRaw)) + reinjectAmount + idleInvestableUsdt;
  const availableVolatileRaw = BigInt(Math.floor(closedVolatileRaw)) + idleWeth;

  // Real swap sizing helper, reused for the actual mint below once uni-lab's
  // range is known — no probe/guessed range fed through this anymore (see
  // the fresh state re-check right below).
  const buildSwapIx = (tickLower: number, tickUpper: number) =>
    sizeRebalanceSwap({
      currentTick: tick,
      newTickLower: tickLower,
      newTickUpper: tickUpper,
      availableStableRaw,
      availableVolatileRaw,
      ethPriceUsd: ethPrice,
      stableIsToken0: chain.stableIsToken0,
      stableDecimals: chain.stableDecimals,
      volatileDecimals: chain.volatileDecimals,
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
    return null;
  }

  // B1: always the vault's ENTIRE committed capital (original investment +
  // every reinjection to date), never just the current position's live
  // value — even on a still-in-range periodic cycle. The position's USD
  // value moves with price inside the range (impermanent-loss-style), so it
  // can sit below what was actually invested even while genuinely in range;
  // using positionValueUsd here would understate B1 and feed uni-lab a
  // "amount to recover" smaller than the real capital at stake. This is
  // ALWAYS the capital committed *before* this cycle — it must never include
  // this cycle's own RESERVE reinjection (see reinjectAmountUsd below),
  // which hasn't happened yet at the moment this is read. `investableUsdt`
  // is DIFFERENT: getCumulativeInvestmentUsd already counted its
  // `Deposited.investableAmount` immediately at deposit time (same rule
  // withdraw()'s own principalUsd assumes — see that function's docstring),
  // so it must NOT be added again here when it finally gets folded into the
  // mint — doing so double-counts it (caught live 2026-07-28 against vault
  // 0x55CB44A1...947D19, before this fix).
  const historicalAmountToRecoverUsd = await getCumulativeInvestmentUsd(chain, vaultAddress, BigInt(record.createdAtBlock), abi);

  // RC method (2026-07-28, replaces the old RLP-style split where reserve
  // reinjection went through E1/reinvestmentAmountUsd instead): fold the
  // reserve reinjection happening THIS cycle into BOTH A1 and B1 at once,
  // and always send E1=0. `idleInvestableUsdt` folds into A1 only (uni-lab
  // needs the position's real post-mint size), never into B1 (see above —
  // already counted at deposit time). Verified empirically against a real
  // vault (2026-07-28): parametrizing an equivalent scenario via E1 (RLP)
  // vs. this combined A1/B1 (RC) produced the IDENTICAL new_upper_bound from
  // uni-lab down to the cent, so this is a pure simplification for the
  // reserve leg, not a behavior change.
  //
  // GAP CLOSED FOR V2 VAULTS (RangeVaultArbCompoundV2.sol) — was previously
  // documented here as unfixed, needing a contract change: a later
  // `deposit()`'s investableAmount used to only ever fold into the real
  // position via `rebalance()`/`sweepIdleDust()`, with no way for the
  // contract to tell "genuine swap dust" (already counted, never sums)
  // apart from "a pending top-up that happens to get swept" (should sum).
  // V2 tracks this on-chain (`uncountedInvestable`, `Deposited.
  // positionAlreadyExists`, `consumedUncounted` on `Rebalanced`/
  // `IdleDustSwept`/`PositionIncreased`) and `getCumulativeInvestmentUsd`
  // above already reads those fields. V1 vaults keep the original
  // behavior (investableAmount always counts at deposit time — see that
  // function's own comment) since they have none of these fields; this
  // function itself is currently only ever called for V1 vaults (V2 isn't
  // wired into the keeper yet), so `idleInvestableUsdt` below still only
  // folds into A1, never B1 here — revisit once V2 vaults are connected,
  // since a V2 vault's still-pending idleInvestableUsdt SHOULD fold into
  // both A1 and B1 together in that case, same as reinjectAmountUsd.
  const reinjectAmountUsd = Number(reinjectAmount) * 10 ** -chain.stableDecimals;
  const idleInvestableUsd = Number(idleInvestableUsdt) * 10 ** -chain.stableDecimals;
  const combinedCurrentLiquidityUsd = positionValueUsd + reinjectAmountUsd + idleInvestableUsd;
  const combinedAmountToRecoverUsd = historicalAmountToRecoverUsd + reinjectAmountUsd;

  // 1% safety margin on B1, ALWAYS applied (not just to dodge the 500 below)
  // — confirmed live 2026-08-01 (vault 0x7186CE90...4D78c7's first
  // ownerRebalance()): uni-lab's ceiling is calibrated so the position's
  // value AT that exact continuous price equals B1, but the real mint can
  // only land on the nearest valid tick (alignToTickSpacing rounds to
  // nearest, either direction) — here it landed $0.31 (0.07%) short of full
  // capital recovery at the real ceiling. Padding the B1 uni-lab targets by
  // 1% shifts the ceiling slightly further out, comfortably covering that
  // tick-rounding noise (plus the swap-execution/volatility slippage the
  // user also observed) in exchange for a marginally later rebalance at the
  // top — never applied to A1/B1 anywhere else in the app (ledger, UI,
  // useVaultCumulativeInvestment), only to what gets SENT to uni-lab here.
  const marginedAmountToRecoverUsd = combinedAmountToRecoverUsd * 1.01;

  // uni-lab.xyz's /rc-rlp-rebalance returns 500 ("input combination doesn't
  // produce a valid rebalance range" — its own documented meaning) whenever
  // A1 (currentLiquidityUsd, the position's live value) exceeds B1 — root-
  // caused by the user from real production data 2026-07-19 (vault
  // 0x00a393AB...78F52b): real yield/appreciation (the volatile asset's
  // price rising) can push the position's live value slightly above its
  // original committed capital, and uni-lab's calculator apparently needs
  // B1 strictly greater than A1 in that case, not just equal. A1 itself is
  // NEVER touched — only B1, and only when this specific condition holds;
  // the normal case (B1 already comfortably above A1, the common one) is
  // untouched. 1.0005 (0.05%) is comfortably above float rounding noise
  // without meaningfully distorting the real "amount to recover". Compared
  // against the COMBINED (post-reinjection) A1/B1, not the raw historical
  // ones — those are what actually get sent. Checked against the 1%-margined
  // B1 above, not the raw one — so this only ever kicks in on top of that
  // margin, never instead of it.
  const cappedAmountToRecoverUsd =
    combinedCurrentLiquidityUsd > marginedAmountToRecoverUsd
      ? combinedCurrentLiquidityUsd * 1.0005
      : marginedAmountToRecoverUsd;

  const baseParams = {
    currentLiquidityUsd: combinedCurrentLiquidityUsd,
    amountToRecoverUsd: cappedAmountToRecoverUsd,
    currentPriceVolatileAsset: ethPrice,
    newLowerBound: newLowerPrice,
    reinvestmentAmountUsd: 0,
  };

  // x402-only (2026-07-15) — the operator's own USDC pays uni-lab directly,
  // no vault budget involved at all, always via Celo regardless of which
  // chain THIS vault lives on (see unilab.ts's own docstring). Confirmed
  // working end-to-end on-chain, see HACKATHON.md "Track 2 — x402". The
  // retired on-chain payUniLabFee()+tx_hash path is gone.
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
    resp = await rcRlpRebalanceViaX402(record.uniLabApiKey, baseParams, vaultAddress, chain.id);
  } catch (err) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: "rc-rlp-rebalance (x402) call failed — skipping cycle, no local fallback for the real mint",
      err: String(err),
    });
    return null;
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
      chainId: chain.id,
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
    return null;
  }
  const newUpperPrice = upper;

  // Higher USD price of ETH = lower tick in this pool, so the converted bounds
  // come out swapped — sort them, Uniswap requires tickLower < tickUpper.
  const tickA = alignToTickSpacing(
    tickFromEthPrice(newLowerPrice, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals),
    spacing,
  );
  const tickB = alignToTickSpacing(
    tickFromEthPrice(newUpperPrice, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals),
    spacing,
  );
  const newTickLower = Math.min(tickA, tickB);
  const newTickUpper = Math.max(tickA, tickB);

  // Re-size the swap against the FINAL range (uni-lab's own answer) — this is
  // the fix for the dust bug: without a real swap here, rebalance() mints
  // with whatever ratio came out of the OLD position, leaving the mismatched
  // side unused.
  //
  // Then guarantee the (possibly zero, on a post-removal vault) flat fee is
  // payable — see ensureFeeCoverage's own docstring.
  const rebalanceFee = await currentRebalanceFee(chain, platformConfig);
  const finalSwap = ensureFeeCoverage(
    buildSwapIx(newTickLower, newTickUpper),
    availableStableRaw,
    rebalanceFee,
    ethPrice,
    chain.stableDecimals,
    chain.volatileDecimals,
  );
  // Safe to route through a different pool than the position's own here: by
  // the time _executeSwap runs inside rebalance(), decreaseLiquidity()+
  // collect() have already moved the old position's tokens into the vault's
  // real balance, same-tx — unlike the standalone pre-tx quote this whole
  // rebalance-swap path exists to avoid (see minAmountOutForRebalanceSwap).
  const swapFee = await pickDeepestSwapFee(chain);
  const buildFinalArgs = (amountOutMinimum: bigint) =>
    [
      newTickLower,
      newTickUpper,
      { token0ToToken1: toToken0ToToken1(finalSwap.sellStable, chain), amountIn: finalSwap.amountIn, amountOutMinimum, fee: swapFee },
      reinjectAmount,
      0n,
      0n,
    ] as const;

  // Real gate, using uni-lab's actual computed range instead of the earlier
  // local guess — the probe above only ever checked our own estimate, and
  // never validated what actually gets sent. uni-lab is already paid at this
  // point either way; this only prevents burning gas on a doomed send.
  const finalAmountOutMinimum = await minAmountOutForRebalanceSwap(
    chain,
    vaultAddress,
    buildFinalArgs,
    finalSwap,
    ethPrice,
    maxSlippageBps,
    abi,
    targetFunctionName,
    simulateAsAccount,
  );
  if (finalAmountOutMinimum === null) {
    logEvent({
      level: "warn",
      vault: vaultAddress,
      msg: `${targetFunctionName} reverts on uni-lab's real range — skipping (uni-lab already paid this cycle)`,
      newTickLower,
      newTickUpper,
    });
    return null;
  }

  return {
    newTickLower,
    newTickUpper,
    swapIx: {
      token0ToToken1: toToken0ToToken1(finalSwap.sellStable, chain),
      amountIn: finalSwap.amountIn,
      amountOutMinimum: finalAmountOutMinimum,
      fee: swapFee,
    },
    reinjectAmount,
  };
}

async function runRebalanceViaUniLab(
  chain: ChainRuntime,
  vaultAddress: Address,
  store: Store,
  reason: "periodic" | "out-of-range-bottom",
  abi: Abi = chain.vaultAbi as Abi,
): Promise<void> {
  const params = await computeRebalanceParams(chain, vaultAddress, store, reason, abi, "rebalance");
  if (!params) return;

  const finalArgs = [params.newTickLower, params.newTickUpper, params.swapIx, params.reinjectAmount, 0n, 0n] as const;
  if (!(await hasEnoughOperatorGas(chain, vaultAddress, { functionName: "rebalance", args: finalArgs }, abi))) {
    return;
  }

  const hash = await sendTaggedTx(chain, vaultAddress, abi, "rebalance", finalArgs);
  await chain.publicClient.waitForTransactionReceipt({ hash });

  logEvent({
    level: "info",
    vault: vaultAddress,
    msg: "rebalanced",
    reason,
    newTickLower: params.newTickLower,
    newTickUpper: params.newTickUpper,
    reinjectAmount: params.reinjectAmount.toString(),
    txHash: hash,
  });

  await maybeSweepIdleDust(chain, vaultAddress, store);
}

/**
 * Owner-triggered twin of runRebalanceViaUniLab, for RangeVaultArbCompoundV2's
 * new ownerRebalance() (named explicitly in that function's own docstring).
 * Computes the same kind of uni-lab-derived parameters — paid via the
 * operator's own x402 wallet, same as every keeper-triggered rebalance — but
 * returns them instead of sending a tx, so a new API route can hand them
 * back to the vault's OWNER to sign with their own wallet, paying their own
 * gas.
 *
 * Uses reason="periodic" (never reinjects reserve — the owner didn't ask for
 * that, same as a real periodic cycle) but forceRecenter=true: D1 recenters
 * via recenterMarginBps under the LIVE price even though the position is
 * still comfortably in range, instead of pinning to the existing floor like
 * the keeper's own periodic cycle does. This is deliberately DIFFERENT from
 * a real periodic cycle — the whole point of the owner forcing a rebalance
 * is usually "I just changed recenterMarginBps (or another agent
 * parameter), apply it right now" (see CLAUDE.md's own design note for this
 * feature) — pinning to the OLD floor would silently ignore that until a
 * real out-of-range-bottom break happened on its own. Confirmed correct
 * 2026-07-29: recentering here doesn't risk the ~100%-one-sided-position
 * swap-math bug forceRecenter's own docstring guards against in
 * computeRebalanceParams, since that only applies to an ALREADY out-of-range
 * position — an in-range one (the only kind ownerRebalance() can even be
 * called against without reverting anyway) always holds both legs.
 * Simulated against ownerRebalance() itself, as the vault's real owner (not
 * the operator) — see simulateAttempt's own docstring on why that
 * distinction matters for an onlyOwner function.
 */
export async function computeOwnerRebalanceParams(
  chain: ChainRuntime,
  vaultAddress: Address,
  store: Store,
  abi: Abi,
): Promise<
  | {
      ok: true;
      newTickLower: number;
      newTickUpper: number;
      swapIx: { token0ToToken1: boolean; amountIn: bigint; amountOutMinimum: bigint; fee: number };
      reinjectAmount: bigint;
    }
  | { ok: false }
> {
  const owner = (await vaultContract(chain, vaultAddress, abi).read.owner()) as Address;
  const params = await computeRebalanceParams(chain, vaultAddress, store, "periodic", abi, "ownerRebalance", owner, true);
  if (!params) return { ok: false };
  return { ok: true, ...params };
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
async function runRebalanceExitTop(
  chain: ChainRuntime,
  vaultAddress: Address,
  store: Store,
  abi: Abi = chain.vaultAbi as Abi,
): Promise<void> {
  const vault = vaultContract(chain, vaultAddress, abi);
  const [
    positionTokenId,
    positionManager,
    idleInvestableUsdt,
    idleWeth,
    recenterMarginBps,
    exitTopCeilingMarginBps,
    platformConfig,
    maxSlippageBps,
    pool,
  ] = await Promise.all([
    vault.read.positionTokenId() as Promise<bigint>,
    vault.read.positionManager() as Promise<Address>,
    vault.read.investableUsdt() as Promise<bigint>, // dust left idle from a prior cycle — see runRebalanceViaUniLab
    chain.publicClient.readContract({ address: chain.volatileToken, abi: erc20Abi, functionName: "balanceOf", args: [vaultAddress] }) as Promise<bigint>,
    // Same fallback as runRebalanceViaUniLab, same reason: these two revert
    // outright on a vault cloned from an implementation that predates them.
    (vault.read.recenterMarginBps() as Promise<bigint>).catch(() => 500n),
    (vault.read.exitTopCeilingMarginBps() as Promise<bigint>).catch(() => 300n),
    vault.read.platformConfig() as Promise<Address>, // for currentRebalanceFee — see ensureFeeCoverage below
    vault.read.maxSlippageBps() as Promise<bigint>,
    vault.read.pool() as Promise<Address>,
  ]);

  const [tick, spacing, position] = await Promise.all([
    currentTick(chain, pool),
    tickSpacing(chain, pool),
    chain.publicClient.readContract({
      address: positionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [positionTokenId],
    }) as Promise<
      readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
    >,
  ]);

  const [, , , , , posTickLower, posTickUpper, liquidity] = position;
  const ethPrice = ethPriceFromTick(tick, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals);

  const newLowerPrice = ethPrice * (1 - Number(recenterMarginBps) / 10_000);
  const newUpperPrice = ethPrice * (1 + Number(exitTopCeilingMarginBps) / 10_000);

  // Price bounds -> ticks can land in either numeric order depending on
  // stableIsToken0 — sort them, Uniswap requires tickLower < tickUpper.
  const tickA = alignToTickSpacing(
    tickFromEthPrice(newLowerPrice, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals),
    spacing,
  );
  const tickB = alignToTickSpacing(
    tickFromEthPrice(newUpperPrice, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals),
    spacing,
  );
  const newTickLower = Math.min(tickA, tickB);
  const newTickUpper = Math.max(tickA, tickB);

  const { amount0Raw: closedAmount0Raw, amount1Raw: closedAmount1Raw } = estimatePositionAmounts({
    liquidity,
    currentTick: tick,
    tickLower: posTickLower,
    tickUpper: posTickUpper,
  });
  // amount0Raw/amount1Raw are Uniswap's real token0/token1 — route to
  // stable/volatile based on this chain's actual order.
  const closedStableRaw = chain.stableIsToken0 ? closedAmount0Raw : closedAmount1Raw;
  const closedVolatileRaw = chain.stableIsToken0 ? closedAmount1Raw : closedAmount0Raw;

  // Same fix as runRebalanceViaUniLab: fold in any dust already idle from a
  // prior cycle, both sides, or it never enters the swap ratio and just
  // keeps growing. Then guarantee the (possibly zero) flat fee is payable —
  // see ensureFeeCoverage's own docstring.
  const availableStableRaw = BigInt(Math.floor(closedStableRaw)) + idleInvestableUsdt;
  const rebalanceFee = await currentRebalanceFee(chain, platformConfig);
  const swapIx = ensureFeeCoverage(
    sizeRebalanceSwap({
      currentTick: tick,
      newTickLower,
      newTickUpper,
      availableStableRaw,
      availableVolatileRaw: BigInt(Math.floor(closedVolatileRaw)) + idleWeth,
      ethPriceUsd: ethPrice,
      stableIsToken0: chain.stableIsToken0,
      stableDecimals: chain.stableDecimals,
      volatileDecimals: chain.volatileDecimals,
    }),
    availableStableRaw,
    rebalanceFee,
    ethPrice,
    chain.stableDecimals,
    chain.volatileDecimals,
  );

  // Safe here for the same reason as runRebalanceViaUniLab: decreaseLiquidity+
  // collect already ran by the time _executeSwap does, inside the same tx.
  const swapFee = await pickDeepestSwapFee(chain);
  const buildRebalanceArgs = (amountOutMinimum: bigint) =>
    [
      newTickLower,
      newTickUpper,
      { token0ToToken1: toToken0ToToken1(swapIx.sellStable, chain), amountIn: swapIx.amountIn, amountOutMinimum, fee: swapFee },
      0n, // no reinjection — from-scratch rebuild, like initPosition()
      0n,
      0n,
    ] as const;

  const exitTopAmountOutMinimum = await minAmountOutForRebalanceSwap(
    chain,
    vaultAddress,
    buildRebalanceArgs,
    swapIx,
    ethPrice,
    maxSlippageBps,
    abi,
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

  if (!(await hasEnoughOperatorGas(chain, vaultAddress, { functionName: "rebalance", args: rebalanceArgs }, abi))) {
    return;
  }

  const hash = await sendTaggedTx(chain, vaultAddress, abi, "rebalance", rebalanceArgs);
  await chain.publicClient.waitForTransactionReceipt({ hash });

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

  await maybeSweepIdleDust(chain, vaultAddress, store, abi);
}

export async function runRebalance(
  chain: ChainRuntime,
  vaultAddress: Address,
  store: Store,
  reason: "periodic" | "out-of-range-top" | "out-of-range-bottom",
  abi: Abi = chain.vaultAbi as Abi,
): Promise<void> {
  // Resolved ONCE here, then threaded through whichever path below runs —
  // both runRebalanceExitTop and runRebalanceViaUniLab, and everything they
  // call, read stableToken/volatileToken/stableIsToken0/stableDecimals/
  // volatileDecimals off of `chain` directly, so overriding it here once is
  // enough to make every nested call correct for THIS vault's own pair.
  chain = applyVaultPair(chain, await resolveVaultPair(chain, vaultAddress, abi, store));

  if (reason === "out-of-range-top") {
    await runRebalanceExitTop(chain, vaultAddress, store, abi);
    return;
  }
  await runRebalanceViaUniLab(chain, vaultAddress, store, reason, abi);
}
