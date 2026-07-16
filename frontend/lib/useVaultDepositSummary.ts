"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { rangeVaultAbi } from "./contracts";
import { FACTORY_DEPLOY_BLOCK } from "./addresses";

export interface VaultDepositSummary {
  initialInvestmentUsdt: bigint; // investableAmount + reserveAmount from the vault's very first deposit() call
}

/**
 * Reads the vault's very first Deposited event — the capital the owner put in
 * when the vault was created — straight from chain logs, same no-backend
 * pattern as useVaultFeesSummary. Used as the denominator for the simple
 * "rentabilidad" stat (comisiones / inversión inicial), so later top-up
 * deposits don't get folded in and dilute it.
 */
export function useVaultDepositSummary(address: `0x${string}` | undefined) {
  const publicClient = usePublicClient();

  return useQuery({
    queryKey: ["vault-deposit-summary", address],
    enabled: Boolean(publicClient && address),
    refetchInterval: 60_000,
    queryFn: async (): Promise<VaultDepositSummary> => {
      if (!publicClient || !address) return { initialInvestmentUsdt: 0n };

      const logs = await publicClient.getContractEvents({
        address,
        abi: rangeVaultAbi,
        eventName: "Deposited",
        fromBlock: FACTORY_DEPLOY_BLOCK,
        toBlock: "latest",
      });
      if (logs.length === 0) return { initialInvestmentUsdt: 0n };

      const args = (logs[0] as { args?: { investableAmount?: bigint; reserveAmount?: bigint } }).args ?? {};
      const initialInvestmentUsdt = (args.investableAmount ?? 0n) + (args.reserveAmount ?? 0n);
      return { initialInvestmentUsdt };
    },
  });
}
