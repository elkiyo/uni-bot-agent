"use client";

import { useWriteContract, type UseWriteContractParameters } from "wagmi";
import { getAttributionDataSuffix } from "./attribution";

/**
 * Drop-in replacement for wagmi's useWriteContract that appends the
 * hackathon attribution tag to every transaction's calldata — the browser
 * equivalent of what the keeper's sendTaggedTx already does server-side
 * (see lib/keeper/serverContracts.ts). Without this, wallet-signed
 * transactions (create/deposit/withdraw/admin) never carried the tag and
 * didn't count toward the leaderboard's tracked volume.
 */
export function useTaggedWriteContract(parameters?: UseWriteContractParameters) {
  const { writeContractAsync, ...rest } = useWriteContract(parameters);

  return {
    ...rest,
    writeContractAsync: (
      ...args: Parameters<typeof writeContractAsync>
    ): ReturnType<typeof writeContractAsync> => {
      const [variables, options] = args;
      return writeContractAsync({ ...variables, dataSuffix: getAttributionDataSuffix() }, options);
    },
  };
}
