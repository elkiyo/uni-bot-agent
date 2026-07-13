"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { decodeEventLog, parseUnits } from "viem";
import { Header } from "../components/Header";
import { vaultFactoryAbi, rangeVaultAbi, erc20Abi, uniswapV3PoolAbi } from "@/lib/contracts";
import { FACTORY_ADDRESS, USDT, WETH, POOL, FEE_TIER } from "@/lib/addresses";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";

type Step = "idle" | "creating" | "approving" | "configuring" | "depositing" | "done" | "error";

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
  const [widthPct, setWidthPct] = useState("20"); // range width as % around current price
  const [maxRebalances, setMaxRebalances] = useState("10");
  const [reinjectionAmount, setReinjectionAmount] = useState("10");
  const [periodicHours, setPeriodicHours] = useState("24");
  const [usdtBudget, setUsdtBudget] = useState("5"); // covers ~10 uni-lab.xyz calls at 0.5 USDT each

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

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
      const halfWidthTicks = Math.max(
        100,
        Math.round(Math.abs(targetTickUpper - targetTickLower) / 2),
      );
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
      <main className="mx-auto max-w-2xl w-full flex-1 px-6 py-10">
        <h1 className="text-2xl font-semibold mb-2">Crear vault</h1>
        <p className="opacity-70 mb-8">
          Par USDT/WETH, pool <code className="text-xs">{POOL}</code> (0.3%). El agente arma la
          posición inicial y la rebalancea según lo que configures acá — ver PLAN.md.
        </p>

        {!FACTORY_ADDRESS && (
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm mb-6">
            <code>NEXT_PUBLIC_FACTORY_ADDRESS</code> no está configurado — el deploy está pendiente.
          </div>
        )}

        {!isConnected && <p className="opacity-70">Conectá tu wallet primero.</p>}

        {isConnected && (
          <div className="flex flex-col gap-5">
            {currentPrice !== undefined && (
              <p className="text-sm opacity-70">Precio actual de ETH: ${currentPrice.toFixed(2)}</p>
            )}

            <Field label="Monto de inversión (USDT)" value={investAmount} onChange={setInvestAmount} />
            <Field
              label="Ancho del rango (% alrededor del precio actual)"
              value={widthPct}
              onChange={setWidthPct}
            />
            <Field
              label="Tope de rebalanceos (maxRebalances)"
              value={maxRebalances}
              onChange={setMaxRebalances}
            />
            <Field
              label="Monto de reinyección alternada (USDT)"
              value={reinjectionAmount}
              onChange={setReinjectionAmount}
            />
            <Field
              label="Rebalanceo periódico cada (horas)"
              value={periodicHours}
              onChange={setPeriodicHours}
            />
            <Field
              label="Presupuesto para uni-lab.xyz (USDT, 0.5 USDT por consulta)"
              value={usdtBudget}
              onChange={setUsdtBudget}
            />

            <button
              onClick={handleCreate}
              disabled={busy || !FACTORY_ADDRESS}
              className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              {step === "idle" && "Crear vault"}
              {step === "creating" && "Creando vault..."}
              {step === "approving" && "Aprobando USDT..."}
              {step === "configuring" && "Configurando..."}
              {step === "depositing" && "Depositando..."}
              {step === "done" && "Listo"}
              {step === "error" && "Reintentar"}
            </button>

            {error && <p className="text-sm text-red-500">{error}</p>}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="opacity-70">{label}</span>
      <input
        className="rounded-md border border-black/10 dark:border-white/10 bg-transparent px-3 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
      />
    </label>
  );
}
