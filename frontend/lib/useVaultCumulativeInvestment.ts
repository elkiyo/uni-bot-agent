"use client";

import type { Abi } from "viem";
import { useVaultEventLogs, type VaultEventLog } from "./useVaultEventLogs";
import type { ChainDef } from "./chains";

export interface CapitalLedgerEntry {
  txHash: `0x${string}`;
  blockNumber: bigint;
  timestamp: number;
  eventName: string;
  /** This event's own signed effect on B1, raw stable-decimal units — never
   * 0 (rows where the event didn't move B1 at all, e.g. a periodic
   * Rebalanced with no reinjection/fold-in, are left out of the ledger
   * entirely by walkCapitalLedger below). */
  deltaRaw: bigint;
  /** B1 total right after this event, clamped like the final total below —
   * never negative. */
  runningB1Raw: bigint;
}

/**
 * B1 — every dollar that has ever actually entered this vault's working
 * position, counted once, at the moment it enters. Client-side mirror of
 * rebalancer.ts's getCumulativeInvestmentUsd (server-only, used to price
 * every real rebalance sent to uni-lab.xyz) — same event set, same rules.
 * Deliberately kept in exact sync with that function: any change to one
 * must be mirrored in the other, or the number shown here would silently
 * diverge from what the keeper itself uses. See that function's own
 * docstring (rebalancer.ts) for the full reasoning behind each event's
 * treatment — summarized here:
 *   - Deposited.investableAmount: counts immediately, UNLESS
 *     positionAlreadyExists is true (V2 only — a later top-up instead
 *     waits for consumedUncounted below, at the moment it's actually
 *     folded in).
 *   - PositionIncreased: ALWAYS the full usdtAmount, never consumedUncounted
 *     — "Sumar a la posición abierta" moves capital out of the owner's
 *     wallet in the SAME transaction, so it counts in full immediately
 *     (same as a bare deposit()), unlike a later deposit()/depositToken()
 *     call, which never touches the live position until a future fold-in.
 *     The leftover that DIDN'T fold in this same cycle (usdtAmount -
 *     consumedUncounted) is tracked in `pendingFromIncreasePosition` below —
 *     already counted here, it must NEVER be added again later.
 *   - Rebalanced/IdleDustSwept: reinjectedAmount (Rebalanced only) +
 *     whatever consumedUncounted exceeds pendingFromIncreasePosition. Both
 *     draw from the SAME pooled on-chain uncountedInvestable counter as a
 *     bare deposit()/depositToken() top-up (which genuinely hasn't been
 *     counted anywhere yet) — the contract can't tell the two provenances
 *     apart, so this is the closest off-chain approximation: protect the
 *     already-counted PositionIncreased leftover first, only count the
 *     excess as a genuine first-time fold-in. Bug found live 2026-07-29
 *     (vault 0x7186CE90...4D78c7): a $10 top-up (usdtAmount=10,
 *     consumedUncounted=7.017287 that cycle) left $2.982713 sitting in
 *     investableUsdt, already counted via usdtAmount above — a LATER
 *     IdleDustSwept folded part of it in (consumedUncounted=0.221142) and,
 *     before this fix, added it to B1 a second time.
 *   - ReinjectedIntoPosition.amount, FeesReinjected.netFeeUsd: reserve/fee
 *     reinjected outside a rebalance cycle.
 *   - Withdrawn/EmergencyWithdraw.principalUsd: SUBTRACTED — symmetric to
 *     the additions above, excludes fees and un-reinjected reserve/gas
 *     (never added, so never subtracted).
 * Returns undefined while the underlying event fetch is loading, raw
 * stable-decimal bigint once resolved (never negative — same defensive
 * clamp as the server-side version).
 */
/**
 * Walks a vault's full event history ONCE, applying every rule from this
 * file's own docstring above, and returns one row per event that actually
 * moved B1 (deposits, top-ups, reinjections, withdrawals — never a bare
 * periodic rebalance with nothing to reinject/fold in). Shared by both hooks
 * below so useVaultCumulativeInvestment (just the final number) and
 * useVaultCapitalLedger (the row-by-row "control de capital" dashboard
 * table) can never drift apart from each other — they already have to stay
 * in sync BY HAND with rebalancer.ts's server-side
 * getCumulativeInvestmentUsd; no reason to also risk drifting internally.
 *
 * `total` itself is never clamped mid-walk (only the exposed runningB1Raw
 * per row, and the final return value, are) — clamping the accumulator
 * itself would corrupt any later event that legitimately brings the true
 * total back up, since it wouldn't be adding on top of the real prior value
 * anymore.
 */
