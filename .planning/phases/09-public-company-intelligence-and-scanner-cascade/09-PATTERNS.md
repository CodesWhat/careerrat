# Phase 09 Patterns - Public Company Intelligence and Scanner Cascade

## Purpose

Map Phase 09 planned work to existing Rolester code patterns. This keeps implementation aligned with current DB, route, scanner, UI, and bounded-AI conventions.

## Pattern Map

| Planned Surface | Role | Closest Existing Analog | Pattern To Reuse |
|-----------------|------|-------------------------|------------------|
| `src/core/db/migrations/009-public-intel.mjs` | SQLite schema | `src/core/db/migrations/006-company-discovery-cache.mjs`, `007-sourcing-runs.mjs`, `008-deep-ingest.mjs` | JSON payload tables with generated columns, explicit indexes, sequential migration ID, no reordering |
| `src/core/db/verbs/public-intel.mjs` | DB verbs | `src/core/db/verbs/company-discovery.mjs`, `source-config.mjs` | Synchronous transactions, clone JSON payloads, return `{ ok, ... }`, enforce version conflicts in verbs |
| `src/core/discovery/public-intel-scrub.mjs` | Privacy validator | `src/core/profile/comp-guard.mjs`, `src/core/profile/schema-validator.mjs`, `tests/bounded-ai.test.mjs` | Pure validation helpers; fail closed; no side effects |
| `src/core/discovery/public-page-extractor.mjs` | Deterministic page extraction | `src/core/discovery/company-board-resolver.mjs` | Safe URL checks, timeout fetch, redirect handling, link extraction, provenance records |
| `src/core/discovery/scanner-cascade.mjs` | Cascade orchestration | `company-board-resolver.mjs`, `src/core/scoring/sourced-scanner.mjs` | Deterministic supported ATS first, structured result objects, injected `fetchImpl` and clock |
| `src/core/discovery/public-scanner-ai.mjs` | Last-resort AI extraction | `src/core/ai/bounded-ai.mjs`, `src/core/ai/structured-oneshot.mjs` | `runBoundedAI()` with labels/schema/manual fallback; one retry; no raw prompt/model leakage |
| `src/cli/discovery-route.mjs` route extensions | Local APIs | existing company proposal routes in same file | `readJsonBodyCapped`, `sendJson`, injected dependencies, no hidden chat/skill runtime handoff |
| `src/cli/onboard-route.mjs` preference route | Onboarding API | candidate config POST routes and AI key route | small capped JSON route; DB-backed write/read; stable error envelopes |
| `src/core/onboarding/onboard-page.mjs` UI | Byte-static UI | existing eight-step onboarding page | inline CSS/script hooks, no template literals inside script, tests parse client script |
| Discovery review UI | Byte-static/local app panel | `src/core/onboarding/search-page.mjs`, discovery route state | DOM hooks, compact rows, local fetch calls, no marketing page |
| Public-intel tests | Verification | `tests/company-discovery-cache-db.test.mjs`, `tests/company-discovery-regression.test.mjs`, `tests/discovery-route.test.mjs`, `tests/bounded-ai.test.mjs` | temp repo setup, fake `fetchImpl`, fake AI seams, route invocation helpers |

## Concrete Existing Excerpts

### SQLite Migration Shape

Use the JSON + generated-column table style from `src/core/db/migrations/007-sourcing-runs.mjs`:

```sql
CREATE TABLE sourcing_runs (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  purpose TEXT GENERATED ALWAYS AS (...) STORED,
  status TEXT GENERATED ALWAYS AS (...) STORED,
  updated_at TEXT GENERATED ALWAYS AS (...) STORED
) WITHOUT ROWID;
CREATE INDEX idx_sourcing_runs_latest_purpose
  ON sourcing_runs(purpose, updated_at DESC, started_at DESC);
```

Phase 09 should use the same pattern for `public_company_intel`, `public_board_intel`, `public_careers_pages`, `public_intel_review_items`, and preference rows.

### DB Verb Shape

Reuse `companyProposalBatchPatchState()` style for versioned review decisions:

```js
return withTransaction(db, () => {
  const current = readBatchById(db, batchId);
  if (currentVersion !== Number(expectedVersion)) throw makeError(..., "CONFLICT");
  const next = { ...clone(current), ...clone(patch), version: currentVersion + 1 };
  db.prepare(`UPDATE ... SET data = ?, updated_at = ? WHERE id = ?`).run(...);
  return { ok: true, batch: readBatchById(db, batchId) };
});
```

Review decisions should follow this conflict pattern.

### Resolver And Public Page Fetch

Reuse `company-board-resolver.mjs` behavior:

- `assertSafeUrl()` rejects non-HTTP, localhost/private, and DNS results resolving to private/local addresses.
- `fetchWithTimeout()` uses `AbortController`.
- `redirectTarget()` follows redirects under a cap.
- `extractLinks()` resolves links relative to the base URL.
- `provenance(source, url, observedAt, extra)` creates auditable metadata.

Phase 09 should extend extraction depth without weakening those safety checks.

### Route Mounting

`mountDiscoveryRoutes()` already accepts dependency injection:

```js
export function mountDiscoveryRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  chatRuntime,
  fetchImpl = fetch,
  resolveCompanyBoard,
  scanCompaniesImpl,
  gateProposal,
  seedCall,
  now,
}) { ... }
```

Add public-intel dependencies in this style so tests can assert no chat/runtime fallback.

### Bounded AI

Phase 09 AI fallback should match `runBoundedAI()` tests:

```js
await runBoundedAI({
  labels: {
    skill: "discover-companies",
    action: "scanner-cascade",
    operation: "public-careers-extract",
  },
  schema,
  manual,
  structuredMode: "native-preferred",
  maxRetries: 1,
  messages,
  root,
});
```

Do not expose raw prompts, raw model text, page body secrets, or private fields in envelopes.

### UI Hooks

`onboard-page.mjs` is a byte-static HTML string with inline CSS and script. Tests use `data-hook` and `new Function()` checks. New sharing toggle UI should:

- add stable `data-hook` attributes
- avoid backticks/template literals inside the inline script
- keep copy in visible DOM so tests can assert it
- use existing `.step`, `.field`, `.actions`, `.result`, `.errors`, and button patterns unless UI-SPEC says otherwise

## Data Flow Constraints

1. Scanner/network/model work happens outside DB transactions.
2. DB verbs persist normalized, scrubbed payloads only.
3. Public sync preview reads only public-intel verbs/tables.
4. Candidate source config writes remain in `source-config.mjs` and only for validated supported ATS approvals.
5. Bounded AI output is never final authority.
6. Review rows exist only for ambiguity/conflict, not clean no-results.
7. Generated tracker/dashboard state remains unrelated; these are source/discovery setup surfaces.

## Test Patterns

Use:

- temp repo setup from `tests/company-discovery-cache-db.test.mjs`
- route invocation helper from `tests/discovery-route.test.mjs`
- privacy leak assertions from `tests/company-discovery-regression.test.mjs`
- fake bounded-AI call counters from `tests/bounded-ai.test.mjs`

## PATTERNS COMPLETE
