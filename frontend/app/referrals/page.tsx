"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { Header } from "../components/Header";
import { useAuthSession } from "@/lib/auth/AuthSessionProvider";
import { useTranslation } from "@/lib/i18n/useTranslation";

interface VolumeByChain {
  chainId: number;
  chainName: string;
  tokenSymbol: string;
  totalDeposited: number;
  vaultCount: number;
  hasDeposit: boolean;
}

interface ReferralRow {
  id: number;
  referrer: string;
  referred: string;
  created_at: string;
  activated_at: string | null;
  volumeByChain: VolumeByChain[];
}

interface LiquidationRow {
  id: number;
  amount: string;
  token_symbol: string;
  chain_name: string;
  tx_hash: string;
  notes: string | null;
  created_at: string;
}

interface StatsResponse {
  referrals: ReferralRow[];
  liquidations: LiquidationRow[];
  grandTotalByToken: Record<string, number>;
  activeCount: number;
  totalCount: number;
}

export default function ReferralsPage() {
  const { address, isConnected } = useAccount();
  const { session, signingIn, signIn } = useAuthSession();
  const { t } = useTranslation();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // No reset-to-null branch here on purpose: `stats` is only ever rendered
    // once `session` matches `address` (see the JSX below), so a stale value
    // from a previous session is simply never shown.
    if (!session || !address || session.wallet.toLowerCase() !== address.toLowerCase()) return;
    let cancelled = false;
    fetch(`/api/referral/stats?referrer=${session.wallet}`)
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setStats(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, address]);

  const referralLink = address && typeof window !== "undefined" ? `${window.location.origin}/?ref=${address}` : "";

  async function copyLink() {
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function shareLink() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url: referralLink, title: t("referrals.shareTitle") });
        return;
      } catch {
        // user dismissed the native share sheet — fall through to copy
      }
    }
    copyLink();
  }

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">{t("referrals.eyebrow")}</span>
        <h1
          className="mt-5 text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("referrals.title")}
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">{t("referrals.subtitle")}</p>

        {!isConnected && (
          <div className="glass mt-10 rounded-2xl p-8 text-center">
            <p className="text-sm text-muted">{t("referrals.connectPrompt")}</p>
          </div>
        )}

        {isConnected && !session && (
          <div className="glass mt-10 rounded-2xl p-8 text-center">
            <p className="text-sm text-muted">{t("referrals.signInPrompt")}</p>
            <button onClick={() => signIn()} disabled={signingIn} className="btn-primary mt-4 !px-5 !py-2.5">
              {signingIn ? t("referrals.signingIn") : t("referrals.signInButton")}
            </button>
          </div>
        )}

        {isConnected && session && address && (
          <>
            <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                {t("referrals.yourLink")}
              </span>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <code className="flex-1 break-all rounded-xl border border-hairline bg-white/[0.02] px-4 py-3 text-xs text-white/80">
                  {referralLink}
                </code>
                <button onClick={copyLink} className="btn-secondary !px-4 !py-2.5">
                  {copied ? t("referrals.copied") : t("referrals.copy")}
                </button>
                <button onClick={shareLink} className="btn-secondary !px-4 !py-2.5">
                  {t("referrals.share")}
                </button>
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Stat label={t("referrals.statTotal")} value={stats ? String(stats.totalCount) : "…"} />
              <Stat label={t("referrals.statActive")} value={stats ? String(stats.activeCount) : "…"} accent />
              <Stat
                label={t("referrals.statLiquidated")}
                value={
                  stats
                    ? Object.entries(stats.grandTotalByToken)
                        .map(([sym, amt]) => `${amt.toFixed(2)} ${sym}`)
                        .join(" + ") || "0"
                    : "…"
                }
              />
            </div>

            <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
              <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
                {t("referrals.listTitle")}
              </h2>
              {stats && stats.referrals.length === 0 && (
                <p className="mt-4 text-sm text-muted">{t("referrals.noneYet")}</p>
              )}
              {!stats && <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{t("referrals.loading")}</p>}
              <div className="mt-4 flex flex-col gap-3">
                {stats?.referrals.map((r) => (
                  <ReferralRowView key={r.id} row={r} t={t} />
                ))}
              </div>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={accent ? "glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5" : "glass rounded-2xl p-5"}>
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <p
        className={`mt-2 text-lg font-semibold tabular-nums ${accent ? "text-accent" : "text-white/90"}`}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </p>
    </div>
  );
}

function ReferralRowView({ row, t }: { row: ReferralRow; t: ReturnType<typeof useTranslation>["t"] }) {
  const active = Boolean(row.activated_at);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="break-all font-mono text-xs text-white/80">{row.referred}</span>
        <span
          className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${
            active ? "bg-accent/[0.12] text-accent" : "bg-white/[0.06] text-muted"
          }`}
        >
          {active ? t("referrals.badgeActive") : t("referrals.badgeRegistered")}
        </span>
        <span className="font-mono text-[11px] text-muted">{new Date(row.created_at).toLocaleDateString()}</span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {row.volumeByChain
          .filter((v) => v.vaultCount > 0)
          .map((v) => (
            <div key={v.chainId} className="rounded-lg bg-black/30 px-3 py-2 text-xs text-white/70">
              {v.chainName}: {v.totalDeposited.toFixed(2)} {v.tokenSymbol}
            </div>
          ))}
        {row.volumeByChain.every((v) => v.vaultCount === 0) && (
          <span className="text-xs text-muted">{t("referrals.noVaultYet")}</span>
        )}
      </div>
    </div>
  );
}
