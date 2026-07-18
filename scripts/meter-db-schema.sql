-- scripts/meter-db-schema.sql
--
-- Optional Supabase sink for the managed-AI proxy's usage ledger
-- (src/cli/ai-proxy.mjs + src/cli/meter-db.mjs), used in place of the local
-- workspace/usage-events.jsonl file when a proxy deployment has no
-- persistent disk. This file is NOT applied by app code at runtime — it is
-- applied to the Supabase project by hand (SQL editor, or `supabase db
-- push` if this repo grows a migrations dir) at deploy time.
--
--   PRIVACY INVARIANT — every column here is metadata-only: counts, a model
--   id, skill/action labels, a 12-hex user hash, an operator label. Never a
--   request/response body, never a raw token. See src/cli/ai-proxy.mjs's
--   header comment and src/core/ai/usage-log.mjs's canonicalizeUsageEvent(),
--   which is the single source of truth this schema mirrors field-for-field
--   (snake_case; `user` -> `user_id`, `userLabel` -> `user_label` — `user`
--   is a reserved-ish identifier in Postgres/PostgREST, avoided here on
--   purpose; src/cli/meter-db.mjs maps both directions).
--
-- Default table name is "usage_events" (ROLESTER_METER_DB_TABLE default) —
-- rename the table below to match if you point the proxy at a different one.

create table if not exists usage_events (
  id text primary key,
  at timestamptz not null,
  source text not null,
  feature text,
  skill text,
  action text,
  operation text,
  model text not null,
  upstream text,
  user_id text,
  user_label text,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  web_searches integer not null default 0,
  shared_cache_hit boolean not null default false,
  cost_usd numeric,
  priced boolean not null default false
);

-- Cap hydration (ai-proxy.mjs's hydrateUserCosts()) filters/groups by this.
create index if not exists usage_events_user_id_idx on usage_events (user_id);

-- No RLS policy is defined on purpose: the proxy only ever talks to this
-- table with the service-role key (ROLESTER_METER_DB_KEY), which bypasses
-- RLS entirely. Enabling RLS with zero policies just means an anon/
-- authenticated key (if one ever leaked) reads and writes nothing here.
alter table usage_events enable row level security;

-- ---------------------------------------------------------------------------
-- Beta-tester Clerk-session -> minted-proxy-token exchange
-- (apps/proxy-vercel/api/auth/exchange.mjs, src/cli/meter-db.mjs's
-- createTokenStore()). One row per Clerk user; a reissue overwrites
-- token_hash/label/last_issued_at and clears revoked_at rather than adding a
-- new row, so token rotation never splits a user's spend history (the
-- pseudonymous id fed to the meter is derived from clerk_user_id, not from
-- the token — see proxy-core.mjs's reportingUserIdForClerk()).
--
--   PRIVACY INVARIANT — same as usage_events above: token_hash is a SHA-256
--   digest of the minted token (proxy-core.mjs's hashProxyToken()), never
--   the raw token itself.
-- ---------------------------------------------------------------------------

create table if not exists proxy_tokens (
  clerk_user_id text primary key,
  token_hash text unique not null,
  label text,
  created_at timestamptz not null default now(),
  last_issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  expires_at timestamptz
);

-- Same posture as usage_events: RLS enabled, no policies — the exchange
-- endpoint only ever talks to this table with the service-role key.
alter table proxy_tokens enable row level security;
