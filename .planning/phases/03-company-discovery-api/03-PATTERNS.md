---
phase: 03
slug: company-discovery-api
status: complete
created: 2026-07-04
sources:
  - AGENTS.md
  - candidate/AGENTS.md
  - .planning/phases/03-company-discovery-api/03-CONTEXT.md
  - .planning/phases/03-company-discovery-api/03-RESEARCH.md
  - .planning/phases/03-company-discovery-api/03-VALIDATION.md
  - .planning/intel/API-SURFACE.md
---

# Phase 03 - Pattern Map

## Purpose

This artifact maps the likely Phase 03 source and test files to the closest
existing Rolester patterns. It is a planning artifact only. Do not modify runtime
source from this file; implementation agents should use it to avoid inventing
new route, AI, DB, scanner, or persistence seams.

Core invariant: AI may propose untrusted company seeds, but deterministic code
owns final URLs, provider identity, cache state, scan proof, proposal gates,
confirmation, and writes.

## Likely Files And Data Flow

| File/module | Action | Role | Data flow | Closest existing analog |
| --- | --- | --- | --- | --- |
| `src/cli/discovery-route.mjs` | modify | Exact-match HTTP adapter under `/api/discovery` | capped JSON body -> core discovery module/DB verb -> stable JSON envelope | `src/cli/discovery-route.mjs`, `src/cli/search-route.mjs`, `src/cli/data-route.mjs`, `src/cli/assist-route.mjs` |
| `src/core/discovery/company-seeds.mjs` | create | AI/manual seed generation and normalization | candidate/dedupe context + manual seeds -> `companySeedSchema` validated `{ companies: [] }` | `src/core/intake/classify.mjs`, `src/cli/assist-route.mjs`, `src/core/ai/bounded-ai.mjs` |
| `config/company-seeds.schema.json` or exported `companySeedSchema` | create | Structured seed schema | model text/manual seed payload -> schema validation, no final trusted URLs | `config/assist-suggest.schema.json`, `tests/bounded-ai.test.mjs` seed fixture |
| `src/core/discovery/company-context.mjs` | create | DB-first candidate/source/dedupe context | DB candidate config + source config + tracker/jobs dedupe -> proposal inputs | `scripts/scan-sourced.mjs`, `src/core/tracker/tracker-data.mjs`, `src/cli/search-route.mjs` |
| `src/core/discovery/company-board-resolver.mjs` | create | Deterministic URL/provider resolver | seed/domain hints/cache/fetch -> resolution record with provenance | `src/core/scoring/sourced-scanner.mjs`, `src/core/intake/resolve.mjs`, `src/cli/boards-route.mjs` |
| `src/core/discovery/company-proposal-gate.mjs` | create | Hard reject/high/borderline classification | resolution + scan + dedupe + candidate rules -> proposal/reject state | `filterAndDedupeOffers()`, `scoreSourcedOffer()`, `.agents/skills/discover-companies/SKILL.md` |
| `src/core/discovery/company-proposals.mjs` | create | Proposal batch orchestration | request -> context -> seeds -> cache/resolve -> scan -> capture artifacts -> gate -> proposal state | `scripts/scan-sourced.mjs`, `src/cli/search-route.mjs` |
| `src/core/discovery/company-proposal-decisions.mjs` | create | Confirmation decision application | decision + pending proposal -> source config write and optional sourced row promotion | `src/cli/companies.mjs`, `src/core/db/verbs/source-config.mjs`, `src/core/scoring/sourced-persistence.mjs` |
| `src/core/db/migrations/006-company-discovery-cache.mjs` | create | SQLite schema for resolver/proposal cache | JSON rows with generated query columns and indexes | `src/core/db/migrations/001-init.mjs`, `005-source-config.mjs` |
| `src/core/db/migrations.mjs` | modify | Migration registration | add migration 006 in ascending order | `ALL_MIGRATIONS` list in `src/core/db/migrations.mjs` |
| `src/core/db/verbs/company-discovery.mjs` | create | Cache/proposal DB verb surface | synchronous DB-only transactions; no network/model work inside | `src/core/db/verbs/source-config.mjs`, `src/core/db/verbs/shared.mjs` |
| `src/core/db/verbs/index.mjs` | modify | DB verb export surface | re-export discovery cache/proposal verbs | existing source-config/sourced re-exports |
| `tests/company-discovery-seeds.test.mjs` | create | Seed schema/no-AI/manual tests | injected model calls, no real AI | `tests/bounded-ai.test.mjs`, `tests/intake-classify.test.mjs` |
| `tests/company-board-resolver.test.mjs` | create | URL/provider safety and resolver tests | stubbed `fetchImpl`, unsafe URL fixtures, provider fixtures | `tests/sourced-scanner.test.mjs`, `tests/boards-route.test.mjs` |
| `tests/company-discovery-cache-db.test.mjs` | create | Migration/verb/cache conflict tests | temp repo DB, direct verb assertions | `tests/db-source-config.test.mjs`, `tests/scan-sourced.test.mjs` |
| `tests/company-proposals-route.test.mjs` | create | `POST/GET /company-proposals` route tests | local HTTP/addRoute harness, injected fetch/AI/core seams | `tests/search-route.test.mjs`, `tests/discovery-route.test.mjs` |
| `tests/company-proposal-decisions.test.mjs` | create | confirmation write tests | approve/reject/suppress/refresh, DB source config and sourced rows | `tests/companies-cli.test.mjs`, `tests/db-source-config.test.mjs`, `tests/scan-sourced.test.mjs` |

