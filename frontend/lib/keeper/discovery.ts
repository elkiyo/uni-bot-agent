import "server-only";
import { parseEventLogs, type Address } from "viem";
import type { ChainRuntime } from "./wallet";
import { Store } from "./store";
import { registerAgent } from "./unilab";
import { getLogsChunkedMulti } from "../getLogsChunked";

/**
 * Scans the factory for VaultCreated events since the last processed block, and
 * registers each new vault with uni-lab.xyz (agent_wallet = vault address, since
 * the vault itself sends the USDT payment — see PLAN.md). Safe to call repeatedly;
 * already-known vaults are skipped.
 */
export async function discoverAndRegisterVaults(chain: ChainRuntime, factoryAddress: Address, store: Store): Promise<void> {
  const latestBlock = await chain.publicClient.getBlockNumber();
  let fromBlock = await store.getLastProcessedBlock();
  if (fromBlock === 0n) {
    // First run (fresh Supabase store — e.g. right after the Vercel migration,
    // see SCALING.md): scan from the factory's actual deployment block, not an
    // arbitrary "latest - N" window. No vault can predate this block, and on
    // Celo (~5s blocks) even a few hours of activity is tens of thousands of
    // blocks — a fixed lookback window silently missed the one real vault the
    // first time this ran against the new store.
    fromBlock = chain.factoryDeployBlock;
  }

  // getLogsChunkedMulti (not a hand-rolled loop) re-verifies a suspiciously
  // empty chunk before trusting it — forno.celo.org confirmed flaky in a way
  // plain retry-on-error can't catch (an identical eth_getLogs request for
  // the same range intermittently comes back empty, a "successful" response,
  // not a thrown error). This matters MORE here than anywhere else this
  // pattern was fixed: the old version advanced setLastProcessedBlock past
  // every chunk unconditionally, so a flakily-empty chunk that actually had
  // a real VaultCreated event in it would have permanently marked that
  // range "done" — the vault would never be discovered, registered, or
  // monitored again, silently, forever.
  const rawLogs = await getLogsChunkedMulti(chain.publicClient, {
    address: [factoryAddress],
    fromBlock,
    toBlock: latestBlock,
  });
  const logs = parseEventLogs({ abi: chain.factoryAbi, logs: rawLogs }).filter((l) => l.eventName === "VaultCreated");

  for (const log of logs as unknown as Array<{
    args: { owner: Address; vault: Address };
    blockNumber: bigint;
  }>) {
    const { owner, vault } = log.args;
    if (await store.getVault(vault)) continue;

    console.log(`Discovered new vault ${vault} (owner ${owner}) — registering with uni-lab.xyz`);
    let apiKey: string | undefined;
    try {
      const reg = await registerAgent(`UniAgent-${vault.slice(2, 8)}`, vault);
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
      reinjectionActive: false,
    });
  }

  await store.setLastProcessedBlock(latestBlock);

  // Retry registration for vaults that were discovered but whose uni-lab
  // registration failed at the time (e.g. the API being unreachable) — without
  // this, a vault would stay keyless forever since the event scan above skips
  // already-known vaults.
  for (const record of await store.listVaults()) {
    if (record.uniLabApiKey) continue;
    console.log(`Retrying uni-lab.xyz registration for vault ${record.address}`);
    try {
      const reg = await registerAgent(`UniAgent-${record.address.slice(2, 8)}`, record.address);
      await store.upsertVault({ ...record, uniLabApiKey: reg.api_key });
      console.log(`Registered vault ${record.address} with uni-lab.xyz`);
    } catch (err) {
      console.error(`Retry registration failed for ${record.address}:`, err);
    }
  }
}
