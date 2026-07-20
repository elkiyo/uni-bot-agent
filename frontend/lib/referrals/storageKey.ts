// Shared between app/components/ReferralCapture.tsx (writes it, no wallet
// required) and lib/auth/AuthSessionProvider.tsx (reads+clears it once a SIWE
// session exists) — see Promtp_sis_referrers/promt_sis_ref.md §2, Pasos 1-2.
export const REFERRAL_STORAGE_KEY = "referrer_pendiente";