Optional but likely: update `src/cli/tracker-dev.mjs` route help/404 text after
adding the new exact paths, following the existing route-list pattern. The route
mount itself already happens through `mountDiscoveryRoutes()`.

## Pattern 1 - Exact-Match Local Route Registration

Phase 03 should extend the existing discovery route module. The dev server route
map is exact method + path, not param based.

Source pattern:

```javascript
// src/cli/tracker-dev.mjs:220-229, 398-403
const routes = new Map();
function addRoute(method, path, handler) {
  routes.set(`${method} ${path}`, handler);
}

const url = (req.url || "/").split("?")[0];
const route = routes.get(`${req.method} ${url}`);
if (route) {
  route(req, res);
  return;
}
```

Existing discovery mount:

```javascript
// src/cli/discovery-route.mjs:156-164
export function mountDiscoveryRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  chatRuntime,
  prepareQuickStart = prepareQuickStartSourcing,
  loadAgentGuidance = loadAgentGuidanceSnapshot,
}) {
```

Existing exact discovery paths:

```javascript
// src/cli/discovery-route.mjs:164, 183, 226
addRoute("GET", "/api/discovery/state", (_req, res) => { ... });
addRoute("POST", "/api/discovery/quick-start", async (_req, res) => { ... });
addRoute("POST", "/api/discovery/next", async (_req, res) => { ... });
```

Phase 03 target paths should be added in the same module:

```javascript
addRoute("POST", "/api/discovery/company-proposals", async (req, res) => { ... });
addRoute("GET", "/api/discovery/company-proposals", async (req, res) => { ... });
addRoute("POST", "/api/discovery/company-proposal-decisions", async (req, res) => { ... });
```

Do not add wildcard paths, `:id` routes, or a second discovery server. If GET
needs a selector, use query-string parsing like `search-route.mjs`:

```javascript
// src/cli/search-route.mjs:44-47
function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}
```

## Pattern 2 - Capped JSON Parsing And Stable Envelopes

Use the shared body and JSON helpers. Do not duplicate stream-reading code.

Source pattern:

```javascript
// src/cli/skill-run-route.mjs:39-45
export function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
```

```javascript
// src/cli/skill-run-route.mjs:56-90
export function readJsonBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) {
        const err = new Error("request body exceeds 1MB limit");
        err.status = 413;
        reject(err);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        const err = new Error("invalid JSON body");
        err.status = 400;
        reject(err);
      }
    });
    req.on("error", (err) => reject(err));
  });
}
```

Route wrapper pattern:

```javascript
// src/cli/data-route.mjs:100-113
async function withBodyVerb(req, res, run) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { ok: false, error: err.message });
    return;
  }
  try {
    const result = run(body);
    respondVerbResult(res, result);
  } catch (err) {
    respondError(res, err);
  }
}
```

Recommended Phase 03 envelope:

```javascript
// success
{ ok: true, data: { batchId, proposals, rejected, counts }, meta: { ... } }

// failure
{ ok: false, code: "VALIDATION_FAILED", error: { message, details } }
```

