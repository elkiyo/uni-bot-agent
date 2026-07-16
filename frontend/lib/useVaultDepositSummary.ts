"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { rangeVaultAbi } from "./contracts";
import { FACTORY_DEPLOY_BLOCK } from "./addresses";

export interface VaultDepositSummary {
  totalDepositedUsdt: bigint; // every Deposited + increasePosition() USDT contribution, ever
  firstDepositTimestamp: number | undefined; // unix seconds, for annualizing APR
}

/**
 * Sums every USDT the owner ever put into the vault — via deposit() (Deposited
 * event) or increasePosition() (PositionIncreased event) — straight from chain
 * logs, same no-backend pattern as useVaultFeesSummary. Used as the APR
 * denominator: current on-chain ledgers (investableUsdt/reserveBalance) only
 * reflect capital not yet deployed, not the total ever contributed.
 */
export function useVaultDepositSummary(address: `0x${string}` | undefined) {
  const publicClient = usePublicClient();

  return useQuery({
    queryKey: ["vault-deposit-summary", address],
    enabled: Boolean(publicClient && address),
    refetchInterval: 60_000,
    queryFn: async (): Promise<VaultDepositSummary> => {
      if (!publicClient || !address) return { totalDepositedUsdt: 0n, firstDepositTimestamp: undefined };

      const [depositLogs, increaseLogs] = await Promise.all([
        publicClient.getContractEvents({
          address,
          abi: rangeVaultAbi,
          eventName: "Deposited",
          fromBlock: FACTORY_DEPLOY_BLOCK,
          toBlock: "latest",
        }),
        publicClient.getContractEvents({
          address,
          abi: rangeVaultAbi,
          eventName: "PositionIncreased",
          fromBlock: FACTORY_DEPLOY_BLOCK,
          toBlock: "latest",
        }),
      ]);

      let totalDepositedUsdt = 0n;
      for (const log of depositLogs) {
        const args = (log as { args?: { investableAmount?: bigint; reserveAmount?: bigint } }).args ?? {};
        totalDepositedUsdt += (args.investableAmount ?? 0n) + (args.reserveAmount ?? 0n);
      }
      for (const log of increaseLogs) {
        const args = (log as { args?: { usdtAmount?: bigint } }).args ?? {};
        totalDepositedUsdt += args.usdtAmount ?? 0n;
      }

      let firstDepositTimestamp: number | undefined;
      if (depositLogs.length > 0) {
        const block = await publicClient.getBlock({ blockNumber: depositLogs[0].blockNumber });
        firstDepositTimestamp = Number(block.timestamp);
      }

      return { totalDepositedUsdt, firstDepositTimestamp };
    },
  });
}
