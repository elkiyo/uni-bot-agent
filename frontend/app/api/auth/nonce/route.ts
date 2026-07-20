import { NextResponse } from "next/server";
import { createNonce } from "@/lib/auth/session";

export async function GET() {
  return NextResponse.json({ nonce: createNonce() });
}
