import "server-only";
import type { Abi, Address } from "viem";
import { operatorAccount, getChainRuntime } from "./wallet";
import { Store, acquireTickLock, releaseTickLock } from "./store";
import { discoverAndRegisterVaults } from "./discovery";
import { checkVault } from "./monitor";
import { runInitPosition, runRebalance, maybeSweepIdleDust, runClaimFees } from "./rebalancer";
import { vaultContract } from "./serverContracts";
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

      // Second factory, compound-interest vaults — Arbitrum only today (see
      // chains.ts's ChainDef docstring on compoundFactoryAddress). Undefined
      // on every other chain, so this whole block is a no-op there.
      if (chainDef.compoundFactoryAddress) {
        try {
          await discoverAndRegisterVaults(
            chain,
            chainDef.compoundFactoryAddress,
            store,
            "compound",
            chainDef.compoundFactoryAbi,
          );
        } catch (err) {
          logEvent({ level: "error", chain: chain.name, msg: "compound discovery failed", err: String(err) });
          summary.errors.push({ msg: `compound discovery failed: ${String(err)}` });
        }
      }

      for (const record of await store.listVaults()) {
        summary.vaultsChecked++;
        // Which ABI/contract this specific vault actually runs — resolved
        // once per vault from its stored `kind`, then threaded through every
        // call below instead of re-deriving it each time.
        const abi: Abi = record.kind === "compound" ? (chainDef.compoundVaultAbi as Abi) : chainDef.vaultAbi;
        try {
          // gas_reserve_empty_since only gets CLEARED as a side effect of
          // hasEnoughOperatorGas() in rebalancer.ts, which only runs when
          // checkVault() below decides this vault needs an actual operator
          // action (init/rebalance/claimFees/sweep). A healthy vault that
          // sits in-range needing none of those never re-evaluates the flag,
          // so an owner who tops up gasReserveBalance after being flagged
          // stays stuck showing "se agotó" indefinitely even though the
          // on-chain balance the vault-detail page reads live is positive
          // again (confirmed live 2026-07-27). Re-check independently of
          // whether an action is due, but only for vaults already flagged —
          // no need to spend an extra RPC read per healthy vault every tick.
          if (record.gasReserveEmptySince) {
            const gasReserveBalance = await (vaultContract(chain, record.address as Address, abi).read
              .gasReserveBalance() as Promise<bigint>).catch(() => undefined);
            if (gasReserveBalance !== undefined && gasReserveBalance > 0n) {
              await store.setGasReserveDepleted(record.address, false);
            }
          }

          const action = await checkVault(chain, record, store);
          if (action.kind === "init") {
            await runInitPosition(chain, record.address as Address, store, abi);
            summary.actions.push({ vault: record.address, action: "initPosition" });
          } else if (action.kind === "rebalance") {
            await runRebalance(chain, record.address as Address, store, action.reason, abi);
            summary.actions.push({ vault: record.address, action: `rebalance:${action.reason}` });
          } else if (action.kind === "claimFees") {
            await runClaimFees(chain, record.address as Address, store, abi);
            summary.actions.push({ vault: record.address, action: "claimFees" });
          } else if (action.kind === "sweep") {
            await maybeSweepIdleDust(chain, record.address as Address, store, abi);
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
