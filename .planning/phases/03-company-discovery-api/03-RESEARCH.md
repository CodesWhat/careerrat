# Phase 03: Company Discovery API - Research

**Researched:** 2026-07-04
**Domain:** Local-first Node.js API, bounded AI seed generation, deterministic ATS resolution, SQLite-backed source configuration
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

The following constraints are copied from `.planning/phases/03-company-discovery-api/03-CONTEXT.md`; treat every D-* item as locked for planning. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]

### Locked Decisions

## Implementation Decisions

### Overall Posture
- **D-01:** Use modern local-first API best practices by default. The user explicitly delegated the remaining technical choices to current best practices rather than bespoke preference gathering.
- **D-02:** Keep the Phase 1 and Phase 2 architecture locked: AI proposes untrusted judgment-shaped data, deterministic code owns URLs, cache state, scan verification, dedupe, confirmation, and writes.
- **D-03:** `POST /api/skill/run` remains a fallback or user-led handoff path, not the default app runtime for this company discovery flow.

### API Surface
- **D-04:** Add a local resource-oriented API under the existing `/api/discovery` surface instead of creating an unrelated service namespace.
- **D-05:** Prefer static, exact-match route paths consistent with the current app server router. A good target shape is:
  - `POST /api/discovery/company-proposals` - create a proposal batch from AI seeds, pasted/manual seeds, cache, resolver, scanner, and gate inputs.
  - `GET /api/discovery/company-proposals` - read the latest pending or cached proposal batch if persisted.
  - `POST /api/discovery/company-proposal-decisions` - apply confirmation decisions such as approve supported ATS, reject, suppress, refresh, or escalate.
- **D-06:** Keep HTTP route handlers thin. Route modules parse/cap JSON bodies, call shared core modules/DB verbs, and return stable envelopes; discovery logic belongs under `src/core/discovery/` or adjacent core modules, not inside route handlers.
- **D-07:** Use explicit status codes and stable JSON envelopes: `200` for successful proposal generation/decision responses, `400` for malformed requests, `409` for state conflicts or unavailable DB state, `422` for schema/gate validation failures, `501` only when no AI route is available and no manual seed input was provided, and `502` for provider/proxy/runtime failures.

### AI Seed Generation
- **D-08:** The bounded AI seed call should use `runBoundedAI()` in native-preferred mode where available, with fallback structured parsing retained by the helper.
- **D-09:** Use strict labels for cost telemetry: `skill: "discover-companies"`, `action: "seed-generate"`, and an operation such as `"company-seeds"`.
- **D-10:** The final Phase 3 seed schema should use the Phase 1 contract name `companySeedSchema` and a top-level `companies[]` collection. Each item should include `name`, optional `domain_hint`, `why`, `role_family_hint`, `confidence`, and `source_hint`.
- **D-11:** Model output must not include trusted final `careers_url`, `job_board_url`, `api_url`, or write approval. Any URL-like hint remains untrusted until the deterministic resolver validates scheme, host, redirects, provider identity, provenance, and scan results.
- **D-12:** Bound the seed request for cost and response quality. Default to a moderate batch size and enforce a hard max; a planner may choose exact numbers, but the API should not accept unbounded "as many as possible" generation.
- **D-13:** If no AI route is configured, the proposal API should still support manual/pasted company seeds. Without AI and without manual seeds, return the shared no-AI/manual fallback envelope instead of silently starting a full skill session.

### Resolver Cache
- **D-14:** Implement `companyBoardResolutionCache` as durable DB-owned state, preferably a dedicated DB table plus verbs rather than stuffing independent resolution rows into generated tracker files or `sourced-scan`.
- **D-15:** Cache records should preserve at least the Phase 1 fields: company name, company domain, careers URL, job board URL, ATS provider, API URL, confidence, source provenance, first resolved time, last verified time, last scan result, failure count, and next refresh reason.
- **D-16:** Reuse the cache on future proposal/sweep runs. Re-resolve only on explicit refresh, stale TTL, 404/403, redirect/provider change, repeated zero-job scans, failed extraction, or other recorded refresh reason.
- **D-17:** Supported ATS promotion and unsupported/custom public-page caching remain separate. Supported ATS entries may be promoted to `sourced-scan` after confirmation; unsupported pages are cache/provenance records for later extraction work.

### Resolver and Scanner Pipeline
- **D-18:** The cheapest-first lane order from Phase 1 stays active: existing DB/source config, cached company board resolution, direct ATS scanner/local scraper, free or cheap job API, targeted crawler/extractor, AI web search/extract, then full skill runtime.
- **D-19:** Phase 3 should prioritize the supported ATS path for runtime writes because existing scanner and `companyAtsUpsert()` support Ashby, Greenhouse, Lever, Workable, and SmartRecruiters today.
- **D-20:** Deterministic resolution should use safe public HTTP fetches, redirects, provider URL inference, known provider host patterns, and homepage/careers link discovery before invoking search/crawler/AI-search lanes.
- **D-21:** Public unsupported career pages may be cached with provenance, but this phase should not pretend they are scannable ATS boards unless the planner explicitly builds and verifies a generic extractor path.
- **D-22:** When the pipeline fetches jobs to prove relevance, preserve reachable JD bodies locally before presenting actionable proposals. If the user has not confirmed the company yet, keep captured jobs attached to the proposal/cache; promote sourced rows only after confirmation.

### Proposal Gate and Confirmation
- **D-23:** Confirm-first remains the default. No proposed company is written to tracked source config unless the user explicitly approves it, except for a future explicit high-confidence auto-add mode that is not the default.
- **D-24:** Hard reject before proposal when the company is already tracked, already applied/sourced enough to be in play, excluded, capped, unreachable, unsupported without cache value, or has no current role signal.
- **D-25:** A high-confidence proposal requires a validated supported ATS board, at least one current role matching target role families or keep signals, clean dedupe/exclusion checks, and acceptable JD capture status.
- **D-26:** Borderline proposals can be returned to the UI/API for user review, but they must include why they are borderline and must not auto-write.
- **D-27:** Proposal records should include company name, why it fits, role family or role seen, careers URL, job board URL, provider or unsupported/custom classification, confidence tier, provenance, scan/extraction summary, JD capture status, and proposed action.

