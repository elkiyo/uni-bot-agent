import "server-only";
import { parseEventLogs, type Abi, type Address } from "viem";
import type { ChainRuntime } from "./wallet";
import { Store, type VaultKindRecord } from "./store";
import { registerAgent } from "./unilab";
import { getLogsChunkedMulti } from "../getLogsChunked";
import { readVaultPairLive } from "./pairInfo";
import { logEvent } from "./logger";

/**
 * Scans a factory for VaultCreated events since the last processed block, and
 * registers each new vault with uni-lab.xyz (agent_wallet = vault address, since
 * the vault itself sends the USDT payment — see autorange.md). Safe to call
 * repeatedly; already-known vaults are skipped. `kind`/`factoryAbi` let the SAME
 * function scan either factory on a chain that has both (see chains.ts's
 * compoundFactoryAddress) — VaultCreated's event shape is identical between
 * VaultFactoryArb and VaultFactoryArbCompound, so either ABI decodes it fine;
 * passed explicitly anyway for correctness, not just convenience.
 */
export async function discoverAndRegisterVaults(
  chain: ChainRuntime,
  factoryAddress: Address,
  store: Store,
  kind: VaultKindRecord = "standard",
  factoryAbi: Abi = chain.factoryAbi,
): Promise<void> {
  const latestBlock = await chain.publicClient.getBlockNumber();
  // Per-kind checkpoint — a chain with two factories (Arbitrum) scans each
  // independently, so a slow/late-deployed compound factory never gets its
  // fromBlock accidentally advanced past real events by the OTHER factory's
  // scan finishing first.
  let fromBlock = await store.getLastProcessedBlock(kind);
  if (fromBlock === 0n) {
    // First run (fresh Supabase store — e.g. right after the Vercel migration,
    // see SCALING.md): scan from the factory's actual deployment block, not an
    // arbitrary "latest - N" window. No vault can predate this block, and on
    // Celo (~5s blocks) even a few hours of activity is tens of thousands of
    // blocks — a fixed lookback window silently missed the one real vault the
    // first time this ran against the new store.
    fromBlock = kind === "compound" ? (chain.compoundFactoryDeployBlock ?? chain.factoryDeployBlock) : chain.factoryDeployBlock;
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
  const logs = parseEventLogs({ abi: factoryAbi, logs: rawLogs }).filter((l) => l.eventName === "VaultCreated");

  // Which vault ABI this factory's clones actually run — token0()/token1()/
  // stableIsToken0() exist on both, needed to resolve each new vault's own
  // pair once at registration time (see pairInfo.ts) instead of assuming the
  // chain's single default pair.
  const vaultAbi: Abi = kind === "compound" ? (chain.compoundVaultAbi as Abi) : chain.vaultAbi;

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

    // Read once, cached forever — see pairInfo.ts's own docstring. Non-fatal
    // if it fails (e.g. a transient RPC blip): resolveVaultPair() lazily
    // retries on the next tick that actually needs this vault's pair, same
    // self-healing fallback a legacy pre-multi-pair row already relies on.
    let pair: Awaited<ReturnType<typeof readVaultPairLive>> | undefined;
    try {
      pair = await readVaultPairLive(chain, vault, vaultAbi);
    } catch (err) {
      logEvent({ level: "warn", vault, msg: "failed to resolve pair info at discovery time, will retry lazily", err: String(err) });
    }

    await store.upsertVault({
      address: vault,
      owner,
      uniLabApiKey: apiKey,
      positionInitialized: false,
      createdAtBlock: log.blockNumber.toString(),
      reinjectionActive: false,
      kind,
      ...pair,
    });
  }

  await store.setLastProcessedBlock(latestBlock, kind);

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
