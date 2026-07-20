"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { buildSiweMessage } from "./siweMessage";
import { REFERRAL_STORAGE_KEY } from "../referrals/storageKey";

export interface AuthSession {
  wallet: `0x${string}`;
  isAdmin: boolean;
}

interface AuthSessionContextValue {
  // undefined = the initial /api/auth/session check hasn't resolved yet.
  session: AuthSession | null | undefined;
  signingIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthSessionContext = createContext<AuthSessionContextValue | undefined>(undefined);

async function registerPendingReferral() {
  const referrer = window.localStorage.getItem(REFERRAL_STORAGE_KEY);
  if (!referrer) return;
  // Cleared up-front (not after the fetch resolves) so a failed/slow request
  // can't cause a retry loop on the next render — same idempotency guard as
  // Promtp_sis_referrers/promt_sis_ref.md §2 Paso 2.
  window.localStorage.removeItem(REFERRAL_STORAGE_KEY);
  try {
    await fetch("/api/referral/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referrer }),
    });
  } catch {
    // Best-effort — the visitor keeps browsing regardless.
  }
}

/**
 * Single source of truth for the SIWE session, mounted once near the root
 * (see app/providers.tsx) so every page shares one flow instead of each
 * racing its own signature prompt. Auto-triggers sign-in whenever the
 * connected wallet has no matching session yet.
 */
export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((res) => res.json())
      .then((body) => setSession(body.session ?? null))
      .catch(() => setSession(null));
  }, []);

  const signIn = useCallback(async () => {
    if (!address || !chainId) return;
    setSigningIn(true);
    try {
      const nonceRes = await fetch("/api/auth/nonce");
      const { nonce } = await nonceRes.json();
      const message = buildSiweMessage({
        domain: window.location.host,
        address,
        uri: window.location.origin,
        chainId,
        nonce,
        issuedAt: new Date().toISOString(),
      });
      const signature = await signMessageAsync({ message });
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      if (verifyRes.ok) {
        const body = await verifyRes.json();
        setSession({ wallet: body.wallet, isAdmin: body.isAdmin });
        await registerPendingReferral();
      }
    } catch {
      // User rejected the signature, or a transient error — the effect below
      // will simply offer sign-in again on the next relevant state change.
    } finally {
      setSigningIn(false);
    }
  }, [address, chainId, signMessageAsync]);

  useEffect(() => {
    if (!isConnected || !address || session === undefined || signingIn) return;
    if (session && session.wallet.toLowerCase() === address.toLowerCase()) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- signIn() is the SIWE flow itself (wallet signature prompt + server round-trips), not a state sync; auto-firing it when the connected wallet has no matching session is the intended behavior.
    signIn();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-trigger on wallet/session identity changes, not on every signIn/signingIn re-render
  }, [isConnected, address, session]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setSession(null);
  }, []);

  return (
    <AuthSessionContext.Provider value={{ session, signingIn, signIn, signOut }}>
      {children}
    </AuthSessionContext.Provider>
  );
}

export function useAuthSession(): AuthSessionContextValue {
  const ctx = useContext(AuthSessionContext);
  if (!ctx) throw new Error("useAuthSession must be used within AuthSessionProvider");
  return ctx;
}
