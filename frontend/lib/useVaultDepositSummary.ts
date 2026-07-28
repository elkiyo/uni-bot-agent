"use client";

import type { Abi } from "viem";
import { useVaultEventLogs } from "./useVaultEventLogs";
import type { ChainDef } from "./chains";

export interface VaultDepositSummary {
  initialInvestmentUsdt: bigint; // investableAmount + reserveAmount from the vault's very first deposit() call
  initialInvestableAmount: bigint; // investableAmount alone, same event — what actually went into the position
}

/**
 * Reads the vault's very first Deposited event — the capital the owner put in
 * when the vault was created — derived from useVaultEventLogs's shared event
 * fetch (see that file for why this used to run its own independent
 * full-history scan and no longer does). Used as the denominator for the
 * simple "rentabilidad" stat (comisiones / inversión inicial), so later
 * top-up deposits don't get folded in and dilute it.
 *
 * `abi` must match whatever every OTHER useVaultEventLogs caller for this
 * same address passes (see that hook's own queryKey, which doesn't include
 * abi) — Deposited's own shape is identical on every vault flavor, so this
 * never affects THIS hook's own output, but a mismatched abi here can still
 * win the shared cache entry's deserialization for every OTHER consumer of
 * the same address (e.g. useVaultFeesSummary's FeesReinjected.netFeeUsd).
 */
export function useVaultDepositSummary(address: `0x${string}` | undefined, chain: ChainDef, abi: Abi = chain.vaultAbi) {
  const { data: logs, ...rest } = useVaultEventLogs(address, chain, abi);

  const summary: VaultDepositSummary | undefined = logs
    ? (() => {
        const deposited = logs.find((l) => l.eventName === "Deposited");
        if (!deposited) return { initialInvestmentUsdt: 0n, initialInvestableAmount: 0n };
        const args = deposited.args as { investableAmount?: bigint; reserveAmount?: bigint };
        return {
          initialInvestmentUsdt: (args.investableAmount ?? 0n) + (args.reserveAmount ?? 0n),
          initialInvestableAmount: args.investableAmount ?? 0n,
        };
      })()
    : undefined;

  return { ...rest, data: summary };
}