### Write Path
- **D-28:** Approved supported ATS promotions must write through the existing source-config/companies path: `companyAtsUpsert()` and the `careerrat companies` mental model.
- **D-29:** DB mode is canonical for the app route. Legacy config compatibility can remain in existing CLI paths, but the new app API should not create a second hand-written legacy state path unless the planner finds an existing helper that makes it low risk.
- **D-30:** Generated dashboard/tracker files are never direct write targets for this phase. DB/source verbs export compatibility state where needed.
- **D-31:** If approved proposals include captured current jobs, persist them through existing sourced persistence and `sourcedUpsertBatch()` after confirmation, preserving JD artifacts under `workspace/jobs/`.

### the agent's Discretion
The user delegated technical choices to modern best practices. The planner may choose exact module names, endpoint names, DB schema details, cache indexes, TTL values, batch sizes, and proposal IDs, provided the plan preserves the decisions above, the existing write contracts, bounded-AI envelope behavior, and route-thin/core-owned architecture.

### Deferred Ideas (OUT OF SCOPE)

## Deferred Ideas

- A full proposal confirmation UI belongs to Phase 4 runtime routing or a dedicated UI phase unless a minimal existing surface hook is needed for API verification.
- Browser-authenticated LinkedIn, Wellfound, webmail, authenticated ATS portals, captchas, 2FA, and session-browser flows remain v2 or full-skill fallback.
- Generic unsupported public-page extraction can build on the cache later; Phase 3 should not dilute supported ATS promotion by writing unsupported pages to `sourced-scan`.
- Paid provider commitments, crawler vendor selection, and broad job API bakeoff remain measured follow-up work unless the planner includes a tiny stub/interface for future lanes.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DISC-01 | Company seed generation returns schema-validated JSON using candidate context and dedup inputs. | Use `runBoundedAI()` with native-preferred structured output, strict labels, `companySeedSchema`, body caps, candidate/dedup context, and manual-seed fallback. [VERIFIED: src/core/ai/bounded-ai.mjs; VERIFIED: .planning/REQUIREMENTS.md] |
| DISC-02 | Deterministic code resolves candidate companies to supported ATS URLs and rejects unsupported boards. | Build a deterministic resolver/cache in `src/core/discovery/`; validate scheme, host, redirects, provider identity, and supported provider inference before promotion. [VERIFIED: src/core/scoring/sourced-scanner.mjs; VERIFIED: src/core/db/verbs/source-config.mjs] |
| DISC-03 | Existing ATS provider scanners verify current relevant roles before a company is proposed. | Reuse `scanCompanies()`/provider fetchers and role scoring inputs; do not create a second scanner. [VERIFIED: src/core/scoring/sourced-scanner.mjs; VERIFIED: tests/sourced-scanner.test.mjs] |
| DISC-04 | Proposed companies are presented for confirmation with clear high-confidence and borderline states. | Add a proposal gate that distinguishes hard rejects, high-confidence supported ATS proposals, and borderline proposals with reasons and proposed action. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |
| DISC-05 | Confirmed companies are written through the existing source-config/companies path and exported to the dashboard. | Approval must call `companyAtsUpsert()` and, when current jobs are captured, persist rows through sourced persistence/`sourcedUpsertBatch()`. [VERIFIED: src/core/db/verbs/source-config.mjs; VERIFIED: src/core/scoring/sourced-persistence.mjs; VERIFIED: src/core/db/verbs/sourced.mjs] |
</phase_requirements>

## Summary

