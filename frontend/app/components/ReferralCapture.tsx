"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { isAddress } from "viem";
import { REFERRAL_STORAGE_KEY } from "@/lib/referrals/storageKey";

// Paso 1 del sistema de referidos: captura ?ref=0x... en localStorage sin
// exigir wallet conectada — el registro real ocurre recién tras el login SIWE
// (ver lib/auth/AuthSessionProvider.tsx). Renders nothing.
function ReferralCaptureInner() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const ref = searchParams.get("ref");
    if (ref && isAddress(ref) && !window.localStorage.getItem(REFERRAL_STORAGE_KEY)) {
      window.localStorage.setItem(REFERRAL_STORAGE_KEY, ref.toLowerCase());
    }
  }, [searchParams]);

  return null;
}

// useSearchParams() requires a Suspense boundary in the App Router, or the
// whole route it's used in opts out of static rendering — this component is
// mounted once at the root (layout.tsx) precisely to avoid that on every page.
export function ReferralCapture() {
  return (
    <Suspense fallback={null}>
      <ReferralCaptureInner />
    </Suspense>
  );
}
