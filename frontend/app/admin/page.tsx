"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { Header } from "../components/Header";
import { platformConfigAbi, vaultFactoryAbi } from "@/lib/contracts";
import { PLATFORM_CONFIG_ADDRESS, FACTORY_ADDRESS } from "@/lib/addresses";

export default function Admin() {
  const { address: connected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: PLATFORM_CONFIG_ADDRESS, abi: platformConfigAbi, functionName: "owner" },
      { address: PLATFORM_CONFIG_ADDRESS, abi: platformConfigAbi, functionName: "rebalanceFee" },
      { address: PLATFORM_CONFIG_ADDRESS, abi: platformConfigAbi, functionName: "defaultOperator" },
      { address: PLATFORM_CONFIG_ADDRESS, abi: platformConfigAbi, functionName: "maxDepositUsd" },
      { address: FACTORY_ADDRESS, abi: vaultFactoryAbi, functionName: "vaultCount" },
    ],
    query: { enabled: Boolean(PLATFORM_CONFIG_ADDRESS && FACTORY_ADDRESS) },
  });

  const [owner, rebalanceFee, defaultOperator, maxDepositUsd, vaultCount] = data?.map((d) => d.result) ?? [];
  const isPlatformOwner = Boolean(
    connected && owner && (connected as string).toLowerCase() === (owner as string).toLowerCase(),
  );

  const [newFee, setNewFee] = useState("");
  const [newOperator, setNewOperator] = useState("");
  const [newCap, setNewCap] = useState("");
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

  return (
    <>
      <Header />
      <main className="mx-auto max-w-2xl w-full flex-1 px-6 py-10">
        <h1 className="text-2xl font-semibold mb-2">Panel admin</h1>
        <p className="opacity-70 mb-8">
          Configuración global de la plataforma (PlatformConfig). Ver PLAN.md &quot;Los 3
          roles del sistema&quot;.
        </p>

        {(!PLATFORM_CONFIG_ADDRESS || !FACTORY_ADDRESS) && (
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm">
            Contratos no configurados todavía — deploy pendiente.
          </div>
        )}

        {PLATFORM_CONFIG_ADDRESS && !data && <p className="opacity-70">Cargando...</p>}

        {data && !isPlatformOwner && (
          <p className="opacity-70">
            Conectá la wallet dueña de la plataforma (<code className="text-xs">{String(owner)}</code>) para
            administrar esta configuración.
          </p>
        )}

        {data && (
          <section className="rounded-lg border border-black/10 dark:border-white/10 p-4 text-sm flex flex-col gap-2 mb-6">
            <Row label="Vaults totales" value={String(vaultCount)} />
            <Row label="Rebalance fee actual" value={`${formatUnits((rebalanceFee as bigint) ?? 0n, 6)} USDT`} />
            <Row label="Operador por defecto" value={String(defaultOperator)} mono />
            <Row label="Tope de depósito por vault" value={`${formatUnits((maxDepositUsd as bigint) ?? 0n, 6)} USDT`} />
          </section>
        )}

        {isPlatformOwner && (
          <section className="rounded-lg border border-black/10 dark:border-white/10 p-4 flex flex-col gap-5">
            <FieldWithAction
              label="Nuevo rebalance fee (USDT)"
              value={newFee}
              onChange={setNewFee}
              actionLabel="Actualizar fee"
              disabled={Boolean(busy)}
              onSubmit={() =>
                withTx("fee", () =>
                  writeContractAsync({
                    address: PLATFORM_CONFIG_ADDRESS,
                    abi: platformConfigAbi,
                    functionName: "setRebalanceFee",
                    args: [parseUnits(newFee || "0", 6)],
                  }),
                )
              }
            />
            <FieldWithAction
              label="Nuevo operador por defecto (address)"
              value={newOperator}
              onChange={setNewOperator}
              actionLabel="Actualizar operador"
              disabled={Boolean(busy)}
              onSubmit={() =>
                withTx("operator", () =>
                  writeContractAsync({
                    address: PLATFORM_CONFIG_ADDRESS,
                    abi: platformConfigAbi,
                    functionName: "setDefaultOperator",
                    args: [newOperator as `0x${string}`],
                  }),
                )
              }
            />
            <FieldWithAction
              label="Nuevo tope de depósito por vault (USDT)"
              value={newCap}
              onChange={setNewCap}
              actionLabel="Actualizar tope"
              disabled={Boolean(busy)}
              onSubmit={() =>
                withTx("cap", () =>
                  writeContractAsync({
                    address: PLATFORM_CONFIG_ADDRESS,
                    abi: platformConfigAbi,
                    functionName: "setMaxDepositUsd",
                    args: [parseUnits(newCap || "0", 6)],
                  }),
                )
              }
            />

            {busy && <p className="text-sm opacity-70">Procesando: {busy}...</p>}
            {error && <p className="text-sm text-red-500">{error}</p>}
          </section>
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

function FieldWithAction({
  label,
  value,
  onChange,
  actionLabel,
  onSubmit,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  actionLabel: string;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-2 items-end">
      <label className="flex flex-col gap-1 text-sm flex-1">
        <span className="opacity-70">{label}</span>
        <input
          className="rounded-md border border-black/10 dark:border-white/10 bg-transparent px-3 py-2"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <button
        onClick={onSubmit}
        disabled={disabled}
        className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-40"
      >
        {actionLabel}
      </button>
    </div>
  );
}
