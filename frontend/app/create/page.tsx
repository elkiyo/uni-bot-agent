"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useWriteContract, useSwitchChain } from "wagmi";
import { decodeEventLog, formatUnits, parseUnits } from "viem";
import { Header } from "../components/Header";
import { AlertModal } from "../components/AlertModal";
import { erc20Abi, uniswapV3PoolAbi, platformConfigAbi } from "@/lib/contracts";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";
import { usePoolMetrics } from "@/lib/usePoolMetrics";
import { useSelectedChain, useAvailableChains } from "@/lib/useSelectedChain";
import { formatUsdCompact } from "@/lib/format";

type Step = "idle" | "creating" | "approving" | "configuring" | "risk" | "depositing" | "done" | "error";

function stepLabelFor(stableSymbol: string): Record<Step, string> {
  return {
    idle: "Crear vault",
    creating: "1/5 · Creando vault…",
    approving: `2/5 · Aprobando ${stableSymbol}…`,
    configuring: "3/5 · Configurando objetivo…",
    risk: "4/5 · Fijando límites de riesgo…",
    depositing: "5/5 · Depositando…",
    done: "Listo ✓",
    error: "Reintentar",
  };
}

// The 5 signatures the wallet is going to ask for, in order — shown as a
// checklist so the user knows what each one actually does before signing,
// not just a changing "3/5…" label on the button mid-flow.
function signatureStepsFor(
  stableSymbol: string,
): { key: Exclude<Step, "idle" | "done" | "error">; title: string; desc: string }[] {
  return [
    {
      key: "creating",
      title: "Crear vault",
      desc: "Despliega tu vault personal (un clon del contrato) — todavía no mueve ningún fondo.",
    },
    {
      key: "approving",
      title: `Aprobar ${stableSymbol}`,
      desc: `Le da permiso al vault para transferir el ${stableSymbol} que vas a depositar en el siguiente paso.`,
    },
    {
      key: "configuring",
      title: "Configurar objetivo",
      desc: "Fija el rango de precio, el tope de rebalanceos y el tope de reinyección que el agente tiene que respetar.",
    },
    {
      key: "risk",
      title: "Fijar límites de riesgo",
      desc: "Slippage máximo y cuánto puede desviarse el rango que proponga el agente del precio de mercado.",
    },
    {
      key: "depositing",
      title: "Depositar",
      desc: `Transfiere el ${stableSymbol} real al vault, repartido entre las reservas que configuraste arriba.`,
    },
  ];
}

