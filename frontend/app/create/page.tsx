"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { decodeEventLog, formatUnits, parseUnits } from "viem";
import { Header } from "../components/Header";
import { AlertModal } from "../components/AlertModal";
import { vaultFactoryAbi, rangeVaultAbi, erc20Abi, uniswapV3PoolAbi, platformConfigAbi } from "@/lib/contracts";
import { FACTORY_ADDRESS, PLATFORM_CONFIG_ADDRESS, USDT, WETH, POOL, FEE_TIER } from "@/lib/addresses";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";
import { usePoolMetrics } from "@/lib/usePoolMetrics";

type Step = "idle" | "creating" | "approving" | "configuring" | "risk" | "depositing" | "done" | "error";

const stepLabel: Record<Step, string> = {
  idle: "Crear vault",
  creating: "1/5 · Creando vault…",
  approving: "2/5 · Aprobando USDT…",
  configuring: "3/5 · Configurando objetivo…",
  risk: "4/5 · Fijando límites de riesgo…",
  depositing: "5/5 · Depositando…",
  done: "Listo ✓",
  error: "Reintentar",
};

// The 5 signatures the wallet is going to ask for, in order — shown as a
// checklist so the user knows what each one actually does before signing,
// not just a changing "3/5…" label on the button mid-flow.
const SIGNATURE_STEPS: { key: Exclude<Step, "idle" | "done" | "error">; title: string; desc: string }[] = [
  {
    key: "creating",
    title: "Crear vault",
    desc: "Despliega tu vault personal (un clon del contrato) — todavía no mueve ningún fondo.",
  },
  {
    key: "approving",
    title: "Aprobar USDT",
    desc: "Le da permiso al vault para transferir el USDT que vas a depositar en el siguiente paso.",
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
    desc: "Transfiere el USDT real al vault, repartido en capital invertible y reserva de reinyección.",
  },
];
const SIGNATURE_KEYS = SIGNATURE_STEPS.map((s) => s.key);

