"use client";

import { TokenIcon } from "./TokenIcon";

export interface DepositTokenOption {
  address: `0x${string}`;
  decimals: number;
  displaySymbol: string;
}

/**
 * Row of stablecoin chips (logo + symbol + live wallet balance) for the
 * compound-vault deposit flows (create/page.tsx, VaultDetail.tsx) — lets the
 * owner pick which token they're actually handing over instead of always
 * assuming the vault's native stable. Purely presentational: the caller owns
 * `selected`/`onSelect` state and whatever balance data feeds `balances`
 * (see lib/useMultiTokenBalances.ts).
 */
export function DepositTokenSelector({
  tokens,
  selected,
  onSelect,
  balances,
  size = "field",
  variant = "dark",
}: {
  tokens: DepositTokenOption[];
  selected: `0x${string}`;
  onSelect: (address: `0x${string}`) => void;
  balances: (number | undefined)[]; // same order as tokens
  size?: "field" | "mini";
  // "light" renders dark-on-light — for use inside the accent-soft modals,
  // whose background is the inverse of this component's usual dark page.
  variant?: "dark" | "light";
}) {
  const iconSize = size === "field" ? 22 : 18;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tokens.map((token, i) => {
        const isSelected = token.address.toLowerCase() === selected.toLowerCase();
        const balance = balances[i];
        return (
          <button
            key={token.address}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onSelect(token.address)}
            className={`flex items-center gap-1.5 rounded-full border px-2 py-1 transition ${
              variant === "light"
                ? isSelected
                  ? "border-black bg-black/[0.06] text-[#050505]"
                  : "border-black/15 text-black/50 hover:border-black/40"
                : isSelected
                  ? "border-accent bg-accent/[0.1] text-white"
                  : "border-hairline text-faint hover:border-accent/50"
            } ${size === "field" ? "text-xs" : "text-[11px]"}`}
          >
            <TokenIcon symbol={token.displaySymbol} size={iconSize} />
            <span className="flex flex-col items-start leading-tight">
              <span className="font-semibold">{token.displaySymbol}</span>
              <span className={`font-mono text-[10px] ${variant === "light" ? "text-black/40" : "text-faint"}`}>
                {balance !== undefined ? balance.toFixed(2) : "—"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
