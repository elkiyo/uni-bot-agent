import "server-only";
import type { Address } from "viem";
import { operatorAccount, getChainRuntime } from "./wallet";
import { Store, acquireTickLock, releaseTickLock } from "./store";
import { discoverAndRegisterVaults } from "./discovery";
import { checkVault } from "./monitor";
import { runInitPosition, runRebalance, maybeSweepIdleDust } from "./rebalancer";
import { logEvent } from "./logger";
import { deployedChains } from "../chains";

const TICK_LOCK_TTL_SECONDS = 4 * 60; // < the 5-minute trigger interval

export interface TickSummary {
  chainId: number;
  operator: string | null;
  vaultsChecked: number;
  actions: Array<{ vault: string; action: string }>;
  errors: Array<{ vault?: string; msg: string }>;
}

/**
 * One full pass per configured (and deployed) chain — discover+register new
 * vaults, then check every known vault on that chain and act
 * (initPosition/rebalance) if it needs it. Chains are processed sequentially
 * within a SINGLE tick lock acquisition (not one lock per chain): there's
 * never a real race between chains within one invocation, so a per-chain
 * lock would only add schema complexity for no benefit — see store.ts's own
 * docstring on acquireTickLock. Invoked by POST /api/cron/tick, itself
 * triggered by a GitHub Actions schedule every 5 minutes (see
 * .github/workflows/keeper-cron.yml and SCALING.md) since Vercel's Hobby
 * plan caps its own Cron Jobs at once a day.
 */
export async function runTick(): Promise<TickSummary[]> {
  if (!(await acquireTickLock(TICK_LOCK_TTL_SECONDS))) {
    logEvent({ level: "warn", msg: "tick already in progress, skipping this trigger" });
    return [{ chainId: 0, operator: null, vaultsChecked: 0, actions: [], errors: [{ msg: "locked" }] }];
  }

  try {
    const chains = deployedChains();
    if (chains.length === 0) {
      throw new Error("no chain has a deployed factory (NEXT_PUBLIC_FACTORY_ADDRESS_* unset) — deploy at least one first");
    }

    const summaries: TickSummary[] = [];
    for (const chainDef of chains) {
      const chain = getChainRuntime(chainDef);
      const store = new Store(chain.id);
      const summary: TickSummary = {
        chainId: chain.id,
        operator: operatorAccount?.address ?? null,
        vaultsChecked: 0,
        actions: [],
        errors: [],
      };

      try {
        await discoverAndRegisterVaults(chain, chainDef.factoryAddress, store);
      } catch (err) {
        logEvent({ level: "error", chain: chain.name, msg: "discovery failed", err: String(err) });
        summary.errors.push({ msg: `discovery failed: ${String(err)}` });
      }

      for (const record of await store.listVaults()) {
        summary.vaultsChecked++;
        try {
          const action = await checkVault(chain, record.address as Address);
          if (action.kind === "init") {
            await runInitPosition(chain, record.address as Address, store);
            summary.actions.push({ vault: record.address, action: "initPosition" });
          } else if (action.kind === "rebalance") {
            await runRebalance(chain, record.address as Address, store, action.reason);
            summary.actions.push({ vault: record.address, action: `rebalance:${action.reason}` });
          } else if (action.kind === "sweep") {
            await maybeSweepIdleDust(chain, record.address as Address);
            summary.actions.push({ vault: record.address, action: "sweepIdleDust" });
          }
        } catch (err) {
          logEvent({ level: "error", vault: record.address, chain: chain.name, msg: "vault check/action failed", err: String(err) });
          summary.errors.push({ vault: record.address, msg: String(err) });
        }
      }

      summaries.push(summary);
    }

    return summaries;
  } finally {
    await releaseTickLock();
  }
}
