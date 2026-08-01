import "server-only";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { celo } from "viem/chains";
import { UNILAB_BASE_URL, UNILAB_PAYMENT_WALLET, USDT } from "../addresses";
import { CHAINS } from "../chains";
import { erc20Abi } from "../contracts";
import { logUniLabCall } from "./logger";
import { operatorAccount, getChainRuntime } from "./wallet";
import { sendTaggedTx } from "./serverContracts";

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
// outcome. See autorange.md.

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

export interface PricingResponse {
  price_usdt: number;
  payment_wallet: string;
  blockchain: string;
}

/**
 * uni-lab.xyz's price isn't fixed — confirmed 2026-07-14 (a hardcoded 0.5
 * USDT 402'd against a real 0.2 USDT price) and reconfirmed 2026-08-01 (a
 * live read came back 0.00001 USDT). Query fresh right before every
 * direct-payment attempt below — never cache or hardcode a number.
 * Unauthenticated, chain-agnostic (no ChainRuntime needed).
 */
export async function getPricing(): Promise<PricingResponse> {
  const res = await fetch(`${UNILAB_BASE_URL}/pricing`);
  if (!res.ok) {
    throw new Error(`pricing failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<PricingResponse>;
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
 * Single choke point both payment rails (x402 and the direct-payment
 * fallback below) funnel through, so logUniLabCall's audit trail stays
 * consistent between them instead of two logging call sites silently
 * drifting apart. `fetchImpl` is the only real difference: the x402-wrapped
 * fetch (signs/retries under the hood) vs. a plain fetch for the
 * direct-payment rail, which authenticates via tx_hash in the body instead
 * of a request header.
 */
async function postToUniLab(
  endpoint: string,
  logLabel: string,
  apiKey: string,
  body: Record<string, unknown>,
  vaultAddress: string,
  vaultChainId: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<RcRlpRebalanceResponse> {
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(`${UNILAB_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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
      chainId: vaultChainId,
      endpoint: logLabel,
      request: body,
      httpStatus: res.status,
      response: parsed,
      ok: res.ok,
      durationMs: Date.now() - startedAt,
    });

    if (!res.ok) throw new Error(`${logLabel} failed: ${res.status} ${text}`);
    return parsed as RcRlpRebalanceResponse;
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith(`${logLabel} failed:`))) {
      // Network-level failure (never got an HTTP response) — still log it.
      // chainId included here too (a real gap in the pre-2026-08-01 version
      // of this function: its network-failure catch omitted chainId while
      // the success path included it, an inconsistency this shared helper
      // fixes as a byproduct of unifying both rails).
      await logUniLabCall({
        vault: vaultAddress,
        chainId: vaultChainId,
        endpoint: logLabel,
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

/**
 * Pays via the x402 protocol — an X-PAYMENT header settled by Celo's
 * facilitator (api.x402.celo.org) in USDC from the operator's OWN wallet,
 * not the vault (see HACKATHON.md "Track 2 — x402": a vault contract can't
 * sign an EIP-712 authorization, only an EOA can). This is the DEFAULT
 * payment path — the earlier on-chain payUniLabFee()+tx_hash flow (paid
 * per-vault, out of each owner's own deposited budget) was retired once
 * x402 was confirmed working end-to-end on-chain: no vault budget needed
 * anymore, the operator covers uni-lab costs directly.
 *
 * Throws if the operator has no USDC to authorize the payment with, or on
 * any other x402/network failure — the caller (rebalancer.ts) catches that
 * and now falls back to rcRlpRebalanceViaDirectPayment below (added
 * 2026-08-01 after uni-lab.xyz's x402 handshake broke — see that function's
 * own docstring) before giving up on the cycle entirely.
 *
 * X402_TIMEOUT_MS bounds how long a BROKEN x402 attempt can stall the whole
 * cycle before falling through to the direct-payment rail. Confirmed live
 * 2026-08-01: during uni-lab's x402 outage, every failing attempt took a
 * consistent ~10.5s (the x402 client's own internal retry/timeout behavior)
 * before finally erroring — with 46 vaults out of range and the cron's
 * sequential per-vault loop bound by a 200s function budget, that ~10.5s of
 * dead time per vault (on top of the direct-payment rail's own ~5-10s) was
 * roughly halving how many vaults could actually get rebalanced per tick.
 * 4s is generous for a healthy x402 round-trip (the docs bundle's own flow
 * completes in under a second end-to-end) while cutting the outage-mode
 * dead time by more than half. Worst case if x402 recovers but is merely
 * SLOW (not broken): an occasional spurious fallback to direct-payment,
 * which still succeeds — not a correctness risk, just an extra operator
 * payment that would have been unnecessary.
 */
const X402_TIMEOUT_MS = 4_000;

export async function rcRlpRebalanceViaX402(
  apiKey: string,
  params: RcRlpRebalanceParams,
  vaultAddress: string,
  vaultChainId: number,
): Promise<RcRlpRebalanceResponse> {
  const fetchImpl = getPayFetch();
  if (!fetchImpl) throw new Error("no operator account configured for x402 payment");

  const body = {
    A1: params.currentLiquidityUsd,
    B1: params.amountToRecoverUsd,
    C1: params.currentPriceVolatileAsset,
    D1: params.newLowerBound,
    E1: params.reinvestmentAmountUsd,
    blockchain: "celo",
  };
  return postToUniLab(
    "rc-rlp-rebalance",
    "rc-rlp-rebalance (x402)",
    apiKey,
    body,
    vaultAddress,
    vaultChainId,
    fetchImpl,
    X402_TIMEOUT_MS,
  );
}

// Same 30% gas-price-drift buffer as rebalancer.ts's GAS_SAFETY_MULTIPLIER_PCT
// — kept as its own local constant rather than imported, since this file
// only needs it for a plain ERC20 transfer estimate (no vault contract
// involved) and importing from rebalancer.ts would create a circular
// import (rebalancer.ts already imports from this file).
const GAS_SAFETY_MULTIPLIER_PCT = 130n;
// A plain ERC20 transfer() is cheap and doesn't vary per-call the way a
// vault contract call does — no need for estimateContractGas, a static
// estimate with the same safety buffer above is enough.
const ESTIMATED_TRANSFER_GAS = 65_000n;

/**
 * Pre-flight check before attempting rcRlpRebalanceViaDirectPayment —
 * mirrors the spirit of rebalancer.ts's hasEnoughOperatorGas, but lives here
 * since it needs a fresh uni-lab price to know the required USDT amount
 * (pricing is a uni-lab concern, not a rebalancer one). Called by
 * rebalancer.ts before spending time on a payment attempt that would just
 * fail — a zero USDT balance is the expected case until the operator wallet
 * is funded for this fallback (it only ever needed USDC for x402 before).
 */
export async function hasEnoughOperatorUsdtForDirectPayment(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!operatorAccount) return { ok: false, reason: "no operator account configured" };
  try {
    const celoChain = getChainRuntime(CHAINS[celo.id]);
    const pricing = await getPricing();
    const amountRaw = BigInt(Math.round(pricing.price_usdt * 1e6)); // USDT, 6 decimals on Celo

    const [usdtBalance, celoBalance, gasPrice] = await Promise.all([
      celoChain.publicClient.readContract({
        address: USDT,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [operatorAccount.address],
      }) as Promise<bigint>,
      celoChain.publicClient.getBalance({ address: operatorAccount.address }),
      celoChain.publicClient.getGasPrice(),
    ]);

    if (usdtBalance < amountRaw) {
      return { ok: false, reason: `operator USDT balance ${usdtBalance} below required ${amountRaw}` };
    }
    const estimatedCost = (ESTIMATED_TRANSFER_GAS * gasPrice * GAS_SAFETY_MULTIPLIER_PCT) / 100n;
    if (celoBalance < estimatedCost) {
      return { ok: false, reason: "operator CELO balance too low for the payment transfer" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `pricing lookup failed: ${String(err)}` };
  }
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// A DEDICATED api_key for the direct-payment rail, registered with
// agent_wallet = the operator's own address (NOT any vault's own
// per-vault api_key, which is registered with agent_wallet = that vault's
// address, from the retired vault-funded flow). Confirmed live 2026-08-01:
// uni-lab.xyz's tx_hash verification checks that the USDT transfer's
// sender matches the CALLING api_key's registered agent_wallet — using a
// vault's own api_key here (the operator is who actually sends the USDT)
// gets rejected with "USDT transfer not from agent wallet". Registered via
// POST /register-agent with agent_wallet=operatorAccount.address once,
// stored here as its own env var since it's an operator-level credential,
// not a per-vault one (those live in Supabase, see store.ts).
const UNILAB_OPERATOR_API_KEY = process.env.UNILAB_OPERATOR_API_KEY;

/**
 * Plan B for the 2026-08-01 x402 outage (uni-lab.xyz's x402 handshake
 * started throwing "Failed to parse payment requirements" 100% of the
 * time): pays uni-lab.xyz's OTHER documented rail instead — confirmed live
 * by reading their docs SPA bundle, this tx_hash+blockchain method is
 * actually their DEFAULT/primary flow, with x402 documented as the
 * optional shortcut, not the other way around. A plain Celo-native USDT
 * transfer to uni-lab's payment wallet, from the operator's OWN EOA (same
 * actor as x402 today, just a different payment rail) — then calls
 * rc-rlp-rebalance with tx_hash+blockchain instead of an X-PAYMENT header.
 *
 * This is the flow retired in commit 7b7d5a3, reintroduced WITHOUT its old
 * vault-funded usdtBudget/payUniLabFee() leg — that ledger is dead (owners
 * no longer fund it at deposit, see rcRlpRebalanceViaX402's own docstring).
 * The operator pays directly here, no vault interaction at all for the
 * payment leg — simpler than the old flow.
 *
 * Throws if the operator has no USDT/CELO to pay with (call
 * hasEnoughOperatorUsdtForDirectPayment first), if UNILAB_OPERATOR_API_KEY
 * isn't configured, or on any other network/API failure — same contract as
 * rcRlpRebalanceViaX402, the caller treats this as the LAST resort before
 * skipping the cycle entirely.
 *
 * Deliberately does NOT take a per-vault apiKey param (unlike
 * rcRlpRebalanceViaX402) — always uses UNILAB_OPERATOR_API_KEY, since a
 * vault's own api_key would fail uni-lab's sender-matches-agent_wallet
 * check (see that constant's own comment above). vaultAddress/vaultChainId
 * here are only for OUR OWN logUniLabCall audit trail, not sent to uni-lab.
 */
export async function rcRlpRebalanceViaDirectPayment(
  params: RcRlpRebalanceParams,
  vaultAddress: string,
  vaultChainId: number,
): Promise<RcRlpRebalanceResponse> {
  if (!UNILAB_OPERATOR_API_KEY) throw new Error("UNILAB_OPERATOR_API_KEY not set — cannot use the direct-payment fallback");
  if (!operatorAccount) throw new Error("no operator account configured for direct payment");
  const celoChain = getChainRuntime(CHAINS[celo.id]);
  if (!celoChain.walletClient) throw new Error("no operator account configured for direct payment");

  const pricing = await getPricing(); // fresh, right before paying — never cached
  const amountRaw = BigInt(Math.round(pricing.price_usdt * 1e6));

  // Prefer the LIVE payment_wallet from /pricing over the UNILAB_PAYMENT_WALLET
  // constant, in case uni-lab ever rotates it — the constant is only a
  // fallback for a missing/malformed field, same defensive posture as never
  // hardcoding the price itself.
  const paymentWallet = ADDRESS_RE.test(pricing.payment_wallet)
    ? (pricing.payment_wallet as `0x${string}`)
    : UNILAB_PAYMENT_WALLET;

  const txHash = await sendTaggedTx(celoChain, USDT, erc20Abi, "transfer", [paymentWallet, amountRaw]);
  await celoChain.publicClient.waitForTransactionReceipt({ hash: txHash });

  const endpoint = "rc-rlp-rebalance";
  const body = {
    A1: params.currentLiquidityUsd,
    B1: params.amountToRecoverUsd,
    C1: params.currentPriceVolatileAsset,
    D1: params.newLowerBound,
    E1: params.reinvestmentAmountUsd,
    tx_hash: txHash,
    blockchain: "celo",
  };

  // uni-lab.xyz may 402 if its backend hasn't indexed the tx yet (Celo
  // finalizes fast, but their own indexing lag is a separate concern) —
  // retry a couple of times with a short backoff rather than giving up on
  // the first 402. Capped small: this runs inside the cron tick's
  // sequential per-vault loop (200s budget across ALL vaults), and every
  // vault could hit this same path during a uni-lab-wide outage.
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 4_000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await postToUniLab(
        endpoint,
        `${endpoint} (direct-payment)`,
        UNILAB_OPERATOR_API_KEY,
        body,
        vaultAddress,
        vaultChainId,
      );
    } catch (err) {
      const is402 = err instanceof Error && err.message.includes("failed: 402");
      if (!is402 || attempt === MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw new Error("unreachable"); // TS narrowing only — loop above always returns or throws
}
