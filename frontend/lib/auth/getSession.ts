import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken, type SessionClaims } from "./session";

export async function getSession(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}