function walkCapitalLedger(logs: VaultEventLog[]): CapitalLedgerEntry[] {
  const entries: CapitalLedgerEntry[] = [];
  let total = 0n;
  // See this file's own docstring — protects an already-counted
  // PositionIncreased leftover from being added to B1 a second time
  // when it later folds into the position via Rebalanced/IdleDustSwept.
  let pendingFromIncreasePosition = 0n;
  for (const log of logs) {
    const args = log.args as Record<string, unknown>;
    let delta = 0n;
    if (log.eventName === "Deposited") {
      if ((args.positionAlreadyExists as boolean | undefined) !== true) {
        delta = (args.investableAmount as bigint | undefined) ?? 0n;
      }
    } else if (log.eventName === "PositionIncreased") {
      const usdtAmount = (args.usdtAmount as bigint | undefined) ?? 0n;
      delta = usdtAmount;
      // V1 has no consumedUncounted field — falls back to usdtAmount
      // (fully "consumed" this cycle), so leftover is always 0 and
      // this shadow counter never grows for a V1 vault.
      const consumedThisCycle = (args.consumedUncounted as bigint | undefined) ?? usdtAmount;
      if (usdtAmount > consumedThisCycle) pendingFromIncreasePosition += usdtAmount - consumedThisCycle;
    } else if (log.eventName === "Rebalanced" || log.eventName === "IdleDustSwept") {
      if (log.eventName === "Rebalanced") delta += (args.reinjectedAmount as bigint | undefined) ?? 0n;
      const consumed = (args.consumedUncounted as bigint | undefined) ?? 0n;
      const protectedAmount = consumed < pendingFromIncreasePosition ? consumed : pendingFromIncreasePosition;
      pendingFromIncreasePosition -= protectedAmount;
      delta += consumed - protectedAmount;
    } else if (log.eventName === "ReinjectedIntoPosition") {
      delta = (args.amount as bigint | undefined) ?? 0n;
    } else if (log.eventName === "FeesReinjected") {
      delta = (args.netFeeUsd as bigint | undefined) ?? 0n;
    } else if (log.eventName === "Withdrawn" || log.eventName === "EmergencyWithdraw") {
      delta = -((args.principalUsd as bigint | undefined) ?? 0n);
    } else {
      continue;
    }
    if (delta === 0n) continue;
    total += delta;
    entries.push({
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      timestamp: log.blockTimestamp,
      eventName: log.eventName,
      deltaRaw: delta,
      runningB1Raw: total < 0n ? 0n : total,
    });
  }
  return entries;
}

export function useVaultCumulativeInvestment(address: `0x${string}` | undefined, chain: ChainDef, abi: Abi = chain.vaultAbi) {
  const { data: logs, ...rest } = useVaultEventLogs(address, chain, abi);
  const data: bigint | undefined = logs ? (walkCapitalLedger(logs).at(-1)?.runningB1Raw ?? 0n) : undefined;
  return { ...rest, data };
}

/**
 * Row-by-row capital ledger for the "control de capital" dashboard table
 * (CapitalLedger.tsx) — every event that ever moved B1, in order, with the
 * running B1 total right after each one. Deliberately excludes A1: unlike
 * B1, A1 is never cumulative — it's the position's LIVE value, recomputed
 * fresh from current liquidity+ticks+price (see PositionNFT.tsx), not
 * something individual past events add up to. A per-row "A1 at the time"
 * would require a historical on-chain read at every single past block
 * (archive-node pricing, one extra RPC round-trip per row) for a number
 * that's only ever meaningful "right now" anyway.
 */
export function useVaultCapitalLedger(address: `0x${string}` | undefined, chain: ChainDef, abi: Abi = chain.vaultAbi) {
  const { data: logs, ...rest } = useVaultEventLogs(address, chain, abi);
  const data: CapitalLedgerEntry[] | undefined = logs ? walkCapitalLedger(logs) : undefined;
  return { ...rest, data };
}
