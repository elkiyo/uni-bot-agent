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
import { platformConfigAbi, vaultFactoryAbi, rangeVaultAbi, uniswapV3PoolAbi, positionManagerAbi, erc20Abi } from "@/lib/contracts";
import { USDC } from "@/lib/addresses";
import { ethPriceFromTick } from "@/lib/priceMath";
import { estimatePositionAmounts } from "@/lib/keeper/swapMath";
import { useSelectedChain } from "@/lib/useSelectedChain";

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
  const { selectedChain: chain } = useSelectedChain();
  const publicClient = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

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
      { address: chain.factoryAddress || undefined, abi: vaultFactoryAbi, functionName: "vaultCount", chainId: chain.id },
    ],
    query: { enabled: Boolean(chain.platformConfigAddress && chain.factoryAddress) },
  });

  const [owner, defaultOperator, maxDepositUsd, performanceFeeBps, creationFeeUsdt, treasury, vaultCount] =
    data?.map((d) => d.result) ?? [];
  const isPlatformOwner = Boolean(
    connected && owner && (connected as string).toLowerCase() === (owner as string).toLowerCase(),
  );

  // All vault addresses, to sum Rebalanced events across the whole platform.
  const { data: allVaultsData } = useReadContracts({
    contracts: Array.from({ length: Number(vaultCount ?? 0n) }, (_, i) => ({
      address: chain.factoryAddress || undefined,
      abi: vaultFactoryAbi,
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
              abi: rangeVaultAbi,
              eventName: "Rebalanced",
              fromBlock,
              toBlock,
            }),
            publicClient!.getContractEvents({
              address: vault,
              abi: rangeVaultAbi,
              eventName: "LpFeesPaidToOwner",
              fromBlock,
              toBlock,
            }),
            publicClient!.getContractEvents({
              address: vault,
              abi: rangeVaultAbi,
              eventName: "PerformanceFeeCollected",
              fromBlock,
              toBlock,
            }),
          ]);
          totalRebalances += rebalancedLogs.length;
          for (const log of lpFeeLogs as unknown as Array<{ args: { amount0: bigint; amount1: bigint } }>) {
            totalLpFees0Raw += log.args.amount0;
            totalLpFees1Raw += log.args.amount1;
          }
          for (const log of performanceFeeLogs as unknown as Array<{ args: { amount0: bigint; amount1: bigint } }>) {
            totalPerformanceFee0Raw += log.args.amount0;
            totalPerformanceFee1Raw += log.args.amount1;
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
  const ethPrice = currentTick !== undefined ? ethPriceFromTick(currentTick) : undefined;

  const { data: vaultLedgers } = useReadContracts({
    contracts: vaultAddresses.flatMap(
      (v) =>
        [
          { address: v, abi: rangeVaultAbi, functionName: "closed", chainId: chain.id },
          { address: v, abi: rangeVaultAbi, functionName: "positionTokenId", chainId: chain.id },
          { address: v, abi: rangeVaultAbi, functionName: "investableUsdt", chainId: chain.id },
          { address: v, abi: rangeVaultAbi, functionName: "reserveBalance", chainId: chain.id },
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
      totalPositionValueUsd += amount0Raw * 1e-6 + amount1Raw * 1e-18 * ethPrice;
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

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">Operaciones</span>
        <h1
          className="mt-5 text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Panel operativo
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
          Salud de la plataforma en vivo — capital bajo gestión, estado del operador, y la
          configuración global que aplica a todos los vaults.
        </p>

        {(!chain.platformConfigAddress || !chain.factoryAddress) && (
          <div className="glass mt-8 rounded-2xl border-accent/35 bg-accent/[0.06] p-5 text-sm text-muted">
            Los contratos todavía no están configurados en {chain.name}.
          </div>
        )}

        {operatorGasLow && (
          <div className="glass mt-8 rounded-2xl border-negative/40 bg-negative/[0.06] p-5">
            <p className="text-sm font-medium text-negative">
              El operador tiene menos de {chain.lowGasThreshold} {chain.viemChain.nativeCurrency.symbol} en {chain.name} —
              puede quedarse sin gas para rebalancear o barrer dust en cualquier momento.
            </p>
            <p className="mt-1 font-mono text-xs text-muted">
              Mandale {chain.viemChain.nativeCurrency.symbol} a {String(defaultOperator)}
            </p>
          </div>
        )}

        {data && (
          <>
            <p className="mt-10 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
              Capital bajo gestión
            </p>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label="TVL total" value={tvlUsd !== undefined ? `$${tvlUsd.toFixed(2)}` : "…"} accent />
              <Stat
                label="En posiciones"
                value={ethPrice !== undefined ? `$${totalPositionValueUsd.toFixed(2)}` : "…"}
              />
              <Stat
                label="Capital libre"
                value={`${totalIdleUsdtNum.toFixed(2)} ${chain.stableSymbol}${
                  totalIdleWethNum > 0 ? ` + ${totalIdleWethNum.toFixed(6)} ${chain.volatileSymbol}` : ""
                }`}
              />
              <Stat
                label="Comisiones LP generadas (bruto)"
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

            <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Vaults</p>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label="Activos" value={String(activeVaults.length)} accent />
              <Stat label="Cerrados" value={String(closedVaultsCount)} />
              <Stat
                label="Fuera de rango ahora"
                value={String(vaultsOutOfRange)}
                accent={vaultsOutOfRange > 0}
                negative={vaultsOutOfRange > 0}
              />
              <Stat label="Rebalanceos totales" value={platformStats ? String(platformStats.totalRebalances) : "…"} />
            </div>

            <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Operador</p>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label={`${chain.viemChain.nativeCurrency.symbol} (gas, ${chain.name})`}
                value={operatorGas ? `${Number(operatorGas.formatted).toFixed(3)} ${chain.viemChain.nativeCurrency.symbol}` : "…"}
                negative={operatorGasLow}
              />
              <Stat
                label="USDC (x402, Celo)"
                value={operatorUsdc !== undefined ? `${formatUnits(operatorUsdc as bigint, 6)} USDC` : "…"}
              />
              <Stat
                label="Consultas a uni-lab"
                value={uniLabCalls ? `${x402Ok} ok / ${x402Failed} fallidas` : "…"}
              />
              <Stat
                label="Revenue de plataforma"
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

            <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Configuración</p>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label="Tope por vault"
                value={`${formatUnits((maxDepositUsd as bigint) ?? 0n, 6)} ${chain.stableSymbol}`}
              />
              <Stat
                label="Performance fee"
                value={`${Number((performanceFeeBps as bigint) ?? 0n) / 100}% de las comisiones LP`}
              />
              <Stat
                label="Fee de creación"
                value={`${formatUnits((creationFeeUsdt as bigint) ?? 0n, 6)} ${chain.stableSymbol} · una vez por vault`}
              />
              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  Operador por defecto
                </span>
                <p className="mt-2 break-all font-mono text-xs text-white/90">{String(defaultOperator)}</p>
              </div>
              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Tesorería</span>
                <p className="mt-2 break-all font-mono text-xs text-white/90">{String(treasury)}</p>
              </div>
              <Stat label="Precio ETH" value={ethPrice !== undefined ? `$${ethPrice.toFixed(2)}` : "…"} />
            </div>

            <VolumeChart vaultAddresses={vaultAddresses} chain={chain} />
          </>
        )}

        {data && !isPlatformOwner && (
          <div className="glass mt-8 rounded-2xl p-6">
            <p className="text-sm text-muted">
              Conectá la wallet dueña de la plataforma (
              <code className="break-all font-mono text-xs">{String(owner)}</code>) para editar
              esta configuración.
            </p>
          </div>
        )}

        {isPlatformOwner && (
          <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
            <h2
              className="text-xl font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Editar configuración
            </h2>

            <div className="mt-6 flex flex-col gap-6">
              <AdminField
                label="Nuevo operador por defecto (address)"
                value={newOperator}
                onChange={setNewOperator}
                action="Actualizar"
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
                label={`Nuevo tope de depósito por vault (${chain.stableSymbol})`}
                value={newCap}
                onChange={setNewCap}
                action="Actualizar"
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
                label="Nuevo performance fee (%, sobre comisiones LP)"
                value={newPerformanceFeePct}
                onChange={setNewPerformanceFeePct}
                action="Actualizar"
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
                label={`Nuevo fee de creación (${chain.stableSymbol}, una vez por vault)`}
                value={newCreationFee}
                onChange={setNewCreationFee}
                action="Actualizar"
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
                label="Nueva tesorería (address)"
                value={newTreasury}
                onChange={setNewTreasury}
                action="Actualizar"
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

            {busy && (
              <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                Procesando: {busy}… firmá en tu wallet
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
              Consultas a uni-lab.xyz
            </h2>
            <p className="mt-2 text-sm text-muted">
              Últimas 50 llamadas pagas del keeper — request, respuesta, y si el vault ya la usó.
            </p>

            {uniLabCalls === null && (
              <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                Cargando…
              </p>
            )}
            {uniLabCalls?.length === 0 && (
              <p className="mt-6 text-sm text-muted">Todavía no hay consultas registradas.</p>
            )}
            {uniLabCalls && uniLabCalls.length > 0 && (
              <div className="mt-6 flex flex-col gap-3">
                {uniLabCalls.map((call) => (
                  <UniLabCallRowView key={call.id} call={call} />
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}

function UniLabCallRowView({ call }: { call: UniLabCallRow }) {
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
          {call.ok ? "ok" : "error"} · {call.http_status} · {call.duration_ms}ms
        </span>
        <span className="font-mono text-[11px] text-muted">
          {new Date(call.created_at).toLocaleString()}
        </span>
      </button>
      {open && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Request</span>
            <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-black/40 p-3 text-[11px] text-white/70">
              {JSON.stringify(call.request, null, 2)}
            </pre>
          </div>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              {call.ok ? "Response" : "Error"}
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
