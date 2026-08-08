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
import { mapWithConcurrency } from "../concurrency";
import type { VaultAction } from "./monitor";

/**
 * Higher = processed earlier in Phase 2's sequential queue below. Exists
 * because that queue can run out of the cron's 200s budget partway through
 * on a bad tick (many vaults needing action at once, or every action taking
 * longer than usual — e.g. uni-lab.xyz's x402 rail down, forcing every
 * rebalance through the slower direct-payment fallback) — confirmed live
 * 2026-08-01 (x402 outage, only ~2 of 30+ out-of-range vaults reached per
 * tick) and again 2026-08-08 (a single newly-periodic vault starved for
 * hours because it always sorted after enough other vaults needing action).
 * Without this, whichever vault happens to sort last in store.listVaults()
 * (roughly creation order) can get starved indefinitely on a chain that's
 * consistently near its budget — this makes a bad tick spread the pain
 * across different vaults instead of always the same ones. Out-of-range
 * outranks periodic outright (the position is actively mispriced, not just
 * due for routine maintenance); within either, the longer-neglected vault
 * (bigger overdueSec) goes first. claimFees/sweep/init are real but less
 * time-critical than a rebalance, so they sort behind all rebalances but
 * ahead of nothing needed at all.
 */
function actionPriority(action: VaultAction): number {
  switch (action.kind) {
    case "rebalance":
      return (action.reason === "periodic" ? 0 : 1_000_000_000) + action.overdueSec;
    case "claimFees":
      return -1;
    case "sweep":
      return -2;
    case "init":
      return -3;
    case "none":
      return -Infinity;
  }
}

const TICK_LOCK_TTL_SECONDS = 4 * 60; // < the 5-minute trigger interval
// See Phase 1's own comment below for why this exists. 10 concurrent reads
// against a public RPC (forno.celo.org/arb1.arbitrum.io) is the same order
// of magnitude already proven safe elsewhere in this codebase (getLogsChunked.ts).
const CHECK_CONCURRENCY = 10;

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

      // Phase 1 — decide what each vault needs. Read-only (checkVault never
      // writes anything; the gasReserveEmptySince re-check below is the only
      // side effect here, and it's independent per vault), so safe to run
      // with bounded concurrency instead of one-at-a-time. This used to be a
      // single sequential for-loop covering both the check AND the action —
      // with Arbitrum alone at ~250 vaults and each checkVault() a handful
      // of RPC round trips, that sequential scan could eat most of the
      // cron's 200s function budget before ever reaching a vault that
      // actually needed a rebalance. Confirmed live 2026-08-01: 30+ vaults
      // out of range during uni-lab.xyz's x402 outage, only ~2 getting
      // reached per tick despite the direct-payment fallback itself being
      // fast (see unilab.ts/rebalancer.ts's own notes on that incident).
      // CHECK_CONCURRENCY bounds the burst against the shared public RPC —
      // see mapWithConcurrency's own docstring (concurrency.ts).
      const vaultRecords = await store.listVaults();
      const decisions = await mapWithConcurrency(vaultRecords, CHECK_CONCURRENCY, async (record) => {
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
          return { record, abi, action, error: undefined as string | undefined };
        } catch (err) {
          return { record, abi, action: { kind: "none" as const }, error: String(err) };
        }
      });

      // Phase 2 — apply actions SEQUENTIALLY, unlike the read-only decisions
      // above: these send real transactions from the SAME operator wallet,
      // so nonce ordering rules out parallelizing this part. Sorted by
      // actionPriority (most-neglected/urgent first) so a tick that runs out
      // of budget partway through drops the LEAST urgent vaults, not
      // whichever ones happen to sort last in store.listVaults() — see that
      // function's own docstring.
      const prioritized = [...decisions].sort((a, b) => actionPriority(b.action) - actionPriority(a.action));
      for (const { record, abi, action, error } of prioritized) {
        summary.vaultsChecked++;
        if (error) {
          logEvent({ level: "error", vault: record.address, chain: chain.name, msg: "vault check failed", err: error });
          summary.errors.push({ vault: record.address, msg: error });
          continue;
        }
        try {
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
          logEvent({ level: "error", vault: record.address, chain: chain.name, msg: "vault action failed", err: String(err) });
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
