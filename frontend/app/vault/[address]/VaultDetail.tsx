"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useSwitchChain,
} from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { Header } from "../../components/Header";
import { AlertModal } from "../../components/AlertModal";
import { PositionNFT } from "./PositionNFT";
import { ActivityFeed } from "./ActivityFeed";
import { PositionHistory } from "./PositionHistory";
import { RebalanceCountdown } from "./RebalanceCountdown";
import { erc20Abi, uniswapV3PoolAbi, positionManagerAbi, platformConfigAbi } from "@/lib/contracts";
import type { ChainDef } from "@/lib/chains";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";
import { sizeRebalanceSwap } from "@/lib/keeper/swapMath";
import { useVaultFeesSummary } from "@/lib/useVaultFeesSummary";
import { useVaultDepositSummary } from "@/lib/useVaultDepositSummary";
import { useSelectedChain } from "@/lib/useSelectedChain";
import { useTranslation } from "@/lib/i18n/useTranslation";

const reads = (address: `0x${string}`, chainId: number, vaultAbi: ChainDef["vaultAbi"]) =>
  [
    "owner",
    "operator",
    "positionTokenId",
    "rebalanceCount",
    "maxRebalances",
    "investableUsdt",
    "reserveBalance",
    "targetTickLower",
    "targetTickUpper",
    "paused",
    "closed",
    "targetConfigured",
    "reinjectionAmount",
    "periodicRebalanceInterval",
    "minRebalanceInterval",
    "lastRebalanceTimestamp",
    "maxSlippageBps",
    "maxRangeDeviationBps",
    "recenterMarginBps",
    "exitTopCeilingMarginBps",
    "creationFeeCharged",
    "feeTier",
    "pool",
  ].map((functionName) => ({ address, abi: vaultAbi, functionName, chainId }) as const);

