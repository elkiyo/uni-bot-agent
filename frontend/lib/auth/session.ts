import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "uniagent_session";

// A SIWE message is only good for this long after `Issued At` — see
// verifyNonce below and app/api/auth/verify/route.ts.
const NONCE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_SECONDS;

function secretBytes(): Uint8Array {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s) throw new Error("AUTH_JWT_SECRET not set — see frontend/.env.local.example");
  return new TextEncoder().encode(s);
}

function hmac(input: string): string {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s) throw new Error("AUTH_JWT_SECRET not set — see frontend/.env.local.example");
  return createHmac("sha256", s).update(input).digest("hex");
}

/**
 * Self-verifying nonce (timestamp + HMAC) instead of a server-stored one:
 * Vercel serverless functions don't reliably share memory between the GET
 * /api/auth/nonce call and the later POST /api/auth/verify call (could be
 * two different lambda instances), and a DB round-trip for a value this
 * short-lived isn't worth the extra table. Not single-use — a replayed nonce
 * within the 10-minute window just re-proves the same key ownership, which
 * isn't a real risk here since it only ever results in re-issuing a session
 * for the wallet that already signed.
 */
export function createNonce(): string {
  const ts = Date.now().toString();
  const sig = hmac(`siwe-nonce:${ts}`);
  return Buffer.from(`${ts}.${sig}`).toString("base64url");
}

export function verifyNonce(nonce: string): boolean {
  try {
    const [ts, sig] = Buffer.from(nonce, "base64url").toString().split(".");
    if (!ts || !sig) return false;
    const expected = Buffer.from(hmac(`siwe-nonce:${ts}`));
    const received = Buffer.from(sig);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
    return Date.now() - Number(ts) < NONCE_TTL_MS;
  } catch {
    return false;
  }
}

export interface SessionClaims {
  wallet: `0x${string}`;
  isAdmin: boolean;
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ wallet: claims.wallet, isAdmin: claims.isAdmin })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretBytes());
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretBytes());
    if (typeof payload.wallet !== "string" || typeof payload.isAdmin !== "boolean") return null;
    return { wallet: payload.wallet as `0x${string}`, isAdmin: payload.isAdmin };
  } catch {
    return null;
  }
}
