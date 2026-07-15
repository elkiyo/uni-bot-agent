"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { Header } from "../../components/Header";
import { PositionNFT } from "./PositionNFT";
import { ActivityFeed } from "./ActivityFeed";
import { PositionHistory } from "./PositionHistory";
import { RebalanceCountdown } from "./RebalanceCountdown";
import { rangeVaultAbi, erc20Abi, uniswapV3PoolAbi } from "@/lib/contracts";
import { USDT, POOL } from "@/lib/addresses";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";
import { useVaultFeesSummary } from "@/lib/useVaultFeesSummary";

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
    "closed",
    "targetConfigured",
    "reinjectionAmount",
    "periodicRebalanceInterval",
    "minRebalanceInterval",
    "lastRebalanceTimestamp",
    "maxSlippageBps",
    "maxRangeDeviationBps",
  ].map((functionName) => ({ address, abi: rangeVaultAbi, functionName }) as const);

export function VaultDetail({ address }: { address: `0x${string}` }) {
  const { address: connected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // 15s polling keeps the stats live while the keeper acts — the page is a demo
  // surface as much as a control panel.
  const { data, refetch } = useReadContracts({
    contracts: reads(address),
    query: { refetchInterval: 15_000 },
  });
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
    closed,
    targetConfigured,
    reinjectionAmount,
    periodicRebalanceInterval,
    minRebalanceInterval,
    lastRebalanceTimestamp,
    maxSlippageBps,
    maxRangeDeviationBps,
  ] = data?.map((d) => d.result) ?? [];

  const { data: feesSummary } = useVaultFeesSummary(address);
  const { data: tickSpacing } = useReadContract({ address: POOL, abi: uniswapV3PoolAbi, functionName: "tickSpacing" });

  const isOwner = Boolean(
    connected && owner && (connected as string).toLowerCase() === (owner as string).toLowerCase(),
  );
  const hasPosition = Boolean(positionTokenId && (positionTokenId as bigint) > 0n);

  const [depInvestable, setDepInvestable] = useState("0");
  const [depReserve, setDepReserve] = useState("0");
  const [cfgMaxRebalances, setCfgMaxRebalances] = useState("");
  const [cfgReinjection, setCfgReinjection] = useState("");
  const [cfgPeriodicHours, setCfgPeriodicHours] = useState("");
  const [cfgMinPrice, setCfgMinPrice] = useState("");
  const [cfgMaxPrice, setCfgMaxPrice] = useState("");
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
    // No uni-lab budget deposit anymore — the operator pays uni-lab.xyz
    // directly via x402, out of its own USDC (see HACKATHON.md "Track 2 —
    // x402"), not the vault's own usdtBudget ledger.
    const investable = parseUnits(depInvestable || "0", 6);
    const reserve = parseUnits(depReserve || "0", 6);
    const budget = 0n;
    const total = investable + reserve + budget;
    if (total === 0n) return;
    await withTx("Aprobando", () =>
      writeContractAsync({ address: USDT, abi: erc20Abi, functionName: "approve", args: [address, total] }),
    );
    await withTx("Depositando", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
        functionName: "deposit",
        args: [budget, reserve, investable],
      }),
    );
  }

  async function handleReconfigure() {
    // Leaving both price fields blank keeps the existing on-chain tick range
    // (the min/max sort also repairs vaults configured with inverted ticks by
    // an older create flow — higher USD price of ETH = lower tick in this
    // pool). Filling them in sets a FRESH range — the only way to finish
    // configuring a vault that only ever got as far as createVault() (e.g.
    // the create flow was abandoned mid-way): targetTickLower/Upper are both
    // 0 on those, so there's no "existing range" to fall back to.
    let lo: number;
    let hi: number;
    const settingFreshRange = Boolean(cfgMinPrice && cfgMaxPrice);
    if (settingFreshRange) {
      if (tickSpacing === undefined) return;
      const lowerPrice = Number(cfgMinPrice);
      const upperPrice = Number(cfgMaxPrice);
      if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) {
        setError("El precio máximo debe ser mayor al mínimo, ambos positivos");
        return;
      }
      const tickA = alignToTickSpacing(tickFromEthPrice(lowerPrice), Number(tickSpacing));
      const tickB = alignToTickSpacing(tickFromEthPrice(upperPrice), Number(tickSpacing));
      lo = Math.min(tickA, tickB);
      hi = Math.max(tickA, tickB);
    } else {
      if (targetTickLower === undefined || targetTickUpper === undefined) return;
      lo = Math.min(Number(targetTickLower), Number(targetTickUpper));
      hi = Math.max(Number(targetTickLower), Number(targetTickUpper));
    }

    await withTx("Reconfigurando", () =>
      writeContractAsync({
        address,
        abi: rangeVaultAbi,
        functionName: "configureTarget",
        args: [
          (investableUsdt as bigint) ?? 0n,
          lo,
          hi,
          BigInt(cfgMaxRebalances || String(maxRebalances ?? 0)),
          parseUnits(cfgReinjection || "0", 6),
          BigInt(Math.round(Number(cfgPeriodicHours || "24") * 3600)),
        ],
      }),
    );

    // A fresh range needs its near-market tolerance set too — the vault
    // starts with maxRangeDeviationBps = 0, which makes _checkRangeNearMarket
    // reject initPosition() almost always. Same half-width heuristic the
    // create flow uses, so this isn't needed when just tuning cadence/caps
    // on an already-working vault.
    if (settingFreshRange) {
      const halfWidthTicks = Math.max(100, Math.round(Math.abs(hi - lo) / 2));
      await withTx("Fijando límites de riesgo", () =>
        writeContractAsync({
          address,
          abi: rangeVaultAbi,
          functionName: "setRiskParams",
          args: [500n, 0n, BigInt(halfWidthTicks)],
        }),
      );
    }
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
            <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-5">
              <Stat
                label="Capital invertible"
                value={`${formatUnits((investableUsdt as bigint) ?? 0n, 6)} USDT`}
              />
              <Stat
                label="Presupuesto uni-lab"
                value={`${formatUnits((usdtBudget as bigint) ?? 0n, 6)} USDT`}
                hint="legado — el agente ahora paga uni-lab directo vía x402, esto ya no se gasta"
              />
              <Stat
                label="Reserva reinyección"
                value={`${formatUnits((reserveBalance as bigint) ?? 0n, 6)} USDT`}
                hint={`tope por ciclo: ${formatUnits((reinjectionAmount as bigint) ?? 0n, 6)} USDT`}
              />
              <Stat
                label="Rebalanceos"
                value={`${rebalanceCount ?? 0} / ${maxRebalances ?? 0}`}
                accent
              />
              <Stat
                label="Comisiones generadas"
                value={`${formatUnits(feesSummary?.totalUsdt ?? 0n, 6)} USDT`}
                hint={
                  feesSummary && feesSummary.totalWeth > 0n
                    ? `+ ${Number(formatUnits(feesSummary.totalWeth, 18)).toFixed(6)} WETH`
                    : `${feesSummary?.payoutCount ?? 0} pagos recibidos`
                }
                accent
              />
            </div>

            {hasPosition && <PositionNFT tokenId={positionTokenId as bigint} />}

            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  Rango objetivo
                </span>
                {targetConfigured ? (
                  <>
                    <p className="mt-2 text-sm font-medium text-white/90">
                      {(() => {
                        const lo = Number(targetTickLower);
                        const hi = Number(targetTickUpper);
                        const priceA = ethPriceFromTick(lo);
                        const priceB = ethPriceFromTick(hi);
                        const low = Math.min(priceA, priceB);
                        const high = Math.max(priceA, priceB);
                        return `$${low.toFixed(2)} – $${high.toFixed(2)}`;
                      })()}
                    </p>
                    {Number(targetTickLower) > Number(targetTickUpper) && (
                      <p className="mt-1 text-xs text-negative">
                        Ticks invertidos on-chain — usá &quot;Reconfigurar agente&quot; para corregir
                      </p>
                    )}
                    <p className="mt-1.5 font-mono text-[11px] text-faint">
                      ticks [{String(targetTickLower)}, {String(targetTickUpper)}]
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-white/90">sin configurar</p>
                )}
              </div>

              <RebalanceCountdown
                lastRebalanceTimestamp={(lastRebalanceTimestamp as bigint) ?? 0n}
                periodicRebalanceInterval={(periodicRebalanceInterval as bigint) ?? 0n}
                hasPosition={hasPosition}
                paused={Boolean(paused)}
                atRebalanceLimit={Boolean(
                  rebalanceCount !== undefined &&
                    maxRebalances !== undefined &&
                    (rebalanceCount as bigint) >= (maxRebalances as bigint),
                )}
              />

              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  Operador
                </span>
                <p className="mt-2 break-all font-mono text-sm text-white/90">{String(operator)}</p>
              </div>
            </div>

            {/* Vault configuration — what was set at create/reconfigure time */}
            <div className="glass mt-4 rounded-2xl p-5">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                Configuración del agente
              </span>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <ConfigRow
                  k="Reinyección alternada"
                  v={`${formatUnits((reinjectionAmount as bigint) ?? 0n, 6)} USDT`}
                />
                <ConfigRow
                  k="Rebalanceo periódico"
                  v={
                    periodicRebalanceInterval && (periodicRebalanceInterval as bigint) > 0n
                      ? `cada ${Number(periodicRebalanceInterval) / 3600}h`
                      : "desactivado"
                  }
                />
                <ConfigRow
                  k="Cooldown mínimo"
                  v={
                    minRebalanceInterval && (minRebalanceInterval as bigint) > 0n
                      ? `${Number(minRebalanceInterval) / 3600}h`
                      : "sin piso"
                  }
                />
                <ConfigRow k="Slippage máx." v={`${Number(maxSlippageBps ?? 0n) / 100}%`} />
                <ConfigRow k="Desviación máx. de rango" v={`${maxRangeDeviationBps ?? 0} ticks`} />
                <ConfigRow k="Tope de rebalanceos" v={`${maxRebalances ?? 0}`} />
              </dl>
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

                <div className="mt-6">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    Depositar USDT (repartido entre capital invertible y reserva de reinyección)
                  </span>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField label="Invertible" value={depInvestable} onChange={setDepInvestable} />
                    <MiniField label="Reserva" value={depReserve} onChange={setDepReserve} />
                    <button onClick={handleDepositMore} disabled={Boolean(busy)} className="btn-primary !py-3">
                      Depositar
                    </button>
                  </div>
                </div>

                <div className="mt-8">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    Reconfigurar agente
                  </span>
                  <p className="mt-1 text-xs text-faint">
                    {targetConfigured
                      ? "Dejá precio mínimo/máximo vacíos para mantener el rango actual, o completalos para fijar uno nuevo (también actualiza los límites de riesgo)."
                      : "Este vault todavía no tiene rango — completá precio mínimo y máximo para terminar de configurarlo."}
                  </p>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField label="Precio mínimo (USD)" value={cfgMinPrice} onChange={setCfgMinPrice} />
                    <MiniField label="Precio máximo (USD)" value={cfgMaxPrice} onChange={setCfgMaxPrice} />
                    <MiniField
                      label={`Tope rebalanceos (hoy: ${maxRebalances ?? "…"})`}
                      value={cfgMaxRebalances}
                      onChange={setCfgMaxRebalances}
                    />
                    <MiniField label="Reinyección (USDT)" value={cfgReinjection} onChange={setCfgReinjection} />
                    <MiniField label="Periódico (horas)" value={cfgPeriodicHours} onChange={setCfgPeriodicHours} />
                    <button onClick={handleReconfigure} disabled={Boolean(busy)} className="btn-secondary !py-3">
                      Actualizar
                    </button>
                  </div>
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
                  {!closed && (
                    <button
                      onClick={() =>
                        withTx("Cerrando vault", () =>
                          writeContractAsync({ address, abi: rangeVaultAbi, functionName: "closeVault", args: [] }),
                        )
                      }
                      disabled={Boolean(busy)}
                      className="btn-danger"
                      title="Solo funciona si el vault ya está vacío — retirá todo primero"
                    >
                      Cerrar vault
                    </button>
                  )}
                </div>
                {Boolean(closed) && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-negative">
                    Vault cerrado permanentemente — ya no puede recibir depósitos ni operar.
                  </p>
                )}

                {busy && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {busy}… firmá en tu wallet
                  </p>
                )}
                {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}
              </div>
            )}

            <PositionHistory address={address} />
            <ActivityFeed address={address} />
          </>
        )}
      </main>
    </>
  );
}

function ConfigRow({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-faint">{k}</dt>
      <dd className="mt-0.5 font-medium text-white/90">{v}</dd>
    </div>
  );
}

function MiniField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex min-w-36 flex-1 flex-col gap-1.5">
      <span className="text-xs text-faint">{label}</span>
      <input
        className="field-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
      />
    </label>
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
