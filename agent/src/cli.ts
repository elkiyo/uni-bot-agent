import type { Address } from "viem";
import { publicClient } from "./wallet.js";
import { Store } from "./store.js";
import { discoverAndRegisterVaults } from "./discovery.js";
import { checkVault } from "./monitor.js";
import { runInitPosition, runRebalance } from "./rebalancer.js";
import { vaultContract } from "./contracts.js";

const store = new Store();

function factoryAddress(): Address {
  const addr = process.env.FACTORY_ADDRESS;
  if (!addr) throw new Error("FACTORY_ADDRESS not set");
  return addr as Address;
}

async function status() {
  await discoverAndRegisterVaults(factoryAddress(), store);
  const vaults = store.listVaults();
  console.log(`${vaults.length} known vault(s):\n`);
  for (const record of vaults) {
    const vault = vaultContract(record.address as Address);
    const [positionTokenId, rebalanceCount, maxRebalances] = await Promise.all([
      vault.read.positionTokenId(),
      vault.read.rebalanceCount(),
      vault.read.maxRebalances(),
    ]);
    const action = await checkVault(record.address as Address);
    console.log(
      `  ${record.address} owner=${record.owner} positionTokenId=${positionTokenId} ` +
        `rebalances=${rebalanceCount}/${maxRebalances} apiKey=${record.uniLabApiKey ? "yes" : "NO"} ` +
        `nextAction=${action.kind}`,
    );
  }
}

async function forceRebalance(vaultAddress: string) {
  await runRebalance(vaultAddress as Address, store, "manual-force");
}

async function forceInit(vaultAddress: string) {
  await runInitPosition(vaultAddress as Address, store);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "status":
      await status();
      break;
    case "force-rebalance":
      if (!arg) throw new Error("usage: cli force-rebalance <vaultAddress>");
      await forceRebalance(arg);
      break;
    case "force-init":
      if (!arg) throw new Error("usage: cli force-init <vaultAddress>");
      await forceInit(arg);
      break;
    default:
      console.log("usage: cli <status|force-rebalance <vault>|force-init <vault>>");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
