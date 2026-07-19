"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@/lib/i18n/useTranslation";

/**
 * Live countdown to the vault's next *periodic* rebalance trigger
 * (lastRebalanceTimestamp + periodicRebalanceInterval — see RangeVault.sol).
 * The other trigger (price leaving the range) isn't a countdown, it's a
 * live price condition — shown separately by the in-range badge on
 * PositionNFT. periodicRebalanceInterval === 0 means that trigger is off.
 */
export function RebalanceCountdown({
  lastRebalanceTimestamp,
  periodicRebalanceInterval,
  hasPosition,
  paused,
  atRebalanceLimit,
}: {
  lastRebalanceTimestamp: bigint;
  periodicRebalanceInterval: bigint;
  hasPosition: boolean;
  paused: boolean;
  atRebalanceLimit: boolean;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const { t } = useTranslation();

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  if (!hasPosition) return null;

  const nextAt = Number(lastRebalanceTimestamp) + Number(periodicRebalanceInterval);
  const remaining = nextAt - now;
  const periodicEnabled = periodicRebalanceInterval > 0n;

  let statusText: string;
  let sub: string;
  if (paused) {
    statusText = t("rebalanceCountdown.pausedTitle");
    sub = t("rebalanceCountdown.pausedSub");
  } else if (atRebalanceLimit) {
    statusText = t("rebalanceCountdown.limitTitle");
    sub = t("rebalanceCountdown.limitSub");
  } else if (!periodicEnabled) {
    statusText = t("rebalanceCountdown.noTriggerTitle");
    sub = t("rebalanceCountdown.noTriggerSub");
  } else if (remaining <= 0) {
    statusText = t("rebalanceCountdown.inWindowTitle");
    sub = t("rebalanceCountdown.inWindowSub");
  } else {
    statusText = formatDuration(remaining);
    sub = t("rebalanceCountdown.countdownSub");
  }

  const progress = periodicEnabled
    ? Math.min(100, Math.max(0, ((Number(periodicRebalanceInterval) - Math.max(0, remaining)) / Number(periodicRebalanceInterval)) * 100))
    : 0;

  return (
    <div className="glass rounded-2xl p-5">
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
        {t("rebalanceCountdown.nextRebalance")}
      </span>
      <p
        className="mt-1 text-lg font-semibold tabular-nums text-white/90"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {statusText}
      </p>
      {periodicEnabled && !paused && !atRebalanceLimit && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
      <p className="mt-2 text-xs text-faint">{sub}</p>
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