export default function CreateVault() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // Which fee-tier pool the NEW position itself will live in — independent
  // of pickDeepestSwapFee (server-side, keeper-only: picks where SWAPS
  // route). This is a yield-strategy choice, not a pure cost minimization —
  // see usePoolMetrics's own docstring for why a lower fee tier isn't
  // automatically better. Defaults to the platform's main pool (FEE_TIER).
  const { data: poolMetrics } = usePoolMetrics();
  const [selectedFee, setSelectedFee] = useState<number>(FEE_TIER);
  const selectedPoolMeta = poolMetrics?.find((p) => p.fee === selectedFee);
  const selectedPool = (selectedPoolMeta?.pool ?? POOL) as `0x${string}`;

  const { data: slot0 } = useReadContract({
    address: selectedPool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
  });
  const { data: tickSpacing } = useReadContract({
    address: selectedPool,
    abi: uniswapV3PoolAbi,
    functionName: "tickSpacing",
  });
  const { data: creationFeeUsdtRaw } = useReadContract({
    address: PLATFORM_CONFIG_ADDRESS,
    abi: platformConfigAbi,
    functionName: "creationFeeUsdt",
  });
  const creationFeeUsdt = (creationFeeUsdtRaw as bigint) ?? 0n;
  // 0 == no cap, same convention RangeVault.deposit() itself uses — read live
  // so a later platform change (e.g. raising it) is reflected without a
  // frontend redeploy. New vault, so nothing previously committed to weigh in.
  const { data: maxDepositUsdRaw } = useReadContract({
    address: PLATFORM_CONFIG_ADDRESS,
    abi: platformConfigAbi,
    functionName: "maxDepositUsd",
  });
  const maxDepositUsd = (maxDepositUsdRaw as bigint) ?? 0n;
  const [capAlert, setCapAlert] = useState<string | null>(null);

  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;
  const currentPrice = currentTick !== undefined ? ethPriceFromTick(currentTick) : undefined;

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

  // Advanced / risk knobs — unlike the fields above, these DO have sensible
  // platform defaults (same values that used to be hardcoded here), so
  // leaving them blank is a valid choice, not an error. See RangeVault.sol
  // for what each one actually gates.
  const [maxSlippagePct, setMaxSlippagePct] = useState("");
  const [minRebalanceCooldownHours, setMinRebalanceCooldownHours] = useState("");
  const [maxRangeDeviationTicks, setMaxRangeDeviationTicks] = useState("");
  const [recenterMarginPct, setRecenterMarginPct] = useState("");
  const [exitTopCeilingMarginPct, setExitTopCeilingMarginPct] = useState("");

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [failedAt, setFailedAt] = useState<Step | null>(null);

  const minPricePlaceholder = currentPrice !== undefined ? (currentPrice * 0.9).toFixed(2) : "1604.18";
  const maxPricePlaceholder = currentPrice !== undefined ? (currentPrice * 1.1).toFixed(2) : "1960.66";

  const totalUsdt =
    (parseFloat(investAmount) || 0) + (parseFloat(reinjectionAmount) || 0) + Number(formatUnits(creationFeeUsdt, 6));
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
    const requestedTotalUsd = (parseFloat(investAmount) || 0) + (parseFloat(reinjectionAmount) || 0);
    if (maxDepositUsd !== 0n && requestedTotalUsd > Number(formatUnits(maxDepositUsd, 6))) {
      setCapAlert(
        `El tope de depósito de la plataforma es ${formatUnits(maxDepositUsd, 6)} USDT. ` +
          `Estás pidiendo ${requestedTotalUsd.toFixed(2)} USDT entre capital invertible y reserva — reducí el monto.`,
      );
      return;
    }

    try {
      currentPhase = "creating";
      setStep(currentPhase);
      const createHash = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: vaultFactoryAbi,
        functionName: "createVault",
        args: [selectedPool, USDT, WETH, selectedFee],
      });
      const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

      let vaultAddress: `0x${string}` | undefined;
      for (const log of createReceipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: vaultFactoryAbi, data: log.data, topics: log.topics });
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
      // In this pool a HIGHER USD price of ETH maps to a LOWER tick (token1/token0
      // inversion), so converting the price bounds yields swapped ticks — sort them,
      // Uniswap requires tickLower < tickUpper or every mint reverts.
      const tickA = alignToTickSpacing(tickFromEthPrice(lowerPrice), Number(tickSpacing));
      const tickB = alignToTickSpacing(tickFromEthPrice(upperPrice), Number(tickSpacing));
      const targetTickLower = Math.min(tickA, tickB);
      const targetTickUpper = Math.max(tickA, tickB);

      const investable = parseUnits(investAmount, 6);
      const reserve = parseUnits(reinjectionAmount, 6);
      const total = investable + reserve;

      currentPhase = "approving";
      setStep(currentPhase);
      // Approve total + creationFeeUsdt — deposit() pulls the one-time creation
      // fee on top of investable+reserve on a vault's first deposit (see
      // RangeVault.sol), so the approval has to cover it too or that call reverts.
      const approveHash = await writeContractAsync({
        address: USDT,
        abi: erc20Abi,
        functionName: "approve",
        args: [vaultAddress, total + creationFeeUsdt],
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
        abi: rangeVaultAbi,
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
        abi: rangeVaultAbi,
        functionName: "setRiskParams",
        args: [maxSlippageBps, minRebalanceIntervalSec, maxRangeDeviationBps],
      });
      await publicClient.waitForTransactionReceipt({ hash: riskHash });

      currentPhase = "depositing";
      setStep(currentPhase);
      const depositHash = await writeContractAsync({
        address: vaultAddress,
        abi: rangeVaultAbi,
        functionName: "deposit",
        args: [reserve, investable],
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
        <span className="eyebrow">Nuevo vault</span>
        <h1
          className="mt-5 text-balance text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Configurá tu posición
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
          Par USDT/WETH. El agente arma la posición inicial con estos parámetros y la
          rebalancea automáticamente — vos mantenés el control y la custodia.
        </p>

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
                  <button
                    key={p.fee}
                    type="button"
                    disabled={disabled}
                    onClick={() => setSelectedFee(p.fee)}
                    className={`rounded-xl border p-4 text-left transition ${
                      isSelected
                        ? "border-accent bg-accent/[0.08]"
                        : disabled
                          ? "border-hairline opacity-40"
                          : "border-hairline hover:border-accent/50"
                    }`}
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
                          <dt>Liquidez</dt>
                          <dd className="font-mono">{p.liquidity.toString()}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt>Volumen (reciente)</dt>
                          <dd className="font-mono">${p.volumeUsdt.toFixed(0)}</dd>
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
                );
              })}
            </div>
          </div>
        )}

        {!FACTORY_ADDRESS && (
          <div className="glass mt-8 rounded-2xl border-accent/35 bg-accent/[0.06] p-5 text-sm text-muted">
            Los contratos todavía no están configurados en este entorno.
          </div>
        )}

        {isConnected ? (
          <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_360px]">
            {/* Form */}
            <div className="glass rounded-2xl p-6 sm:p-8">
              <div className="grid gap-6 sm:grid-cols-2">
                <Field
                  label="Monto de inversión"
                  suffix="USDT"
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
                  suffix="USDT"
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
              </div>

              <div className="mt-8">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  Avanzado — dejar en blanco usa los valores por defecto de la plataforma
                </span>
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
              </div>

              <button onClick={handleCreate} disabled={busy || !FACTORY_ADDRESS} className="btn-primary mt-8 w-full">
                {stepLabel[step]}
              </button>

              {busy && (
                <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                  Firmá cada transacción en tu wallet — son 5 en total
                </p>
              )}
              {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}

              <div className="mt-6">
                <SignatureStepper current={step} failedAt={failedAt} />
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
                  <SummaryRow k="Capital invertible" v={`${investAmount || "0"} USDT`} />
                  <SummaryRow k="Reserva de reinyección" v={`${reinjectionAmount || "0"} USDT`} />
                  {creationFeeUsdt > 0n && (
                    <SummaryRow k="Fee de creación (una vez)" v={`${formatUnits(creationFeeUsdt, 6)} USDT`} />
                  )}
                  <div className="my-1 border-t border-hairline" />
                  <SummaryRow k="Total a depositar" v={`${totalUsdt.toFixed(2)} USDT`} strong />
                  {maxDepositUsd > 0n && (
                    <SummaryRow k="Tope de la plataforma" v={`${formatUnits(maxDepositUsd, 6)} USDT`} />
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
  label: string;
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
function SignatureStepper({ current, failedAt }: { current: Step; failedAt: Step | null }) {
  const currentIndex = SIGNATURE_KEYS.indexOf(current as (typeof SIGNATURE_KEYS)[number]);
  const isDone = current === "done";
  const isError = current === "error";
  const failedIndex = failedAt ? SIGNATURE_KEYS.indexOf(failedAt as (typeof SIGNATURE_KEYS)[number]) : -1;

  return (
    <div className="glass rounded-2xl p-5">
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
        Firmas necesarias (5)
      </span>
      <ol className="mt-4 flex flex-col gap-4">
        {SIGNATURE_STEPS.map((s, i) => {
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
