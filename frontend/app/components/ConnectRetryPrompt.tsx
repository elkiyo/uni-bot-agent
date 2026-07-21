"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useReconnect } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";

// On mobile, approving a WalletConnect pairing from the wallet app can lose
// the session entirely if the browser tab gets backgrounded mid-handshake —
// confirmed no version of @walletconnect/core listens for visibilitychange
// to resume a relay connection dropped while the tab was hidden, so there's
// nothing to reconnect to when that happens; a page reload won't help. That
// can't be fixed from the dApp side, so instead: if the tab was hidden while
// a connect attempt was in flight and comes back still disconnected, surface
// a clear "try again" prompt instead of leaving the person staring at a page
// that looks like nothing happened.
export function ConnectRetryPrompt() {
  const { isConnected, isConnecting, isReconnecting } = useAccount();
  const { reconnect } = useReconnect();
  const { openConnectModal } = useConnectModal();
  const [showRetry, setShowRetry] = useState(false);
  const pendingRef = useRef(false);
  const isConnectedRef = useRef(isConnected);

  useEffect(() => {
    isConnectedRef.current = isConnected;
    if (isConnected) {
      pendingRef.current = false;
      setShowRetry(false);
    }
  }, [isConnected]);

  useEffect(() => {
    if (isConnecting || isReconnecting) pendingRef.current = true;
  }, [isConnecting, isReconnecting]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== "visible" || !pendingRef.current) return;
      pendingRef.current = false;
      // The approval can land on the relay right as (or just after) the tab
      // regains focus, but the connector doesn't always surface that on its
      // own — actively re-check for a completed session instead of only
      // waiting on it, then fall back to the retry prompt if that comes up
      // empty too.
      reconnect();
      setTimeout(() => {
        if (!isConnectedRef.current) setShowRetry(true);
      }, 4000);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!showRetry) return null;

  return (
    <div className="fixed inset-x-4 bottom-24 z-[60] mx-auto max-w-sm rounded-2xl border border-hairline bg-black/90 p-4 text-center shadow-2xl backdrop-blur-xl sm:bottom-6">
      <p className="text-sm text-white/80">No se pudo completar la conexión con tu wallet. Probá de nuevo.</p>
      <div className="mt-3 flex justify-center gap-3">
        <button
          type="button"
          onClick={() => {
            setShowRetry(false);
            openConnectModal?.();
          }}
          className="btn-primary !px-4 !py-2 text-sm"
        >
          Reintentar
        </button>
        <button type="button" onClick={() => setShowRetry(false)} className="btn-secondary !px-4 !py-2 text-sm">
          Cerrar
        </button>
      </div>
    </div>
  );
}
