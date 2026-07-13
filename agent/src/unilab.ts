import { UNILAB_BASE_URL } from "./addresses.js";

/** Thin client for uni-lab.xyz's pay-per-query API (docs: https://uni-lab-xyz.vercel.app/api-docs). */

export interface RegisterAgentResponse {
  api_key: string;
  agent_id: string;
  agent_name: string;
  agent_wallet: string;
  created_at: string;
}

export async function registerAgent(agentName: string, agentWallet: string): Promise<RegisterAgentResponse> {
  const res = await fetch(`${UNILAB_BASE_URL}/register-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_name: agentName, agent_wallet: agentWallet }),
  });
  if (!res.ok) {
    throw new Error(`register-agent failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<RegisterAgentResponse>;
}

export interface PoolSetupInitialParams {
  usdPoolInvestment: number;
  currentPriceVolatileAsset: number;
  minPriceLowerLimit: number;
  maxPriceUpperLimit: number;
  txHash: string;
}

export interface PoolSetupInitialResponse {
  [key: string]: unknown; // response schema not fully documented — consumed defensively
}

export async function poolSetupInitial(
  apiKey: string,
  params: PoolSetupInitialParams,
): Promise<PoolSetupInitialResponse> {
  return callPaidEndpoint(apiKey, "pool-setup-initial", {
    usd_pool_investment: params.usdPoolInvestment,
    current_price_volatile_asset: params.currentPriceVolatileAsset,
    min_price_lower_limit: params.minPriceLowerLimit,
    max_price_upper_limit: params.maxPriceUpperLimit,
    tx_hash: params.txHash,
    blockchain: "celo",
  });
}

export interface RcRlpRebalanceParams {
  currentLiquidityUsd: number; // A1
  amountToRecoverUsd: number; // B1
  currentPriceVolatileAsset: number; // C1
  newLowerBound: number; // D1
  reinvestmentAmountUsd: number; // E1 — 0 = RC, >0 = RLP
  txHash: string;
}

export interface RcRlpRebalanceResponse {
  [key: string]: unknown; // expected to include the new upper bound; schema not pinned down
}

export async function rcRlpRebalance(
  apiKey: string,
  params: RcRlpRebalanceParams,
): Promise<RcRlpRebalanceResponse> {
  return callPaidEndpoint(apiKey, "rc-rlp-rebalance", {
    A1: params.currentLiquidityUsd,
    B1: params.amountToRecoverUsd,
    C1: params.currentPriceVolatileAsset,
    D1: params.newLowerBound,
    E1: params.reinvestmentAmountUsd,
    tx_hash: params.txHash,
    blockchain: "celo",
  });
}

async function callPaidEndpoint(
  apiKey: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${UNILAB_BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // 402 here means the on-chain payment tx wasn't found/valid yet — the caller
    // should confirm more blocks and retry rather than treat this as fatal.
    throw new Error(`${endpoint} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}
