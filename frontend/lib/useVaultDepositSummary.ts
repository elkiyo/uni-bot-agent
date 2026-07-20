"use client";

import { useVaultEventLogs } from "./useVaultEventLogs";
import type { ChainDef } from "./chains";

export interface VaultDepositSummary {
  initialInvestmentUsdt: bigint; // investableAmount + reserveAmount from the vault's very first deposit() call
}

/**
 * Reads the vault's very first Deposited event — the capital the owner put in
 * when the vault was created — derived from useVaultEventLogs's shared event
 * fetch (see that file for why this used to run its own independent
 * full-history scan and no longer does). Used as the denominator for the
 * simple "rentabilidad" stat (comisiones / inversión inicial), so later
 * top-up deposits don't get folded in and dilute it.
 */
export function useVaultDepositSummary(address: `0x${string}` | undefined, chain: ChainDef) {
  const { data: logs, ...rest } = useVaultEventLogs(address, chain);

  const summary: VaultDepositSummary | undefined = logs
    ? (() => {
        const deposited = logs.find((l) => l.eventName === "Deposited");
        if (!deposited) return { initialInvestmentUsdt: 0n };
        const args = deposited.args as { investableAmount?: bigint; reserveAmount?: bigint };
        return { initialInvestmentUsdt: (args.investableAmount ?? 0n) + (args.reserveAmount ?? 0n) };
      })()
    : undefined;

  return { ...rest, data: summary };
}