Status mapping for discovery errors:

| Status | Use for |
| --- | --- |
| `400` | malformed JSON, missing required request fields, unsupported decision action |
| `409` | no DB for DB-canonical app route, stale proposal version, already decided proposal, conflicting pending state |
| `422` | syntactically valid request that fails schema/gate validation |
| `501` | no AI route and no manual seeds were supplied |
| `502` | upstream AI/proxy/provider/fetch runtime failure |

For bounded AI output, reuse `runBoundedAI()`'s existing envelope directly when
returning an AI failure.

## Pattern 3 - Bounded AI Seed Generation

Phase 03 seed generation should use `runBoundedAI()` in `native-preferred` mode
when model generation is needed. Manual/pasted seeds should remain usable without
AI.

Strict labels already appear in the bounded-AI tests:

```javascript
// tests/bounded-ai.test.mjs:8-12
const LABELS = {
  skill: "discover-companies",
  action: "seed-generate",
  operation: "company-seeds",
};
```

Native-preferred mode sends provider-native schema hints but still validates
locally:

```javascript
// src/core/ai/bounded-ai.mjs:220-236
const response = await nativeCall(
  withDefined(
    {
      messages: messagesForAttempt(messages, lastErrors),
      skill: labels.skill,
      action: labels.action,
      outputMode: "native",
      outputSchema: schema,
    },
    { system, model: requestedModel, maxTokens, outputName, root, env, signal }
  )
);
const unwrapped = unwrapInvocationResult(response);
const parsed = parseStructuredJson(unwrapped.text, schema);
```

The helper maps schema, no-AI, and provider failures to stable statuses:

```javascript
// src/core/ai/bounded-ai.mjs:350-390
return makeBoundedAIEnvelope({
  ok: false,
  status: 422,
  code: BOUNDED_AI_CODES.AI_SCHEMA_INVALID,
  ...
});

// no AI route -> 501
// provider failure -> 502
```

Route usage pattern from `assist-route`:

```javascript
// src/cli/assist-route.mjs:216-223
const result = await runBoundedAI({
  labels,
  schema,
  manual: ASSIST_MANUAL,
  maxRetries: 1,
  invoke,
});
sendJson(res, result.status, result.body);
```

For Phase 03, prefer:

```javascript
const result = await runBoundedAI({
  labels: {
    skill: "discover-companies",
    action: "seed-generate",
    operation: "company-seeds",
  },
  schema: companySeedSchema,
  structuredMode: "native-preferred",
  manual: {
    available: true,
    reason: "manual-company-seeds",
    action: "Paste company names or homepages.",
  },
  messages,
  system,
  outputName: "company_seed_response",
  maxTokens: 1200,
  root: repoRoot,
  env,
  call,
});
```

Seed schema guardrails:

