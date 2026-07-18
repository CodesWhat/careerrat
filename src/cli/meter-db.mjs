#!/usr/bin/env node
// meter-db.mjs — optional Supabase-REST sink for the managed-AI proxy's usage
// ledger (src/cli/ai-proxy.mjs), so a proxy deployment can meter usage
// without a persistent disk to hold workspace/usage-events.jsonl. Talks to
// PostgREST (Supabase's auto-generated REST API) with the global `fetch`
// only — no new npm dependency.
//
//   PRIVACY INVARIANT — same one ai-proxy.mjs's header and usage-log.mjs
//   both hold: every row this module sends or reads is metadata-only
//   (counts, a model id, skill/action labels, the 12-hex reportingUserId
//   hash, an operator label). It never sees, and could never send, a
//   request/response body or a raw token — canonicalizeUsageEvent() in
//   usage-log.mjs is what enforces that shape upstream; this module only
//   relays the already-canonicalized event and renames two fields to valid
//   Postgres column names (see scripts/meter-db-schema.sql).
//
// createDbMeter() is a pure factory (no top-level state) so tests can inject
// a mock fetchImpl — or point `url` at a real mock node:http PostgREST
// stand-in, the same pattern tests/ai-proxy.test.mjs uses for its mock
// upstream — and assert on exactly what was sent.

// Canonical usage-event field -> Postgres column. `user`/`userLabel` are the
// only two renamed: `user` is a reserved-ish identifier in Postgres/
// PostgREST, so the column is `user_id`; every other canonical field is
// already snake_case and passes through unchanged.
const COLUMN_BY_FIELD = {
  user: "user_id",
  userLabel: "user_label",
};

function toRow(event) {
  const row = {};
  for (const [key, value] of Object.entries(event)) {
    row[COLUMN_BY_FIELD[key] || key] = value;
  }
  return row;
}

const PAGE_SIZE = 1000;