Phase 03 should prove the decomposed skill-to-API pattern by adding a local, resource-oriented API under the existing `/api/discovery` namespace, not by launching the full `discover-companies` skill as the primary runtime. The standard design is a thin HTTP adapter over core modules: parse/cap JSON, load candidate and dedupe context, invoke bounded AI only for untrusted seed suggestions, resolve/cached ATS boards deterministically, scan supported providers, gate proposals, and return stable JSON envelopes. [VERIFIED: src/cli/discovery-route.mjs; VERIFIED: src/cli/search-route.mjs; VERIFIED: src/core/ai/bounded-ai.mjs; CITED: https://datatracker.ietf.org/doc/html/rfc9110]

The highest-risk planning boundary is state ownership. Proposal generation may write durable resolver/proposal cache and temporary JD artifacts, but source config and sourced rows are confirmation-only writes. DB mode is canonical for app routes; generated tracker/dashboard files remain export artifacts, not write targets. [VERIFIED: AGENTS.md; VERIFIED: src/core/db/verbs/source-config.mjs; VERIFIED: src/core/scoring/sourced-persistence.mjs]

**Primary recommendation:** Implement `POST/GET /api/discovery/company-proposals` plus `POST /api/discovery/company-proposal-decisions`, backed by `src/core/discovery/*` modules and DB verbs for `companyBoardResolutionCache`/proposal state; reuse `runBoundedAI()`, `companyAtsUpsert()`, `scanCompanies()`, and sourced persistence. [VERIFIED: codebase grep]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Candidate/dedupe context assembly | API / Backend | Database / Storage | Existing app routes and DB verbs own candidate/source state; the browser should not infer dedupe or caps. [VERIFIED: src/cli/data-route.mjs; VERIFIED: src/core/db/verbs] |
| AI company seed generation | API / Backend | External AI provider | `runBoundedAI()` centralizes labels, structured output, no-AI, and provider errors; model output remains untrusted. [VERIFIED: src/core/ai/bounded-ai.mjs] |
| ATS URL resolution and cache | API / Backend | Database / Storage | Deterministic resolver logic owns URL/provenance checks; durable DB cache prevents repeated fetch/model cost. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |
| Supported ATS role verification | API / Backend | External ATS APIs | Existing scanner code already fetches Ashby, Greenhouse, Lever, Workable, and SmartRecruiters data. [VERIFIED: src/core/scoring/sourced-scanner.mjs] |
| Proposal gate and confidence tiers | API / Backend | Browser / Client | Backend owns hard reject/high/borderline logic; UI later renders the returned proposal fields. [VERIFIED: .planning/architecture/discover-companies-target-contract.md] |
| Confirmation decisions | Browser / Client | API / Backend | User approval is required before source-config writes; Phase 03 can verify this via API tests without a full UI. [VERIFIED: .agents/skills/discover-companies/SKILL.md] |
| Confirmed source writes/export | Database / Storage | API / Backend | DB/source verbs write canonical state and export compatibility files for dashboard rendering. [VERIFIED: AGENTS.md; VERIFIED: src/core/db/verbs/source-config.mjs] |

## Project Constraints (from AGENTS.md)

- Skills are operating contracts; when behavior belongs to `discover-companies`, `search-jobs`, `research-boards`, or `setup-searches`, preserve the owning skill's workflow semantics in the API. [VERIFIED: AGENTS.md; VERIFIED: .agents/skills/discover-companies/SKILL.md]
- In DB workspaces, tracker-visible mutations must go through DB verbs or `careerrat data <verb>` patterns; `workspace/tracker.json` and `workspace/activity.jsonl` are generated compatibility files. [VERIFIED: AGENTS.md]
- Supported tracked-company additions use the source-config/companies path; unsupported/custom pages must not be written as scannable `sourced-scan` tracked companies in this phase. [VERIFIED: AGENTS.md; VERIFIED: src/cli/companies.mjs]
- Every grabbed posting must capture its full job-description body locally under `workspace/jobs/` and mirror the artifact path onto the row/proposal before the source disappears. [VERIFIED: AGENTS.md; VERIFIED: src/core/scoring/sourced-persistence.mjs]
- `discover-companies` is confirm-first by default; auto-add is opt-in only and borderline proposals must remain confirmation-gated. [VERIFIED: AGENTS.md; VERIFIED: .agents/skills/discover-companies/SKILL.md]
- Browser-authenticated sources and session-browser flows remain optional/fallback work, not default Phase 03 runtime. [VERIFIED: AGENTS.md; VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
- Route/API behavior must remain domain-neutral; personal, company, region, or role-family assumptions belong in candidate/source configuration, not code. [VERIFIED: AGENTS.md; VERIFIED: tests/sourced-scanner.test.mjs]

## Standard Stack

### Core

| Library / Module | Version | Purpose | Why Standard |
|------------------|---------|---------|--------------|
| Node.js runtime | v24.18.0 | Local HTTP routes, tests, `node:sqlite` support. | Current project runtime on this machine; no extra server dependency needed. [VERIFIED: `node --version`; CITED: https://nodejs.org/api/http.html] |
| `node:http` route modules | Node v24.18.0 API | Existing app-server route style. | Node HTTP requests are stream-oriented and do not buffer full request bodies automatically, matching the existing capped-body helper pattern. [CITED: https://nodejs.org/api/http.html] |
| `node:sqlite` + SQLite | Node v24.18.0 / SQLite 3.51.0 | Durable local resolver/proposal cache and DB verbs. | Repo already uses `DatabaseSync`; SQLite supports table constraints and JSON validity checks used by existing migrations. [VERIFIED: src/core/db/connection.mjs; CITED: https://nodejs.org/api/sqlite.html; CITED: https://www.sqlite.org/lang_createtable.html; CITED: https://sqlite.org/json1.html] |
| `runBoundedAI()` | Internal | Schema-bound seed generation with labels, no-AI, 422, and 502 behavior. | Phase 02 foundation already centralizes native/fallback structured output and safe envelopes. [VERIFIED: src/core/ai/bounded-ai.mjs; VERIFIED: tests/bounded-ai.test.mjs] |
| `readJsonBodyCapped()` / `sendJson()` | Internal | Stable JSON request/response adapter for route modules. | Existing route helpers already enforce capped bodies and consistent JSON writes. [VERIFIED: src/cli/skill-run-route.mjs; VERIFIED: src/cli/search-route.mjs] |
| `companyAtsUpsert()` | Internal | Confirmed supported ATS company write path. | Existing DB verb validates provider support and writes `sourced-scan` source config. [VERIFIED: src/core/db/verbs/source-config.mjs; VERIFIED: tests/db-source-config.test.mjs] |
| `scanCompanies()` / provider fetchers | Internal | Supported ATS proof of current roles. | Existing scanner supports Ashby, Greenhouse, Lever, Workable, and SmartRecruiters. [VERIFIED: src/core/scoring/sourced-scanner.mjs] |
| `captureAndPersistOffersIfDb()` / `sourcedUpsertBatch()` | Internal | JD artifact capture and sourced-row persistence after confirmation. | Existing persistence path writes artifacts then DB-backed sourced rows. [VERIFIED: src/core/scoring/sourced-persistence.mjs; VERIFIED: src/core/db/verbs/sourced.mjs] |

### Supporting

| Library / Module | Version | Purpose | When to Use |
|------------------|---------|---------|-------------|
| `src/core/profile/schema-validator.mjs` | Internal | JSON schema validation for structured outputs and request/proposal payloads. | Use for `companySeedSchema`, proposal-decision validation, and cache payload checks. [VERIFIED: src/core/profile/schema-validator.mjs; VERIFIED: src/core/ai/structured-oneshot.mjs] |
| `src/core/db/transaction.mjs` / `runVerb()` | Internal | Atomic DB verb execution and post-transaction export. | Use for cache/proposal/confirmation verbs; keep network and model calls outside transactions. [VERIFIED: src/core/db/transaction.mjs; VERIFIED: src/core/db/verbs/shared.mjs] |
| `scripts/scan-sourced.mjs` | Internal | Existing scan orchestration reference. | Use as a reference for source config loading, scanner options, persistence, and JD capture. [VERIFIED: scripts/scan-sourced.mjs] |
| `src/cli/companies.mjs` | Internal | CLI mental model for supported ATS additions. | Keep API approval semantics aligned with `careerrat companies --add --write`. [VERIFIED: src/cli/companies.mjs] |
| `node:test` | v24.18.0 | Unit/integration tests. | Existing test suite is Node test based and already covers AI/routes/scanners/DB verbs. [VERIFIED: package.json; VERIFIED: focused test run] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Local REST-ish `/api/discovery` routes | GraphQL or a new service namespace | Reject for Phase 03; user locked local resource routes and existing exact-match router style. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |
| Core modules under `src/core/discovery/` | Business logic inside route handlers | Reject; existing route patterns are thin adapters and are easier to test with injected dependencies. [VERIFIED: src/cli/search-route.mjs; VERIFIED: src/cli/data-route.mjs] |
| Dedicated DB-owned resolver/proposal cache | Stuff cache rows into `sourced-scan` or generated tracker files | Reject; generated files are not write targets and unsupported pages must stay separate from tracked supported ATS config. [VERIFIED: AGENTS.md] |
| Reuse supported ATS scanner | New generic scraper for all public pages | Reject for MVP; supported ATS path already exists and generic unsupported extraction is deferred. [VERIFIED: src/core/scoring/sourced-scanner.mjs; VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |
| Bounded AI seed call | Full `POST /api/skill/run` skill session | Reject as default runtime; full skill remains fallback/user-led only. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |

**Installation:**
```bash
# No new external packages are required for Phase 03.
```

**Version verification:** `node --version` returned `v24.18.0`, `npm --version` returned `11.16.0`, and `sqlite3 --version` returned `3.51.0`. [VERIFIED: local command output]

## Package Legitimacy Audit

No new external packages are recommended for this phase, so the package legitimacy gate is not applicable. [VERIFIED: Standard Stack]

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| none | none | none | none | none | OK | No install |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```text
POST /api/discovery/company-proposals
  -> cap + parse request body
  -> load candidate context + dedupe inputs + existing tracked companies
  -> manual seeds? merge
  -> AI route available and seed count needed?
       -> runBoundedAI(companySeedSchema, labels)
       -> schema validation / no-AI / provider error envelope
  -> normalize seed names/domains
  -> resolver cache lookup
       -> cache hit and fresh? reuse
       -> stale/miss/refresh? deterministic resolver
            -> safe HTTP fetch + redirects + provider host inference + careers links
            -> supported ATS? classify provider + API URL
            -> unsupported? cache provenance only
  -> supported ATS candidates
       -> scanCompanies/provider fetcher
       -> role relevance filter + dedupe checks
       -> attach reachable JD bodies to proposal/cache
  -> proposal gate
       -> hard reject | high-confidence | borderline
  -> persist cache/proposal state
  -> stable JSON envelope

GET /api/discovery/company-proposals
  -> read latest pending/cached proposal batch
  -> stable JSON envelope

POST /api/discovery/company-proposal-decisions
  -> cap + parse decisions
  -> load proposal/cache records
  -> approve supported ATS?
       -> companyAtsUpsert()
       -> captured jobs? captureAndPersistOffersIfDb()/sourcedUpsertBatch()
       -> DB export/dashboard compatibility path
  -> reject/suppress/refresh/escalate?
       -> update proposal/cache state
  -> stable JSON envelope
```

### Recommended Project Structure

```text
src/
|-- cli/
|   `-- discovery-route.mjs                 # exact-match /api/discovery route adapters
|-- core/
|   |-- discovery/
|   |   |-- company-seeds.mjs               # candidate context + bounded AI/manual seed orchestration
|   |   |-- company-board-resolver.mjs      # deterministic URL/provider/cache resolution
|   |   |-- company-proposals.mjs           # seed -> resolve -> scan -> gate orchestration
|   |   |-- company-proposal-gate.mjs       # hard reject/high/borderline rules
|   |   `-- company-proposal-decisions.mjs  # approve/reject/suppress/refresh application logic
|   `-- db/
|       |-- migrations/
|       |   `-- 006-company-discovery-cache.mjs
|       `-- verbs/
|           `-- company-discovery.mjs       # cache/proposal DB verbs
tests/
|-- company-discovery-seeds.test.mjs
|-- company-board-resolver.test.mjs
|-- company-proposals-route.test.mjs
|-- company-proposal-decisions.test.mjs
`-- company-discovery-cache-db.test.mjs
```

### Pattern 1: Thin Route, Injected Core Runtime

**What:** Add exact-match route branches inside `mountDiscoveryRoutes()` and delegate all discovery behavior to core functions with injected `fetchImpl`, AI/client hooks, repo root, and environment. [VERIFIED: src/cli/discovery-route.mjs; VERIFIED: src/cli/search-route.mjs]

**When to use:** Every Phase 03 HTTP endpoint. Route code should only parse, cap, dispatch, map errors/status codes, and serialize envelopes. [VERIFIED: src/cli/data-route.mjs]

**Example:**
```javascript
// Source: existing route pattern in src/cli/search-route.mjs and src/cli/skill-run-route.mjs
const body = await readJsonBodyCapped(req, res, MAX_BODY_BYTES);
if (!body) return true;

try {
  const result = await createCompanyProposalBatch({ root, env, fetchImpl, body });
  sendJson(res, result.status ?? 200, { ok: true, data: result.data, meta: result.meta });
} catch (err) {
  sendJson(res, mapDiscoveryStatus(err), { ok: false, error: formatDiscoveryError(err) });
}
```

### Pattern 2: Schema-First Bounded AI Seeds

**What:** Use `runBoundedAI()` for seed suggestions only, with `mode: "native-preferred"`, strict labels, and a schema that contains untrusted company fields but no final URLs or write approvals. [VERIFIED: src/core/ai/bounded-ai.mjs]

**When to use:** Only when manual seeds are insufficient and an AI route is available; manual seeds keep the API useful with no configured AI. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]

**Example:**
```javascript
// Source: src/core/ai/bounded-ai.mjs pattern
const result = await runBoundedAI({
  skill: "discover-companies",
  action: "seed-generate",
  operation: "company-seeds",
  schema: companySeedSchema,
  mode: "native-preferred",
  prompt,
  root,
  env,
});

if (!result.ok && result.code === "NO_AI_ROUTE") {
  return manualSeeds.length ? { companies: manualSeeds } : noAiManualFallbackEnvelope();
}
```

### Pattern 3: DB-Owned Resolver Cache

**What:** Add a dedicated DB verb surface for company board resolution/proposal state. Match the repo's migration style: JSON payloads guarded by `json_valid(data)`, generated columns for query fields, and indexes for common lookup paths. [VERIFIED: src/core/db/migrations/001-init.mjs; CITED: https://sqlite.org/json1.html; CITED: https://www.sqlite.org/lang_createtable.html]

**When to use:** Cache hits, stale checks, provider changes, repeated zero-job scans, unsupported-page provenance, and pending proposal lookup. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]

**Example:**
```javascript
// Source: existing JSON-table migration pattern in src/core/db/migrations/001-init.mjs
db.exec(`
  CREATE TABLE IF NOT EXISTS company_board_resolutions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (json_valid(data)),
    company_key TEXT GENERATED ALWAYS AS (json_extract(data, '$.company_key')) VIRTUAL,
    provider TEXT GENERATED ALWAYS AS (json_extract(data, '$.ats_provider')) VIRTUAL,
    status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL,
    last_verified_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.last_verified_at')) VIRTUAL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_company_board_resolutions_company_key
    ON company_board_resolutions(company_key);
  CREATE INDEX IF NOT EXISTS idx_company_board_resolutions_provider
    ON company_board_resolutions(provider);
`);
```

### Pattern 4: Supported ATS Scan Before Proposal

**What:** A company is high confidence only after deterministic provider classification and a successful supported-provider scan with at least one relevant current role. [VERIFIED: src/core/scoring/sourced-scanner.mjs; VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]

**When to use:** Before returning actionable high-confidence proposals and before writing approved jobs. [VERIFIED: AGENTS.md]

**Example:**
```javascript
// Source: provider inference and scanner behavior in src/core/scoring/sourced-scanner.mjs
const provider = inferProvider({ careers_url: resolution.job_board_url });
if (!provider) {
  return markUnsupportedCacheOnly(seed, resolution);
}

const scan = await scanCompanies({
  tracked_companies: [{ name: seed.name, careers_url: resolution.job_board_url }],
  candidateContext,
  fetchImpl,
});

const matchingOffers = scan.offers.filter((offer) => offer.score?.decision !== "CUT");
```

### Pattern 5: Confirmation-Only Source Writes

**What:** Proposal decisions are the only path that writes confirmed companies to source config or sourced rows. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]

**When to use:** `approve-supported-ats` decisions after loading the proposal and checking it is still supported/not stale. [VERIFIED: src/core/db/verbs/source-config.mjs]

**Example:**
```javascript
// Source: src/core/db/verbs/source-config.mjs and src/core/scoring/sourced-persistence.mjs
const added = companyAtsUpsert({
  repoRoot,
  env,
  entry: {
    name: proposal.company.name,
    careers_url: proposal.job_board_url,
  },
});

if (proposal.capturedOffers?.length) {
  await captureAndPersistOffersIfDb({ root: repoRoot, offers: proposal.capturedOffers, env });
}
```

### Anti-Patterns to Avoid

- **Trusted model URLs:** Model output can suggest `domain_hint`, but final ATS URLs require deterministic validation and scan proof. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
- **Writing unsupported pages to `sourced-scan`:** Unsupported/custom public pages are cache/provenance records until a verified extractor exists. [VERIFIED: AGENTS.md]
- **Route-local discovery logic:** Complex resolver/gate/scan code in `discovery-route.mjs` will be hard to test and conflicts with existing route style. [VERIFIED: src/cli/search-route.mjs]
- **Direct generated-file mutation:** Do not write `workspace/tracker.json` or `workspace/activity.jsonl` from the app API. [VERIFIED: AGENTS.md]
- **Network/model work inside DB transactions:** Existing DB verb pattern runs a transaction, then exports; keep slow/external work outside the transaction. [VERIFIED: src/core/db/transaction.mjs; VERIFIED: src/core/db/verbs/shared.mjs]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Structured AI output and no-AI/provider errors | Custom OpenAI/proxy route call | `runBoundedAI()` | Existing helper owns labels, native/fallback structured output, 501/422/502, and safe envelopes. [VERIFIED: src/core/ai/bounded-ai.mjs] |
| JSON body parsing and request caps | Ad hoc `req.on("data")` body code | `readJsonBodyCapped()` | Existing helper already returns 413 on oversized bodies and 400 on invalid JSON. [VERIFIED: src/cli/skill-run-route.mjs] |
| Supported ATS provider inference | Regexes scattered in resolver/route code | `inferProvider()` | Existing inference is shared with scanner and company add validation. [VERIFIED: src/core/scoring/sourced-scanner.mjs; VERIFIED: src/core/db/verbs/source-config.mjs] |
| Current-role verification | New ATS fetcher set | `scanCompanies()` and provider fetchers | Scanner already handles supported provider APIs and offer shape. [VERIFIED: src/core/scoring/sourced-scanner.mjs] |
| Confirmed company writes | Direct DB/source config edits | `companyAtsUpsert()` | Existing verb validates supported hosts and preserves source-config behavior. [VERIFIED: tests/db-source-config.test.mjs] |
| JD artifact capture and sourced persistence | New file writer + row writer | `captureAndPersistOffersIfDb()` / `sourcedUpsertBatch()` | Existing path preserves JD bodies and writes DB-backed sourced rows. [VERIFIED: src/core/scoring/sourced-persistence.mjs] |
| DB migrations and transactions | Raw writes from route handlers | Existing migration + verb pattern | Existing DB uses `user_version`, JSON checks, transactions, and post-transaction export. [VERIFIED: src/core/db/migrations.mjs; VERIFIED: src/core/db/verbs/shared.mjs] |

**Key insight:** Phase 03 is valuable because it separates judgment from authority: AI may suggest companies, but deterministic code and DB verbs own URLs, scan proof, dedupe, confirmation, and writes. [VERIFIED: .planning/PROJECT.md; VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]

## Common Pitfalls

### Pitfall 1: Trusting Model-Generated URLs
**What goes wrong:** AI output is treated as a final `careers_url` or `job_board_url`. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
**Why it happens:** Seed generation and resolution are collapsed into one step. [VERIFIED: .planning/architecture/discover-companies-target-contract.md]
**How to avoid:** Keep seed schema limited to `name`, optional `domain_hint`, `why`, `role_family_hint`, `confidence`, and `source_hint`; deterministic resolver owns final URL fields. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
**Warning signs:** Proposal records include final URLs sourced only from model output. [VERIFIED: .planning/architecture/runtime-routing-policy.md]

### Pitfall 2: Proposing Companies Without Current Role Proof
**What goes wrong:** A company is proposed because it has a careers page, but no matching active role is found. [VERIFIED: .agents/skills/discover-companies/SKILL.md]
**Why it happens:** Resolver success is mistaken for sourcing success. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
**How to avoid:** Run supported ATS scanner proof before high-confidence proposal. [VERIFIED: src/core/scoring/sourced-scanner.mjs]
**Warning signs:** High-confidence proposals have empty `scan_summary` or no captured offers. [VERIFIED: .planning/architecture/discover-companies-target-contract.md]

### Pitfall 3: Writing Before Confirmation
**What goes wrong:** Proposal generation adds a company to `sourced-scan` or persists sourced rows before user approval. [VERIFIED: AGENTS.md]
**Why it happens:** Scan/persistence code is reused without a proposal/decision boundary. [VERIFIED: src/core/scoring/sourced-persistence.mjs]
**How to avoid:** Persist cache/proposal state during generation; source-config and sourced rows only in the decision endpoint. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
**Warning signs:** `POST /company-proposals` changes source config. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]

### Pitfall 4: Losing JD Bodies
**What goes wrong:** The scanner sees matching jobs but the JD body is not captured until later, after the posting changes or closes. [VERIFIED: AGENTS.md]
**Why it happens:** Proposal state stores only URLs. [VERIFIED: AGENTS.md]
**How to avoid:** Attach reachable body text/artifact references to proposal/cache immediately, then promote rows after confirmation. [VERIFIED: src/core/scoring/sourced-persistence.mjs]
**Warning signs:** Approved sourced rows have missing `artifacts.jd`. [VERIFIED: tests/scan-sourced.test.mjs]

### Pitfall 5: Treating Unsupported Public Pages as Supported ATS
**What goes wrong:** A generic careers page is written to tracked companies even though no scanner can verify it. [VERIFIED: AGENTS.md]
**Why it happens:** `careers_url` presence is conflated with `provider` support. [VERIFIED: src/core/scoring/sourced-scanner.mjs]
**How to avoid:** Cache unsupported pages as provenance only and return borderline/escalate states, not `approve-supported-ats` actions. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
**Warning signs:** `companyAtsUpsert()` is bypassed or custom public hosts appear in `sourced-scan`. [VERIFIED: src/core/db/verbs/source-config.mjs]

### Pitfall 6: Unsafe Resolver Fetches
**What goes wrong:** The resolver follows arbitrary user/model-supplied URLs into localhost, private networks, unsupported schemes, or excessive redirects. [ASSUMED]
**Why it happens:** URL hints are treated as trusted fetch targets. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
**How to avoid:** Accept only `http:`/`https:`, reject localhost/private IP targets after DNS/redirect checks, cap redirects and timeouts, and require supported provider identity before promotion. [ASSUMED]
**Warning signs:** Resolver tests do not include localhost/private IP/redirect cases. [ASSUMED]

### Pitfall 7: No-AI Blocks Manual Seeds
**What goes wrong:** The route returns 501 even though the user supplied manual companies. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
**Why it happens:** AI seeding is treated as mandatory. [VERIFIED: src/core/ai/bounded-ai.mjs]
**How to avoid:** Run manual seeds through resolver/scanner/gate without AI; reserve 501 for no AI route and no manual seeds. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
**Warning signs:** Tests only cover AI-enabled proposal generation. [VERIFIED: tests/bounded-ai.test.mjs]

## Code Examples

Verified patterns from official and local sources:

### Stable HTTP Status Mapping

```javascript
// Source: RFC HTTP semantics + existing route style
const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  CONFLICT: 409,
  VALIDATION_FAILED: 422,
  NO_AI_ROUTE: 501,
  PROVIDER_FAILURE: 502,
};
```

`409` is appropriate when request conflict is with current resource state, `422` when syntax/content type are acceptable but instructions cannot be processed, `501` when server functionality is unsupported, and `502` for upstream/provider gateway failure. [CITED: https://datatracker.ietf.org/doc/html/rfc9110]

### Company Seed Schema Shape

```javascript
// Source: Phase 03 CONTEXT D-10 and src/core/profile/schema-validator.mjs usage pattern
export const companySeedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["companies"],
  properties: {
    companies: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "why", "role_family_hint", "confidence", "source_hint"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          domain_hint: { type: "string", maxLength: 160 },
          why: { type: "string", minLength: 1, maxLength: 400 },
          role_family_hint: { type: "string", minLength: 1, maxLength: 120 },
          confidence: { enum: ["high", "medium", "low"] },
          source_hint: { type: "string", minLength: 1, maxLength: 180 },
        },
      },
    },
  },
};
```

The `maxItems: 12` value is the Phase 03 planner-pinned hard limit for seed and proposal batches. [VERIFIED: planner decision]

### Resolver Cache Record Shape

```javascript
// Source: Phase 03 CONTEXT D-15 plus existing JSON DB table pattern
const cacheRecord = {
  id,
  company_key,
  company_name,
  company_domain,
  careers_url,
  job_board_url,
  ats_provider,
  api_url,
  confidence,
  provenance: [{ source: "homepage-link", url, observed_at }],
  first_resolved_at,
  last_verified_at,
  last_scan_result: {
    status: "matching_roles_found",
    matching_role_count: 3,
    last_error: null,
  },
  failure_count: 0,
  next_refresh_reason: null,
  status: "supported_ats",
};
```

JSON data stored in SQLite should be checked with `json_valid(data)` when validity matters. [CITED: https://sqlite.org/json1.html]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Full `discover-companies` skill handles all discovery work | Local `/api/discovery` resource routes call bounded AI and deterministic core modules | Phase 03 planning, 2026-07-04 | Planner should create API/core tasks, not a chat-runtime task. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |
| AI or skill output can carry broad recommendations | AI output is schema-bound seed data only | Phase 02/03 decisions, 2026-07-04 | Deterministic resolver/scanner/write code owns authority. [VERIFIED: src/core/ai/bounded-ai.mjs] |
| Source config was the only durable company discovery state | Add resolver/proposal cache as separate DB-owned state | Phase 03 decision D-14, 2026-07-04 | Unsupported/cache provenance no longer pollutes `sourced-scan`. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |
| Route handlers may directly perform flow logic | Thin handlers over core modules/DB verbs | Existing app/server pattern | Tests can inject AI/fetch/DB seams and keep behavior hermetic. [VERIFIED: src/cli/search-route.mjs; VERIFIED: src/cli/data-route.mjs] |

**Deprecated/outdated:**
- GraphQL or separate service surface for this phase: replaced by local resource routes under `/api/discovery`. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
- Trusted model URLs/write approvals: replaced by untrusted seed schema plus deterministic resolution and confirmation. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
- Direct edits to generated tracker/dashboard files: replaced by DB/source verbs and exports. [VERIFIED: AGENTS.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Resolver fetches must reject localhost/private IP targets, cap redirects at 3, cap fetches at 8000ms, and validate post-redirect provider identity. | Common Pitfalls / Security Domain | Without these controls, a URL hint could become an SSRF-like local fetch risk. |
| A2 | Seed and proposal batches are capped at 12 items. | Code Examples / Open Questions (RESOLVED) | If too small, proposal recall may be low; if too large, AI cost and scan latency rise. |

## Open Questions (RESOLVED)

1. **Exact cache TTL and refresh policy**
   - What we know: Re-resolve on explicit refresh, stale TTL, 404/403, provider change, repeated zero-job scans, failed extraction, or recorded refresh reason. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
   - RESOLVED planner decision: define and test these constants in `company-board-resolver.mjs`: `RESOLUTION_CACHE_TTL_DAYS = 14`, `ZERO_JOB_REFRESH_THRESHOLD = 2`, `RESOLVER_FETCH_TIMEOUT_MS = 8000`, `RESOLVER_REDIRECT_CAP = 3`, `RESOLUTION_FAILURE_REFRESH_THRESHOLD = 2`, and `COMPANY_DISCOVERY_BATCH_MAX = 12`.
   - RESOLVED planner decision: use this refresh reason enum across resolver cache and proposal decisions: `explicit-refresh`, `stale-ttl`, `http-403`, `http-404`, `redirect-provider-change`, `provider-change`, `zero-jobs-threshold`, `failed-extraction`, `resolver-failure-threshold`, and `manual-review`.
   - RESOLVED planner decision: `refresh` decisions must call the resolver with `forceRefresh:true`, rescan supported ATS results when available, rerun the proposal gate, update cache/proposal state and version, and return refreshed proposal or rejection metadata without writing source config or sourced rows.

2. **Proposal persistence model**
   - What we know: `GET /company-proposals` should read latest pending or cached proposal batch if persisted. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
   - RESOLVED planner decision: pending proposals live in a separate `company_discovery_proposals` table keyed by `proposal_batch_id`; resolver cache rows remain reusable across batches.
   - RESOLVED planner decision: proposal records use a single camelCase API contract shared by gate and decision plans: `proposalId`, `company`, `why`, `roleFamily`, `roleSeen`, `careersUrl`, `jobBoardUrl`, `atsProvider`, `classification`, `confidenceTier`, `provenance`, `scanSummary`, `jdCapture`, `proposedAction`, `reviewReasons`, `rejectReasons`, `capturedOffers`, and `version`.

3. **Minimal API verification surface**
   - What we know: Full confirmation UI is deferred. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md]
   - RESOLVED planner decision: verify Phase 03 through `node:test` route and DB tests only; do not build a CLI/dev-only fixture or UI surface in Phase 03.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Routes, DB, tests | yes | v24.18.0 | none needed. [VERIFIED: local command output] |
| npm | Test scripts | yes | 11.16.0 | `node --test` for focused slices. [VERIFIED: local command output] |
| SQLite CLI | DB inspection/migration debugging | yes | 3.51.0 | `node:sqlite` runtime APIs. [VERIFIED: local command output] |
| `node:sqlite` | DB verbs and migrations | yes | Node v24.18.0 exposes `DatabaseSync` | none needed. [VERIFIED: local command output; CITED: https://nodejs.org/api/sqlite.html] |
| git | Optional research commit | yes | available | none needed. [VERIFIED: local command output] |
| `careerrat` binary on PATH | Manual CLI smoke commands | no | none | Use `node src/cli/*.mjs` or npm scripts from repo root. [VERIFIED: local command output] |
| Context7 CLI/MCP | Documentation lookup | no | none | Official web docs and local source reads were used. [VERIFIED: local command output] |

**Missing dependencies with no fallback:**
- none. [VERIFIED: Environment Availability]

**Missing dependencies with fallback:**
- `careerrat` CLI binary on PATH; use direct `node src/cli/*.mjs` commands or npm scripts during implementation/testing. [VERIFIED: local command output]
- Context7 CLI/MCP; official documentation URLs and codebase reads are sufficient for this phase. [VERIFIED: local command output]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node `node:test` on Node v24.18.0. [VERIFIED: package.json; VERIFIED: local command output] |
| Config file | none for core `node:test`; scripts live in `package.json`. [VERIFIED: package.json] |
| Quick run command | `node --test tests/company-discovery-seeds.test.mjs tests/company-board-resolver.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/company-discovery-cache-db.test.mjs` |
| Existing related slice | `node --test tests/bounded-ai.test.mjs tests/discovery-route.test.mjs tests/db-source-config.test.mjs tests/companies-cli.test.mjs tests/scan-sourced.test.mjs tests/search-route.test.mjs tests/sourced-scanner.test.mjs` passed 69 tests. [VERIFIED: local command output] |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| DISC-01 | AI/manual seed generation returns schema-validated `companies[]` and handles no-AI/manual fallback. | unit + route | `node --test tests/company-discovery-seeds.test.mjs tests/company-proposals-route.test.mjs` | no - Wave 0 |
| DISC-02 | Resolver validates supported ATS URLs, rejects unsupported/private/invalid targets, and uses durable cache. | unit + DB | `node --test tests/company-board-resolver.test.mjs tests/company-discovery-cache-db.test.mjs` | no - Wave 0 |
| DISC-03 | Existing ATS scanners verify current relevant roles before proposal. | integration | `node --test tests/company-proposals-route.test.mjs tests/sourced-scanner.test.mjs` | partial - scanner tests exist |
| DISC-04 | Proposal gate returns hard rejects, high-confidence, and borderline states with reasons. | unit + route | `node --test tests/company-proposals-route.test.mjs` | no - Wave 0 |
| DISC-05 | Approved decisions call source-config/companies path, persist captured jobs, and export dashboard-compatible state. | integration + DB | `node --test tests/company-proposal-decisions.test.mjs tests/db-source-config.test.mjs tests/scan-sourced.test.mjs` | partial - existing write-path tests only |

### Sampling Rate

- **Per task commit:** Run the focused new Phase 03 tests plus the directly touched existing test file. [VERIFIED: existing node:test workflow]
- **Per wave merge:** Run the existing related slice listed above plus all new `company-discovery-*` tests. [VERIFIED: local focused test run]
- **Phase gate:** Run `npm test`, then investigate or isolate any pre-existing release-safety failure before signoff. A broad probe during research hit unrelated dirty-worktree/release-safety expectations in `tests/release-safety.test.mjs`. [VERIFIED: local command output; VERIFIED: git status]

### Wave 0 Gaps

- [ ] `tests/company-discovery-seeds.test.mjs` - covers DISC-01.
- [ ] `tests/company-board-resolver.test.mjs` - covers DISC-02 and SSRF/redirect/provider classification.
- [ ] `tests/company-discovery-cache-db.test.mjs` - covers cache migration/verbs/proposal persistence.
- [ ] `tests/company-proposals-route.test.mjs` - covers DISC-01 through DISC-04 route behavior/status envelopes.
- [ ] `tests/company-proposal-decisions.test.mjs` - covers DISC-05 confirmation writes and reject/suppress/refresh decisions.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | Local-first route does not add account auth; do not introduce network-exposed auth assumptions. [VERIFIED: project architecture] |
| V3 Session Management | no | Browser-auth/session automation is deferred; Phase 03 uses local API calls and public ATS fetches. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |
| V4 Access Control | yes | Scope all DB/source reads and writes to the active repo/root; proposal decisions must validate current proposal state and return 409 on conflicts. [VERIFIED: src/core/db/connection.mjs; CITED: https://datatracker.ietf.org/doc/html/rfc9110] |
| V5 Input Validation | yes | Use capped JSON bodies, JSON schema validation, URL validation, batch max, provider allowlist, and stable 400/422 envelopes. [VERIFIED: src/cli/skill-run-route.mjs; VERIFIED: src/core/profile/schema-validator.mjs] |
| V6 Cryptography | no | No new cryptographic primitive; do not hand-roll crypto. [VERIFIED: phase scope] |
| V8 Data Protection | yes | Do not leak prompts, raw candidate data, or fetched bodies in error envelopes; persist local artifacts intentionally. [VERIFIED: src/core/ai/bounded-ai.mjs; VERIFIED: AGENTS.md] |
| V10 SSRF | yes | Resolver fetches must validate URL scheme, host, redirect target, provider identity, and reject private/local targets. [ASSUMED] |

### Known Threat Patterns for Local Discovery API

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Model output attempts to authorize writes | Elevation of Privilege | Seed schema excludes final URL and approval fields; deterministic resolver and confirmation endpoint own authority. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |
| Resolver fetches internal/private URLs | Information Disclosure | Validate URL scheme/host, resolve redirects safely, reject localhost/private IPs, cap timeout and redirects. [ASSUMED] |
| Prompt injection from fetched careers/JD content | Tampering | Treat fetched content as data only; never execute instructions from pages; validate structured outputs. [VERIFIED: src/core/ai/bounded-ai.mjs] |
| Overlarge JSON body or unbounded batch | Denial of Service | `readJsonBodyCapped()` plus seed/proposal batch hard max. [VERIFIED: src/cli/skill-run-route.mjs; VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md] |
| Concurrent approve/reject of same proposal | Tampering | Store proposal state/version and return 409 on stale/conflicting decisions. [CITED: https://datatracker.ietf.org/doc/html/rfc9110] |
| Unsupported board promoted as scannable source | Integrity | Gate writes through `companyAtsUpsert()` supported provider validation. [VERIFIED: src/core/db/verbs/source-config.mjs] |
| Privacy leakage in AI/provider errors | Information Disclosure | Reuse bounded-AI safe error envelope; log provider metadata, not raw prompt/body. [VERIFIED: src/core/ai/bounded-ai.mjs] |

## Sources

### Primary (HIGH confidence)
- `.planning/phases/03-company-discovery-api/03-CONTEXT.md` - locked decisions, route shape, status policy, resolver cache, proposal gate, write path.
- `.planning/REQUIREMENTS.md` - DISC-01 through DISC-05 requirement surface.
- `AGENTS.md` - DB write contract, source config ownership, JD capture invariant, confirm-first posture.
- `.agents/skills/discover-companies/SKILL.md` - current discover-companies workflow and confirmation model.
- `.agents/skills/search-jobs/SKILL.md` - JD capture and sourced-row expectations.
- `src/cli/discovery-route.mjs`, `src/cli/search-route.mjs`, `src/cli/data-route.mjs`, `src/cli/skill-run-route.mjs` - existing local API route patterns.
- `src/core/ai/bounded-ai.mjs`, `src/core/ai/call-ai.mjs`, `src/core/ai/structured-oneshot.mjs` - bounded AI patterns.
- `src/core/db/*`, `src/core/db/verbs/source-config.mjs`, `src/core/db/verbs/sourced.mjs` - DB migrations, transactions, source writes, sourced writes.
- `src/core/scoring/sourced-scanner.mjs`, `src/core/scoring/sourced-persistence.mjs`, `scripts/scan-sourced.mjs` - supported ATS scanning and persistence.
- Focused local test run: 69 related tests passed for bounded AI, discovery/search routes, DB source config, company CLI, sourced scan, and scanner behavior.

### Secondary (MEDIUM confidence)
- Node.js HTTP documentation - request/response stream behavior and Node HTTP API. [CITED: https://nodejs.org/api/http.html]
- Node.js SQLite documentation - `node:sqlite` module and `DatabaseSync`. [CITED: https://nodejs.org/api/sqlite.html]
- SQLite JSON1 documentation - `json_valid()` behavior. [CITED: https://sqlite.org/json1.html]
- SQLite CREATE TABLE documentation - table/constraint/index capability. [CITED: https://www.sqlite.org/lang_createtable.html]
- RFC 9110 HTTP semantics - status code classes and 409/413/422/501/502 semantics. [CITED: https://datatracker.ietf.org/doc/html/rfc9110]

### Tertiary (LOW confidence)
- None used as authoritative input.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - existing repo modules and local runtime versions were verified; no new external packages recommended. [VERIFIED: codebase grep; VERIFIED: local command output]
- Architecture: HIGH - route/core/DB/scanner boundaries are locked by CONTEXT and match existing code patterns. [VERIFIED: .planning/phases/03-company-discovery-api/03-CONTEXT.md; VERIFIED: src/cli/search-route.mjs]
- Pitfalls: HIGH for state/model/write-path pitfalls from locked decisions and code; MEDIUM for SSRF-specific controls because exact resolver implementation is still pending. [VERIFIED: AGENTS.md; ASSUMED]

**Research date:** 2026-07-04
**Valid until:** 2026-08-03 for local architecture and repo patterns; recheck external Node/SQLite docs if runtime version changes.
