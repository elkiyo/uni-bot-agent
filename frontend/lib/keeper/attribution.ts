import "server-only";
import { toDataSuffix } from "@celo/attribution-tags";
import { concat, type Hex } from "viem";

// ERC-8021 codes must match [a-z0-9_] only (lowercase, no hyphens/spaces).
const PROJECT_CODE = "range_vault";

/**
 * Appends the hackathon attribution tag (ERC-8021) to a transaction's calldata.
 * ATTRIBUTION_TAG is unset until the project registers on celobuilders.xyz
 * (deliberately deferred to the end, see autorange.md) — until then the calldata is
 * returned unmodified.
 */
export function withAttribution(data: Hex): Hex {
  const tag = process.env.ATTRIBUTION_TAG;
  if (!tag) return data;
  const suffix = toDataSuffix([PROJECT_CODE, tag]);
  return concat([data, suffix]);
}
