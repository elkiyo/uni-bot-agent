import { toDataSuffix } from "@celo/attribution-tags";
import type { Hex } from "viem";

// ERC-8021 codes must match [a-z0-9_] only (lowercase, no hyphens/spaces).
// Mirrors lib/keeper/attribution.ts (server-only) — this copy is for
// transactions the browser sends itself (create/deposit/withdraw/admin),
// which need the tag baked in at build time via NEXT_PUBLIC_ATTRIBUTION_TAG.
const PROJECT_CODE = "range_vault";

export function getAttributionDataSuffix(): Hex | undefined {
  const tag = process.env.NEXT_PUBLIC_ATTRIBUTION_TAG;
  if (!tag) return undefined;
  return toDataSuffix([PROJECT_CODE, tag]);
}
