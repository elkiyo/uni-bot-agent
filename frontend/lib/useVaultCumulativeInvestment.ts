"use client";

import type { Abi } from "viem";
import { useVaultEventLogs } from "./useVaultEventLogs";
import type { ChainDef } from "./chains";

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
 *   - PositionIncreased: consumedUncounted (V2, measured) or usdtAmount
 *     (V1 fallback) — "Sumar a la posición abierta" is real capital
 *     landing directly in the position.
 *   - Rebalanced: reinjectedAmount + consumedUncounted (V2) — reserve
 *     reinjection and any pending top-up folded in this cycle.
 *   - IdleDustSwept: consumedUncounted (V2 only — V1's is always genuine
 *     dust, never summed).
 *   - ReinjectedIntoPosition.amount, FeesReinjected.netFeeUsd: reserve/fee
 *     reinjected outside a rebalance cycle.
 *   - Withdrawn/EmergencyWithdraw.principalUsd: SUBTRACTED — symmetric to
 *     the additions above, excludes fees and un-reinjected reserve/gas
 *     (never added, so never subtracted).
 * Returns undefined while the underlying event fetch is loading, raw
 * stable-decimal bigint once resolved (never negative — same defensive
 * clamp as the server-side version).
 */
export function useVaultCumulativeInvestment(address: `0x${string}` | undefined, chain: ChainDef, abi: Abi = chain.vaultAbi) {
  const { data: logs, ...rest } = useVaultEventLogs(address, chain, abi);

  const data: bigint | undefined = logs
    ? (() => {
        let total = 0n;
        for (const log of logs) {
          const args = log.args as Record<string, unknown>;
          if (log.eventName === "Deposited") {
            if ((args.positionAlreadyExists as boolean | undefined) !== true) {
              total += (args.investableAmount as bigint | undefined) ?? 0n;
            }
          } else if (log.eventName === "PositionIncreased") {
            total += (args.consumedUncounted as bigint | undefined) ?? (args.usdtAmount as bigint | undefined) ?? 0n;
          } else if (log.eventName === "Rebalanced") {
            total += (args.reinjectedAmount as bigint | undefined) ?? 0n;
            total += (args.consumedUncounted as bigint | undefined) ?? 0n;
          } else if (log.eventName === "IdleDustSwept") {
            total += (args.consumedUncounted as bigint | undefined) ?? 0n;
          } else if (log.eventName === "ReinjectedIntoPosition") {
            total += (args.amount as bigint | undefined) ?? 0n;
          } else if (log.eventName === "FeesReinjected") {
            total += (args.netFeeUsd as bigint | undefined) ?? 0n;
          } else if (log.eventName === "Withdrawn" || log.eventName === "EmergencyWithdraw") {
            total -= (args.principalUsd as bigint | undefined) ?? 0n;
          }
        }
        return total < 0n ? 0n : total;
      })()
    : undefined;

  return { ...rest, data };
}
