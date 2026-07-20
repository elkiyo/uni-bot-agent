import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { isAddress } from "viem";
import { parseSiweMessage } from "@/lib/auth/siweMessage";
import { verifyNonce, signSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session";
import { isAdminWallet } from "@/lib/auth/isAdminWallet";
import { getChain, deployedChains } from "@/lib/chains";
import { getChainRuntime } from "@/lib/keeper/wallet";

const MESSAGE_TTL_MS = 10 * 60 * 1000;

/**
 * Verifies a signed SIWE (EIP-4361) message and, on success, issues a session
 * cookie. This is the server-verified-identity step the referral system
 * needs (see lib/referrals — `referred` in /api/referral/register is read
 * from THIS session, never from a request body).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const message = body?.message;
  const signature = body?.signature;
  if (typeof message !== "string" || typeof signature !== "string") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const parsed = parseSiweMessage(message);
  if (!parsed || !isAddress(parsed.address)) {
    return NextResponse.json({ error: "invalid_message" }, { status: 400 });
  }
  if (!verifyNonce(parsed.nonce)) {
    return NextResponse.json({ error: "invalid_or_expired_nonce" }, { status: 401 });
  }

  const expectedHost = (await headers()).get("host");
  if (!expectedHost || parsed.domain !== expectedHost) {
    return NextResponse.json({ error: "domain_mismatch" }, { status: 401 });
  }

  const issuedAtMs = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > MESSAGE_TTL_MS) {
    return NextResponse.json({ error: "message_expired" }, { status: 401 });
  }

  const chain = deployedChains().find((c) => c.id === parsed.chainId) ?? getChain(parsed.chainId);
  let valid = false;
  try {
    valid = await getChainRuntime(chain).publicClient.verifyMessage({
      address: parsed.address,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });

  const wallet = parsed.address.toLowerCase() as `0x${string}`;
  const isAdmin = await isAdminWallet(wallet);
  const token = await signSession({ wallet, isAdmin });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return NextResponse.json({ ok: true, wallet, isAdmin });
}