export default function CreateVault() {
  const router = useRouter();
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { selectedChain: chain, setSelectedChainId } = useSelectedChain();
  const availableChains = useAvailableChains();
  const publicClient = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const stepLabel = stepLabelFor(chain.stableSymbol);
  const SIGNATURE_STEPS = signatureStepsFor(chain.stableSymbol);
  const SIGNATURE_KEYS = SIGNATURE_STEPS.map((s) => s.key);

  // Which fee-tier pool the NEW position itself will live in — independent
  // of pickDeepestSwapFee (server-side, keeper-only: picks where SWAPS
  // route). This is a yield-strategy choice, not a pure cost minimization —
  // see usePoolMetrics's own docstring for why a lower fee tier isn't
  // automatically better. Defaults to the platform's main pool (chain.feeTier).
  const { data: poolMetrics } = usePoolMetrics(chain);
  const [selectedFee, setSelectedFee] = useState<number>(chain.feeTier);
  const selectedPoolMeta = poolMetrics?.find((p) => p.fee === selectedFee);
  const selectedPool = (selectedPoolMeta?.pool ?? chain.pool) as `0x${string}`;

  const { data: slot0 } = useReadContract({
    address: selectedPool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    chainId: chain.id,
  });
  const { data: tickSpacing } = useReadContract({
    address: selectedPool,
    abi: uniswapV3PoolAbi,
    functionName: "tickSpacing",
    chainId: chain.id,
  });
  const { data: creationFeeUsdtRaw } = useReadContract({
    address: chain.platformConfigAddress || undefined,
    abi: platformConfigAbi,
    functionName: "creationFeeUsdt",
    chainId: chain.id,
  });
  const creationFeeUsdt = (creationFeeUsdtRaw as bigint) ?? 0n;
  // 0 == no cap, same convention RangeVault.deposit() itself uses — read live
  // so a later platform change (e.g. raising it) is reflected without a
  // frontend redeploy. New vault, so nothing previously committed to weigh in.
  const { data: maxDepositUsdRaw } = useReadContract({
    address: chain.platformConfigAddress || undefined,
    abi: platformConfigAbi,
    functionName: "maxDepositUsd",
    chainId: chain.id,
  });
  const maxDepositUsd = (maxDepositUsdRaw as bigint) ?? 0n;
  const [capAlert, setCapAlert] = useState<string | null>(null);

  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;
  const currentPrice = currentTick !== undefined ? ethPriceFromTick(currentTick, chain.stableIsToken0) : undefined;

  // All fields start empty — nothing is submitted until the user actually
  // types a value. The numbers shown below (as `placeholder`, not `value`)
  // are just worked examples, computed live where it makes sense (min/max
  // price from the pool's current price ±10%) so there's no setState-in-effect
  // prefill trick needed.
  const [investAmount, setInvestAmount] = useState("");
  // Min/max are independent — no forced symmetry; the contract has never
  // required it, only the old UI did.
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [maxRebalances, setMaxRebalances] = useState("");
  const [reinjectionAmount, setReinjectionAmount] = useState("");
  const [periodicHours, setPeriodicHours] = useState("");
  // Only meaningful on chains whose vault has a dedicated gasReserveBalance
  // ledger (RangeVaultArb — see chains.ts's supportsGasReserve) — optional,
  // blank = 0: the keeper gas reimbursement never blocks a rebalance even
  // with zero budget (see RangeVaultArb.sol), it just reimburses nothing
  // until the owner tops this up.
  const [gasReserveAmount, setGasReserveAmount] = useState("");

  // Advanced / risk knobs — unlike the fields above, these DO have sensible
  // platform defaults (same values that used to be hardcoded here), so
  // leaving them blank is a valid choice, not an error. See RangeVault.sol
  // for what each one actually gates.
  const [maxSlippagePct, setMaxSlippagePct] = useState("");
  const [minRebalanceCooldownHours, setMinRebalanceCooldownHours] = useState("");
  const [maxRangeDeviationTicks, setMaxRangeDeviationTicks] = useState("");
  const [recenterMarginPct, setRecenterMarginPct] = useState("");
  const [exitTopCeilingMarginPct, setExitTopCeilingMarginPct] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copiedPool, setCopiedPool] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [failedAt, setFailedAt] = useState<Step | null>(null);

  const minPricePlaceholder = currentPrice !== undefined ? (currentPrice * 0.9).toFixed(2) : "1604.18";
  const maxPricePlaceholder = currentPrice !== undefined ? (currentPrice * 1.1).toFixed(2) : "1960.66";

  const totalUsdt =
    (parseFloat(investAmount) || 0) +
    (parseFloat(reinjectionAmount) || 0) +
    (chain.supportsGasReserve ? parseFloat(gasReserveAmount) || 0 : 0) +
    Number(formatUnits(creationFeeUsdt, 6));
  const lowerPreview = parseFloat(minPrice) || undefined;
  const upperPreview = parseFloat(maxPrice) || undefined;

  async function handleCreate() {
    if (!address || !publicClient || currentPrice === undefined || tickSpacing === undefined) return;
    setError(null);
    setFailedAt(null);
    let currentPhase: Step = "creating"; // tracked outside React state — setStep() batches, so `step` itself isn't reliable to read back mid-function

    if (!investAmount || !minPrice || !maxPrice || !maxRebalances || !reinjectionAmount || !periodicHours) {
      setError("Completá todos los campos — no hay valores por defecto.");
      setStep("error");
      return;
    }

    // Same check RangeVault.deposit() itself makes (reserveAmount +
    // investableAmount vs PlatformConfig.maxDepositUsd, fee excluded) — catch
    // it here so the wallet never even pops up for a deposit that's certain
    // to revert on-chain. Confirmed in production 2026-07-17: a user hit
    // DepositExceedsPlatformCap with no explanation, just a raw revert.
    const requestedTotalUsd =
      (parseFloat(investAmount) || 0) +
      (parseFloat(reinjectionAmount) || 0) +
      (chain.supportsGasReserve ? parseFloat(gasReserveAmount) || 0 : 0);
    if (maxDepositUsd !== 0n && requestedTotalUsd > Number(formatUnits(maxDepositUsd, 6))) {
      setCapAlert(
        `El tope de depósito de la plataforma es ${formatUnits(maxDepositUsd, 6)} ${chain.stableSymbol}. ` +
          `Estás pidiendo ${requestedTotalUsd.toFixed(2)} ${chain.stableSymbol} entre capital invertible, reserva y presupuesto de gas — reducí el monto.`,
      );
      return;
    }

    // The viewing chain (chain, from useSelectedChain) and the wallet's
    // actual connected chain are independent — see the network picker above.
    // Every write in this flow targets `chain`, so the wallet has to
    // actually be on it before the first signature.
    if (walletChainId !== chain.id) {
      try {
        await switchChainAsync({ chainId: chain.id });
      } catch {
        setError(`Cambiá tu wallet a ${chain.name} para crear un vault ahí.`);
        setStep("error");
        return;
      }
    }

    try {
      currentPhase = "creating";
      setStep(currentPhase);
      const createHash = await writeContractAsync({
        address: chain.factoryAddress || "0x0000000000000000000000000000000000000000",
        abi: chain.factoryAbi,
        functionName: "createVault",
        args: [selectedPool, chain.stableToken, chain.volatileToken, selectedFee],
        chainId: chain.id,
      });
      const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

      let vaultAddress: `0x${string}` | undefined;
      for (const log of createReceipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: chain.factoryAbi, data: log.data, topics: log.topics });
          if (decoded.eventName === "VaultCreated") {
            vaultAddress = (decoded.args as unknown as { vault: `0x${string}` }).vault;
            break;
          }
        } catch {
          // not the event we're looking for, ignore
        }
      }
      if (!vaultAddress) throw new Error("VaultCreated event not found in receipt");

      const lowerPrice = Number(minPrice);
      const upperPrice = Number(maxPrice);
      if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) {
        throw new Error("El precio máximo debe ser mayor al mínimo, ambos positivos");
      }
      // Whether a HIGHER USD price of ETH maps to a lower or higher tick depends
      // on chain.stableIsToken0 (Celo vs Arbitrum sort WETH/stable oppositely),
      // so converting the two price bounds can yield ticks in either order —
      // sort them, Uniswap requires tickLower < tickUpper or every mint reverts.
      const tickA = alignToTickSpacing(tickFromEthPrice(lowerPrice, chain.stableIsToken0), Number(tickSpacing));
      const tickB = alignToTickSpacing(tickFromEthPrice(upperPrice, chain.stableIsToken0), Number(tickSpacing));
      const targetTickLower = Math.min(tickA, tickB);
      const targetTickUpper = Math.max(tickA, tickB);

      const investable = parseUnits(investAmount, 6);
      const reserve = parseUnits(reinjectionAmount, 6);
      const gasReserve = chain.supportsGasReserve ? parseUnits(gasReserveAmount || "0", 6) : 0n;
      const total = investable + reserve + gasReserve;

      currentPhase = "approving";
      setStep(currentPhase);
      // Approve total + creationFeeUsdt — deposit() pulls the one-time creation
      // fee on top of investable+reserve on a vault's first deposit (see
      // RangeVault.sol), so the approval has to cover it too or that call reverts.
      const approveHash = await writeContractAsync({
        address: chain.stableToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [vaultAddress, total + creationFeeUsdt],
        chainId: chain.id,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      // Blank = platform default, same values this form used to hardcode —
      // see the field hints for what each one does.
      const recenterMarginBps = recenterMarginPct ? BigInt(Math.round(Number(recenterMarginPct) * 100)) : 500n;
      const exitTopCeilingMarginBps = exitTopCeilingMarginPct
        ? BigInt(Math.round(Number(exitTopCeilingMarginPct) * 100))
        : 300n;

      currentPhase = "configuring";
      setStep(currentPhase);
      const configureHash = await writeContractAsync({
        address: vaultAddress,
        abi: chain.vaultAbi,
        functionName: "configureTarget",
        args: [
          parseUnits(investAmount, 6),
          targetTickLower,
          targetTickUpper,
          BigInt(maxRebalances),
          reserve,
          BigInt(Number(periodicHours) * 3600),
          recenterMarginBps,
          exitTopCeilingMarginBps,
        ],
        chainId: chain.id,
      });
      await publicClient.waitForTransactionReceipt({ hash: configureHash });

      // setRiskParams is mandatory, not optional: the vault initializes with
      // maxRangeDeviationBps = 0, and RangeVault._checkRangeNearMarket rejects
      // any range whose center isn't exactly the current tick under that value
      // — so without this call the agent's initPosition() would revert with
      // RangeTooFarFromMarket almost every time.
      //
      // A half-width-of-initial-range heuristic used to live here, but real
      // production data (2026-07-15) showed it's not a reliable estimate: the
      // periodic-rebalance path pins the old floor and lets uni-lab's real RC
      // calculation pick the ceiling, and that real (paid, on-chain-confirmed)
      // answer landed the range's center ~260-290 ticks from market on 3
      // vaults whose half-width was only 135-150 — genuinely blocked, not a
      // keeper-side estimation bug (see rebalancer.ts's own fix the same day,
      // which stopped trusting a local guess and started using uni-lab's real
      // range — the real range still didn't fit). The three values below now
      // come from the form (blank = the same generous defaults this used to
      // hardcode) instead of being fixed for every vault — see field hints.
      currentPhase = "risk";
      setStep(currentPhase);
      const maxSlippageBps = maxSlippagePct ? BigInt(Math.round(Number(maxSlippagePct) * 100)) : 30n;
      const minRebalanceIntervalSec = minRebalanceCooldownHours
        ? BigInt(Math.round(Number(minRebalanceCooldownHours) * 3600))
        : 0n;
      const maxRangeDeviationBps = maxRangeDeviationTicks ? BigInt(maxRangeDeviationTicks) : 5_000n;
      const riskHash = await writeContractAsync({
        address: vaultAddress,
        abi: chain.vaultAbi,
        functionName: "setRiskParams",
        args: [maxSlippageBps, minRebalanceIntervalSec, maxRangeDeviationBps],
        chainId: chain.id,
      });
      await publicClient.waitForTransactionReceipt({ hash: riskHash });

      currentPhase = "depositing";
      setStep(currentPhase);
      const depositHash = await writeContractAsync({
        address: vaultAddress,
        abi: chain.vaultAbi,
        functionName: "deposit",
        // RangeVaultArb's deposit() takes a 3rd gasReserveAmount arg that the
        // original RangeVault.sol doesn't have — chain.vaultAbi already
        // reflects whichever contract this chain actually runs (see
        // chains.ts), so the arg count has to match it exactly.
        args: chain.supportsGasReserve ? [reserve, investable, gasReserve] : [reserve, investable],
        chainId: chain.id,
      });
      await publicClient.waitForTransactionReceipt({ hash: depositHash });

      setStep("done");
      router.push(`/vault/${vaultAddress}`);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setFailedAt(currentPhase);
      setStep("error");
    }
  }

  const busy = step !== "idle" && step !== "done" && step !== "error";

  return (
    <>
      {capAlert && (
        <AlertModal title="Supera el tope de depósito" message={capAlert} onClose={() => setCapAlert(null)} />
      )}
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">Nuevo vault</span>
        </div>
        <h1
          className="mt-5 text-balance text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Configurá tu posición
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
          Par {chain.stableSymbol}/{chain.volatileSymbol} en {chain.name}. El agente arma la posición inicial con
          estos parámetros y la rebalancea automáticamente — vos mantenés el control y la custodia.
        </p>

        {availableChains.length > 1 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Red:</span>
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

        {isConnected && (
          <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              Elegí la pool donde vive tu posición
            </span>
            <p className="mt-1 text-xs text-faint">
              Métricas en vivo, se actualizan cada minuto. Menor fee no es automáticamente mejor —
              depende del volumen real que pase por esa pool, no solo de la tasa. La comisión por
              unidad de liquidez es la mejor referencia de cuánto rendiría un LP ahí ahora mismo.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {(poolMetrics ?? []).map((p) => {
                const isSelected = p.fee === selectedFee;
                const disabled = !p.exists || p.liquidity === 0n;
                return (
                  <div
                    key={p.fee}
                    className={`rounded-xl border p-4 transition ${
                      isSelected
                        ? "border-accent bg-accent/[0.08]"
                        : disabled
                          ? "border-hairline opacity-40"
                          : "border-hairline hover:border-accent/50"
                    }`}
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setSelectedFee(p.fee)}
                      className="w-full text-left"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm font-semibold">{p.fee / 10_000}%</span>
                        {isSelected && <span className="font-mono text-[10px] uppercase text-accent">Elegida</span>}
                      </div>
                      {disabled ? (
                        <p className="mt-2 text-xs text-faint">Sin liquidez — no disponible</p>
                      ) : (
                        <dl className="mt-2 flex flex-col gap-1 text-xs text-muted">
                          <div className="flex justify-between">
                            <dt>TVL</dt>
                            <dd className="font-mono">{formatUsdCompact(p.tvlUsd)}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>Liquidez</dt>
                            <dd className="font-mono" title={p.liquidity.toString()}>
                              {Number(p.liquidity).toExponential(2)}
                            </dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>Volumen (reciente)</dt>
                            <dd className="font-mono">{formatUsdCompact(p.volumeStable)}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>Swaps (reciente)</dt>
                            <dd className="font-mono">{p.swapCount}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>Comisión/liquidez</dt>
                            <dd className="font-mono">
                              {p.feeRevenuePerLiquidity !== undefined
                                ? p.feeRevenuePerLiquidity.toExponential(2)
                                : "—"}
                            </dd>
                          </div>
                        </dl>
                      )}
                    </button>

                    {p.exists && (
                      <div className="mt-3 flex items-center justify-between border-t border-hairline/50 pt-3">
                        <span className="eyebrow !px-2 !py-0.5 !text-[9px]">V3</span>
                        <div className="flex items-center gap-2 font-mono text-[10px] text-faint">
                          <button
                            type="button"
                            onClick={async () => {
                              await navigator.clipboard.writeText(p.pool);
                              setCopiedPool(p.pool);
                              setTimeout(() => setCopiedPool((cur) => (cur === p.pool ? null : cur)), 1500);
                            }}
                            className="transition-colors hover:text-accent"
                            title="Copiar dirección de la pool"
                          >
                            {copiedPool === p.pool
                              ? "Copiado ✓"
                              : `${p.pool.slice(0, 6)}…${p.pool.slice(-4)}`}
                          </button>
                          <a
                            href={`${chain.explorerBaseUrl}/address/${p.pool}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="transition-colors hover:text-accent"
                            title="Ver en el explorer"
                          >
                            ↗
                          </a>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!chain.factoryAddress && (
          <div className="glass mt-8 rounded-2xl border-accent/35 bg-accent/[0.06] p-5 text-sm text-muted">
            Los contratos todavía no están configurados en {chain.name}.
          </div>
        )}

        {isConnected ? (
          <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_360px]">
            {/* Form */}
            <div className="glass rounded-2xl p-6 sm:p-8">
              <div className="grid gap-6 sm:grid-cols-2">
                <Field
                  label="Monto de inversión"
                  suffix={chain.stableSymbol}
                  value={investAmount}
                  onChange={setInvestAmount}
                  placeholder="100"
                />
                <Field
                  label="Precio mínimo"
                  suffix="USD"
                  value={minPrice}
                  onChange={setMinPrice}
                  placeholder={minPricePlaceholder}
                  hint="Piso del rango — no tiene que ser simétrico"
                />
                <Field
                  label="Precio máximo"
                  suffix="USD"
                  value={maxPrice}
                  onChange={setMaxPrice}
                  placeholder={maxPricePlaceholder}
                  hint="Techo del rango"
                />
                <Field
                  label="Tope de rebalanceos"
                  value={maxRebalances}
                  onChange={setMaxRebalances}
                  placeholder="10"
                  hint="Tu techo de gasto en fees"
                />
                <Field
                  label="Tope de reinyección por ciclo"
                  suffix={chain.stableSymbol}
                  value={reinjectionAmount}
                  onChange={setReinjectionAmount}
                  placeholder="10"
                  hint="Máximo que el agente puede mover de la reserva por rebalanceo"
                />
                <Field
                  label="Rebalanceo periódico"
                  suffix="horas"
                  value={periodicHours}
                  onChange={setPeriodicHours}
                  placeholder="24"
                />
                {chain.supportsGasReserve && (
                  <Field
                    label={
                      <>
                        Presupuesto de gas para el <span className="text-accent">agente</span>
                      </>
                    }
                    suffix={chain.stableSymbol}
                    value={gasReserveAmount}
                    onChange={setGasReserveAmount}
                    placeholder="5"
                    hint="Le reembolsa al operador el gas real de cada rebalanceo — opcional, dejar en blanco es 0. Si se agota, el agente sigue rebalanceando igual, solo deja de cobrar hasta que deposites más."
                  />
                )}
              </div>

              <div className="mt-8">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-white"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    className={`shrink-0 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                  >
                    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Avanzado — dejar en blanco usa los valores por defecto de la plataforma
                </button>
                {showAdvanced && (
                  <div className="mt-4 grid gap-6 sm:grid-cols-2">
                    <Field
                      label="Slippage máximo"
                      suffix="%"
                      value={maxSlippagePct}
                      onChange={setMaxSlippagePct}
                      placeholder="0.3"
                    />
                    <Field
                      label="Cooldown mínimo entre rebalanceos"
                      suffix="horas"
                      value={minRebalanceCooldownHours}
                      onChange={setMinRebalanceCooldownHours}
                      placeholder="0"
                      hint="0 = sin piso además del periódico"
                    />
                    <Field
                      label="Desviación máx. de rango"
                      suffix="ticks"
                      value={maxRangeDeviationTicks}
                      onChange={setMaxRangeDeviationTicks}
                      placeholder="5000"
                      hint="Cuánto puede alejarse el precio del rango propuesto sin que el contrato lo rechace"
                    />
                    <Field
                      label="Margen de recentrado"
                      suffix="%"
                      value={recenterMarginPct}
                      onChange={setRecenterMarginPct}
                      placeholder="5"
                      hint="Piso nuevo por debajo del precio al reconstruir el rango desde cero"
                    />
                    <Field
                      label="Margen del techo (salida por arriba)"
                      suffix="%"
                      value={exitTopCeilingMarginPct}
                      onChange={setExitTopCeilingMarginPct}
                      placeholder="3"
                      hint="Techo nuevo por encima del precio al salir de rango por arriba"
                    />
                  </div>
                )}
              </div>

              <button onClick={handleCreate} disabled={busy || !chain.factoryAddress} className="btn-primary mt-8 w-full">
                {stepLabel[step]}
              </button>

              {busy && (
                <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                  Firmá cada transacción en tu wallet — son 5 en total
                </p>
              )}
              {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}

              <div className="mt-6">
                <SignatureStepper current={step} failedAt={failedAt} steps={SIGNATURE_STEPS} keys={SIGNATURE_KEYS} />
              </div>
            </div>

            {/* Live summary */}
            <aside className="flex flex-col gap-4">
              <div className="glass rounded-2xl border-accent/35 bg-accent/[0.06] p-6">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
                  Resumen
                </span>
                <dl className="mt-4 flex flex-col gap-3 text-sm">
                  <SummaryRow k="Pool elegida" v={`${selectedFee / 10_000}%`} />
                  <SummaryRow
                    k="Precio actual ETH"
                    v={currentPrice !== undefined ? `$${currentPrice.toFixed(2)}` : "…"}
                  />
                  <SummaryRow
                    k="Rango estimado"
                    v={
                      lowerPreview !== undefined && upperPreview !== undefined
                        ? `$${lowerPreview.toFixed(0)} – $${upperPreview.toFixed(0)}`
                        : "…"
                    }
                  />
                  <div className="my-1 border-t border-hairline" />
                  <SummaryRow k="Capital invertible" v={`${investAmount || "0"} ${chain.stableSymbol}`} />
                  <SummaryRow k="Reserva de reinyección" v={`${reinjectionAmount || "0"} ${chain.stableSymbol}`} />
                  {chain.supportsGasReserve && (
                    <SummaryRow k="Presupuesto de gas" v={`${gasReserveAmount || "0"} ${chain.stableSymbol}`} />
                  )}
                  {creationFeeUsdt > 0n && (
                    <SummaryRow
                      k="Fee de creación (una vez)"
                      v={`${formatUnits(creationFeeUsdt, 6)} ${chain.stableSymbol}`}
                    />
                  )}
                  <div className="my-1 border-t border-hairline" />
                  <SummaryRow k="Total a depositar" v={`${totalUsdt.toFixed(2)} ${chain.stableSymbol}`} strong />
                  {maxDepositUsd > 0n && (
                    <SummaryRow
                      k="Tope de la plataforma"
                      v={`${formatUnits(maxDepositUsd, 6)} ${chain.stableSymbol}`}
                    />
                  )}
                </dl>
              </div>

              <div className="glass rounded-2xl p-5">
                <p className="text-[13px] leading-relaxed text-muted">
                  El agente cobra el fee de la plataforma por cada rebalanceo exitoso, hasta el
                  tope que definas. Podés pausar, revocar al operador o retirar todo en
                  cualquier momento.
                </p>
              </div>
            </aside>
          </div>
        ) : (
          <div className="glass mt-10 rounded-2xl p-10 text-center">
            <p className="text-muted">Conectá tu wallet para crear un vault.</p>
          </div>
        )}
      </main>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  hint,
  placeholder,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <div className="relative">
        <input
          className="field-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode="decimal"
        />
        {suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center font-mono text-xs text-faint">
            {suffix}
          </span>
        )}
      </div>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

function SummaryRow({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className={strong ? "font-semibold text-accent" : "font-medium text-white/90"}>{v}</dd>
    </div>
  );
}

/** Shows the 5 signatures the wallet will ask for, what each one does, and —
 * once the flow starts — which one is in progress / done / where it failed.
 * Visible from before the user even clicks "Crear vault", not just mid-flow. */
function SignatureStepper({
  current,
  failedAt,
  steps,
  keys,
}: {
  current: Step;
  failedAt: Step | null;
  steps: ReturnType<typeof signatureStepsFor>;
  keys: Step[];
}) {
  const currentIndex = keys.indexOf(current);
  const isDone = current === "done";
  const isError = current === "error";
  const failedIndex = failedAt ? keys.indexOf(failedAt) : -1;

  return (
    <div className="glass rounded-2xl p-5">
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
        Firmas necesarias (5)
      </span>
      <ol className="mt-4 flex flex-col gap-4">
        {steps.map((s, i) => {
          const done = isDone || i < currentIndex || (isError && i < failedIndex);
          const failed = isError && i === failedIndex;
          const active = !isDone && !isError && i === currentIndex;
          return (
            <li key={s.key} className="flex gap-3">
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] ${
                  failed
                    ? "bg-negative/20 text-negative"
                    : done
                      ? "bg-accent text-black"
                      : active
                        ? "border border-accent text-accent"
                        : "border border-hairline text-faint"
                }`}
              >
                {failed ? "!" : done ? "✓" : i + 1}
              </span>
              <div>
                <p className={`text-sm font-medium ${active ? "text-accent" : "text-white/90"}`}>{s.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{s.desc}</p>
                {failed && <p className="mt-1 text-xs text-negative">Falló acá — revisá el error abajo y reintentá.</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
