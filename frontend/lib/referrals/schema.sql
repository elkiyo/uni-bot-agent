-- Run once in the Supabase project's SQL Editor, same as lib/keeper/schema.sql.
--
-- RLS is enabled with NO policies on both tables, same pattern as the
-- keeper_* tables: only a client authenticated with the service_role key
-- (server-only, see lib/keeper/supabaseClient.ts, reused as-is here) can
-- read/write these. This project never uses the anon key client-side, so
-- there is no policy to write — every read/write goes through an API route
-- that enforces access control in code (see app/api/referral/*,
-- app/api/admin/referral-overview, and lib/auth/getSession.ts).

-- Referrer -> referred relationship. Each referred wallet can have at most
-- ONE referrer, for life (unique index on lower(referred)).
create table if not exists referrals (
  id bigint generated always as identity primary key,
  referrer text not null,
  referred text not null,
  created_at timestamptz not null default now(),
  -- Filled in when the referred wallet's first real Deposited event is
  -- observed on-chain (see lib/referrals/volume.ts) — either via the lazy
  -- activation in GET /api/referral/stats, or (future) an explicit trigger
  -- at deposit time. Null means "registered but not yet active".
  activated_at timestamptz
);
alter table referrals enable row level security;
create unique index if not exists referrals_referred_unique on referrals (lower(referred));
create index if not exists referrals_referrer_idx on referrals (lower(referrer));

-- Manual record of a reward payment made by the admin OUTSIDE this system
-- (normal wallet / multisig transfer) — evidence only, never computed or
-- paid automatically. See app/api/referral/liquidation/route.ts.
create table if not exists referral_liquidations (
  id bigint generated always as identity primary key,
  referrer text not null,
  amount text not null, -- string, not numeric: avoids losing display precision
  token_symbol text not null,
  chain_id integer not null,
  chain_name text not null,
  tx_hash text not null, -- hash of the manual transfer, serves as proof
  notes text,
  created_at timestamptz not null default now()
);
alter table referral_liquidations enable row level security;
create index if not exists referral_liquidations_referrer_idx on referral_liquidations (lower(referrer));
