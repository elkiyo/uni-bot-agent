import type { Abi, Address } from "viem";
import { publicClient } from "./wallet.js";
import { Store } from "./store.js";
import { registerAgent } from "./unilab.js";
import VaultFactoryAbi from "./abi/VaultFactory.json" with { type: "json" };

const MAX_BLOCK_RANGE = 5_000n; // conservative chunk size for public RPC log queries

/**
 * Scans the factory for VaultCreated events since the last processed block, and
 * registers each new vault with uni-lab.xyz (agent_wallet = vault address, since
 * the vault itself sends the USDT payment — see PLAN.md). Safe to call repeatedly;
 * already-known vaults are skipped.
 */
export async function discoverAndRegisterVaults(factoryAddress: Address, store: Store): Promise<void> {
  const latestBlock = await publicClient.getBlockNumber();
  let fromBlock = store.getLastProcessedBlock();
  if (fromBlock === 0n) {
    // First run: don't scan from Celo genesis. Start close to "now" — in production
    // this should be the factory's actual deployment block, set via env/config.
    fromBlock = latestBlock > 10_000n ? latestBlock - 10_000n : 0n;
  }

  while (fromBlock <= latestBlock) {
    const toBlock = fromBlock + MAX_BLOCK_RANGE > latestBlock ? latestBlock : fromBlock + MAX_BLOCK_RANGE;

    const logs = await publicClient.getContractEvents({
      address: factoryAddress,
      abi: VaultFactoryAbi as Abi,
      eventName: "VaultCreated",
      fromBlock,
      toBlock,
    });

    for (const log of logs as unknown as Array<{
      args: { owner: Address; vault: Address };
      blockNumber: bigint;
    }>) {
      const { owner, vault } = log.args;
      if (store.getVault(vault)) continue;

      console.log(`Discovered new vault ${vault} (owner ${owner}) — registering with uni-lab.xyz`);
      let apiKey: string | undefined;
      try {
        const reg = await registerAgent(`uni-bot-agent-${vault.slice(2, 8)}`, vault);
        apiKey = reg.api_key;
      } catch (err) {
        console.error(`Failed to register vault ${vault} with uni-lab.xyz:`, err);
      }

      store.upsertVault({
        address: vault,
        owner,
        uniLabApiKey: apiKey,
        positionInitialized: false,
        createdAtBlock: log.blockNumber.toString(),
      });
    }

    store.setLastProcessedBlock(toBlock);
    fromBlock = toBlock + 1n;
  }
}
