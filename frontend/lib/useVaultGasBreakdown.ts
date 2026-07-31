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
}

const EMPTY_ENTRY: GasBreakdownEntry = { count: 0, usdRaw: 0n };

/**
 * KeeperGasReimbursed fires from 4 different functions (see
 * RangeVaultArb.sol's _reimburseKeeperGas call sites: initPosition,
 * rebalance, reinjectIntoPosition, sweepIdleDust) but carries no field
 * saying which one — the event itself is identical regardless of source.
 * Every one of those functions calls _reimburseKeeperGas() immediately
 * before emitting its OWN event (PositionInitialized/Rebalanced/
 * ReinjectedIntoPosition/IdleDustSwept respectively), in the same
 * transaction, one log index apart — confirmed against real indexed event
 * data (every KeeperGasReimbursed row is immediately followed by exactly
 * one of those four, same tx_hash, never a different tx or more than one
 * log apart). That adjacency is the only way to attribute a reimbursement
 * to its source, so this walk keys off it instead of relying on any field
 * inside the event itself.
 */
function walkGasBreakdown(logs: VaultEventLog[]): GasBreakdownByAction {
  const result: GasBreakdownByAction = {
    initPosition: { ...EMPTY_ENTRY },
    rebalance: { ...EMPTY_ENTRY },
    reinjectIntoPosition: { ...EMPTY_ENTRY },
    sweepIdleDust: { ...EMPTY_ENTRY },
  };
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (log.eventName !== "KeeperGasReimbursed") continue;
    const next = logs[i + 1];
    if (!next || next.transactionHash !== log.transactionHash) continue;
    const usd = (log.args as { amountUsd?: bigint }).amountUsd ?? 0n;
    const bucket =
      next.eventName === "PositionInitialized"
        ? result.initPosition
        : next.eventName === "Rebalanced"
          ? result.rebalance
          : next.eventName === "ReinjectedIntoPosition"
            ? result.reinjectIntoPosition
            : next.eventName === "IdleDustSwept"
              ? result.sweepIdleDust
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
