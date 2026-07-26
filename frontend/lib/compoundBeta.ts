// Interest-compounding (RangeVaultArbCompound) just went live on Arbitrum
// (2026-07-26) — restricted to a single wallet while it's still being
// polished (see the "switch didn't show"/"config fields were hard to find"
// fixes from the same rollout). Delete this file and every import of it once
// the feature is ready for everyone — there's nothing else gating it at that
// point, chain.compoundFactoryAddress being set is the only other check.
const COMPOUND_BETA_WALLET = "0xb0E5ADb84373b30D0F79C3f9E814d13D7125991b".toLowerCase();

export function isCompoundBetaWallet(address: string | undefined): boolean {
  return Boolean(address && address.toLowerCase() === COMPOUND_BETA_WALLET);
}
