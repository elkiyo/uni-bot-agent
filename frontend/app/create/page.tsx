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

  const [investAmount, setInvestAmount] = useState("100");
  const [widthPct, setWidthPct] = useState("20");
  const [maxRebalances, setMaxRebalances] = useState("10");
  const [reinjectionAmount, setReinjectionAmount] = useState("10");
  const [periodicHours, setPeriodicHours] = useState("24");
  const [usdtBudget, setUsdtBudget] = useState("5");

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  const totalUsdt =
    (parseFloat(investAmount) || 0) + (parseFloat(reinjectionAmount) || 0) + (parseFloat(usdtBudget) || 0);
  const lowerPreview =
    currentPrice !== undefined ? currentPrice * (1 - (parseFloat(widthPct) || 0) / 200) : undefined;
  const upperPreview =
    currentPrice !== undefined ? currentPrice * (1 + (parseFloat(widthPct) || 0) / 200) : undefined;

  async function handleCreate() {
    if (!address || !publicClient || currentPrice === undefined || tickSpacing === undefined) return;
    setError(null);

    try {
      setStep("creating");
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

      const widthFraction = Number(widthPct) / 100;
      const lowerPrice = currentPrice * (1 - widthFraction / 2);
      const upperPrice = currentPrice * (1 + widthFraction / 2);
      const targetTickLower = alignToTickSpacing(tickFromEthPrice(lowerPrice), Number(tickSpacing));
      const targetTickUpper = alignToTickSpacing(tickFromEthPrice(upperPrice), Number(tickSpacing));

      const investable = parseUnits(investAmount, 6);
      const reserve = parseUnits(reinjectionAmount, 6);
      const budget = parseUnits(usdtBudget, 6);
      const total = investable + reserve + budget;

      setStep("approving");
      const approveHash = await writeContractAsync({
        address: USDT,
        abi: erc20Abi,
        functionName: "approve",
        args: [vaultAddress, total],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setStep("configuring");
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
      // RangeTooFarFromMarket almost every time. maxRangeDeviationBps is set to
      // the range's half-width (1 tick == 1 bps), so the recentered range the
      // agent proposes always fits while genuinely wild ranges stay blocked.
      setStep("risk");
      const halfWidthTicks = Math.max(100, Math.round(Math.abs(targetTickUpper - targetTickLower) / 2));
      const riskHash = await writeContractAsync({
        address: vaultAddress,
        abi: rangeVaultAbi,
        functionName: "setRiskParams",
        args: [500n, 0n, BigInt(halfWidthTicks)], // 5% slippage cap, no extra cooldown, half-width deviation
      });
      await publicClient.waitForTransactionReceipt({ hash: riskHash });

      setStep("depositing");
      const depositHash = await writeContractAsync({
        address: vaultAddress,
        abi: rangeVaultAbi,
        functionName: "deposit",
        args: [budget, reserve, investable],
      });
      await publicClient.waitForTransactionReceipt({ hash: depositHash });

      setStep("done");
      router.push(`/vault/${vaultAddress}`);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
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
                />
                <Field
                  label="Ancho del rango"
                  suffix="%"
                  value={widthPct}
                  onChange={setWidthPct}
                  hint="Alrededor del precio actual"
                />
                <Field
                  label="Tope de rebalanceos"
                  value={maxRebalances}
                  onChange={setMaxRebalances}
                  hint="Tu techo de gasto en fees"
                />
                <Field
                  label="Reinyección alternada"
                  suffix="USDT"
                  value={reinjectionAmount}
                  onChange={setReinjectionAmount}
                  hint="Entra y sale de la posición en ciclos"
                />
                <Field
                  label="Rebalanceo periódico"
                  suffix="horas"
                  value={periodicHours}
                  onChange={setPeriodicHours}
                />
                <Field
                  label="Presupuesto uni-lab.xyz"
                  suffix="USDT"
                  value={usdtBudget}
                  onChange={setUsdtBudget}
                  hint="0.5 USDT por consulta"
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
                  <SummaryRow k="Presupuesto de cálculo" v={`${usdtBudget || "0"} USDT`} />
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <div className="relative">
        <input
          className="field-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