```javascript
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

The schema intentionally excludes trusted `careers_url`, `job_board_url`,
`api_url`, provider identity, and write approval. Tests should assert those
fields are rejected through `additionalProperties: false`.

Manual fallback rule:

- If manual seeds are present, route them through normalization/resolution even
  when AI is unavailable.
- If no AI route is configured and no manual seeds were provided, return `501`
  with a manual action envelope.
- Do not start `/api/skill/run` as a hidden fallback for this endpoint.

## Pattern 4 - DB Migrations And Verb Ownership

Migrations are sequential and registered explicitly:

```javascript
// src/core/db/migrations.mjs:20-27
export const ALL_MIGRATIONS = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
];
```

Add `migration006` in ascending order only. The runner rejects gaps or reorder:

```javascript
// src/core/db/migrations.mjs:33-42
function assertSequential(migrations) {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.id !== expected) {
      throw new Error(...);
    }
  });
}
```

JSON-table pattern:

```javascript
// src/core/db/migrations/001-init.mjs:20-34
CREATE TABLE applications (
  id                TEXT PRIMARY KEY,
  data              TEXT NOT NULL CHECK (json_valid(data)),
  company           TEXT GENERATED ALWAYS AS (json_extract(data,'$.company')) STORED,
  role              TEXT GENERATED ALWAYS AS (json_extract(data,'$.role')) STORED,
  status            TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_apps_status  ON applications(status);
```

Source-config table pattern:

```javascript
// src/core/db/migrations/005-source-config.mjs:11-15
CREATE TABLE candidate_source_configs (
  name TEXT PRIMARY KEY CHECK (name IN ('search-sources','sourced-scan')),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

Recommended Phase 03 migration shape:

```sql
CREATE TABLE company_board_resolutions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  company_key TEXT GENERATED ALWAYS AS (json_extract(data,'$.company_key')) STORED,
  company_domain TEXT GENERATED ALWAYS AS (json_extract(data,'$.company_domain')) STORED,
  ats_provider TEXT GENERATED ALWAYS AS (json_extract(data,'$.ats_provider')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  last_verified_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.last_verified_at')) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_company_board_resolutions_company_key
  ON company_board_resolutions(company_key);
CREATE INDEX idx_company_board_resolutions_provider
  ON company_board_resolutions(ats_provider);
CREATE INDEX idx_company_board_resolutions_status
  ON company_board_resolutions(status);

CREATE TABLE company_discovery_proposals (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.created_at')) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_company_discovery_proposals_status_updated
  ON company_discovery_proposals(status, updated_at DESC);
```

DB connection pattern:

```javascript
// src/core/db/connection.mjs:54-57
const db = new DatabaseSync(path);
applyPragmas(db);
runMigrations(db);
```

Transaction rule:

```javascript
// src/core/db/transaction.mjs:3-9
// fn must be synchronous, pure DB work - no model calls, no network, no
// fs-heavy work inside the transaction.
```

Choose the correct verb base:

- Pure resolver/proposal cache state is app state, not tracker state. Follow
  `source-config.mjs`: `requireDb()` + `withTransaction()`, no tracker meta bump
  and no export unless a route intentionally needs the generated dashboard files.
- Confirmed sourced rows are tracker-visible. Use `sourcedUpsertBatch()`, which
  goes through `runVerb()`, bumps meta, logs one activity event, refreshes
  analytics, and exports tracker files.

Source-config verb style:

```javascript
// src/core/db/verbs/source-config.mjs:81-91
export function sourceConfigGet({ repoRoot, env, name } = {}) {
  const db = requireDb({ repoRoot, env });
  return { ok: true, ...readSourceConfig(db, name) };
}

export function sourceConfigPut({ repoRoot, env, name, data } = {}) {
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    putSourceConfig(db, name, data);
    return { ok: true, ...readSourceConfig(db, name) };
  });
}
```

Tracker-visible verb style:

```javascript
// src/core/db/verbs/shared.mjs:147-152
export function runVerb({ repoRoot, env }, fn) {
  const pathCtx = { repoRoot, env };
  const db = requireDb(pathCtx);
  const result = withTransaction(db, () => fn(db, pathCtx));
  const exported = exportToTracker(pathCtx);
  return { ok: true, ...result, exported };
}
```

## Pattern 5 - Supported ATS Inference And Scanner Reuse

Do not create a second supported ATS scanner. Use the existing provider
inference and fetcher dispatch.

Provider inference source:

```javascript
// src/core/scoring/sourced-scanner.mjs:359-369
export function inferProvider(entry = {}) {
  if (entry.provider) return entry.provider;
  const url = entry.careers_url || "";
  if (/jobs\.ashbyhq\.com\//.test(url)) return "ashby";
  if (/job-boards(?:\.eu)?\.greenhouse\.io\/|boards\.greenhouse\.io\//.test(url))
    return "greenhouse";
  if (/jobs\.lever\.co\//.test(url)) return "lever";
  if (/apply\.workable\.com\//.test(url)) return "workable";
  if (/(careers|jobs)\.smartrecruiters\.com\//.test(url)) return "smartrecruiters";
  return null;
}
```

Scanner source:

```javascript
// src/core/scoring/sourced-scanner.mjs:458-482
export async function scanCompanies(config, { fetchImpl = fetch, companyFilter = null } = {}) {
  const companies = (config.tracked_companies || [])
    .filter((entry) => entry && entry.enabled !== false)
    .filter(
      (entry) => !companyFilter || entry.name.toLowerCase().includes(companyFilter.toLowerCase())
    );

  const results = [];
  const errors = [];

  for (const company of companies) {
    const provider = inferProvider(company);
    if (!provider) {
      errors.push({ company: company.name, error: "no supported provider inferred" });
      continue;
    }
    try {
      const jobs = await fetchProvider(provider, company, fetchImpl);
      results.push(...jobs.map((job) => ({ ...job, source: `${provider}-api` })));
    } catch (error) {
      errors.push({ company: company.name, error: error.message });
    }
  }

  return { offers: results, errors };
}
```

Provider dispatch:

```javascript
// src/core/scoring/sourced-scanner.mjs:485-493
export async function fetchProvider(provider, entry, fetchImpl = fetch) {
  if (provider === "ashby") return fetchAshby(entry, fetchImpl);
  if (provider === "greenhouse") return fetchGreenhouse(entry, fetchImpl);
  if (provider === "lever") return fetchLever(entry, fetchImpl);
  if (provider === "workable") return fetchWorkable(entry, fetchImpl);
  if (provider === "smartrecruiters") return fetchSmartRecruiters(entry, fetchImpl);
  if (provider === "rss") return fetchRss(entry, fetchImpl);
  throw new Error(`unsupported provider: ${provider}`);
}
```

Existing fetch timeout pattern:

```javascript
// src/core/scoring/sourced-scanner.mjs:545-555
async function fetchWithTimeout(url, fetchImpl, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0 } = {}) {
  ...
  return await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
}
```

Resolver-specific addition: Phase 03 must add URL safety checks before fetches.
Existing scanner fetches known provider APIs; the new resolver handles
user/model-supplied hints and homepage links. It must reject unsupported schemes,
localhost/private IPs, unsafe redirects, and provider mismatches before a URL is
eligible for promotion.

## Pattern 6 - Proposal Gate And Dedupe Inputs

The proposal gate should reuse scanner scoring and existing dedupe conventions.

Existing dedupe sets:

```javascript
// src/core/tracker/tracker-data.mjs:207-229
export function buildSeenSets(root = ".") {
  const pathCtx = { repoRoot: root };
  const data = loadTrackerDataSafe(userPath(pathCtx, "workspace/tracker.json"));
  const seenUrls = new Set();
  const seenReqIds = new Set();
  const seenCompanyRoles = new Set();

  for (const row of [...data.apps, ...data.sourced]) {
    if (row.link) seenUrls.add(row.link);
    if (row.link) addReqId(seenReqIds, row.link);
    if (row.co && row.role) seenCompanyRoles.add(normalizeCompanyRoleKey(row.co, row.role));
  }
  ...
  return { seenUrls, seenReqIds, seenCompanyRoles, tracker: data };
}
```

Existing scanner filtering/scoring:

```javascript
// src/core/scoring/sourced-scanner.mjs:371-420
export function filterAndDedupeOffers(
  offers,
  { seenUrls, seenReqIds = new Set(), seenCompanyRoles, titleFilter, locationFilter, config = {} }
) {
  ...
  kept.push({
    ...offer,
    key,
    reqId: req.id,
    possibleDuplicate,
    ...scoreSourcedOffer(offer, config),
  });
}
```

Existing score gate:

```javascript
// src/core/scoring/sourced-scanner.mjs:268-287
function gateFromScoreAndFlags(score, flags, modes = {}) {
  if (flags.some((flag) =>
    flag.startsWith("cut-risk") || flag === "excluded-company" || flag === "comp-below-floor"
  ))
    return "likely-cut";
  if (flags.some((flag) =>
    flag === "comp-unposted" ||
    flag === "top-of-band-only" ||
    flag === "ca-comp-unverified" ||
    flag === "family-cold"
  ))
    return "review";
  if (score >= scannerLikelyKeepThreshold(modes)) return "likely-keep";
  return "review";
}
```

Phase 03 proposal tiers:

- `rejected`: already tracked/in play/excluded/capped, unsupported without cache
  value, unreachable, no current role signal, cut-only signal, or failed JD
  capture without a partial explanation.
- `high-confidence`: supported ATS, validated provider board, at least one
  current role that scores non-cut, clean dedupe/exclusion checks, acceptable JD
  capture.
- `borderline`: enough signal to show the user, but missing one high-confidence
  criterion. Must remain confirm-first.

## Pattern 7 - Source Config / `companyAtsUpsert()` Write Path

Confirmed supported ATS companies must write through `companyAtsUpsert()`. Do
not directly edit SQLite rows, `config/sourced-scan.json`, or generated tracker
files from the app API.

Validation and idempotency source:

```javascript
// src/core/db/verbs/source-config.mjs:57-72
function normalizeCompanyEntry(entry = {}) {
  const name = String(entry.name || "").trim();
  const careersUrl = String(entry.careers_url || entry.url || "").trim();
  if (!name || !careersUrl) {
    const err = new Error("company ATS entry requires name and careers_url");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const provider = inferProvider({ careers_url: careersUrl });
  if (!provider) {
    const err = new Error(`unsupported ATS host - cannot scan "${careersUrl}"`);
    err.code = "BAD_REQUEST";
    throw err;
  }
  return { name, careers_url: careersUrl };
}
```

Upsert source:

```javascript
// src/core/db/verbs/source-config.mjs:94-130
export function companyAtsUpsert({ repoRoot, env, entry } = {}) {
  const normalized = normalizeCompanyEntry(entry);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = readSourceConfig(db, "sourced-scan").data;
    const companies = Array.isArray(current.tracked_companies)
      ? current.tracked_companies.slice()
      : [];
    const index = companies.findIndex((company) => sameCompanyOrUrl(company, normalized));
    ...
    putSourceConfig(db, "sourced-scan", next);
    return { ok: true, status, entry: ..., total: companies.length, data: ... };
  });
}
```

CLI mental model:

```javascript
// src/cli/companies.mjs:111-158
const provider = inferProvider({ careers_url: url });
if (!provider) {
  console.error(`Unsupported ATS host - cannot scan "${url}".`);
  return 2;
}
...
if (dbExists(pathCtx)) {
  const result = companyAtsUpsert({ ...pathCtx, entry });
  ...
}
```

Phase 03 approval should do this:

```javascript
const added = companyAtsUpsert({
  repoRoot,
  env,
  entry: {
    name: proposal.company_name,
    careers_url: proposal.job_board_url,
  },
});
```

Unsupported/custom pages stay in the resolver cache/proposal record. They must
not enter `sourced-scan`.

## Pattern 8 - JD Artifact Capture And Sourced Row Promotion

Important split:

- Proposal generation should preserve reachable JD bodies before presentation.
- Proposal generation must not promote sourced rows before user approval.
- Approved decisions may persist sourced rows.

Existing capture-only function:

```javascript
// src/core/scoring/sourced-persistence.mjs:138-149
export function offersWithCapturedJobs({ repoRoot, env, offers, savedAt = new Date() } = {}) {
  return (Array.isArray(offers) ? offers : []).filter(hasRequiredSourcedFields).map((offer) => {
    const jd = captureSourcedOfferJob({ repoRoot, env, offer, savedAt });
    const bodyText = offerBodyText(offer);
    const { rawText, description, ...rest } = offer;
    return {
      ...rest,
      ...(bodyText ? { bodyText } : {}),
      bodyChars: bodyText.length,
      artifacts: { ...(offer.artifacts || {}), jd },
    };
  });
}
```

Existing row conversion:

```javascript
// src/core/scoring/sourced-persistence.mjs:152-184
export function sourcedRowsFromScanOffers(offers, nowIso = new Date().toISOString()) {
  return offers.filter(hasRequiredSourcedFields).map((offer) => ({
    id: stableSourcedId(offer),
    company: offer.company,
    role: offer.title,
    status: "sourced",
    source: offer.source || "scanner",
    channel: "board",
    link: offer.url,
    fitScore: Number.isFinite(fitScore) ? fitScore : 0,
    fitBucket: offer.fit || "",
    fitBasis: "triage",
    artifacts: offer.artifacts || {},
    scanner: { reqId: offer.reqId || null, key: offer.key || null, bodyChars: ... },
  }));
}
```

Existing persist helper:

```javascript
// src/core/scoring/sourced-persistence.mjs:193-208
export function captureAndPersistOffersIfDb({ repoRoot, env, offers, savedAt = new Date() } = {}) {
  if (!dbExists({ repoRoot, env })) return null;
  const capturedOffers = offersWithCapturedJobs({ repoRoot, env, offers, savedAt });
  const persisted = persistScanOffersIfDb({ repoRoot, env, offers: capturedOffers, nowIso: savedAt.toISOString() });
  return { ok: true, persistedRows: ..., offers: capturedOffers, persisted };
}
```

Sourced row transaction:

```javascript
// src/core/db/verbs/sourced.mjs:25-47
export function sourcedUpsertBatch({ repoRoot, env, rows } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("sourcedUpsertBatch: rows must be a non-empty array");
  }
  return runVerb({ repoRoot, env }, (db) => {
    ...
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "sourced",
      title: `Sourced sweep - ${created} new, ${updated} updated`,
      tags: [`count:${rows.length}`],
    });
    const analytics = refreshAnalytics(db);
    return { created, updated, meta, event, analytics };
  });
}
```

Recommended Phase 03 use:

```javascript
// proposal generation: capture artifacts, attach to proposal/cache, do not persist sourced rows
const capturedOffers = offersWithCapturedJobs({ repoRoot, env, offers: matchingOffers, savedAt });

// approval decision: if already captured, preserve artifacts and only write rows
const rows = sourcedRowsFromScanOffers(proposal.capturedOffers, savedAt.toISOString());
const persisted = rows.length ? sourcedUpsertBatch({ repoRoot, env, rows }) : null;

// if a future path reaches approval without pre-captured artifacts:
const persistedWithCapture = captureAndPersistOffersIfDb({ repoRoot, env, offers, savedAt });
```

Avoid calling `captureAndPersistOffersIfDb()` from
`POST /api/discovery/company-proposals`; it persists sourced rows in DB mode and
would violate the confirm-first boundary.

## Pattern 9 - Importable Orchestration With Injected Fetch/AI

`runSourcedScan()` is the closest orchestration analog: importable, dependency
injected, no CLI side effects on import, and DB-first.

Source pattern:

```javascript
// scripts/scan-sourced.mjs:179-190
export async function runSourcedScan({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  configPath,
  companyFilter = null,
  write = true,
  intake = true,
  verify = false,
  limit = 0,
  timestamped = false,
} = {}) {
```

DB-first source config:

```javascript
// scripts/scan-sourced.mjs:98-107
function loadScannerConfigForRun({ pathCtx, configPath }) {
  if (!configPath && dbExists(pathCtx))
    return sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  return loadScannerConfig(configPath || userPath(pathCtx, "config/sourced-scan.json"));
}

function loadSearchSourcesForRun(pathCtx) {
  if (dbExists(pathCtx)) {
    return sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
  }
  ...
}
```

Scan and filter flow:

```javascript
// scripts/scan-sourced.mjs:212-241
const scanned = await scanCompanies(config, { fetchImpl, companyFilter });
...
let filtered = filterAndDedupeOffers(allOffers, {
  seenUrls,
  seenReqIds,
  seenCompanyRoles,
  titleFilter,
  locationFilter,
  config: candidateConfig,
});
```

Phase 03 orchestration should follow the same shape:

```javascript
export async function createCompanyProposalBatch({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  call,
  body,
  now = new Date(),
} = {}) {
  // no CLI parsing, no real AI/network in tests unless injected
}
```

Keep model calls, HTTP fetches, and file writes outside DB transactions. Persist
cache/proposal state only after deterministic results are assembled.

## Pattern 10 - Route/Core Test Harnesses

Route tests use `node:test`, temp repos, local `addRoute` maps, and injected
network/model seams. No full tracker-dev server is required.

Discovery route harness:

```javascript
// tests/discovery-route.test.mjs:32-64
function bootServer({ chatRuntime = fakeChatRuntime(), prepareQuickStart = ..., loadAgentGuidance = ... } = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDiscoveryRoutes({ addRoute, repoRoot: "/tmp/...", env: {}, chatRuntime, ... });
  return { server: { routes }, chatRuntime };
}
```

HTTP route harness:

```javascript
// tests/search-route.test.mjs:50-68
function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountSearchRoutes({ addRoute, repoRoot, env: {}, ...opts });
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    ...
  });
}
```

Stubbed ATS network:

```javascript
// tests/search-route.test.mjs:90-106
function leverFetchStub() {
  return async (url) => {
    if (String(url).includes("api.lever.co")) {
      return new Response(JSON.stringify([{ text: "Director of IT", ... }]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}
```

DB temp repo pattern:

```javascript
// tests/db-source-config.test.mjs:17-28
function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-db-source-config-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
```

DB source-config assertion:

```javascript
// tests/db-source-config.test.mjs:30-55
candidateSetupInitialize({ repoRoot });
const added = companyAtsUpsert({
  repoRoot,
  entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
});
assert.equal(added.status, "added");
assert.equal(existsSync(userPath({ repoRoot }, "config/sourced-scan.json")), false);
```

DB scan/persistence assertion:

```javascript
// tests/search-route.test.mjs:144-179
openDb({ repoRoot });
companyAtsUpsert({ repoRoot, entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" } });
...
assert.match(rows[0].artifacts.jd, /^workspace\/jobs\/acme-director-of-it-/);
assert.equal(existsSync(userPath({ repoRoot }, rows[0].artifacts.jd)), true);
assert.equal(tracker.sourced[0].id, rows[0].id);
```

Bounded AI test assertions to reuse:

```javascript
// tests/bounded-ai.test.mjs:171-218
const result = await runBoundedAI({
  labels: LABELS,
  schema: SEED_SCHEMA,
  manual: MANUAL,
  structuredMode: "native-preferred",
  call: async (options) => { ... },
  messages: [{ role: "user", content: "Suggest company seeds." }],
  outputName: "company_seed_response",
  root: ROOT,
});
assert.equal(calls[0].outputMode, "native");
assert.equal(calls[0].outputSchema, SEED_SCHEMA);
assert.equal(result.body.ai.mode, "native");
```

Required new test coverage from validation:

- `tests/company-discovery-seeds.test.mjs`: schema rejects URL/write fields;
  manual seeds work without AI; no-AI/no-manual returns 501.
- `tests/company-board-resolver.test.mjs`: rejects unsafe schemes,
  localhost/private targets, unsafe redirects, unsupported providers.
- `tests/company-discovery-cache-db.test.mjs`: migration, cache upsert/read,
  latest pending proposal, stale version conflict.
- `tests/company-proposals-route.test.mjs`: capped JSON, batch max, stable
  envelopes, high/borderline/reject proposal states.
- `tests/company-proposal-decisions.test.mjs`: approve supported ATS writes via
  `companyAtsUpsert()`, preserves sourced JD artifacts, rejects stale or
  unsupported approvals.

## Anti-Patterns To Avoid

- Trusting model-generated final URLs, provider identity, or write approval.
- Launching `POST /api/skill/run` from `POST /api/discovery/company-proposals`.
- Adding discovery logic directly inside route handlers.
- Writing unsupported/custom pages to `sourced-scan`.
- Directly editing `workspace/tracker.json`, `workspace/activity.jsonl`,
  `config/sourced-scan.json`, or source YAML from the app API in DB mode.
- Running model calls, public HTTP fetches, or filesystem-heavy work inside
  `withTransaction()`.
- Calling `captureAndPersistOffersIfDb()` during proposal generation before user
  approval.
- Letting tests hit real ATS boards or real AI providers.
- Treating absence in `.planning/intel/API-SURFACE.md` as proof a route does not
  exist; that intel file is explicitly incomplete.

## Implementation Checklist For Future Plans

1. Add schema and seed/core tests first; assert URLs/write fields are rejected.
2. Add migration 006 and cache/proposal verbs with temp-DB tests.
3. Add resolver tests with injected fetch and unsafe URL fixtures before
   resolver implementation.
4. Add route tests that mount `mountDiscoveryRoutes()` directly and verify exact
   `/api/discovery/company-*` paths.
5. Implement proposal orchestration with manual seed fallback and injected AI.
6. Capture JD artifacts for proposals with `offersWithCapturedJobs()`, not
   sourced persistence.
7. Implement decision approval with `companyAtsUpsert()` and sourced row
   promotion through existing persistence/DB verbs.
8. Run the focused Phase 03 slice plus existing related tests:
   `node --test tests/bounded-ai.test.mjs tests/discovery-route.test.mjs tests/db-source-config.test.mjs tests/companies-cli.test.mjs tests/scan-sourced.test.mjs tests/search-route.test.mjs tests/sourced-scanner.test.mjs`.
