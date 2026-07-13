import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface VaultRecord {
  address: string;
  owner: string;
  uniLabApiKey?: string;
  positionInitialized: boolean;
  createdAtBlock: string; // stored as string, bigint doesn't survive JSON
}

interface StoreShape {
  lastProcessedBlock: string; // bigint as string
  vaults: Record<string, VaultRecord>; // keyed by lowercase vault address
}

const DEFAULT_PATH = new URL("../data/store.json", import.meta.url).pathname;

function empty(): StoreShape {
  return { lastProcessedBlock: "0", vaults: {} };
}

/**
 * Minimal JSON-file-backed state for the keeper: which vaults exist, their
 * uni-lab.xyz api_key (one per vault — see PLAN.md, agent_wallet = vault address
 * because the vault itself sends the USDT payment), and how far event discovery
 * has scanned. A real deployment would use a database; a JSON file is plenty for
 * the hackathon's timeline and vault count.
 */
export class Store {
  private path: string;
  private data: StoreShape;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
    if (existsSync(path)) {
      this.data = JSON.parse(readFileSync(path, "utf-8"));
    } else {
      this.data = empty();
      this.persist();
    }
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  getLastProcessedBlock(): bigint {
    return BigInt(this.data.lastProcessedBlock);
  }

  setLastProcessedBlock(block: bigint) {
    this.data.lastProcessedBlock = block.toString();
    this.persist();
  }

  getVault(address: string): VaultRecord | undefined {
    return this.data.vaults[address.toLowerCase()];
  }

  listVaults(): VaultRecord[] {
    return Object.values(this.data.vaults);
  }

  upsertVault(record: VaultRecord) {
    this.data.vaults[record.address.toLowerCase()] = record;
    this.persist();
  }
}