export function VaultDetail({ address }: { address: `0x${string}` }) {
  const { address: connected, chainId: walletChainId } = useAccount();
  const { selectedChain: chain } = useSelectedChain();
  const publicClient = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const { t } = useTranslation();

  // 15s polling keeps the stats live while the keeper acts — the page is a demo
  // surface as much as a control panel.
  const { data, refetch } = useReadContracts({
    contracts: reads(address, chain.id, chain.vaultAbi),
    query: { refetchInterval: 15_000 },
  });

  // Surfaces the keeper's own uni-lab call failures (x402 down, or a 200 with
  // no usable range) instead of letting a stuck rebalance fail silently in
  // server logs — see app/api/vault/[address]/alert. Clears itself once a
  // later call succeeds.
  const { data: rebalanceAlert } = useQuery({
    queryKey: ["vault-rebalance-alert", chain.id, address],
    queryFn: async () => {
      const res = await fetch(`/api/vault/${address}/alert?chainId=${chain.id}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { alert: { message: string; endpoint: string; createdAt: string } | null };
      return body.alert;
    },
    refetchInterval: 30_000,
  });
  const [
    owner,
    operator,
    positionTokenId,
    rebalanceCount,
    maxRebalances,
    investableUsdt,
    reserveBalance,
    targetTickLower,
    targetTickUpper,
    paused,
    closed,
    targetConfigured,
    reinjectionAmount,
    periodicRebalanceInterval,
    minRebalanceInterval,
    lastRebalanceTimestamp,
    maxSlippageBps,
    maxRangeDeviationBps,
    recenterMarginBps,
    exitTopCeilingMarginBps,
    creationFeeCharged,
    feeTierRaw,
    poolRaw,
  ] = data?.map((d) => d.result) ?? [];
  // A vault's real pool/fee tier is chosen at creation time (createVault's
  // caller picks any pool for the pair, not necessarily chain.pool/
  // chain.feeTier's "default" one) — reading them live instead of assuming
  // the chain default matters for display, for increasePosition's swap fee
  // below, AND for every slot0/tickSpacing read this page does (a wrong
  // pool address there means wrong price/tickSpacing for the vault's real
  // position). Confirmed live 2026-07-19: a real vault (0x5cD98eC8...4A5dEcb)
  // was created against Arbitrum's USDC/WETH 0.30% pool, not the 0.05%
  // default, and every one of these read chain.pool/chain.feeTier before
  // this fix.
  const feeTier = feeTierRaw !== undefined ? Number(feeTierRaw) : chain.feeTier;
  const poolAddress = (poolRaw as `0x${string}` | undefined) ?? chain.pool;

  const { data: creationFeeUsdtRaw } = useReadContract({
    address: chain.platformConfigAddress || undefined,
    abi: platformConfigAbi,
    functionName: "creationFeeUsdt",
    chainId: chain.id,
  });
  // Only actually owed if this vault never had a successful deposit() yet —
  // see RangeVault.sol's creationFeeCharged, set permanently true the first
  // time deposit() succeeds.
  const pendingCreationFee = creationFeeCharged === false ? ((creationFeeUsdtRaw as bigint) ?? 0n) : 0n;

  // 0 == no cap, same convention RangeVault.deposit() itself uses — read live
  // so a later platform change (e.g. raising it) is reflected without a
  // frontend redeploy. See handleDepositMore's own check below.
  const { data: maxDepositUsdRaw } = useReadContract({
    address: chain.platformConfigAddress || undefined,
    abi: platformConfigAbi,
    functionName: "maxDepositUsd",
    chainId: chain.id,
  });
  const maxDepositUsd = (maxDepositUsdRaw as bigint) ?? 0n;
  const [capAlert, setCapAlert] = useState<string | null>(null);

  // Separate read (not part of the shared `reads()` list above) — only
  // RangeVaultArb has this function at all; calling it against Celo's own
  // ABI (which lacks it entirely) would fail to encode, not just revert.
  const { data: gasReserveBalanceRaw } = useReadContract({
    address,
    abi: chain.vaultAbi,
    functionName: "gasReserveBalance",
    chainId: chain.id,
    query: { enabled: chain.supportsGasReserve, refetchInterval: 15_000 },
  });
  const gasReserveBalance = (gasReserveBalanceRaw as bigint) ?? 0n;

  const { data: feesSummary } = useVaultFeesSummary(address, chain);
  const { data: depositSummary } = useVaultDepositSummary(address, chain);
  const { data: tickSpacing } = useReadContract({
    address: poolAddress,
    abi: uniswapV3PoolAbi,
    functionName: "tickSpacing",
    chainId: chain.id,
  });
  const { data: slot0 } = useReadContract({
    address: poolAddress,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    chainId: chain.id,
    query: { refetchInterval: 15_000 },
  });
  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;

  const feesUsdtStr = formatUnits(feesSummary?.totalUsdt ?? 0n, 6);
  const feesWethRaw = feesSummary?.totalWeth ?? 0n;
  const feesWethStr = Number(formatUnits(feesWethRaw, 18)).toFixed(6);
  const feesUsdTotal =
    currentTick !== undefined
      ? Number(feesUsdtStr) + Number(formatUnits(feesWethRaw, 18)) * ethPriceFromTick(currentTick, chain.stableIsToken0)
      : undefined;

  // Rentabilidad = comisiones (USD) sobre el monto depositado al crear el
  // vault — mismo cálculo simple que la tarjeta en /vaults, no anualizado.
  const initialInvestmentUsd = Number(formatUnits(depositSummary?.initialInvestmentUsdt ?? 0n, 6));
  const rentLabel =
    feesUsdTotal !== undefined && initialInvestmentUsd > 0
      ? t("vaults.returnLabel", { pct: ((feesUsdTotal / initialInvestmentUsd) * 100).toFixed(2) })
      : undefined;

  const isOwner = Boolean(
    connected && owner && (connected as string).toLowerCase() === (owner as string).toLowerCase(),
  );
  const hasPosition = Boolean(positionTokenId && (positionTokenId as bigint) > 0n);

  // Only needed to size increasePosition()'s swap — the position's OWN live
  // range (not targetTickLower/Upper, which don't move on rebalance()).
  const { data: positionData } = useReadContract({
    address: chain.positionManager,
    abi: positionManagerAbi,
    functionName: "positions",
    args: hasPosition ? [positionTokenId as bigint] : undefined,
    chainId: chain.id,
    query: { enabled: hasPosition, refetchInterval: 15_000 },
  });
  const positionTicks = positionData
    ? {
        tickLower: Number((positionData as readonly unknown[])[5]),
        tickUpper: Number((positionData as readonly unknown[])[6]),
      }
    : undefined;

  // Idle WETH the vault might already be holding (e.g. dust stranded by a
  // prior mis-sized swap) — increasePosition()'s own swap has to account for
  // this too, or the contract's increaseLiquidity() (which sweeps in the
  // vault's FULL token1 balance, not just what this call's swap produces)
  // ends up with more WETH than the swap was sized for, leaving the
  // mismatched USDT side over. Confirmed in production 2026-07-16 (vault
  // 0x0Bf394B3...5dEBCE5b8: $64.92 USDT left over after "Sumar a la
  // posición" ignored ~$190 of pre-existing idle WETH).
  const { data: idleWeth } = useReadContract({
    address: chain.volatileToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    chainId: chain.id,
    query: { refetchInterval: 15_000 },
  });

  const [depInvestable, setDepInvestable] = useState("0");
  const [depReserve, setDepReserve] = useState("0");
  const [depGasReserve, setDepGasReserve] = useState("0");
  const [cfgMaxRebalances, setCfgMaxRebalances] = useState("");
  const [cfgReinjection, setCfgReinjection] = useState("");
  const [cfgPeriodicHours, setCfgPeriodicHours] = useState("");
  const [cfgMinPrice, setCfgMinPrice] = useState("");
  const [cfgMaxPrice, setCfgMaxPrice] = useState("");
  const [cfgRecenterMarginPct, setCfgRecenterMarginPct] = useState("");
  const [cfgExitTopCeilingMarginPct, setCfgExitTopCeilingMarginPct] = useState("");
  const [riskMaxSlippagePct, setRiskMaxSlippagePct] = useState("");
  const [riskMinCooldownHours, setRiskMinCooldownHours] = useState("");
  const [riskMaxRangeDeviationTicks, setRiskMaxRangeDeviationTicks] = useState("");
  const [increaseAmount, setIncreaseAmount] = useState("0");
  const [withdrawPositionPct, setWithdrawPositionPct] = useState("0");
  const [withdrawFundsPct, setWithdrawFundsPct] = useState("0");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Single choke point for every write in this file — the viewing chain
  // (chain, from useSelectedChain) and the wallet's actual connected chain
  // are deliberately decoupled (see lib/useSelectedChain.tsx), so every
  // write has to confirm the wallet is actually on `chain` before signing.
  async function withTx(label: string, fn: () => Promise<`0x${string}`>) {
    if (!publicClient) return;
    setBusy(label);
    setError(null);
    try {
      if (walletChainId !== chain.id) {
        try {
          await switchChainAsync({ chainId: chain.id });
        } catch {
          setError(t("vaultDetail.errSwitchChain", { chain: chain.name }));
          return;
        }
      }
      const hash = await fn();
      await publicClient.waitForTransactionReceipt({ hash });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDepositMore() {
    const investable = parseUnits(depInvestable || "0", 6);
    const reserve = parseUnits(depReserve || "0", 6);
    const gasReserve = chain.supportsGasReserve ? parseUnits(depGasReserve || "0", 6) : 0n;
    const total = investable + reserve + gasReserve;
    if (total === 0n) return;

    // Same check RangeVault.deposit() itself makes (reserveAmount +
    // investableAmount vs PlatformConfig.maxDepositUsd, fee excluded, on top
    // of whatever's already committed) — catch it here so the wallet never
    // even pops up for a deposit that's certain to revert on-chain.
    // Confirmed in production 2026-07-17: a user hit DepositExceedsPlatformCap
    // with no explanation, just a raw revert.
    const currentTotal = ((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n) + gasReserveBalance;
    if (maxDepositUsd > 0n && currentTotal + total > maxDepositUsd) {
      const room = maxDepositUsd > currentTotal ? maxDepositUsd - currentTotal : 0n;
      setCapAlert(
        t("vaultDetail.capAlertMsg", {
          cap: formatUnits(maxDepositUsd, 6),
          symbol: chain.stableSymbol,
          current: formatUnits(currentTotal, 6),
          room: formatUnits(room, 6),
        }),
      );
      return;
    }

    // If this vault never had a successful deposit() yet, this call IS the
    // first one — deposit() pulls PlatformConfig's one-time creationFeeUsdt
    // on top, so the approval has to cover it too (see RangeVault.sol).
    await withTx(t("vaultDetail.txApproving"), () =>
      writeContractAsync({
        address: chain.stableToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [address, total + pendingCreationFee],
        chainId: chain.id,
      }),
    );
    await withTx(t("vaultDetail.txDepositing"), () =>
      writeContractAsync({
        address,
        abi: chain.vaultAbi,
        functionName: "deposit",
        args: chain.supportsGasReserve ? [reserve, investable, gasReserve] : [reserve, investable],
        chainId: chain.id,
      }),
    );
  }

  async function handleReconfigure() {
    // Leaving both price fields blank keeps the existing on-chain tick range
    // (the min/max sort also repairs vaults configured with inverted ticks by
    // an older create flow — higher USD price of ETH = lower tick in this
    // pool). Filling them in sets a FRESH range — the only way to finish
    // configuring a vault that only ever got as far as createVault() (e.g.
    // the create flow was abandoned mid-way): targetTickLower/Upper are both
    // 0 on those, so there's no "existing range" to fall back to.
    let lo: number;
    let hi: number;
    const settingFreshRange = Boolean(cfgMinPrice && cfgMaxPrice);
    if (settingFreshRange) {
      if (tickSpacing === undefined) return;
      const lowerPrice = Number(cfgMinPrice);
      const upperPrice = Number(cfgMaxPrice);
      if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) {
        setError(t("vaultDetail.errPriceRange"));
        return;
      }
      const tickA = alignToTickSpacing(tickFromEthPrice(lowerPrice, chain.stableIsToken0), Number(tickSpacing));
      const tickB = alignToTickSpacing(tickFromEthPrice(upperPrice, chain.stableIsToken0), Number(tickSpacing));
      lo = Math.min(tickA, tickB);
      hi = Math.max(tickA, tickB);
    } else {
      if (targetTickLower === undefined || targetTickUpper === undefined) return;
      lo = Math.min(Number(targetTickLower), Number(targetTickUpper));
      hi = Math.max(Number(targetTickLower), Number(targetTickUpper));
    }

    await withTx(t("vaultDetail.txReconfiguring"), () =>
      writeContractAsync({
        address,
        abi: chain.vaultAbi,
        functionName: "configureTarget",
        args: [
          (investableUsdt as bigint) ?? 0n,
          lo,
          hi,
          BigInt(cfgMaxRebalances || String(maxRebalances ?? 0)),
          parseUnits(cfgReinjection || "0", 6),
          BigInt(Math.round(Number(cfgPeriodicHours || "24") * 3600)),
          cfgRecenterMarginPct
            ? BigInt(Math.round(Number(cfgRecenterMarginPct) * 100))
            : ((recenterMarginBps as bigint) ?? 500n),
          cfgExitTopCeilingMarginPct
            ? BigInt(Math.round(Number(cfgExitTopCeilingMarginPct) * 100))
            : ((exitTopCeilingMarginBps as bigint) ?? 300n),
        ],
        chainId: chain.id,
      }),
    );

    // A fresh range needs its near-market tolerance set too — the vault
    // starts with maxRangeDeviationBps = 0, which makes _checkRangeNearMarket
    // reject initPosition() almost always. Not needed when just tuning
    // cadence/caps on an already-working vault. Uses whatever's in the risk
    // params form below (blank = keep the vault's current value, or the
    // create flow's generous default if it never had one) — resubmitting a
    // range here is also how an already-broken vault's on-chain tolerance
    // gets raised, since setRiskParams is owner-only and this form is the
    // owner-facing path to call it.
    if (settingFreshRange) {
      await handleUpdateRiskParams();
    }
  }

  async function handleUpdateRiskParams() {
    const newMaxSlippageBps = riskMaxSlippagePct
      ? BigInt(Math.round(Number(riskMaxSlippagePct) * 100))
      : ((maxSlippageBps as bigint) ?? 30n);
    const newMinRebalanceInterval = riskMinCooldownHours
      ? BigInt(Math.round(Number(riskMinCooldownHours) * 3600))
      : ((minRebalanceInterval as bigint) ?? 0n);
    const newMaxRangeDeviationBps = riskMaxRangeDeviationTicks
      ? BigInt(riskMaxRangeDeviationTicks)
      : ((maxRangeDeviationBps as bigint) || 5_000n);

    await withTx(t("vaultDetail.txSettingRisk"), () =>
      writeContractAsync({
        address,
        abi: chain.vaultAbi,
        functionName: "setRiskParams",
        args: [newMaxSlippageBps, newMinRebalanceInterval, newMaxRangeDeviationBps],
        chainId: chain.id,
      }),
    );
  }

  async function handleIncreasePosition() {
    const usdtAmount = parseUnits(increaseAmount || "0", 6);
    if (usdtAmount === 0n) return;
    if (!positionTicks || currentTick === undefined) {
      setError(t("vaultDetail.errNoRange"));
      return;
    }

    // Sized client-side — no uni-lab consultation needed, this is just the
    // position's already-known live ratio at the pool's current price, both
    // public reads. Uses sizeRebalanceSwap (a MIXED starting balance), not
    // sizeInitialSwap (all-stable), because the contract's increaseLiquidity()
    // sweeps in the vault's FULL volatile-leg balance — including any WETH
    // already sitting idle from a prior mis-sized swap — not just what
    // usdtAmount alone would produce. Ignoring that pre-existing WETH here is
    // exactly what left $64.92 of USDT stranded in production 2026-07-16
    // (vault 0x0Bf394B3...5dEBCE5b8). The stable side is still capped to
    // usdtAmount to match increasePosition()'s own cap — old investableUsdt
    // dust stays untouched.
    const ethPrice = ethPriceFromTick(currentTick, chain.stableIsToken0);
    const swap = sizeRebalanceSwap({
      currentTick,
      newTickLower: positionTicks.tickLower,
      newTickUpper: positionTicks.tickUpper,
      availableStableRaw: usdtAmount,
      availableVolatileRaw: (idleWeth as bigint) ?? 0n,
      ethPriceUsd: ethPrice,
      stableIsToken0: chain.stableIsToken0,
    });

    await withTx(t("vaultDetail.txApproving"), () =>
      writeContractAsync({
        address: chain.stableToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [address, usdtAmount],
        chainId: chain.id,
      }),
    );
    await withTx(t("vaultDetail.txIncreasing"), () =>
      writeContractAsync({
        address,
        abi: chain.vaultAbi,
        functionName: "increasePosition",
        args: [
          {
            token0ToToken1: swap.sellStable === chain.stableIsToken0,
            amountIn: swap.amountIn,
            amountOutMinimum: 0n,
            fee: feeTier,
          },
          usdtAmount,
          0n,
          0n,
        ],
        chainId: chain.id,
      }),
    );
    setIncreaseAmount("0");
  }

  async function handlePartialWithdraw() {
    const positionShareBps = BigInt(Math.round(Number(withdrawPositionPct || "0") * 100));
    const fundsShareBps = BigInt(Math.round(Number(withdrawFundsPct || "0") * 100));
    if (positionShareBps === 0n && fundsShareBps === 0n) return;
    if (positionShareBps > 10_000n || fundsShareBps > 10_000n) {
      setError(t("vaultDetail.errPctOver100"));
      return;
    }
    await withTx(t("vaultDetail.txWithdrawing"), () =>
      writeContractAsync({
        address,
        abi: chain.vaultAbi,
        functionName: "withdraw",
        args: [positionShareBps, fundsShareBps],
        chainId: chain.id,
      }),
    );
    setWithdrawPositionPct("0");
    setWithdrawFundsPct("0");
  }

  return (
    <>
      {capAlert && (
        <AlertModal title={t("vaultDetail.capAlertTitle")} message={capAlert} onClose={() => setCapAlert(null)} />
      )}
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">
            {t("vaultDetail.eyebrow", {
              pair: `${chain.stableSymbol}/${chain.volatileSymbol}`,
              fee: feeTier / 10_000,
            })}
          </span>
          {paused ? (
            <span className="eyebrow !border-negative/40 !text-negative">{t("vaultDetail.paused")}</span>
          ) : (
            <span className="eyebrow !border-positive/40 !text-positive">{t("vaultDetail.active")}</span>
          )}
          {hasPosition ? (
            <span className="eyebrow !border-accent/40 !text-accent">
              {t("vaultDetail.positionLabel", { id: String(positionTokenId) })}
            </span>
          ) : (
            <span className="eyebrow">{t("vaultDetail.noPositionYet")}</span>
          )}
        </div>

        <h1 className="mt-5 break-all font-mono text-lg text-white/90 sm:text-xl">{address}</h1>
        <p className="mt-2 text-sm text-muted">
          {isOwner ? t("vaultDetail.ownerNote") : t("vaultDetail.readOnlyNote")}
        </p>

        {rebalanceAlert && (
          <div className="glass mt-6 rounded-2xl border-negative/40 bg-negative/[0.06] p-5">
            <p className="text-sm font-medium text-negative">{t("vaultDetail.rebalanceFailedTitle")}</p>
            <p className="mt-1 text-xs text-negative/80">{rebalanceAlert.message}</p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-negative/60">
              {new Date(rebalanceAlert.createdAt).toLocaleString()}
            </p>
          </div>
        )}

        {!data && (
          <div className="glass mt-10 rounded-2xl p-10 text-center">
            <p className="text-muted">{t("vaultDetail.loading")}</p>
          </div>
        )}

        {data && (
          <>
            {/* Stats */}
            <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label={t("vaultDetail.statInvestable")}
                value={`${formatUnits((investableUsdt as bigint) ?? 0n, 6)} ${chain.stableSymbol}`}
                hint={
                  (idleWeth as bigint | undefined) && (idleWeth as bigint) > 0n
                    ? t("vaultDetail.idleWethHint", {
                        amount: Number(formatUnits(idleWeth as bigint, 18)).toFixed(6),
                        symbol: chain.volatileSymbol,
                        usdSuffix:
                          currentTick !== undefined
                            ? ` (~$${(Number(idleWeth as bigint) * 1e-18 * ethPriceFromTick(currentTick, chain.stableIsToken0)).toFixed(2)})`
                            : "",
                      })
                    : undefined
                }
              />
              <Stat
                label={t("vaultDetail.statReserve")}
                value={`${formatUnits((reserveBalance as bigint) ?? 0n, 6)} ${chain.stableSymbol}`}
                hint={t("vaultDetail.reserveHint", {
                  amount: formatUnits((reinjectionAmount as bigint) ?? 0n, 6),
                  symbol: chain.stableSymbol,
                })}
              />
              {chain.supportsGasReserve && (
                <Stat
                  label={t("vaultDetail.statGasBudget")}
                  value={`${formatUnits(gasReserveBalance, 6)} ${chain.stableSymbol}`}
                  hint={t("vaultDetail.gasBudgetHint")}
                />
              )}
              <Stat
                label={t("vaultDetail.statRebalances")}
                value={`${rebalanceCount ?? 0} / ${maxRebalances ?? 0}`}
                accent
              />
              <Stat
                label={t("vaultDetail.statFees")}
                value={
                  feesUsdTotal !== undefined ? `$${feesUsdTotal.toFixed(2)}` : `${feesUsdtStr} ${chain.stableSymbol}`
                }
                hint={
                  feesWethRaw > 0n
                    ? `${feesUsdtStr} ${chain.stableSymbol} + ${feesWethStr} ${chain.volatileSymbol}`
                    : `${feesUsdtStr} ${chain.stableSymbol}`
                }
                hint2={rentLabel}
                accent
              />
            </div>

            {hasPosition && <PositionNFT tokenId={positionTokenId as bigint} chain={chain} pool={poolAddress} />}

            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  {t("vaultDetail.targetRange")}
                </span>
                {targetConfigured ? (
                  <>
                    <p className="mt-2 text-sm font-medium text-white/90">
                      {(() => {
                        const lo = Number(targetTickLower);
                        const hi = Number(targetTickUpper);
                        const priceA = ethPriceFromTick(lo, chain.stableIsToken0);
                        const priceB = ethPriceFromTick(hi, chain.stableIsToken0);
                        const low = Math.min(priceA, priceB);
                        const high = Math.max(priceA, priceB);
                        return `$${low.toFixed(2)} – $${high.toFixed(2)}`;
                      })()}
                    </p>
                    {Number(targetTickLower) > Number(targetTickUpper) && (
                      <p className="mt-1 text-xs text-negative">{t("vaultDetail.invertedTicksWarning")}</p>
                    )}
                    <p className="mt-1.5 font-mono text-[11px] text-faint">
                      ticks [{String(targetTickLower)}, {String(targetTickUpper)}]
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-white/90">{t("vaultDetail.notConfigured")}</p>
                )}
              </div>

              <RebalanceCountdown
                lastRebalanceTimestamp={(lastRebalanceTimestamp as bigint) ?? 0n}
                periodicRebalanceInterval={(periodicRebalanceInterval as bigint) ?? 0n}
                hasPosition={hasPosition}
                paused={Boolean(paused)}
                atRebalanceLimit={Boolean(
                  rebalanceCount !== undefined &&
                    maxRebalances !== undefined &&
                    (rebalanceCount as bigint) >= (maxRebalances as bigint),
                )}
              />

              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  {t("vaultDetail.operator")}
                </span>
                <p className="mt-2 break-all font-mono text-sm text-white/90">{String(operator)}</p>
              </div>
            </div>

            {/* Vault configuration — what was set at create/reconfigure time */}
            <div className="glass mt-4 rounded-2xl p-5">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                {t("vaultDetail.agentConfigPre")}
                <span className="text-accent">{t("vaultDetail.agentConfigHighlight")}</span>
              </span>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <ConfigRow
                  k={t("vaultDetail.configReinjection")}
                  v={`${formatUnits((reinjectionAmount as bigint) ?? 0n, 6)} ${chain.stableSymbol}`}
                />
                <ConfigRow
                  k={t("vaultDetail.configPeriodic")}
                  v={
                    periodicRebalanceInterval && (periodicRebalanceInterval as bigint) > 0n
                      ? t("vaultDetail.configPeriodicEvery", { hours: Number(periodicRebalanceInterval) / 3600 })
                      : t("vaultDetail.configOff")
                  }
                />
                <ConfigRow
                  k={t("vaultDetail.configCooldown")}
                  v={
                    minRebalanceInterval && (minRebalanceInterval as bigint) > 0n
                      ? `${Number(minRebalanceInterval) / 3600}h`
                      : t("vaultDetail.configNoFloor")
                  }
                />
                <ConfigRow k={t("vaultDetail.configMaxSlippage")} v={`${Number(maxSlippageBps ?? 0n) / 100}%`} />
                <ConfigRow k={t("vaultDetail.configMaxDeviation")} v={`${maxRangeDeviationBps ?? 0} ticks`} />
                <ConfigRow k={t("vaultDetail.configRecenterMargin")} v={`${Number(recenterMarginBps ?? 0n) / 100}%`} />
                <ConfigRow
                  k={t("vaultDetail.configTopMargin")}
                  v={`${Number(exitTopCeilingMarginBps ?? 0n) / 100}%`}
                />
                <ConfigRow k={t("vaultDetail.configMaxRebalances")} v={`${maxRebalances ?? 0}`} />
              </dl>
            </div>

            {/* Owner actions */}
            {isOwner && (
              <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
                <h2
                  className="text-xl font-semibold tracking-tight"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {t("vaultDetail.managementTitle")}
                </h2>
                <p className="mt-1 text-sm text-muted">{t("vaultDetail.managementSubtitle")}</p>

                <div className="mt-6">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {t("vaultDetail.depositLabel", { symbol: chain.stableSymbol })}
                  </span>
                  {pendingCreationFee > 0n && (
                    <p className="mt-1 text-xs text-faint">
                      {t("vaultDetail.pendingFeeNote", {
                        fee: formatUnits(pendingCreationFee, 6),
                        symbol: chain.stableSymbol,
                      })}
                    </p>
                  )}
                  {maxDepositUsd > 0n && (
                    <p className="mt-1 text-xs text-faint">
                      {t("vaultDetail.platformCapNote", {
                        cap: formatUnits(maxDepositUsd, 6),
                        symbol: chain.stableSymbol,
                        room: formatUnits(
                          maxDepositUsd >
                            ((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n) + gasReserveBalance
                            ? maxDepositUsd -
                                (((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n) + gasReserveBalance)
                            : 0n,
                          6,
                        ),
                      })}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField label={t("vaultDetail.fieldInvestable")} value={depInvestable} onChange={setDepInvestable} />
                    <MiniField label={t("vaultDetail.fieldReserve")} value={depReserve} onChange={setDepReserve} />
                    {chain.supportsGasReserve && (
                      <MiniField label={t("vaultDetail.fieldGasBudget")} value={depGasReserve} onChange={setDepGasReserve} />
                    )}
                    <button onClick={handleDepositMore} disabled={Boolean(busy)} className="btn-primary !py-3">
                      {t("vaultDetail.deposit")}
                    </button>
                  </div>
                </div>

                <div className="mt-8">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {t("vaultDetail.reconfigureLabelPre")}
                    <span className="text-accent">{t("vaultDetail.reconfigureLabelHighlight")}</span>
                  </span>
                  <p className="mt-1 text-xs text-faint">
                    {targetConfigured
                      ? t("vaultDetail.reconfigureHintConfigured")
                      : t("vaultDetail.reconfigureHintUnconfigured")}
                  </p>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField label={t("vaultDetail.fieldMinPriceUsd")} value={cfgMinPrice} onChange={setCfgMinPrice} />
                    <MiniField label={t("vaultDetail.fieldMaxPriceUsd")} value={cfgMaxPrice} onChange={setCfgMaxPrice} />
                    <MiniField
                      label={t("vaultDetail.fieldMaxRebalancesToday", { n: maxRebalances !== undefined ? String(maxRebalances) : "…" })}
                      value={cfgMaxRebalances}
                      onChange={setCfgMaxRebalances}
                    />
                    <MiniField
                      label={t("vaultDetail.fieldReinjectionSymbol", { symbol: chain.stableSymbol })}
                      value={cfgReinjection}
                      onChange={setCfgReinjection}
                    />
                    <MiniField label={t("vaultDetail.fieldPeriodicHours")} value={cfgPeriodicHours} onChange={setCfgPeriodicHours} />
                    <MiniField
                      label={t("vaultDetail.fieldRecenterMarginToday", { n: Number(recenterMarginBps ?? 500n) / 100 })}
                      value={cfgRecenterMarginPct}
                      onChange={setCfgRecenterMarginPct}
                    />
                    <MiniField
                      label={t("vaultDetail.fieldTopMarginToday", { n: Number(exitTopCeilingMarginBps ?? 300n) / 100 })}
                      value={cfgExitTopCeilingMarginPct}
                      onChange={setCfgExitTopCeilingMarginPct}
                    />
                    <button onClick={handleReconfigure} disabled={Boolean(busy)} className="btn-secondary !py-3">
                      {t("vaultDetail.update")}
                    </button>
                  </div>
                </div>

                <div className="mt-8">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {t("vaultDetail.riskLimitsLabel")}
                  </span>
                  <p className="mt-1 text-xs text-faint">{t("vaultDetail.riskLimitsHint")}</p>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField
                      label={t("vaultDetail.fieldMaxSlippageToday", { n: Number(maxSlippageBps ?? 30n) / 100 })}
                      value={riskMaxSlippagePct}
                      onChange={setRiskMaxSlippagePct}
                    />
                    <MiniField
                      label={t("vaultDetail.fieldCooldownToday", { n: Number(minRebalanceInterval ?? 0n) / 3600 })}
                      value={riskMinCooldownHours}
                      onChange={setRiskMinCooldownHours}
                    />
                    <MiniField
                      label={t("vaultDetail.fieldMaxDeviationToday", { n: maxRangeDeviationBps !== undefined ? String(maxRangeDeviationBps) : "5000" })}
                      value={riskMaxRangeDeviationTicks}
                      onChange={setRiskMaxRangeDeviationTicks}
                    />
                    <button onClick={handleUpdateRiskParams} disabled={Boolean(busy)} className="btn-secondary !py-3">
                      {t("vaultDetail.update")}
                    </button>
                  </div>
                </div>

                {hasPosition && (
                  <div className="mt-8">
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                      {t("vaultDetail.increasePositionLabel")}
                    </span>
                    <p className="mt-1 text-xs text-faint">{t("vaultDetail.increasePositionHint")}</p>
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <MiniField
                        label={t("vaultDetail.fieldAmountSymbol", { symbol: chain.stableSymbol })}
                        value={increaseAmount}
                        onChange={setIncreaseAmount}
                      />
                      <button
                        onClick={handleIncreasePosition}
                        disabled={Boolean(busy)}
                        className="btn-secondary !py-3"
                      >
                        {t("vaultDetail.addToPosition")}
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-8">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {t("vaultDetail.partialWithdrawLabel")}
                  </span>
                  <p className="mt-1 text-xs text-faint">{t("vaultDetail.partialWithdrawHint")}</p>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField
                      label={t("vaultDetail.fieldPositionPct")}
                      value={withdrawPositionPct}
                      onChange={setWithdrawPositionPct}
                    />
                    <MiniField label={t("vaultDetail.fieldIdleFundsPct")} value={withdrawFundsPct} onChange={setWithdrawFundsPct} />
                    <button
                      onClick={handlePartialWithdraw}
                      disabled={Boolean(busy)}
                      className="btn-secondary !py-3"
                    >
                      {t("vaultDetail.partialWithdraw")}
                    </button>
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  <button
                    onClick={() =>
                      withTx(t("vaultDetail.txCollectingFees"), () =>
                        writeContractAsync({
                          address,
                          abi: chain.vaultAbi,
                          functionName: "collectFees",
                          args: [],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy) || !hasPosition}
                    className="btn-secondary"
                    title={
                      hasPosition
                        ? t("vaultDetail.collectFeesTooltipEnabled")
                        : t("vaultDetail.collectFeesTooltipDisabled")
                    }
                  >
                    {t("vaultDetail.collectFees")}
                  </button>
                  <button
                    onClick={() =>
                      withTx(t("vaultDetail.txWithdrawing"), () =>
                        writeContractAsync({
                          address,
                          abi: chain.vaultAbi,
                          functionName: "withdrawAll",
                          args: [],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    {t("vaultDetail.withdrawAll")}
                  </button>
                  <button
                    onClick={() =>
                      withTx(paused ? t("vaultDetail.txResuming") : t("vaultDetail.txPausing"), () =>
                        writeContractAsync({
                          address,
                          abi: chain.vaultAbi,
                          functionName: paused ? "unpause" : "pause",
                          args: [],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    {paused ? t("vaultDetail.resume") : t("vaultDetail.pause")}
                  </button>
                  <button
                    onClick={() =>
                      withTx(t("vaultDetail.txRevoking"), () =>
                        writeContractAsync({
                          address,
                          abi: chain.vaultAbi,
                          functionName: "setOperator",
                          args: ["0x0000000000000000000000000000000000000000"],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    {t("vaultDetail.revokeOperator")}
                  </button>
                  <button
                    onClick={() =>
                      withTx(t("vaultDetail.txEmergency"), () =>
                        writeContractAsync({
                          address,
                          abi: chain.vaultAbi,
                          functionName: "emergencyWithdrawPosition",
                          args: [],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-danger"
                  >
                    {t("vaultDetail.emergencyWithdraw")}
                  </button>
                  {!closed && (
                    <button
                      onClick={() =>
                        withTx(t("vaultDetail.txClosing"), () =>
                          writeContractAsync({
                            address,
                            abi: chain.vaultAbi,
                            functionName: "closeVault",
                            args: [],
                            chainId: chain.id,
                          }),
                        )
                      }
                      disabled={Boolean(busy)}
                      className="btn-danger"
                      title={t("vaultDetail.closeVaultTooltip")}
                    >
                      {t("vaultDetail.closeVaultBtn")}
                    </button>
                  )}
                </div>
                {Boolean(closed) && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-negative">
                    {t("vaultDetail.closedNote")}
                  </p>
                )}

                {busy && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {t("vaultDetail.signing", { action: busy })}
                  </p>
                )}
                {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}
              </div>
            )}

            <PositionHistory address={address} chain={chain} />
            <ActivityFeed address={address} chain={chain} />
          </>
        )}
      </main>
    </>
  );
}

function ConfigRow({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-faint">{k}</dt>
      <dd className="mt-0.5 font-medium text-white/90">{v}</dd>
    </div>
  );
}

function MiniField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex min-w-36 flex-1 flex-col gap-1.5">
      <span className="text-xs text-faint">{label}</span>
      <input
        className="field-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
      />
    </label>
  );
}

function Stat({
  label,
  value,
  hint,
  hint2,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  hint2?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        accent
          ? "glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5"
          : "glass rounded-2xl p-5"
      }
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <p
        className={`mt-2 text-lg font-semibold tabular-nums ${accent ? "text-accent" : "text-white/90"}`}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
      {hint2 && <p className="mt-0.5 font-mono text-xs text-accent">{hint2}</p>}
    </div>
  );
}
