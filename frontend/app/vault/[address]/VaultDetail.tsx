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
import { rangeVaultAbi, erc20Abi, uniswapV3PoolAbi, positionManagerAbi, platformConfigAbi } from "@/lib/contracts";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";
import { sizeRebalanceSwap } from "@/lib/keeper/swapMath";
import { useVaultFeesSummary } from "@/lib/useVaultFeesSummary";
import { useVaultDepositSummary } from "@/lib/useVaultDepositSummary";
import { useSelectedChain } from "@/lib/useSelectedChain";

const reads = (address: `0x${string}`, chainId: number) =>
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
  ].map((functionName) => ({ address, abi: rangeVaultAbi, functionName, chainId }) as const);

export function VaultDetail({ address }: { address: `0x${string}` }) {
  const { address: connected, chainId: walletChainId } = useAccount();
  const { selectedChain: chain } = useSelectedChain();
  const publicClient = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

  // 15s polling keeps the stats live while the keeper acts — the page is a demo
  // surface as much as a control panel.
  const { data, refetch } = useReadContracts({
    contracts: reads(address, chain.id),
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
  ] = data?.map((d) => d.result) ?? [];

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

  const { data: feesSummary } = useVaultFeesSummary(address, chain);
  const { data: depositSummary } = useVaultDepositSummary(address, chain);
  const { data: tickSpacing } = useReadContract({
    address: chain.pool,
    abi: uniswapV3PoolAbi,
    functionName: "tickSpacing",
    chainId: chain.id,
  });
  const { data: slot0 } = useReadContract({
    address: chain.pool,
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
      ? Number(feesUsdtStr) + Number(formatUnits(feesWethRaw, 18)) * ethPriceFromTick(currentTick)
      : undefined;

  // Rentabilidad = comisiones (USD) sobre el monto depositado al crear el
  // vault — mismo cálculo simple que la tarjeta en /vaults, no anualizado.
  const initialInvestmentUsd = Number(formatUnits(depositSummary?.initialInvestmentUsdt ?? 0n, 6));
  const rentLabel =
    feesUsdTotal !== undefined && initialInvestmentUsd > 0
      ? `${((feesUsdTotal / initialInvestmentUsd) * 100).toFixed(2)}% rent.`
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
  // are deliberately decoupled (see Header.tsx's NetworkSelector), so every
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
          setError(`Cambiá tu wallet a ${chain.name} para continuar.`);
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
    const total = investable + reserve;
    if (total === 0n) return;

    // Same check RangeVault.deposit() itself makes (reserveAmount +
    // investableAmount vs PlatformConfig.maxDepositUsd, fee excluded, on top
    // of whatever's already committed) — catch it here so the wallet never
    // even pops up for a deposit that's certain to revert on-chain.
    // Confirmed in production 2026-07-17: a user hit DepositExceedsPlatformCap
    // with no explanation, just a raw revert.
    const currentTotal = ((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n);
    if (maxDepositUsd > 0n && currentTotal + total > maxDepositUsd) {
      const room = maxDepositUsd > currentTotal ? maxDepositUsd - currentTotal : 0n;
      setCapAlert(
        `El tope de depósito de la plataforma es ${formatUnits(maxDepositUsd, 6)} ${chain.stableSymbol} y este vault ya tiene ` +
          `${formatUnits(currentTotal, 6)} ${chain.stableSymbol} comprometidos — quedan ${formatUnits(room, 6)} ${chain.stableSymbol} de margen. ` +
          `Reducí el monto.`,
      );
      return;
    }

    // If this vault never had a successful deposit() yet, this call IS the
    // first one — deposit() pulls PlatformConfig's one-time creationFeeUsdt
    // on top, so the approval has to cover it too (see RangeVault.sol).
    await withTx("Aprobando", () =>
      writeContractAsync({
        address: chain.stableToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [address, total + pendingCreationFee],
        chainId: chain.id,
      }),
    );
    await withTx("Depositando", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
        functionName: "deposit",
        args: [reserve, investable],
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
        setError("El precio máximo debe ser mayor al mínimo, ambos positivos");
        return;
      }
      const tickA = alignToTickSpacing(tickFromEthPrice(lowerPrice), Number(tickSpacing));
      const tickB = alignToTickSpacing(tickFromEthPrice(upperPrice), Number(tickSpacing));
      lo = Math.min(tickA, tickB);
      hi = Math.max(tickA, tickB);
    } else {
      if (targetTickLower === undefined || targetTickUpper === undefined) return;
      lo = Math.min(Number(targetTickLower), Number(targetTickUpper));
      hi = Math.max(Number(targetTickLower), Number(targetTickUpper));
    }

    await withTx("Reconfigurando", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
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

    await withTx("Fijando límites de riesgo", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
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
      setError("Todavía no se pudo leer el rango actual de la posición — probá de nuevo en un momento.");
      return;
    }

    // Sized client-side — no uni-lab consultation needed, this is just the
    // position's already-known live ratio at the pool's current price, both
    // public reads. Uses sizeRebalanceSwap (a MIXED starting balance), not
    // sizeInitialSwap (all-token0), because the contract's increaseLiquidity()
    // sweeps in the vault's FULL token1 balance — including any WETH already
    // sitting idle from a prior mis-sized swap — not just what usdtAmount
    // alone would produce. Ignoring that pre-existing WETH here is exactly
    // what left $64.92 of USDT stranded in production 2026-07-16 (vault
    // 0x0Bf394B3...5dEBCE5b8). token0 is still capped to usdtAmount to match
    // increasePosition()'s own cap — old investableUsdt dust stays untouched.
    const ethPrice = ethPriceFromTick(currentTick);
    const swap = sizeRebalanceSwap({
      currentTick,
      newTickLower: positionTicks.tickLower,
      newTickUpper: positionTicks.tickUpper,
      availableToken0Raw: usdtAmount,
      availableToken1Raw: (idleWeth as bigint) ?? 0n,
      ethPriceUsd: ethPrice,
    });

    await withTx("Aprobando", () =>
      writeContractAsync({
        address: chain.stableToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [address, usdtAmount],
        chainId: chain.id,
      }),
    );
    await withTx("Sumando a la posición", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
        functionName: "increasePosition",
        args: [
          { token0ToToken1: swap.token0ToToken1, amountIn: swap.amountIn, amountOutMinimum: 0n, fee: chain.feeTier },
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
      setError("Los porcentajes no pueden superar 100%");
      return;
    }
    await withTx("Retirando", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
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
        <AlertModal title="Supera el tope de depósito" message={capAlert} onClose={() => setCapAlert(null)} />
      )}
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">
            Vault · {chain.stableSymbol}/{chain.volatileSymbol} {chain.feeTier / 10_000}%
          </span>
          {paused ? (
            <span className="eyebrow !border-negative/40 !text-negative">Pausado</span>
          ) : (
            <span className="eyebrow !border-positive/40 !text-positive">Activo</span>
          )}
          {hasPosition ? (
            <span className="eyebrow !border-accent/40 !text-accent">Posición #{String(positionTokenId)}</span>
          ) : (
            <span className="eyebrow">Sin posición aún</span>
          )}
        </div>

        <h1 className="mt-5 break-all font-mono text-lg text-white/90 sm:text-xl">{address}</h1>
        <p className="mt-2 text-sm text-muted">
          {isOwner ? "Sos el owner de este vault." : "Vista de solo lectura — no sos el owner."}
        </p>

        {rebalanceAlert && (
          <div className="glass mt-6 rounded-2xl border-negative/40 bg-negative/[0.06] p-5">
            <p className="text-sm font-medium text-negative">
              El último rebalanceo no se pudo completar — no se pudo consultar la API de precios (uni-lab).
            </p>
            <p className="mt-1 text-xs text-negative/80">{rebalanceAlert.message}</p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-negative/60">
              {new Date(rebalanceAlert.createdAt).toLocaleString()}
            </p>
          </div>
        )}

        {!data && (
          <div className="glass mt-10 rounded-2xl p-10 text-center">
            <p className="text-muted">Cargando…</p>
          </div>
        )}

        {data && (
          <>
            {/* Stats */}
            <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label="Capital invertible"
                value={`${formatUnits((investableUsdt as bigint) ?? 0n, 6)} ${chain.stableSymbol}`}
                hint={
                  (idleWeth as bigint | undefined) && (idleWeth as bigint) > 0n
                    ? `+ ${Number(formatUnits(idleWeth as bigint, 18)).toFixed(6)} ${chain.volatileSymbol} suelto${
                        currentTick !== undefined
                          ? ` (~$${(Number(idleWeth as bigint) * 1e-18 * ethPriceFromTick(currentTick)).toFixed(2)})`
                          : ""
                      }`
                    : undefined
                }
              />
              <Stat
                label="Reserva reinyección"
                value={`${formatUnits((reserveBalance as bigint) ?? 0n, 6)} ${chain.stableSymbol}`}
                hint={`tope por ciclo: ${formatUnits((reinjectionAmount as bigint) ?? 0n, 6)} ${chain.stableSymbol}`}
              />
              <Stat
                label="Rebalanceos"
                value={`${rebalanceCount ?? 0} / ${maxRebalances ?? 0}`}
                accent
              />
              <Stat
                label="Comisiones generadas"
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

            {hasPosition && <PositionNFT tokenId={positionTokenId as bigint} chain={chain} />}

            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  Rango objetivo
                </span>
                {targetConfigured ? (
                  <>
                    <p className="mt-2 text-sm font-medium text-white/90">
                      {(() => {
                        const lo = Number(targetTickLower);
                        const hi = Number(targetTickUpper);
                        const priceA = ethPriceFromTick(lo);
                        const priceB = ethPriceFromTick(hi);
                        const low = Math.min(priceA, priceB);
                        const high = Math.max(priceA, priceB);
                        return `$${low.toFixed(2)} – $${high.toFixed(2)}`;
                      })()}
                    </p>
                    {Number(targetTickLower) > Number(targetTickUpper) && (
                      <p className="mt-1 text-xs text-negative">
                        Ticks invertidos on-chain — usá &quot;Reconfigurar agente&quot; para corregir
                      </p>
                    )}
                    <p className="mt-1.5 font-mono text-[11px] text-faint">
                      ticks [{String(targetTickLower)}, {String(targetTickUpper)}]
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-white/90">sin configurar</p>
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
                  Operador
                </span>
                <p className="mt-2 break-all font-mono text-sm text-white/90">{String(operator)}</p>
              </div>
            </div>

            {/* Vault configuration — what was set at create/reconfigure time */}
            <div className="glass mt-4 rounded-2xl p-5">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                Configuración del agente
              </span>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <ConfigRow
                  k="Reinyección alternada"
                  v={`${formatUnits((reinjectionAmount as bigint) ?? 0n, 6)} ${chain.stableSymbol}`}
                />
                <ConfigRow
                  k="Rebalanceo periódico"
                  v={
                    periodicRebalanceInterval && (periodicRebalanceInterval as bigint) > 0n
                      ? `cada ${Number(periodicRebalanceInterval) / 3600}h`
                      : "desactivado"
                  }
                />
                <ConfigRow
                  k="Cooldown mínimo"
                  v={
                    minRebalanceInterval && (minRebalanceInterval as bigint) > 0n
                      ? `${Number(minRebalanceInterval) / 3600}h`
                      : "sin piso"
                  }
                />
                <ConfigRow k="Slippage máx." v={`${Number(maxSlippageBps ?? 0n) / 100}%`} />
                <ConfigRow k="Desviación máx. de rango" v={`${maxRangeDeviationBps ?? 0} ticks`} />
                <ConfigRow k="Margen de recentrado" v={`${Number(recenterMarginBps ?? 0n) / 100}%`} />
                <ConfigRow k="Margen techo (salida arriba)" v={`${Number(exitTopCeilingMarginBps ?? 0n) / 100}%`} />
                <ConfigRow k="Tope de rebalanceos" v={`${maxRebalances ?? 0}`} />
              </dl>
            </div>

            {/* Owner actions */}
            {isOwner && (
              <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
                <h2
                  className="text-xl font-semibold tracking-tight"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  Gestión
                </h2>
                <p className="mt-1 text-sm text-muted">Solo el owner puede ejecutar estas acciones.</p>

                <div className="mt-6">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    Depositar {chain.stableSymbol} (repartido entre capital invertible y reserva de reinyección)
                  </span>
                  {pendingCreationFee > 0n && (
                    <p className="mt-1 text-xs text-faint">
                      Este vault todavía no pagó el fee de creación — se suma {formatUnits(pendingCreationFee, 6)}{" "}
                      {chain.stableSymbol} arriba de lo que pongas acá, una sola vez.
                    </p>
                  )}
                  {maxDepositUsd > 0n && (
                    <p className="mt-1 text-xs text-faint">
                      Tope de la plataforma: {formatUnits(maxDepositUsd, 6)} {chain.stableSymbol} — quedan{" "}
                      {formatUnits(
                        maxDepositUsd >
                          ((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n)
                          ? maxDepositUsd - (((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n))
                          : 0n,
                        6,
                      )}{" "}
                      {chain.stableSymbol} de margen.
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField label="Invertible" value={depInvestable} onChange={setDepInvestable} />
                    <MiniField label="Reserva" value={depReserve} onChange={setDepReserve} />
                    <button onClick={handleDepositMore} disabled={Boolean(busy)} className="btn-primary !py-3">
                      Depositar
                    </button>
                  </div>
                </div>

                <div className="mt-8">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    Reconfigurar agente
                  </span>
                  <p className="mt-1 text-xs text-faint">
                    {targetConfigured
                      ? "Dejá precio mínimo/máximo vacíos para mantener el rango actual, o completalos para fijar uno nuevo (también actualiza los límites de riesgo)."
                      : "Este vault todavía no tiene rango — completá precio mínimo y máximo para terminar de configurarlo."}
                  </p>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField label="Precio mínimo (USD)" value={cfgMinPrice} onChange={setCfgMinPrice} />
                    <MiniField label="Precio máximo (USD)" value={cfgMaxPrice} onChange={setCfgMaxPrice} />
                    <MiniField
                      label={`Tope rebalanceos (hoy: ${maxRebalances ?? "…"})`}
                      value={cfgMaxRebalances}
                      onChange={setCfgMaxRebalances}
                    />
                    <MiniField
                      label={`Reinyección (${chain.stableSymbol})`}
                      value={cfgReinjection}
                      onChange={setCfgReinjection}
                    />
                    <MiniField label="Periódico (horas)" value={cfgPeriodicHours} onChange={setCfgPeriodicHours} />
                    <MiniField
                      label={`Margen recentrado % (hoy: ${Number(recenterMarginBps ?? 500n) / 100})`}
                      value={cfgRecenterMarginPct}
                      onChange={setCfgRecenterMarginPct}
                    />
                    <MiniField
                      label={`Margen techo salida arriba % (hoy: ${Number(exitTopCeilingMarginBps ?? 300n) / 100})`}
                      value={cfgExitTopCeilingMarginPct}
                      onChange={setCfgExitTopCeilingMarginPct}
                    />
                    <button onClick={handleReconfigure} disabled={Boolean(busy)} className="btn-secondary !py-3">
                      Actualizar
                    </button>
                  </div>
                </div>

                <div className="mt-8">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    Límites de riesgo
                  </span>
                  <p className="mt-1 text-xs text-faint">
                    Dejá cualquiera en blanco para mantener su valor actual. Se aplican solos al fijar un rango
                    nuevo arriba, o podés actualizarlos acá sin tocar el rango.
                  </p>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField
                      label={`Slippage máx. % (hoy: ${Number(maxSlippageBps ?? 30n) / 100})`}
                      value={riskMaxSlippagePct}
                      onChange={setRiskMaxSlippagePct}
                    />
                    <MiniField
                      label={`Cooldown mín. horas (hoy: ${Number(minRebalanceInterval ?? 0n) / 3600})`}
                      value={riskMinCooldownHours}
                      onChange={setRiskMinCooldownHours}
                    />
                    <MiniField
                      label={`Desviación máx. ticks (hoy: ${maxRangeDeviationBps ?? 5_000n})`}
                      value={riskMaxRangeDeviationTicks}
                      onChange={setRiskMaxRangeDeviationTicks}
                    />
                    <button onClick={handleUpdateRiskParams} disabled={Boolean(busy)} className="btn-secondary !py-3">
                      Actualizar
                    </button>
                  </div>
                </div>

                {hasPosition && (
                  <div className="mt-8">
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                      Sumar a la posición abierta
                    </span>
                    <p className="mt-1 text-xs text-faint">
                      Entra a la posición actual al instante, sin esperar al próximo rebalanceo del agente — se
                      calcula acá mismo el swap necesario para respetar el rango vigente.
                    </p>
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <MiniField
                        label={`Monto (${chain.stableSymbol})`}
                        value={increaseAmount}
                        onChange={setIncreaseAmount}
                      />
                      <button
                        onClick={handleIncreasePosition}
                        disabled={Boolean(busy)}
                        className="btn-secondary !py-3"
                      >
                        Sumar a la posición
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-8">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    Retiro parcial
                  </span>
                  <p className="mt-1 text-xs text-faint">
                    Independiente entre sí — retirá un % de la posición activa, un % de los fondos idle
                    (invertible + reserva), o ambos, sin cerrar el vault.
                  </p>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField
                      label="% de la posición"
                      value={withdrawPositionPct}
                      onChange={setWithdrawPositionPct}
                    />
                    <MiniField label="% de fondos idle" value={withdrawFundsPct} onChange={setWithdrawFundsPct} />
                    <button
                      onClick={handlePartialWithdraw}
                      disabled={Boolean(busy)}
                      className="btn-secondary !py-3"
                    >
                      Retirar parcial
                    </button>
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  <button
                    onClick={() =>
                      withTx("Reclamando comisiones", () =>
                        writeContractAsync({
                          address,
                          abi: rangeVaultAbi,
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
                        ? "Cobra solo las comisiones de trading acumuladas — la posición sigue abierta, sin tocar el principal"
                        : "No hay posición abierta todavía"
                    }
                  >
                    Reclamar comisiones
                  </button>
                  <button
                    onClick={() =>
                      withTx("Retirando", () =>
                        writeContractAsync({
                          address,
                          abi: rangeVaultAbi,
                          functionName: "withdrawAll",
                          args: [],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    Retirar todo
                  </button>
                  <button
                    onClick={() =>
                      withTx(paused ? "Reanudando" : "Pausando", () =>
                        writeContractAsync({
                          address,
                          abi: rangeVaultAbi,
                          functionName: paused ? "unpause" : "pause",
                          args: [],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    {paused ? "Reanudar" : "Pausar"}
                  </button>
                  <button
                    onClick={() =>
                      withTx("Revocando operador", () =>
                        writeContractAsync({
                          address,
                          abi: rangeVaultAbi,
                          functionName: "setOperator",
                          args: ["0x0000000000000000000000000000000000000000"],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    Revocar operador
                  </button>
                  <button
                    onClick={() =>
                      withTx("Retiro de emergencia", () =>
                        writeContractAsync({
                          address,
                          abi: rangeVaultAbi,
                          functionName: "emergencyWithdrawPosition",
                          args: [],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-danger"
                  >
                    Emergency withdraw
                  </button>
                  {!closed && (
                    <button
                      onClick={() =>
                        withTx("Cerrando vault", () =>
                          writeContractAsync({
                            address,
                            abi: rangeVaultAbi,
                            functionName: "closeVault",
                            args: [],
                            chainId: chain.id,
                          }),
                        )
                      }
                      disabled={Boolean(busy)}
                      className="btn-danger"
                      title="Solo funciona si el vault ya está vacío — retirá todo primero"
                    >
                      Cerrar vault
                    </button>
                  )}
                </div>
                {Boolean(closed) && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-negative">
                    Vault cerrado permanentemente — ya no puede recibir depósitos ni operar.
                  </p>
                )}

                {busy && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {busy}… firmá en tu wallet
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