export function createDbMeter({ url, serviceKey, table = "usage_events", fetchImpl = fetch } = {}) {
  const base = String(url || "").replace(/\/+$/, "");
  const key = String(serviceKey || "");
  if (!base) throw new Error("meter-db: url is required");
  if (!key) throw new Error("meter-db: serviceKey is required");

  const restUrl = `${base}/rest/v1/${table}`;

  function headers(extra = {}) {
    return {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...extra,
    };
  }

  // Fire-and-forget from the caller's perspective: never throws, always
  // resolves — a failed write comes back as { ok:false, error } so
  // ai-proxy.mjs can fall back to the local JSONL ledger without wrapping
  // this in a request-path try/catch. `error` is always a short,
  // metadata-only string (an HTTP status code or the fetch error's own
  // .message) — never response body text, which could in principle echo
  // back the row we just tried to insert.
  async function append(event) {
    try {
      const res = await fetchImpl(restUrl, {
        method: "POST",
        headers: headers({ prefer: "return=minimal" }),
        body: JSON.stringify(toRow(event)),
      });
      if (!res.ok) {
        // Drain the body so undici's connection pool doesn't stall on it,
        // but never surface it — see the privacy invariant above.
        await res.text().catch(() => {});
        return { ok: false, error: `http_${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Per-user cost sums for startup cap hydration (see ai-proxy.mjs). Tries
  // PostgREST's aggregate-function syntax first — `select=user_id,cost_usd.sum()`,
  // grouped implicitly by every non-aggregate selected column — which
  // requires aggregates to be enabled on the Supabase project. If that
  // fails for any reason (disabled, unsupported PostgREST version, a
  // network error), falls back to paging the raw rows and summing
  // client-side, so hydration degrades gracefully instead of leaving every
  // cap at 0. Returns a Map of user_id -> cost_usd.
  async function hydrateUserCosts() {
    const viaAggregate = await hydrateViaAggregate();
    if (viaAggregate) return viaAggregate;
    return hydrateViaPaging();
  }

  async function hydrateViaAggregate() {
    try {
      const qs = new URLSearchParams({
        select: "user_id,cost_usd.sum()",
        user_id: "not.is.null",
      });
      const res = await fetchImpl(`${restUrl}?${qs.toString()}`, { headers: headers() });
      if (!res.ok) {
        await res.text().catch(() => {});
        return null;
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) return null;
      const out = new Map();
      for (const row of rows) {
        if (!row || !row.user_id) continue;
        const sum = Number(row.sum);
        out.set(row.user_id, Number.isFinite(sum) ? sum : 0);
      }
      return out;
    } catch {
      return null;
    }
  }

  async function hydrateViaPaging() {
    const out = new Map();
    let offset = 0;
    for (;;) {
      const qs = new URLSearchParams({
        select: "user_id,cost_usd",
        user_id: "not.is.null",
        order: "user_id.asc",
      });
      let res;
      try {
        res = await fetchImpl(`${restUrl}?${qs.toString()}`, {
          headers: headers({ range: `${offset}-${offset + PAGE_SIZE - 1}` }),
        });
      } catch {
        // Total failure of the fallback path too — leaving hydration at
        // whatever partial sum was already gathered is the right call here;
        // surviving further is the local-JSONL fallback's job, not this
        // module's.
        break;
      }
      if (!res.ok) {
        await res.text().catch(() => {});
        break;
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        if (!row || !row.user_id) continue;
        const cost = Number(row.cost_usd);
        if (!Number.isFinite(cost)) continue;
        out.set(row.user_id, (out.get(row.user_id) || 0) + cost);
      }
      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return out;
  }

  // Single-user cost sum for a per-request serverless cap check (see
  // apps/proxy-vercel and proxy-core.mjs's meterDbWrite doc) — there's no
  // long-lived accumulator across invocations, so the cap check re-derives
  // "how much has this user spent" from the DB on every request instead of
  // once at boot. Same aggregate-first/paged-fallback shape as
  // hydrateUserCosts(), just filtered to one user_id via `eq.` instead of
  // grouped over all of them. Returns a plain number (0 when the user has no
  // rows yet or on total failure — see the caller's own eventually-
  // consistent-cap doc; never throws).
  async function userCost(userId) {
    const id = String(userId || "").trim();
    if (!id) return 0;
    const viaAggregate = await userCostViaAggregate(id);
    if (viaAggregate !== null) return viaAggregate;
    return userCostViaPaging(id);
  }

  async function userCostViaAggregate(userId) {
    try {
      const qs = new URLSearchParams({
        select: "user_id,cost_usd.sum()",
        user_id: `eq.${userId}`,
      });
      const res = await fetchImpl(`${restUrl}?${qs.toString()}`, { headers: headers() });
      if (!res.ok) {
        await res.text().catch(() => {});
        return null;
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) return null;
      const sum = Number(rows[0]?.sum);
      return Number.isFinite(sum) ? sum : 0;
    } catch {
      return null;
    }
  }

  async function userCostViaPaging(userId) {
    let total = 0;
    let offset = 0;
    for (;;) {
      const qs = new URLSearchParams({
        select: "cost_usd",
        user_id: `eq.${userId}`,
      });
      let res;
      try {
        res = await fetchImpl(`${restUrl}?${qs.toString()}`, {
          headers: headers({ range: `${offset}-${offset + PAGE_SIZE - 1}` }),
        });
      } catch {
        break; // partial sum stands — see hydrateViaPaging's own doc
      }
      if (!res.ok) {
        await res.text().catch(() => {});
        break;
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const cost = Number(row?.cost_usd);
        if (Number.isFinite(cost)) total += cost;
      }
      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return total;
  }

  return { append, hydrateUserCosts, userCost };
}

// ---------------------------------------------------------------------------
// createTokenStore() — the Supabase sink for the beta Clerk-session exchange
// (apps/proxy-vercel/api/auth/exchange.mjs) and the minted-token auth path
// in proxy-core.mjs's authenticate(). Same PostgREST conventions as
// createDbMeter() above (service-role headers, metadata-only error shapes,
// response body text is drained but never surfaced), talking to a separate
// table (default "proxy_tokens" — scripts/meter-db-schema.sql) keyed on
// clerk_user_id.
//
//   PRIVACY INVARIANT — same one this file's header holds: every row here is
//   metadata-only. token_hash is a SHA-256 digest (proxy-core.mjs's
//   hashProxyToken()), never the raw minted token; nothing here ever sees or
//   sends a Clerk JWT.
// ---------------------------------------------------------------------------

export function createTokenStore({
  url,
  serviceKey,
  table = "proxy_tokens",
  fetchImpl = fetch,
} = {}) {
  const base = String(url || "").replace(/\/+$/, "");
  const key = String(serviceKey || "");
  if (!base) throw new Error("meter-db: url is required");
  if (!key) throw new Error("meter-db: serviceKey is required");

  const restUrl = `${base}/rest/v1/${table}`;

  function headers(extra = {}) {
    return {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...extra,
    };
  }

  // Looked up on every request that presents a token matching
  // looksLikeMintedToken() (proxy-core.mjs's authenticate()) — a miss or a
  // network/HTTP failure both resolve to null, which authenticate() treats
  // as a rejection (fail closed, never throws into the request path).
  async function lookupByHash(tokenHash) {
    const hash = String(tokenHash || "").trim();
    if (!hash) return null;
    try {
      const qs = new URLSearchParams({
        select: "clerk_user_id,label,revoked_at",
        token_hash: `eq.${hash}`,
        limit: "1",
      });
      const res = await fetchImpl(`${restUrl}?${qs.toString()}`, { headers: headers() });
      if (!res.ok) {
        await res.text().catch(() => {});
        return null;
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0];
      return {
        clerkUserId: row.clerk_user_id ?? null,
        label: row.label ?? null,
        revokedAt: row.revoked_at ?? null,
      };
    } catch {
      return null;
    }
  }

  // Upsert-by-clerk_user_id (the table's primary key) — a reissue for a
  // Clerk user who already has a row overwrites its token_hash/label,
  // refreshes last_issued_at, and clears any prior revoked_at. Mirrors
  // append()'s own error-shape contract: never throws, `error` is always a
  // short metadata-only string.
  async function upsertForUser({ clerkUserId, tokenHash, label }) {
    const clerkId = String(clerkUserId || "").trim();
    const hash = String(tokenHash || "").trim();
    if (!clerkId || !hash) return { ok: false, error: "missing_fields" };
    const nowIso = new Date().toISOString();
    try {
      const qs = new URLSearchParams({ on_conflict: "clerk_user_id" });
      const res = await fetchImpl(`${restUrl}?${qs.toString()}`, {
        method: "POST",
        headers: headers({ prefer: "resolution=merge-duplicates,return=representation" }),
        body: JSON.stringify({
          clerk_user_id: clerkId,
          token_hash: hash,
          label: label || null,
          last_issued_at: nowIso,
          revoked_at: null,
        }),
      });
      if (!res.ok) {
        await res.text().catch(() => {});
        return { ok: false, error: `http_${res.status}` };
      }
      const rows = await res.json().catch(() => null);
      const lastIssuedAt =
        Array.isArray(rows) && rows[0]?.last_issued_at ? rows[0].last_issued_at : nowIso;
      return { ok: true, lastIssuedAt };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // For the exchange endpoint's reissue cooldown — a miss (never issued
  // before) resolves to null, same fail-open-to-"no cooldown" shape as a
  // brand-new tester's first exchange.
  async function getIssueState(clerkUserId) {
    const clerkId = String(clerkUserId || "").trim();
    if (!clerkId) return null;
    try {
      const qs = new URLSearchParams({
        select: "last_issued_at",
        clerk_user_id: `eq.${clerkId}`,
        limit: "1",
      });
      const res = await fetchImpl(`${restUrl}?${qs.toString()}`, { headers: headers() });
      if (!res.ok) {
        await res.text().catch(() => {});
        return null;
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return { lastIssuedAt: rows[0]?.last_issued_at ?? null };
    } catch {
      return null;
    }
  }

  return { lookupByHash, upsertForUser, getIssueState };
}
