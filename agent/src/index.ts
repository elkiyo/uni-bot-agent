import { publicClient, operatorAccount } from "./wallet.js";

async function main() {
  const chainId = await publicClient.getChainId();
  console.log(`uni-bot-agent keeper starting — chainId=${chainId}`);
  if (!operatorAccount) {
    console.log("OPERATOR_PRIVATE_KEY not set — read-only mode (no txs can be sent).");
  } else {
    console.log(`Operator wallet: ${operatorAccount.address}`);
  }
  // TODO: discovery.ts (VaultCreated events) + monitor.ts + rebalancer.ts loop — see PLAN.md
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
