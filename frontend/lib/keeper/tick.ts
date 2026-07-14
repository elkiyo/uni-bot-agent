import "server-only";
import type { Address } from "viem";
import { publicClient, operatorAccount } from "./wallet";
import { Store, acquireTickLock, releaseTickLock } from "./store";
import { discoverAndRegisterVaults } from "./discovery";
import { checkVault } from "./monitor";
import { runInitPosition, runRebalance } from "./rebalancer";
import { logEvent } from "./logger";
import { FACTORY_ADDRESS } from "../addresses";

const TICK_LOCK_TTL_SECONDS = 4 * 60; // < the 5-minute trigger interval

export interface TickSummary {
  chainId: number;
  operator: string | null;
  vaultsChecked: number;
  actions: Array<{ vault: string; action: string }>;
  errors: Array<{ vault?: string; msg: string }>;
  debug?: Record<string, unknown>;
}

/**
 * One full pass of what used to be node-cron's `tick()` in the old
 * agent/src/index.ts: discover+register new vaults, then check every known
 * vault and act (initPosition/rebalance) if it needs it. Now invoked by
 * POST /api/cron/tick, itself triggered by a GitHub Actions schedule every 5
 * minutes (see .github/workflows/keeper-cron.yml and SCALING.md) since
 * Vercel's Hobby plan caps its own Cron Jobs at once a day.
 */
export async function runTick(): Promise<TickSummary> {
  if (!(await acquireTickLock(TICK_LOCK_TTL_SECONDS))) {
    logEvent({ level: "warn", msg: "tick already in progress, skipping this trigger" });
    return { chainId: 0, operator: null, vaultsChecked: 0, actions: [], errors: [{ msg: "locked" }] };
  }

  try {
    if (!FACTORY_ADDRESS) throw new Error("NEXT_PUBLIC_FACTORY_ADDRESS not set — deploy the factory first");

    const chainId = await publicClient.getChainId();
    const store = new Store();
    const lastProcessedBlockBefore = await store.getLastProcessedBlock();
    const latestBlock = await publicClient.getBlockNumber();
    const summary: TickSummary = {
      chainId,
      operator: operatorAccount?.address ?? null,
      vaultsChecked: 0,
      actions: [],
      errors: [],
      debug: {
        factoryAddress: FACTORY_ADDRESS,
        lastProcessedBlockBefore: lastProcessedBlockBefore.toString(),
        latestBlock: latestBlock.toString(),
      },
    };

    try {
      await discoverAndRegisterVaults(FACTORY_ADDRESS, store);
    } catch (err) {
      logEvent({ level: "error", msg: "discovery failed", err: String(err) });
      summary.errors.push({ msg: `discovery failed: ${String(err)}` });
    }
    if (summary.debug) {
      summary.debug.lastProcessedBlockAfter = (await store.getLastProcessedBlock()).toString();
    }

    for (const record of await store.listVaults()) {
      summary.vaultsChecked++;
      try {
        const action = await checkVault(record.address as Address);
        if (action.kind === "init") {
          await runInitPosition(record.address as Address, store);
          summary.actions.push({ vault: record.address, action: "initPosition" });
        } else if (action.kind === "rebalance") {
          await runRebalance(record.address as Address, store, action.reason);
          summary.actions.push({ vault: record.address, action: `rebalance:${action.reason}` });
        }
      } catch (err) {
        logEvent({ level: "error", vault: record.address, msg: "vault check/action failed", err: String(err) });
        summary.errors.push({ vault: record.address, msg: String(err) });
      }
    }

    return summary;
  } finally {
    await releaseTickLock();
  }
}
