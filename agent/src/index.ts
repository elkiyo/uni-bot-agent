import cron from "node-cron";
import type { Address } from "viem";
import { publicClient, operatorAccount } from "./wallet.js";
import { Store } from "./store.js";
import { discoverAndRegisterVaults } from "./discovery.js";
import { checkVault } from "./monitor.js";
import { runInitPosition, runRebalance } from "./rebalancer.js";
import { logEvent } from "./logger.js";

const store = new Store();

function factoryAddress(): Address {
  const addr = process.env.FACTORY_ADDRESS;
  if (!addr) throw new Error("FACTORY_ADDRESS not set — deploy the factory first (see PLAN.md)");
  return addr as Address;
}

async function tick() {
  try {
    await discoverAndRegisterVaults(factoryAddress(), store);
  } catch (err) {
    logEvent({ level: "error", msg: "discovery failed", err: String(err) });
  }

  for (const record of store.listVaults()) {
    try {
      const action = await checkVault(record.address as Address);
      if (action.kind === "init") {
        await runInitPosition(record.address as Address, store);
      } else if (action.kind === "rebalance") {
        await runRebalance(record.address as Address, store, action.reason);
      }
    } catch (err) {
      logEvent({ level: "error", vault: record.address, msg: "vault check/action failed", err: String(err) });
    }
  }
}

async function main() {
  const chainId = await publicClient.getChainId();
  console.log(`uni-bot-agent keeper starting — chainId=${chainId}`);
  if (!operatorAccount) {
    console.log("OPERATOR_PRIVATE_KEY not set — read-only mode, the scheduler will only log actions it would take.");
  } else {
    console.log(`Operator wallet: ${operatorAccount.address}`);
  }

  await tick();
  // Every 5 minutes: cheap enough for a hackathon-scale vault count, frequent
  // enough to catch periodic-rebalance windows without excessive RPC load.
  cron.schedule("*/5 * * * *", () => {
    tick().catch((err) => logEvent({ level: "error", msg: "tick failed", err: String(err) }));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
