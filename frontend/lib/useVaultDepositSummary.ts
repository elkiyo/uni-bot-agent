"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseEventLogs, type Log } from "viem";
import { rangeVaultAbi } from "./contracts";
import { FACTORY_DEPLOY_BLOCK } from "./addresses";
import { getLogsChunked } from "./getLogsChunked";

export interface VaultDepositSummary {
  initialInvestmentUsdt: bigint; // investableAmount + reserveAmount from the vault's very first deposit() call
}

/**
 * Reads the vault's very first Deposited event — the capital the owner put in
 * when the vault was created — straight from chain logs, same
 * getLogsChunked + parseEventLogs pattern as useVaultFeesSummary (a plain
 * getContractEvents({ fromBlock: FACTORY_DEPLOY_BLOCK, toBlock: "latest" })
 * silently fails once the range exceeds forno.celo.org's 5000-block cap —
 * see getLogsChunked.ts). Used as the denominator for the simple
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

      const rawLogs = await getLogsChunked(publicClient, { address, fromBlock: FACTORY_DEPLOY_BLOCK, toBlock: "latest" });
      const logs = parseEventLogs({ abi: rangeVaultAbi, logs: rawLogs as Log[] }).filter(
        (l) => l.eventName === "Deposited",
      );
      if (logs.length === 0) return { initialInvestmentUsdt: 0n };

      const args = logs[0].args as { investableAmount?: bigint; reserveAmount?: bigint };
      const initialInvestmentUsdt = (args.investableAmount ?? 0n) + (args.reserveAmount ?? 0n);
      return { initialInvestmentUsdt };
    },
  });
}
