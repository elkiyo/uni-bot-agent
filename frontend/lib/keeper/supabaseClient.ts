import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | undefined;

/**
 * Server-only Supabase client, authenticated with the service_role key so it
 * bypasses RLS (see schema.sql — the keeper_* tables have RLS enabled with no
 * policies, so only this key can touch them). Never import this from
 * client-facing code; the service_role key must never reach the browser.
 */
export function supabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — see frontend/.env.local.example");
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
