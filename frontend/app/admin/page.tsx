"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { formatUnits, parseUnits, type Address } from "viem";
import { Header } from "../components/Header";
import { platformConfigAbi, vaultFactoryAbi, rangeVaultAbi } from "@/lib/contracts";
import { PLATFORM_CONFIG_ADDRESS, FACTORY_ADDRESS, FACTORY_DEPLOY_BLOCK } from "@/lib/addresses";

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

  // All vault addresses, to sum Rebalanced events across the whole platform.
  const { data: allVaultsData } = useReadContracts({
    contracts: Array.from({ length: Number(vaultCount ?? 0n) }, (_, i) => ({
      address: FACTORY_ADDRESS,
      abi: vaultFactoryAbi,
      functionName: "allVaults",
      args: [BigInt(i)],
    })),
    query: { enabled: Boolean(FACTORY_ADDRESS) && Number(vaultCount ?? 0n) > 0 },
  });
  const vaultAddresses = (allVaultsData?.map((d) => d.result) ?? []).filter(Boolean) as Address[];

  const [platformStats, setPlatformStats] = useState<{ totalRebalances: number; totalFeesUsd: number } | null>(null);

  useEffect(() => {
    if (!publicClient || vaultAddresses.length === 0) return;
    let cancelled = false;

    async function scan() {
      const latest = await publicClient!.getBlockNumber();
      const MAX_RANGE = 5_000n;
      let totalRebalances = 0;
      let totalFeesRaw = 0n;

      for (const vault of vaultAddresses) {
        let fromBlock = FACTORY_DEPLOY_BLOCK;
        while (fromBlock <= latest) {
          const toBlock = fromBlock + MAX_RANGE > latest ? latest : fromBlock + MAX_RANGE;
          const logs = await publicClient!.getContractEvents({
            address: vault,
            abi: rangeVaultAbi,
            eventName: "Rebalanced",
            fromBlock,
            toBlock,
          });
          for (const log of logs as unknown as Array<{ args: { feePaid: bigint } }>) {
            totalRebalances += 1;
            totalFeesRaw += log.args.feePaid;
          }
          fromBlock = toBlock + 1n;
        }
      }

      if (!cancelled) {
        setPlatformStats({ totalRebalances, totalFeesUsd: Number(formatUnits(totalFeesRaw, 6)) });
      }
    }

    scan().catch((err) => console.error("platform stats scan failed", err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vaultAddresses is a derived array, re-created every render; comparing its content via length+publicClient is enough here
  }, [publicClient, vaultAddresses.length]);

  const [uniLabCalls, setUniLabCalls] = useState<UniLabCallRow[] | null>(null);
  useEffect(() => {
    if (!isPlatformOwner) return;
    fetch("/api/admin/unilab-calls")
      .then((res) => res.json())
      .then((body) => setUniLabCalls(body.calls ?? []))
      .catch((err) => console.error("failed to load uni-lab call log", err));
  }, [isPlatformOwner]);

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
            <Stat
              label="Rebalanceos totales"
              value={platformStats ? String(platformStats.totalRebalances) : "…"}
              accent
            />
            <Stat
              label="Revenue acumulado"
              value={platformStats ? `$${platformStats.totalFeesUsd.toFixed(2)}` : "…"}
              accent
            />
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
