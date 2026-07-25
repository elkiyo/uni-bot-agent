import "server-only";
import type { Abi, Address } from "viem";
import type { ChainRuntime } from "./wallet";
import { vaultContract } from "./serverContracts";
import { erc20Abi } from "../contracts";
import type { Store, VaultRecord } from "./store";
import { logEvent } from "./logger";

/**
 * A single vault's own resolved stable/volatile pair — the "resolver el par
 * de ESTE vault" primitive from wild-exploring-bumblebee.md's multi-pair
 * design. Every field here is readable live from data the vault/tokens
 * already expose publicly (token0()/token1()/stableIsToken0() on the vault,
 * decimals() on each ERC20) — no separate pairs registry needed for an
 * already-deployed vault, only for curating which pairs to OFFER at
 * vault-creation time (see chains.ts's future SupportedPair, Fase 4).
 */
export interface VaultPairInfo {
  stableToken: Address;
  volatileToken: Address;
  stableIsToken0: boolean;
  stableDecimals: number;
  volatileDecimals: number;
}

/**
 * Resolves a vault's pair, preferring the cached copy on its VaultRecord
 * (populated once by discovery.ts at registration time) and falling back to
 * a live on-chain read + one-time backfill for a legacy row that predates
 * those columns (see schema.sql's migration note) — self-healing, no manual
 * backfill script required. This never changes after a vault is created, so
 * the live-read path only ever runs once per vault, ever.
 *
 * `record` is optional — pass it when the caller already has one loaded
 * (avoids a redundant Supabase round-trip); omit it to have this function
 * fetch it itself, for callers that don't otherwise need the full record.
 */
export async function resolveVaultPair(
  chain: ChainRuntime,
  vaultAddress: Address,
  abi: Abi,
  store: Store,
  record?: VaultRecord,
): Promise<VaultPairInfo> {
  const resolvedRecord = record ?? (await store.getVault(vaultAddress));
  if (
    resolvedRecord?.stableToken !== undefined &&
    resolvedRecord.volatileToken !== undefined &&
    resolvedRecord.stableIsToken0 !== undefined &&
    resolvedRecord.stableDecimals !== undefined &&
    resolvedRecord.volatileDecimals !== undefined
  ) {
    return {
      stableToken: resolvedRecord.stableToken as Address,
      volatileToken: resolvedRecord.volatileToken as Address,
      stableIsToken0: resolvedRecord.stableIsToken0,
      stableDecimals: resolvedRecord.stableDecimals,
      volatileDecimals: resolvedRecord.volatileDecimals,
    };
  }

  const pair = await readVaultPairLive(chain, vaultAddress, abi);

  try {
    await store.setVaultPairInfo(vaultAddress, pair);
  } catch (err) {
    // Non-fatal — worst case this same live read repeats next cycle. Never
    // block trading on the backfill write succeeding.
    logEvent({ level: "warn", vault: vaultAddress, msg: "failed to persist resolved pair info, will retry next cycle", err: String(err) });
  }

  return pair;
}

/**
 * Overrides a ChainRuntime's default-pair fields with a specific vault's own
 * resolved pair — every downstream keeper helper (pickDeepestSwapFee,
 * ethPriceFromTick, sizeRebalanceSwap, toToken0ToToken1, the volatile-token
 * balanceOf reads, ...) already takes `chain: ChainRuntime` and reads
 * stableToken/volatileToken/stableIsToken0/stableDecimals/volatileDecimals
 * off of it, so passing the object this returns in place of the raw chain
 * makes every one of those calls automatically correct for THIS vault's
 * pair, with no signature changes needed anywhere else. Every other field
 * (publicClient, feeTier, candidateSwapFeeTiers, ...) passes through
 * unchanged — feeTier/candidateSwapFeeTiers in particular still describe the
 * CHAIN's default pair's swap-routing pools, a known limitation until Fase 4
 * gives each supported pair its own candidate fee tiers too; harmless today
 * since every vault in production is still on the chain's default pair.
 */
export function applyVaultPair(chain: ChainRuntime, pair: VaultPairInfo): ChainRuntime {
  return {
    ...chain,
    stableToken: pair.stableToken,
    volatileToken: pair.volatileToken,
    stableIsToken0: pair.stableIsToken0,
    stableDecimals: pair.stableDecimals,
    volatileDecimals: pair.volatileDecimals,
  };
}

/** The actual on-chain reads behind resolveVaultPair's fallback path — also
 * used directly by discovery.ts to populate a brand-new vault's pair columns
 * at registration time, before a VaultRecord even exists to check. */
export async function readVaultPairLive(chain: ChainRuntime, vaultAddress: Address, abi: Abi): Promise<VaultPairInfo> {
  const vault = vaultContract(chain, vaultAddress, abi);
  const [token0, token1, stableIsToken0] = (await Promise.all([
    vault.read.token0(),
    vault.read.token1(),
    vault.read.stableIsToken0(),
  ])) as [Address, Address, boolean];

  const stableToken = stableIsToken0 ? token0 : token1;
  const volatileToken = stableIsToken0 ? token1 : token0;

  const [stableDecimals, volatileDecimals] = await Promise.all([
    chain.publicClient.readContract({ address: stableToken, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
    chain.publicClient.readContract({ address: volatileToken, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
  ]);

  return { stableToken, volatileToken, stableIsToken0, stableDecimals, volatileDecimals };
}
