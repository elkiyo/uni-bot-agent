"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { Header } from "../../components/Header";
import { PositionNFT } from "./PositionNFT";
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

  const isOwner = Boolean(
    connected && owner && (connected as string).toLowerCase() === (owner as string).toLowerCase(),
  );
  const hasPosition = Boolean(positionTokenId && (positionTokenId as bigint) > 0n);

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
    await withTx("Aprobando", () =>
      writeContractAsync({ address: USDT, abi: erc20Abi, functionName: "approve", args: [address, amount] }),
    );
    await withTx("Depositando", () =>
      writeContractAsync({ address, abi: rangeVaultAbi, functionName: "deposit", args: [0n, 0n, amount] }),
    );
  }

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">Vault · USDT/WETH 0.3%</span>
          {paused ? (
            <span className="eyebrow !border-negative/40 !text-negative">Pausado</span>
          ) : (
            <span className="eyebrow !border-positive/40 !text-positive">Activo</span>
          )}
          {hasPosition ? (
            <span className="eyebrow !border-accent/40 !text-accent">Posición #{String(positionTokenId)}</span>
          ) : (
            <span className="eyebrow">Sin posición aún</span>
          )}
        </div>

        <h1 className="mt-5 break-all font-mono text-lg text-white/90 sm:text-xl">{address}</h1>
        <p className="mt-2 text-sm text-muted">
          {isOwner ? "Sos el owner de este vault." : "Vista de solo lectura — no sos el owner."}
        </p>

        {!data && (
          <div className="glass mt-10 rounded-2xl p-10 text-center">
            <p className="text-muted">Cargando…</p>
          </div>
        )}

        {data && (
          <>
            {/* Stats */}
            <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label="Capital invertible"
                value={`${formatUnits((investableUsdt as bigint) ?? 0n, 6)} USDT`}
              />
              <Stat
                label="Presupuesto uni-lab"
                value={`${formatUnits((usdtBudget as bigint) ?? 0n, 6)} USDT`}
              />
              <Stat
                label="Reserva reinyección"
                value={`${formatUnits((reserveBalance as bigint) ?? 0n, 6)} USDT`}
                hint={reinjectionActive ? "próximo ciclo: retira" : "próximo ciclo: reinyecta"}
              />
              <Stat
                label="Rebalanceos"
                value={`${rebalanceCount ?? 0} / ${maxRebalances ?? 0}`}
                accent
              />
            </div>

            {hasPosition && <PositionNFT tokenId={positionTokenId as bigint} />}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  Rango objetivo
                </span>
                <p className="mt-2 font-mono text-sm text-white/90">
                  {targetConfigured
                    ? `ticks [${targetTickLower}, ${targetTickUpper}]`
                    : "sin configurar"}
                </p>
              </div>
              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  Operador
                </span>
                <p className="mt-2 break-all font-mono text-sm text-white/90">{String(operator)}</p>
              </div>
            </div>

            {/* Owner actions */}
            {isOwner && (
              <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
                <h2
                  className="text-xl font-semibold tracking-tight"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  Gestión
                </h2>
                <p className="mt-1 text-sm text-muted">Solo el owner puede ejecutar estas acciones.</p>

                <div className="mt-6 flex flex-wrap items-end gap-3">
                  <label className="flex min-w-56 flex-1 flex-col gap-1.5">
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                      Depositar más USDT
                    </span>
                    <input
                      className="field-input"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      inputMode="decimal"
                    />
                  </label>
                  <button onClick={handleDepositMore} disabled={Boolean(busy)} className="btn-primary !py-3">
                    Depositar
                  </button>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  <button
                    onClick={() =>
                      withTx("Retirando", () =>
                        writeContractAsync({ address, abi: rangeVaultAbi, functionName: "withdrawAll", args: [] }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    Retirar todo
                  </button>
                  <button
                    onClick={() =>
                      withTx(paused ? "Reanudando" : "Pausando", () =>
                        writeContractAsync({
                          address,
                          abi: rangeVaultAbi,
                          functionName: paused ? "unpause" : "pause",
                          args: [],
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    {paused ? "Reanudar" : "Pausar"}
                  </button>
                  <button
                    onClick={() =>
                      withTx("Revocando operador", () =>
                        writeContractAsync({
                          address,
                          abi: rangeVaultAbi,
                          functionName: "setOperator",
                          args: ["0x0000000000000000000000000000000000000000"],
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    Revocar operador
                  </button>
                  <button
                    onClick={() =>
                      withTx("Retiro de emergencia", () =>
                        writeContractAsync({
                          address,
                          abi: rangeVaultAbi,
                          functionName: "emergencyWithdrawPosition",
                          args: [],
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-danger"
                  >
                    Emergency withdraw
                  </button>
                </div>

                {busy && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {busy}… firmá en tu wallet
                  </p>
                )}
                {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        accent
          ? "glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5"
          : "glass rounded-2xl p-5"
      }
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <p
        className={`mt-2 text-lg font-semibold tabular-nums ${accent ? "text-accent" : "text-white/90"}`}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  );
}
