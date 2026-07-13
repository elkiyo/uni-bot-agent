"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { Header } from "../../components/Header";
import { rangeVaultAbi, erc20Abi } from "@/lib/contracts";
import { USDT } from "@/lib/addresses";

const reads = (address: `0x${string}`) =>
  [
    "owner",
    "operator",
    "positionTokenId",
    "rebalanceCount",
    "maxRebalances",
    "investableUsdt",
    "usdtBudget",
    "reserveBalance",
    "targetTickLower",
    "targetTickUpper",
    "paused",
    "reinjectionActive",
    "targetConfigured",
  ].map((functionName) => ({ address, abi: rangeVaultAbi, functionName }) as const);

export function VaultDetail({ address }: { address: `0x${string}` }) {
  const { address: connected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const { data, refetch } = useReadContracts({ contracts: reads(address) });
  const [
    owner,
    operator,
    positionTokenId,
    rebalanceCount,
    maxRebalances,
    investableUsdt,
    usdtBudget,
    reserveBalance,
    targetTickLower,
    targetTickUpper,
    paused,
    reinjectionActive,
    targetConfigured,
  ] = data?.map((d) => d.result) ?? [];

  const isOwner = Boolean(connected && owner && (connected as string).toLowerCase() === (owner as string).toLowerCase());

  const [depositAmount, setDepositAmount] = useState("0");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function withTx(label: string, fn: () => Promise<`0x${string}`>) {
    if (!publicClient) return;
    setBusy(label);
    setError(null);
    try {
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
    const amount = parseUnits(depositAmount, 6);
    await withTx("approving", () =>
      writeContractAsync({ address: USDT, abi: erc20Abi, functionName: "approve", args: [address, amount] }),
    );
    await withTx("depositing", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
        functionName: "deposit",
        args: [0n, 0n, amount],
      }),
    );
  }

  async function handleWithdrawAll() {
    await withTx("withdrawing", () =>
      writeContractAsync({ address, abi: rangeVaultAbi, functionName: "withdrawAll", args: [] }),
    );
  }

  async function handleTogglePause() {
    await withTx(paused ? "unpausing" : "pausing", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
        functionName: paused ? "unpause" : "pause",
        args: [],
      }),
    );
  }

  async function handleRevokeOperator() {
    await withTx("revoking", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
        functionName: "setOperator",
        args: ["0x0000000000000000000000000000000000000000"],
      }),
    );
  }

  async function handleEmergencyWithdraw() {
    await withTx("emergency-withdraw", () =>
      writeContractAsync({ address, abi: rangeVaultAbi, functionName: "emergencyWithdrawPosition", args: [] }),
    );
  }

  return (
    <>
      <Header />
      <main className="mx-auto max-w-2xl w-full flex-1 px-6 py-10">
        <h1 className="text-xl font-semibold mb-1 font-mono break-all">{address}</h1>
        <p className="opacity-70 mb-8 text-sm">
          {isOwner ? "Sos el owner de este vault." : "Vista de solo lectura — no sos el owner."}
        </p>

        {!data && <p className="opacity-70">Cargando...</p>}

        {data && (
          <div className="flex flex-col gap-6">
            <section className="rounded-lg border border-black/10 dark:border-white/10 p-4 text-sm flex flex-col gap-2">
              <Row label="Owner" value={String(owner)} mono />
              <Row label="Operador" value={String(operator)} mono />
              <Row label="Position token id" value={String(positionTokenId)} />
              <Row label="Rebalanceos" value={`${rebalanceCount}/${maxRebalances}`} />
              <Row
                label="Rango objetivo (ticks)"
                value={targetConfigured ? `[${targetTickLower}, ${targetTickUpper}]` : "sin configurar"}
              />
              <Row label="Investable USDT" value={formatUnits((investableUsdt as bigint) ?? 0n, 6)} />
              <Row label="Presupuesto uni-lab (USDT)" value={formatUnits((usdtBudget as bigint) ?? 0n, 6)} />
              <Row label="Reserva de reinyección (USDT)" value={formatUnits((reserveBalance as bigint) ?? 0n, 6)} />
              <Row label="Ciclo de reinyección activo" value={reinjectionActive ? "sí" : "no"} />
              <Row label="Pausado" value={paused ? "sí" : "no"} />
            </section>

            {isOwner && (
              <section className="rounded-lg border border-black/10 dark:border-white/10 p-4 flex flex-col gap-4">
                <h2 className="font-medium">Gestión (solo owner)</h2>

                <div className="flex gap-2 items-end">
                  <label className="flex flex-col gap-1 text-sm flex-1">
                    <span className="opacity-70">Depositar más USDT</span>
                    <input
                      className="rounded-md border border-black/10 dark:border-white/10 bg-transparent px-3 py-2"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      inputMode="decimal"
                    />
                  </label>
                  <button
                    onClick={handleDepositMore}
                    disabled={Boolean(busy)}
                    className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-40"
                  >
                    Depositar
                  </button>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleWithdrawAll}
                    disabled={Boolean(busy)}
                    className="rounded-md border border-black/20 dark:border-white/20 px-4 py-2 text-sm disabled:opacity-40"
                  >
                    Retirar todo
                  </button>
                  <button
                    onClick={handleTogglePause}
                    disabled={Boolean(busy)}
                    className="rounded-md border border-black/20 dark:border-white/20 px-4 py-2 text-sm disabled:opacity-40"
                  >
                    {paused ? "Reanudar" : "Pausar"}
                  </button>
                  <button
                    onClick={handleRevokeOperator}
                    disabled={Boolean(busy)}
                    className="rounded-md border border-black/20 dark:border-white/20 px-4 py-2 text-sm disabled:opacity-40"
                  >
                    Revocar operador (kill switch)
                  </button>
                  <button
                    onClick={handleEmergencyWithdraw}
                    disabled={Boolean(busy)}
                    className="rounded-md border border-red-500/50 text-red-500 px-4 py-2 text-sm disabled:opacity-40"
                  >
                    Emergency withdraw
                  </button>
                </div>

                {busy && <p className="text-sm opacity-70">Procesando: {busy}...</p>}
                {error && <p className="text-sm text-red-500">{error}</p>}
              </section>
            )}
          </div>
        )}
      </main>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="opacity-60">{label}</span>
      <span className={mono ? "font-mono text-xs break-all text-right" : "text-right"}>{value}</span>
    </div>
  );
}
