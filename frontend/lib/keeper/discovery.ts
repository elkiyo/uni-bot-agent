import "server-only";
import type { Address } from "viem";
import { publicClient } from "./wallet";
import { Store } from "./store";
import { registerAgent } from "./unilab";
import { vaultFactoryAbi } from "../contracts";

const MAX_BLOCK_RANGE = 5_000n; // conservative chunk size for public RPC log queries

/**
 * Scans the factory for VaultCreated events since the last processed block, and
 * registers each new vault with uni-lab.xyz (agent_wallet = vault address, since
 * the vault itself sends the USDT payment — see PLAN.md). Safe to call repeatedly;
 * already-known vaults are skipped.
 */
export async function discoverAndRegisterVaults(factoryAddress: Address, store: Store): Promise<void> {
  const latestBlock = await publicClient.getBlockNumber();
  let fromBlock = await store.getLastProcessedBlock();
  if (fromBlock === 0n) {
    // First run: don't scan from Celo genesis. Start close to "now" — in production
    // this should be the factory's actual deployment block, set via env/config.
    fromBlock = latestBlock > 10_000n ? latestBlock - 10_000n : 0n;
  }

  while (fromBlock <= latestBlock) {
    const toBlock = fromBlock + MAX_BLOCK_RANGE > latestBlock ? latestBlock : fromBlock + MAX_BLOCK_RANGE;

    const logs = await publicClient.getContractEvents({
      address: factoryAddress,
      abi: vaultFactoryAbi,
      eventName: "VaultCreated",
      fromBlock,
      toBlock,
    });

    for (const log of logs as unknown as Array<{
      args: { owner: Address; vault: Address };
      blockNumber: bigint;
    }>) {
      const { owner, vault } = log.args;
      if (await store.getVault(vault)) continue;

      console.log(`Discovered new vault ${vault} (owner ${owner}) — registering with uni-lab.xyz`);
      let apiKey: string | undefined;
      try {
        const reg = await registerAgent(`uni-bot-agent-${vault.slice(2, 8)}`, vault);
        apiKey = reg.api_key;
      } catch (err) {
        console.error(`Failed to register vault ${vault} with uni-lab.xyz:`, err);
      }

      await store.upsertVault({
        address: vault,
        owner,
        uniLabApiKey: apiKey,
        positionInitialized: false,
        createdAtBlock: log.blockNumber.toString(),
      });
    }

    await store.setLastProcessedBlock(toBlock);
    fromBlock = toBlock + 1n;
  }

  // Retry registration for vaults that were discovered but whose uni-lab
  // registration failed at the time (e.g. the API being unreachable) — without
  // this, a vault would stay keyless forever since the event scan above skips
  // already-known vaults.
  for (const record of await store.listVaults()) {
    if (record.uniLabApiKey) continue;
    console.log(`Retrying uni-lab.xyz registration for vault ${record.address}`);
    try {
      const reg = await registerAgent(`uni-bot-agent-${record.address.slice(2, 8)}`, record.address);
      await store.upsertVault({ ...record, uniLabApiKey: reg.api_key });
      console.log(`Registered vault ${record.address} with uni-lab.xyz`);
    } catch (err) {
      console.error(`Retry registration failed for ${record.address}:`, err);
    }
  }
}
