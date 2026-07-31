"use client";

import type { Abi } from "viem";
import { useVaultEventLogs, type VaultEventLog } from "./useVaultEventLogs";
import type { ChainDef } from "./chains";

export interface GasBreakdownEntry {
  count: number;
  usdRaw: bigint;
}

export interface GasBreakdownByAction {
  initPosition: GasBreakdownEntry;
  rebalance: GasBreakdownEntry;
  reinjectIntoPosition: GasBreakdownEntry;
  sweepIdleDust: GasBreakdownEntry;
  // Compound (V2) only — harvestFees()'s auto-compound fee claim. Absent
  // from the standard ABI/contract, so always 0 for a standard vault.
  harvestFees: GasBreakdownEntry;
}

const EMPTY_ENTRY: GasBreakdownEntry = { count: 0, usdRaw: 0n };

/**
 * KeeperGasReimbursed fires from up to 5 different functions (see
 * RangeVaultArb[CompoundV2].sol's _reimburseKeeperGas call sites:
 * initPosition, rebalance, reinjectIntoPosition, sweepIdleDust, and
 * compound-only harvestFees) but carries no field saying which one — the
 * event itself is identical regardless of source.
 *
 * Grouped by TRANSACTION rather than "the next log in the array" — an
 * earlier version relied on adjacency (gas event immediately followed by
 * its action event, same tx), which holds for 4 of the 5 functions but
 * NOT harvestFees(): it emits FeesReinjected/PerformanceFeeCollected
 * BEFORE calling _reimburseKeeperGas(), so KeeperGasReimbursed is the
 * LAST event in that transaction — the old "next log" lookup would spill
 * into an unrelated later transaction and silently drop the reimbursement
 * from every bucket. Confirmed live against vault 0x7186CE90...4D78c7,
 * whose harvestFees() call (tx 0x45094f39...) has PerformanceFeeCollected
 * → FeesReinjected → KeeperGasReimbursed in that exact order.
 *
 * Priority matters because rebalance() can ALSO emit FeesReinjected (its
 * own compound fee-split path) alongside Rebalanced in the same tx —
 * Rebalanced must win that case, so harvestFees is checked LAST, only
 * when none of the other four unique markers are present.
 */
function walkGasBreakdown(logs: VaultEventLog[]): GasBreakdownByAction {
  const result: GasBreakdownByAction = {
    initPosition: { ...EMPTY_ENTRY },
    rebalance: { ...EMPTY_ENTRY },
    reinjectIntoPosition: { ...EMPTY_ENTRY },
    sweepIdleDust: { ...EMPTY_ENTRY },
    harvestFees: { ...EMPTY_ENTRY },
  };

  const byTx = new Map<string, VaultEventLog[]>();
  for (const log of logs) {
    const existing = byTx.get(log.transactionHash);
    if (existing) existing.push(log);
    else byTx.set(log.transactionHash, [log]);
  }

  for (const txLogs of byTx.values()) {
    const gasLog = txLogs.find((l) => l.eventName === "KeeperGasReimbursed");
    if (!gasLog) continue;
    const usd = (gasLog.args as { amountUsd?: bigint }).amountUsd ?? 0n;
    const has = (name: string) => txLogs.some((l) => l.eventName === name);
    const bucket = has("PositionInitialized")
      ? result.initPosition
      : has("Rebalanced")
        ? result.rebalance
        : has("ReinjectedIntoPosition")
          ? result.reinjectIntoPosition
          : has("IdleDustSwept")
            ? result.sweepIdleDust
            : has("FeesReinjected")
              ? result.harvestFees
              : undefined;
    if (!bucket) continue;
    bucket.count += 1;
    bucket.usdRaw += usd;
  }

  return result;
}

export function useVaultGasBreakdown(address: `0x${string}` | undefined, chain: ChainDef, abi: Abi = chain.vaultAbi) {
  const { data: logs, ...rest } = useVaultEventLogs(address, chain, abi);
  const data: GasBreakdownByAction | undefined = logs ? walkGasBreakdown(logs) : undefined;
  return { ...rest, data };
}
