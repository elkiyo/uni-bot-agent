import "server-only";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UNILAB_BASE_URL } from "../addresses";
import { logUniLabCall } from "./logger";
import { operatorAccount } from "./wallet";

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

// pool-setup-initial (the initial position's swap sizing) is deliberately not
// called anymore — the response was never actually used even when it
// succeeded (initPosition always used the locally-computed balanced-deposit
// ratio), so paying for it was a real cost to the owner for no benefit. Only
// rebalance() consults uni-lab now, where the answer genuinely drives the
// outcome. See PLAN.md.

export interface RcRlpRebalanceParams {
  currentLiquidityUsd: number; // A1
  amountToRecoverUsd: number; // B1
  currentPriceVolatileAsset: number; // C1
  newLowerBound: number; // D1
  reinvestmentAmountUsd: number; // E1 — 0 = RC, >0 = RLP
}

export interface RcRlpRebalanceResponse {
  [key: string]: unknown; // expected to include the new upper bound; schema not pinned down
}

const CELO_NETWORK = "eip155:42220"; // CAIP-2, confirmed against https://api.x402.celo.org/supported

let payFetch: ReturnType<typeof wrapFetchWithPayment> | undefined;

/** Lazy — operatorAccount is undefined in any env missing OPERATOR_PRIVATE_KEY. */
function getPayFetch() {
  if (!operatorAccount) return undefined;
  if (!payFetch) {
    const client = new x402Client().register(CELO_NETWORK, new ExactEvmScheme(operatorAccount));
    payFetch = wrapFetchWithPayment(fetch, client);
  }
  return payFetch;
}

/**
 * Pays via the x402 protocol — an X-PAYMENT header settled by Celo's
 * facilitator (api.x402.celo.org) in USDC from the operator's OWN wallet,
 * not the vault (see HACKATHON.md "Track 2 — x402": a vault contract can't
 * sign an EIP-712 authorization, only an EOA can). This is the only payment
 * path uni-bot-agent uses as of 2026-07-15 — the earlier on-chain
 * payUniLabFee()+tx_hash flow (paid per-vault, out of each owner's own
 * deposited budget) was retired once x402 was confirmed working end-to-end
 * on-chain: no vault budget needed anymore, the operator covers uni-lab
 * costs directly. Confirmed live with a real settled USDC transfer.
 *
 * Throws if the operator has no USDC to authorize the payment with, or on
 * any other x402/network failure — the caller (rebalancer.ts) catches that
 * and proceeds with a fallback width estimate rather than treating it as fatal.
 */
export async function rcRlpRebalanceViaX402(
  apiKey: string,
  params: RcRlpRebalanceParams,
  vaultAddress: string,
): Promise<RcRlpRebalanceResponse> {
  const fetchImpl = getPayFetch();
  if (!fetchImpl) throw new Error("no operator account configured for x402 payment");

  const endpoint = "rc-rlp-rebalance";
  const body = {
    A1: params.currentLiquidityUsd,
    B1: params.amountToRecoverUsd,
    C1: params.currentPriceVolatileAsset,
    D1: params.newLowerBound,
    E1: params.reinvestmentAmountUsd,
    blockchain: "celo",
  };
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(`${UNILAB_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as raw text
    }

    await logUniLabCall({
      vault: vaultAddress,
      endpoint: `${endpoint} (x402)`,
      request: body,
      httpStatus: res.status,
      response: parsed,
      ok: res.ok,
      durationMs: Date.now() - startedAt,
    });

    if (!res.ok) throw new Error(`${endpoint} (x402) failed: ${res.status} ${text}`);
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith(`${endpoint} (x402) failed:`))) {
      // Network-level failure (never got an HTTP response) — still log it.
      await logUniLabCall({
        vault: vaultAddress,
        endpoint: `${endpoint} (x402)`,
        request: body,
        httpStatus: 0,
        response: null,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: String(err),
      });
    }
    throw err;
  }
}
