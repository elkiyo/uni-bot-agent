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

  const [owner, rebalanceFee, defaultOperator, maxDepositUsd, vaultCount] =
    data?.map((d) => d.result) ?? [];
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
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">Plataforma</span>
        <h1
          className="mt-5 text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Panel de administración
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
          Configuración global que aplica en vivo a todos los vaults: precio por rebalanceo,
          operador por defecto y tope de depósito por vault.
        </p>

        {(!PLATFORM_CONFIG_ADDRESS || !FACTORY_ADDRESS) && (
          <div className="glass mt-8 rounded-2xl border-accent/35 bg-accent/[0.06] p-5 text-sm text-muted">
            Los contratos todavía no están configurados en este entorno.
          </div>
        )}

        {data && (
          <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Vaults totales" value={String(vaultCount ?? 0)} accent />
            <Stat
              label="Fee por rebalanceo"
              value={`${formatUnits((rebalanceFee as bigint) ?? 0n, 6)} USDT`}
            />
            <Stat
              label="Tope por vault"
              value={`${formatUnits((maxDepositUsd as bigint) ?? 0n, 6)} USDT`}
            />
            <div className="glass rounded-2xl p-5">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                Operador por defecto
              </span>
              <p className="mt-2 break-all font-mono text-xs text-white/90">
                {String(defaultOperator)}
              </p>
            </div>
          </div>
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
                label="Nuevo fee por rebalanceo (USDT)"
                value={newFee}
                onChange={setNewFee}
                action="Actualizar"
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
              <AdminField
                label="Nuevo operador por defecto (address)"
                value={newOperator}
                onChange={setNewOperator}
                action="Actualizar"
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
              <AdminField
                label="Nuevo tope de depósito por vault (USDT)"
                value={newCap}
                onChange={setNewCap}
                action="Actualizar"
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
            </div>

            {busy && (
              <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                Procesando: {busy}… firmá en tu wallet
              </p>
            )}
            {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}
          </div>
        )}
      </main>
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={
        accent ? "glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5" : "glass rounded-2xl p-5"
      }
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <p
        className={`mt-2 text-lg font-semibold tabular-nums ${accent ? "text-accent" : "text-white/90"}`}
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
