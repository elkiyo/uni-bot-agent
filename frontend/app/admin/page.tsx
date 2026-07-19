"use client";

import { useEffect, useState } from "react";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useSwitchChain,
} from "wagmi";
import { formatUnits, parseUnits, type Address } from "viem";
import { Header } from "../components/Header";
import { VolumeChart } from "./VolumeChart";
import { platformConfigAbi, uniswapV3PoolAbi, positionManagerAbi, erc20Abi } from "@/lib/contracts";
import { USDC } from "@/lib/addresses";
import { ethPriceFromTick } from "@/lib/priceMath";
import { estimatePositionAmounts } from "@/lib/keeper/swapMath";
import { useSelectedChain, useAvailableChains } from "@/lib/useSelectedChain";
import { useTranslation } from "@/lib/i18n/useTranslation";

interface UniLabCallRow {
  id: number;
  vault: string;
  endpoint: string;
  http_status: number;
  ok: boolean;
  duration_ms: number;
  request: Record<string, unknown>;
  response: unknown;
  error: string | null;
  created_at: string;
}

export default function Admin() {
  const { address: connected, chainId: walletChainId } = useAccount();
  const { selectedChain: chain, setSelectedChainId } = useSelectedChain();
  const availableChains = useAvailableChains();
  const publicClient = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const { t } = useTranslation();

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: chain.platformConfigAddress || undefined, abi: platformConfigAbi, functionName: "owner", chainId: chain.id },
      {
        address: chain.platformConfigAddress || undefined,
        abi: platformConfigAbi,
        functionName: "defaultOperator",
        chainId: chain.id,
      },
      {
        address: chain.platformConfigAddress || undefined,
        abi: platformConfigAbi,
        functionName: "maxDepositUsd",
        chainId: chain.id,
      },
      {
        address: chain.platformConfigAddress || undefined,
        abi: platformConfigAbi,
        functionName: "performanceFeeBps",
        chainId: chain.id,
      },
      {
        address: chain.platformConfigAddress || undefined,
        abi: platformConfigAbi,
        functionName: "creationFeeUsdt",
        chainId: chain.id,
      },
      { address: chain.platformConfigAddress || undefined, abi: platformConfigAbi, functionName: "treasury", chainId: chain.id },
      { address: chain.factoryAddress || undefined, abi: chain.factoryAbi, functionName: "vaultCount", chainId: chain.id },
      { address: chain.platformConfigAddress || undefined, abi: platformConfigAbi, functionName: "pendingOwner", chainId: chain.id },
    ],
    query: { enabled: Boolean(chain.platformConfigAddress && chain.factoryAddress) },
  });

  const [owner, defaultOperator, maxDepositUsd, performanceFeeBps, creationFeeUsdt, treasury, vaultCount, pendingOwner] =
    data?.map((d) => d.result) ?? [];
  const isPlatformOwner = Boolean(
    connected && owner && (connected as string).toLowerCase() === (owner as string).toLowerCase(),
  );
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const hasPendingTransfer = Boolean(pendingOwner && (pendingOwner as string).toLowerCase() !== ZERO_ADDRESS);
  const isPendingOwner = Boolean(
    connected && hasPendingTransfer && (connected as string).toLowerCase() === (pendingOwner as string).toLowerCase(),
  );

  // All vault addresses, to sum Rebalanced events across the whole platform.
  const { data: allVaultsData } = useReadContracts({
    contracts: Array.from({ length: Number(vaultCount ?? 0n) }, (_, i) => ({
      address: chain.factoryAddress || undefined,
      abi: chain.factoryAbi,
      functionName: "allVaults",
      args: [BigInt(i)],
      chainId: chain.id,
    })),
    query: { enabled: Boolean(chain.factoryAddress) && Number(vaultCount ?? 0n) > 0 },
  });
  const vaultAddresses = (allVaultsData?.map((d) => d.result) ?? []).filter(Boolean) as Address[];

  const [platformStats, setPlatformStats] = useState<{
    totalRebalances: number;
    totalLpFees0Usd: number;
    totalLpFees1Weth: number;
    totalPerformanceFee0Usd: number;
    totalPerformanceFee1Weth: number;
  } | null>(null);

  useEffect(() => {
    if (!publicClient || vaultAddresses.length === 0) return;
    let cancelled = false;

    async function scan() {
      const latest = await publicClient!.getBlockNumber();
      const MAX_RANGE = 5_000n;
      let totalRebalances = 0;
      let totalLpFees0Raw = 0n;
      let totalLpFees1Raw = 0n;
      let totalPerformanceFee0Raw = 0n;
      let totalPerformanceFee1Raw = 0n;

      for (const vault of vaultAddresses) {
        let fromBlock = chain.factoryDeployBlock;
        while (fromBlock <= latest) {
          const toBlock = fromBlock + MAX_RANGE > latest ? latest : fromBlock + MAX_RANGE;
          const [rebalancedLogs, lpFeeLogs, performanceFeeLogs] = await Promise.all([
            publicClient!.getContractEvents({
              address: vault,
              abi: chain.vaultAbi,
              eventName: "Rebalanced",
              fromBlock,
              toBlock,
            }),
            publicClient!.getContractEvents({
              address: vault,
              abi: chain.vaultAbi,
              eventName: "LpFeesPaidToOwner",
              fromBlock,
              toBlock,
            }),
            publicClient!.getContractEvents({
              address: vault,
              abi: chain.vaultAbi,
              eventName: "PerformanceFeeCollected",
              fromBlock,
              toBlock,
            }),
          ]);
          totalRebalances += rebalancedLogs.length;
          // amount0/amount1 are Uniswap's real token0/token1 — route into the
          // stable/volatile accumulators based on this chain's actual order
          // (USDT<WETH on Celo, but WETH<USDC on Arbitrum).
          for (const log of lpFeeLogs as unknown as Array<{ args: { amount0: bigint; amount1: bigint } }>) {
            totalLpFees0Raw += chain.stableIsToken0 ? log.args.amount0 : log.args.amount1;
            totalLpFees1Raw += chain.stableIsToken0 ? log.args.amount1 : log.args.amount0;
          }
          for (const log of performanceFeeLogs as unknown as Array<{ args: { amount0: bigint; amount1: bigint } }>) {
            totalPerformanceFee0Raw += chain.stableIsToken0 ? log.args.amount0 : log.args.amount1;
            totalPerformanceFee1Raw += chain.stableIsToken0 ? log.args.amount1 : log.args.amount0;
          }
          fromBlock = toBlock + 1n;
        }
      }

      if (!cancelled) {
        setPlatformStats({
          totalRebalances,
          totalLpFees0Usd: Number(formatUnits(totalLpFees0Raw, 6)),
          totalLpFees1Weth: Number(formatUnits(totalLpFees1Raw, 18)),
          totalPerformanceFee0Usd: Number(formatUnits(totalPerformanceFee0Raw, 6)),
          totalPerformanceFee1Weth: Number(formatUnits(totalPerformanceFee1Raw, 18)),
        });
      }
    }

    scan().catch((err) => console.error("platform stats scan failed", err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vaultAddresses is a derived array, re-created every render; comparing its content via length+publicClient is enough here
  }, [publicClient, vaultAddresses.length, chain.factoryDeployBlock]);

  // --- Live per-vault snapshot: active/closed split, idle capital, TVL, in-range health ---
  const { data: slot0 } = useReadContract({
    address: chain.pool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    chainId: chain.id,
    query: { refetchInterval: 15_000 },
  });
  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;
  const ethPrice = currentTick !== undefined ? ethPriceFromTick(currentTick, chain.stableIsToken0) : undefined;

  const { data: vaultLedgers } = useReadContracts({
    contracts: vaultAddresses.flatMap(
      (v) =>
        [
          { address: v, abi: chain.vaultAbi, functionName: "closed", chainId: chain.id },
          { address: v, abi: chain.vaultAbi, functionName: "positionTokenId", chainId: chain.id },
          { address: v, abi: chain.vaultAbi, functionName: "investableUsdt", chainId: chain.id },
          { address: v, abi: chain.vaultAbi, functionName: "reserveBalance", chainId: chain.id },
        ] as const,
    ),
    query: { enabled: vaultAddresses.length > 0, refetchInterval: 30_000 },
  });

  const { data: vaultWethBalances } = useReadContracts({
    contracts: vaultAddresses.map(
      (v) =>
        ({ address: chain.volatileToken, abi: erc20Abi, functionName: "balanceOf", args: [v], chainId: chain.id }) as const,
    ),
    query: { enabled: vaultAddresses.length > 0, refetchInterval: 30_000 },
  });

  const perVault = vaultAddresses.map((address, i) => ({
    address,
    closed: vaultLedgers?.[i * 4]?.result as boolean | undefined,
    positionTokenId: vaultLedgers?.[i * 4 + 1]?.result as bigint | undefined,
    investableUsdt: (vaultLedgers?.[i * 4 + 2]?.result as bigint | undefined) ?? 0n,
    reserveBalance: (vaultLedgers?.[i * 4 + 3]?.result as bigint | undefined) ?? 0n,
    idleWeth: (vaultWethBalances?.[i]?.result as bigint | undefined) ?? 0n,
  }));

  const activeVaults = perVault.filter((v) => v.closed !== true);
  const closedVaultsCount = perVault.filter((v) => v.closed === true).length;
  const vaultsWithPosition = activeVaults.filter((v) => v.positionTokenId && v.positionTokenId > 0n);

  const { data: positionsData } = useReadContracts({
    contracts: vaultsWithPosition.map(
      (v) =>
        ({
          address: chain.positionManager,
          abi: positionManagerAbi,
          functionName: "positions",
          args: [v.positionTokenId as bigint],
          chainId: chain.id,
        }) as const,
    ),
    query: { enabled: vaultsWithPosition.length > 0, refetchInterval: 30_000 },
  });

  let totalPositionValueUsd = 0;
  let vaultsOutOfRange = 0;
  if (positionsData && currentTick !== undefined && ethPrice !== undefined) {
    positionsData.forEach((r) => {
      const pos = r.result as
        | readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
        | undefined;
      if (!pos) return;
      const [, , , , , tickLower, tickUpper, liquidity] = pos;
      const { amount0Raw, amount1Raw } = estimatePositionAmounts({ liquidity, currentTick, tickLower, tickUpper });
      const stableRaw = chain.stableIsToken0 ? amount0Raw : amount1Raw;
      const volatileRaw = chain.stableIsToken0 ? amount1Raw : amount0Raw;
      totalPositionValueUsd += stableRaw * 1e-6 + volatileRaw * 1e-18 * ethPrice;
      if (currentTick < tickLower || currentTick > tickUpper) vaultsOutOfRange += 1;
    });
  }

  const totalIdleUsdt = activeVaults.reduce((sum, v) => sum + v.investableUsdt + v.reserveBalance, 0n);
  const totalIdleWeth = activeVaults.reduce((sum, v) => sum + v.idleWeth, 0n);
  const totalIdleUsdtNum = Number(formatUnits(totalIdleUsdt, 6));
  const totalIdleWethNum = Number(formatUnits(totalIdleWeth, 18));
  const tvlUsd =
    ethPrice !== undefined ? totalIdleUsdtNum + totalIdleWethNum * ethPrice + totalPositionValueUsd : undefined;

  // --- Operator health — real incident 2026-07-16: ran out of CELO gas mid-session ---
  // Native gas is per-chain (CELO on Celo, ETH on Arbitrum) — follows the
  // selected chain. The USDC balance is deliberately NOT chain-aware: uni-lab
  // payment always happens from the operator's Celo-side USDC regardless of
  // which chain's vault triggered the rebalance cycle (see unilab.ts).
  const { data: operatorGas } = useBalance({
    address: defaultOperator as Address | undefined,
    chainId: chain.id,
    query: { enabled: Boolean(defaultOperator), refetchInterval: 30_000 },
  });
  const { data: operatorUsdc } = useReadContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: defaultOperator ? [defaultOperator as Address] : undefined,
    query: { enabled: Boolean(defaultOperator), refetchInterval: 30_000 },
  });
  const operatorGasLow = operatorGas !== undefined && Number(operatorGas.formatted) < chain.lowGasThreshold;

  const [uniLabCalls, setUniLabCalls] = useState<UniLabCallRow[] | null>(null);
  useEffect(() => {
    if (!isPlatformOwner) return;
    fetch("/api/admin/unilab-calls")
      .then((res) => res.json())
      .then((body) => setUniLabCalls(body.calls ?? []))
      .catch((err) => console.error("failed to load uni-lab call log", err));
  }, [isPlatformOwner]);

  const x402Ok = uniLabCalls?.filter((c) => c.ok).length ?? 0;
  const x402Failed = uniLabCalls ? uniLabCalls.length - x402Ok : 0;

  const [newOperator, setNewOperator] = useState("");
  const [newCap, setNewCap] = useState("");
  const [newPerformanceFeePct, setNewPerformanceFeePct] = useState("");
  const [newCreationFee, setNewCreationFee] = useState("");
  const [newTreasury, setNewTreasury] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function withTx(label: string, fn: () => Promise<`0x${string}`>) {
    if (!publicClient) return;
    setBusy(label);
    setError(null);
    try {
      if (walletChainId !== chain.id) {
        try {
          await switchChainAsync({ chainId: chain.id });
        } catch {
          setError(t("admin.switchChainError", { chain: chain.name }));
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

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">{t("admin.eyebrow")}</span>
        <h1
          className="mt-5 text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("admin.title")}
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">{t("admin.subtitle")}</p>

        {availableChains.length > 1 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{t("admin.networkLabel")}</span>
            {availableChains.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedChainId(c.id)}
                className={
                  c.id === chain.id
                    ? "rounded-full border border-accent bg-accent/[0.08] px-3 py-1.5 text-sm font-medium text-accent"
                    : "rounded-full border border-hairline px-3 py-1.5 text-sm text-white/70 transition-colors hover:border-accent/50 hover:text-white"
                }
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        {!data && Boolean(chain.platformConfigAddress) && (
          <p className="mt-10 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{t("admin.loading")}</p>
        )}

        {data && !isPlatformOwner && !isPendingOwner && (
          <div className="glass mt-10 rounded-2xl p-8 text-center">
            <p className="text-sm text-muted">
              {t("admin.ownerOnlyPre", { chain: chain.name })}
              {connected ? (
                <>
                  {t("admin.ownerOnlyConnectedPre")}
                  <code className="break-all font-mono text-xs">{String(owner)}</code>
                  {t("admin.ownerOnlyConnectedPost")}
                </>
              ) : (
                t("admin.ownerOnlyDisconnected")
              )}
            </p>
          </div>
        )}

        {data && isPendingOwner && (
          <div className="glass mt-10 rounded-2xl border-accent/35 bg-accent/[0.06] p-6 sm:p-8">
            <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
              {t("admin.pendingTransferTitle")}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {t("admin.pendingTransferTextPre")}
              <code className="break-all font-mono text-xs">{String(owner)}</code>
              {t("admin.pendingTransferTextMid", { chain: chain.name })}
            </p>
            {busy && (
              <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                {t("admin.processingLabel", { action: busy })}
              </p>
            )}
            {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}
            <button
              onClick={() =>
                withTx("acceptOwnership", () =>
                  writeContractAsync({
                    address: chain.platformConfigAddress || "0x0000000000000000000000000000000000000000",
                    abi: platformConfigAbi,
                    functionName: "acceptOwnership",
                    chainId: chain.id,
                  }),
                )
              }
              disabled={Boolean(busy)}
              className="btn-primary mt-6 !px-5 !py-2.5"
            >
              {t("admin.acceptOwnership")}
            </button>
          </div>
        )}

        {data && isPlatformOwner && (
          <>
            {(!chain.platformConfigAddress || !chain.factoryAddress) && (
          <div className="glass mt-8 rounded-2xl border-accent/35 bg-accent/[0.06] p-5 text-sm text-muted">
            {t("admin.contractsNotDeployed", { chain: chain.name })}
          </div>
        )}

        {operatorGasLow && (
          <div className="glass mt-8 rounded-2xl border-negative/40 bg-negative/[0.06] p-5">
            <p className="text-sm font-medium text-negative">
              {t("admin.lowGasWarning", {
                threshold: chain.lowGasThreshold,
                symbol: chain.viemChain.nativeCurrency.symbol,
                chain: chain.name,
              })}
            </p>
            <p className="mt-1 font-mono text-xs text-muted">
              {t("admin.lowGasSendHint", { symbol: chain.viemChain.nativeCurrency.symbol, address: String(defaultOperator) })}
            </p>
          </div>
        )}

        {data && (
          <>
            <p className="mt-10 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
              {t("admin.capitalUnderManagement")}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label={t("admin.statTvlTotal")} value={tvlUsd !== undefined ? `$${tvlUsd.toFixed(2)}` : "…"} accent />
              <Stat
                label={t("admin.statInPositions")}
                value={ethPrice !== undefined ? `$${totalPositionValueUsd.toFixed(2)}` : "…"}
              />
              <Stat
                label={t("admin.statFreeCapital")}
                value={`${totalIdleUsdtNum.toFixed(2)} ${chain.stableSymbol}${
                  totalIdleWethNum > 0 ? ` + ${totalIdleWethNum.toFixed(6)} ${chain.volatileSymbol}` : ""
                }`}
              />
              <Stat
                label={t("admin.statLpFeesGross")}
                value={
                  platformStats
                    ? `${(platformStats.totalLpFees0Usd + platformStats.totalPerformanceFee0Usd).toFixed(2)} ${chain.stableSymbol}${
                        platformStats.totalLpFees1Weth + platformStats.totalPerformanceFee1Weth > 0
                          ? ` + ${(platformStats.totalLpFees1Weth + platformStats.totalPerformanceFee1Weth).toFixed(6)} ${chain.volatileSymbol}`
                          : ""
                      }`
                    : "…"
                }
              />
            </div>

            <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">{t("admin.vaultsLabel")}</p>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label={t("admin.statActive")} value={String(activeVaults.length)} accent />
              <Stat label={t("admin.statClosed")} value={String(closedVaultsCount)} />
              <Stat
                label={t("admin.statOutOfRangeNow")}
                value={String(vaultsOutOfRange)}
                accent={vaultsOutOfRange > 0}
                negative={vaultsOutOfRange > 0}
              />
              <Stat label={t("admin.statTotalRebalances")} value={platformStats ? String(platformStats.totalRebalances) : "…"} />
            </div>

            <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">{t("admin.operatorLabel")}</p>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label={t("admin.statGasLabel", { symbol: chain.viemChain.nativeCurrency.symbol, chain: chain.name })}
                value={operatorGas ? `${Number(operatorGas.formatted).toFixed(3)} ${chain.viemChain.nativeCurrency.symbol}` : "…"}
                negative={operatorGasLow}
              />
              <Stat
                label={t("admin.statUsdcLabel")}
                value={operatorUsdc !== undefined ? `${formatUnits(operatorUsdc as bigint, 6)} USDC` : "…"}
              />
              <Stat
                label={t("admin.statUnilabQueries")}
                value={uniLabCalls ? t("admin.statUnilabValue", { ok: x402Ok, failed: x402Failed }) : "…"}
              />
              <Stat
                label={t("admin.statPlatformRevenue")}
                value={
                  platformStats
                    ? `$${(
                        platformStats.totalPerformanceFee0Usd +
                        platformStats.totalPerformanceFee1Weth * (ethPrice ?? 0)
                      ).toFixed(2)}`
                    : "…"
                }
                accent
              />
            </div>

            <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">{t("admin.configLabel")}</p>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label={t("admin.statCapPerVault")}
                value={`${formatUnits((maxDepositUsd as bigint) ?? 0n, 6)} ${chain.stableSymbol}`}
              />
              <Stat
                label={t("admin.statPerformanceFee")}
                value={t("admin.statPerformanceFeeValue", { pct: Number((performanceFeeBps as bigint) ?? 0n) / 100 })}
              />
              <Stat
                label={t("admin.statCreationFee")}
                value={t("admin.statCreationFeeValue", {
                  amount: formatUnits((creationFeeUsdt as bigint) ?? 0n, 6),
                  symbol: chain.stableSymbol,
                })}
              />
              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  {t("admin.statDefaultOperator")}
                </span>
                <p className="mt-2 break-all font-mono text-xs text-white/90">{String(defaultOperator)}</p>
              </div>
              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{t("admin.statTreasury")}</span>
                <p className="mt-2 break-all font-mono text-xs text-white/90">{String(treasury)}</p>
              </div>
              <Stat label={t("admin.statEthPrice")} value={ethPrice !== undefined ? `$${ethPrice.toFixed(2)}` : "…"} />
            </div>

            <VolumeChart vaultAddresses={vaultAddresses} chain={chain} />
          </>
        )}


        {isPlatformOwner && (
          <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
            <h2
              className="text-xl font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {t("admin.editConfigTitle")}
            </h2>

            <div className="mt-6 flex flex-col gap-6">
              <AdminField
                label={t("admin.fieldNewOperator")}
                value={newOperator}
                onChange={setNewOperator}
                action={t("admin.actionUpdate")}
                disabled={Boolean(busy)}
                onSubmit={() =>
                  withTx("operator", () =>
                    writeContractAsync({
                      address: chain.platformConfigAddress || "0x0000000000000000000000000000000000000000",
                      abi: platformConfigAbi,
                      functionName: "setDefaultOperator",
                      args: [newOperator as `0x${string}`],
                      chainId: chain.id,
                    }),
                  )
                }
              />
              <AdminField
                label={t("admin.fieldNewCap", { symbol: chain.stableSymbol })}
                value={newCap}
                onChange={setNewCap}
                action={t("admin.actionUpdate")}
                disabled={Boolean(busy)}
                onSubmit={() =>
                  withTx("cap", () =>
                    writeContractAsync({
                      address: chain.platformConfigAddress || "0x0000000000000000000000000000000000000000",
                      abi: platformConfigAbi,
                      functionName: "setMaxDepositUsd",
                      args: [parseUnits(newCap || "0", 6)],
                      chainId: chain.id,
                    }),
                  )
                }
              />
              <AdminField
                label={t("admin.fieldNewPerformanceFee")}
                value={newPerformanceFeePct}
                onChange={setNewPerformanceFeePct}
                action={t("admin.actionUpdate")}
                disabled={Boolean(busy)}
                onSubmit={() =>
                  withTx("performanceFee", () =>
                    writeContractAsync({
                      address: chain.platformConfigAddress || "0x0000000000000000000000000000000000000000",
                      abi: platformConfigAbi,
                      functionName: "setPerformanceFeeBps",
                      args: [BigInt(Math.round(Number(newPerformanceFeePct || "0") * 100))],
                      chainId: chain.id,
                    }),
                  )
                }
              />
              <AdminField
                label={t("admin.fieldNewCreationFee", { symbol: chain.stableSymbol })}
                value={newCreationFee}
                onChange={setNewCreationFee}
                action={t("admin.actionUpdate")}
                disabled={Boolean(busy)}
                onSubmit={() =>
                  withTx("creationFee", () =>
                    writeContractAsync({
                      address: chain.platformConfigAddress || "0x0000000000000000000000000000000000000000",
                      abi: platformConfigAbi,
                      functionName: "setCreationFeeUsdt",
                      args: [parseUnits(newCreationFee || "0", 6)],
                      chainId: chain.id,
                    }),
                  )
                }
              />
              <AdminField
                label={t("admin.fieldNewTreasury")}
                value={newTreasury}
                onChange={setNewTreasury}
                action={t("admin.actionUpdate")}
                disabled={Boolean(busy)}
                onSubmit={() =>
                  withTx("treasury", () =>
                    writeContractAsync({
                      address: chain.platformConfigAddress || "0x0000000000000000000000000000000000000000",
                      abi: platformConfigAbi,
                      functionName: "setTreasury",
                      args: [newTreasury as `0x${string}`],
                      chainId: chain.id,
                    }),
                  )
                }
              />
            </div>

            <div className="mt-8 border-t border-hairline pt-6">
              <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-negative">
                {t("admin.transferOwnershipTitle")}
              </h3>
              <p className="mt-2 text-sm text-muted">{t("admin.transferOwnershipDesc")}</p>
              {hasPendingTransfer && (
                <p className="mt-2 font-mono text-xs text-accent">
                  {t("admin.pendingTransferBy", { address: String(pendingOwner) })}
                </p>
              )}
              <div className="mt-4">
                <AdminField
                  label={t("admin.fieldNewOwner", { chain: chain.name })}
                  value={newOwner}
                  onChange={setNewOwner}
                  action={t("admin.actionPropose")}
                  disabled={Boolean(busy)}
                  onSubmit={() =>
                    withTx("transferOwnership", () =>
                      writeContractAsync({
                        address: chain.platformConfigAddress || "0x0000000000000000000000000000000000000000",
                        abi: platformConfigAbi,
                        functionName: "transferOwnership",
                        args: [newOwner as `0x${string}`],
                        chainId: chain.id,
                      }),
                    )
                  }
                />
              </div>
            </div>

            {busy && (
              <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                {t("admin.processingLabel", { action: busy })}
              </p>
            )}
            {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}
          </div>
        )}

        {isPlatformOwner && (
          <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
            <h2
              className="text-xl font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {t("admin.unilabCallsTitle")}
            </h2>
            <p className="mt-2 text-sm text-muted">{t("admin.unilabCallsSubtitle")}</p>

            {uniLabCalls === null && (
              <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                {t("admin.loading")}
              </p>
            )}
            {uniLabCalls?.length === 0 && (
              <p className="mt-6 text-sm text-muted">{t("admin.noCallsYet")}</p>
            )}
            {uniLabCalls && uniLabCalls.length > 0 && (
              <div className="mt-6 flex flex-col gap-3">
                {uniLabCalls.map((call) => (
                  <UniLabCallRowView key={call.id} call={call} t={t} />
                ))}
              </div>
            )}
          </div>
        )}
          </>
        )}
      </main>
    </>
  );
}

function UniLabCallRowView({ call, t }: { call: UniLabCallRow; t: ReturnType<typeof useTranslation>["t"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
      >
        <span className="font-mono text-xs text-white/80">{call.endpoint}</span>
        <span className="break-all font-mono text-[11px] text-muted">{call.vault}</span>
        <span
          className={`font-mono text-[11px] uppercase tracking-[0.12em] ${call.ok ? "text-accent" : "text-negative"}`}
        >
          {call.ok ? t("admin.okLabel") : t("admin.errorShortLabel")} · {call.http_status} · {call.duration_ms}ms
        </span>
        <span className="font-mono text-[11px] text-muted">
          {new Date(call.created_at).toLocaleString()}
        </span>
      </button>
      {open && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{t("admin.requestLabel")}</span>
            <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-black/40 p-3 text-[11px] text-white/70">
              {JSON.stringify(call.request, null, 2)}
            </pre>
          </div>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              {call.ok ? t("admin.responseLabel") : t("admin.errorLabel")}
            </span>
            <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-black/40 p-3 text-[11px] text-white/70">
              {JSON.stringify(call.ok ? call.response : call.error, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  negative,
}: {
  label: string;
  value: string;
  accent?: boolean;
  negative?: boolean;
}) {
  return (
    <div
      className={
        negative
          ? "glass rounded-2xl border-negative/40 bg-negative/[0.06] p-5"
          : accent
            ? "glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5"
            : "glass rounded-2xl p-5"
      }
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <p
        className={`mt-2 text-lg font-semibold tabular-nums ${
          negative ? "text-negative" : accent ? "text-accent" : "text-white/90"
        }`}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </p>
    </div>
  );
}

function AdminField({
  label,
  value,
  onChange,
  action,
  onSubmit,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  action: string;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-64 flex-1 flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</span>
        <input className="field-input" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      <button onClick={onSubmit} disabled={disabled} className="btn-secondary !py-3">
        {action}
      </button>
    </div>
  );
}
