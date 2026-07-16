"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { decodeEventLog, parseUnits } from "viem";
import { Header } from "../components/Header";
import { vaultFactoryAbi, rangeVaultAbi, erc20Abi, uniswapV3PoolAbi } from "@/lib/contracts";
import { FACTORY_ADDRESS, USDT, WETH, POOL, FEE_TIER } from "@/lib/addresses";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";

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

  const { data: slot0 } = useReadContract({
    address: POOL,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
  });
  const { data: tickSpacing } = useReadContract({
    address: POOL,
    abi: uniswapV3PoolAbi,
    functionName: "tickSpacing",
  });

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

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [failedAt, setFailedAt] = useState<Step | null>(null);

  const minPricePlaceholder = currentPrice !== undefined ? (currentPrice * 0.9).toFixed(2) : "1604.18";
  const maxPricePlaceholder = currentPrice !== undefined ? (currentPrice * 1.1).toFixed(2) : "1960.66";

  const totalUsdt = (parseFloat(investAmount) || 0) + (parseFloat(reinjectionAmount) || 0);
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

    try {
      currentPhase = "creating";
      setStep(currentPhase);
      const createHash = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: vaultFactoryAbi,
        functionName: "createVault",
        args: [POOL, USDT, WETH, FEE_TIER],
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
      const approveHash = await writeContractAsync({
        address: USDT,
        abi: erc20Abi,
        functionName: "approve",
        args: [vaultAddress, total],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

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
      // range — the real range still didn't fit). Fixed value instead, with
      // enough margin that a legitimate uni-lab-driven periodic cycle should
      // never hit it in practice; still bounded well short of Uniswap's
      // absolute tick range, so a genuinely deranged proposal (bug or a
      // compromised operator key) stays blocked.
      currentPhase = "risk";
      setStep(currentPhase);
      const MAX_RANGE_DEVIATION_TICKS = 5_000n; // ~50% price deviation tolerance
      const riskHash = await writeContractAsync({
        address: vaultAddress,
        abi: rangeVaultAbi,
        functionName: "setRiskParams",
        args: [500n, 0n, MAX_RANGE_DEVIATION_TICKS], // 5% slippage cap, no extra cooldown, generous deviation cap
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
          Par USDT/WETH (0.3%). El agente arma la posición inicial con estos parámetros y la
          rebalancea automáticamente — vos mantenés el control y la custodia.
        </p>

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
                  <div className="my-1 border-t border-hairline" />
                  <SummaryRow k="Total a depositar" v={`${totalUsdt.toFixed(2)} USDT`} strong />
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
