import { NextResponse } from "next/server";

export const runtime = "nodejs";

// TEMPORARY — reveals only the Supabase project URL (not the service_role
// key) so the project owner can find which Supabase login owns it, since
// SUPABASE_URL is marked "Sensitive" in Vercel and can't be viewed again
// through the dashboard once saved. Delete this route right after use.
export async function GET() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
  const hasServiceKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  return NextResponse.json({ url, hasServiceKey });
}
