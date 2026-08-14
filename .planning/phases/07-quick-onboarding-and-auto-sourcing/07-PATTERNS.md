# Phase 7: Quick Onboarding and Auto Sourcing - Pattern Map

**Mapped:** 2026-07-05
**Files analyzed:** 25
**Analogs found:** 24 / 25

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `package.json` | config | dependency-management | `package.json` | exact |
| `package-lock.json` | config | dependency-management | `package-lock.json` | exact |
| `config/targeting.schema.json` | config | validation | `config/targeting.schema.json` | exact |
| `src/core/db/migrations/007-sourcing-runs.mjs` | migration | CRUD/schema | `src/core/db/migrations/006-company-discovery-cache.mjs` | exact |
| `src/core/db/migrations.mjs` | config | batch/schema | `src/core/db/migrations.mjs` | exact |
| `src/core/db/verbs/sourcing-runs.mjs` | service | CRUD/request-response | `src/core/db/verbs/company-discovery.mjs` | exact |
| `src/core/db/verbs/index.mjs` | config | module-export | `src/core/db/verbs/index.mjs` | exact |
| `src/core/onboarding/first-search-run.mjs` | service | event-driven/batch | `scripts/scan-sourced.mjs` | role-match |
| `src/core/onboarding/resume-docx.mjs` | utility | file-I/O/transform | `src/cli/onboard-route.mjs` | role-match |
| `src/cli/sourcing-route.mjs` | route | request-response/event-driven | `src/cli/search-route.mjs` | exact |
| `src/cli/onboard-route.mjs` | route | request-response/file-I/O | `src/cli/onboard-route.mjs` | exact |
| `src/cli/search-route.mjs` | route | request-response/batch | `src/cli/search-route.mjs` | exact |
| `scripts/scan-sourced.mjs` | service/CLI | batch/file-I/O | `scripts/scan-sourced.mjs` | exact |
| `src/core/scoring/sourced-scanner.mjs` | utility/service | batch/transform | `src/core/scoring/sourced-scanner.mjs` | exact |
| `src/core/profile/generate-search-sources.mjs` | utility | transform | `src/core/profile/generate-search-sources.mjs` | exact |
| `apps/web/src/lib/api.js` | utility | request-response | `apps/web/src/lib/api.js` | exact |
| `apps/web/src/onboarding/steps/FinishStep.jsx` | component | request-response/event-driven | `apps/web/src/onboarding/steps/FinishStep.jsx` | exact |
| `apps/web/src/onboarding/steps/ResumeStep.jsx` | component | file-I/O/request-response | `apps/web/src/onboarding/steps/ResumeStep.jsx` | exact |
| `apps/web/src/pages/SetupReadinessCard.jsx` | component | request-response | `apps/web/src/pages/SetupReadinessCard.jsx` | exact |
| `apps/web/src/jobs/JobsPage.jsx` | component | request-response | `apps/web/src/jobs/JobsPage.jsx` | exact |
| `apps/web/src/styles/app.css` | config | presentation | `apps/web/src/styles/app.css` | exact |
| `tests/sourcing-runs.test.mjs` | test | CRUD/request-response | `tests/db-source-config.test.mjs` | role-match |
| `tests/onboard-route.test.mjs` | test | request-response/file-I/O | `tests/onboard-route.test.mjs` | exact |
| `tests/search-route.test.mjs` | test | request-response/batch | `tests/search-route.test.mjs` | exact |
| `apps/web/src/onboarding/steps/ResumeStep.test.jsx` | test | component/file-I/O | `apps/web/src/onboarding/steps/FinishStep.test.jsx` | role-match |
| `apps/web/src/jobs/JobsPage.test.jsx` | test | component/request-response | `apps/web/src/pages/SetupReadinessCard.test.jsx` | role-match |

## Pattern Assignments

### `src/core/db/migrations/007-sourcing-runs.mjs` (migration, CRUD/schema)

**Analog:** `src/core/db/migrations/006-company-discovery-cache.mjs`

**Imports pattern:** none. Migration modules export a named object only.

**Core schema pattern** (lines 4-45):
```javascript
export const migration006 = {
  id: 6,
  name: "company-discovery-cache",
  up(db) {
    db.exec(`
CREATE TABLE company_board_resolutions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  company_key TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.company_key') END) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) WITHOUT ROWID;
CREATE INDEX idx_company_board_resolutions_status
  ON company_board_resolutions(status);
`);
  },
};
```

**Apply to new migration:** create `migration007` with `id: 7`, `name: "sourcing-runs"`, a `sourcing_runs` table, JSON `data CHECK (json_valid(data))`, generated columns for `purpose`, `status`, `started_at`, `completed_at`, `updated_at`, and indexes for latest first-search lookup and running-status lookup.

### `src/core/db/migrations.mjs` (config, batch/schema)

**Analog:** `src/core/db/migrations.mjs`

**Imports and registration pattern** (lines 14-29):
```javascript
import { migration005 } from "./migrations/005-source-config.mjs";
import { migration006 } from "./migrations/006-company-discovery-cache.mjs";

// Add new migrations here, in ascending id order, as the schema evolves.
export const ALL_MIGRATIONS = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
];
```

**Validation pattern** (lines 35-44):
```javascript
function assertSequential(migrations) {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.id !== expected) {
      throw new Error(
        `runMigrations: migration list is not sequential — expected id ${expected} at position ${index}, ` +
          `got id ${migration.id} (name="${migration.name}"). Gaps and out-of-order migrations are rejected.`
      );
    }
  });
}
```

**Planner note:** import `migration007` and append it after `migration006`. Update `tests/db-migrations.test.mjs`; the existing test asserts `ALL_MIGRATIONS.at(-1).id`, so it will catch missing registration.

### `src/core/db/verbs/sourcing-runs.mjs` (service, CRUD/request-response)

**Analog:** `src/core/db/verbs/company-discovery.mjs`

**Imports and error pattern** (lines 6-8, 41-45):
```javascript
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}
```

**Upsert/read pattern** (lines 172-192):
```javascript
export function companyProposalBatchPut({ repoRoot, env, batch } = {}) {
  assertBatch(batch);
  const db = requireDb({ repoRoot, env });
  const data = clone(batch);
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO company_discovery_proposals (id, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
    ).run(String(data.batchId), JSON.stringify(data), now);
    return { ok: true, batch: readBatchById(db, data.batchId) };
  });
}
```

**Versioned patch pattern** (lines 208-249):
```javascript
export function companyProposalBatchPatchState({ repoRoot, env, batchId, expectedVersion, status, patch = {} } = {}) {
  if (!Number.isInteger(Number(expectedVersion))) {
    throw makeError("companyProposalBatchPatchState requires expectedVersion", "BAD_REQUEST");
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = readBatchById(db, batchId);
    if (!current) throw makeError(`company proposal batch not found: ${batchId}`, "NOT_FOUND");
    const next = { ...clone(current), ...clone(patch), ...(status ? { status } : {}), version: currentVersion + 1 };
    db.prepare(`UPDATE company_discovery_proposals SET data = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(next), now, String(batchId));
    return { ok: true, batch: readBatchById(db, batchId) };
  });
}
```

**Apply to new verb:** expose `sourcingRunLatest`, `sourcingRunStart`, `sourcingRunComplete`, `sourcingRunFail`, and optionally `sourcingRunList`. Use DB idempotency, prepared statements, JSON summaries/errors, and `BAD_REQUEST` / `NOT_FOUND` / `CONFLICT` error codes.

### `src/core/db/verbs/index.mjs` (config, module-export)

**Analog:** `src/core/db/verbs/index.mjs`

**Barrel export pattern** (lines 1-5, 47-53):
```javascript
// verbs/index.mjs — the single import surface for every domain-action verb
// re-exported here so src/cli/data.mjs and src/cli/data-route.mjs each have
// exactly one place to import from.
export {
  companyAtsRemove,
  companyAtsUpsert,
  sourceConfigGet,
  sourceConfigPut,
} from "./source-config.mjs";
export { sourcedPromote, sourcedUpsertBatch } from "./sourced.mjs";
```

**Apply to new verb:** export the sourcing-run functions here; `src/core/db/verbs.mjs` already re-exports the index (lines 1-5), so no second barrel is needed.

### `src/core/onboarding/first-search-run.mjs` (service, event-driven/batch)

**Analogs:** `scripts/scan-sourced.mjs`, `src/cli/search-route.mjs`, `src/cli/onboard-route.mjs`

**Scan orchestration pattern** (`scripts/scan-sourced.mjs` lines 191-295):
```javascript
export async function runSourcedScan({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  write = true,
  intake = true,
  verify = false,
  limit = 0,
} = {}) {
  const pathCtx = { repoRoot, env };
  const config = loadScannerConfigForRun({ pathCtx, configPath });
  const candidateConfig = loadCandidateConfig(pathCtx, { standaloneConfigMode });
  const scanned = await scanCompanies(config, { fetchImpl, companyFilter });
  if (!companyFilter && !standaloneConfigMode) {
    searchSources = loadSearchSourcesForRun(pathCtx);
    if (searchSources) sourcedFromSearches = await scanSearchSources(searchSources, { fetchImpl });
  }
  const summary = {
    scanned: scanned.offers.length,
    new: filtered.kept.length,
    errors: scanned.errors,
    offers: outputOffers,
  };
  if (write && !standaloneConfigMode) {
    persistSearchSourceWatermarks({ pathCtx, searchSources, savedAt });
  }
  return summary;
}
```

**Readiness/source-setup pattern** (`src/cli/onboard-route.mjs` lines 530-600):
```javascript
export function prepareQuickStartSourcing({ repoRoot, env = process.env } = {}) {
  const pathCtx = { repoRoot, env };
  if (!dbExists(pathCtx)) {
    return { status: 409, body: { ok: false, error: "SQLite candidate setup is required before quick-start sourcing" } };
  }
  const setup = config.setup || {};
  if (setup.readiness?.search_ready !== true) {
    return {
      status: 409,
      body: { ok: false, error: "Candidate setup is not search-ready", readiness: setup.readiness || {}, missing: setup.missing || {} },
    };
  }
  const { written, sources } = writeDbCompatibilityBundle(repoRoot, pathCtx, config);
  return { status: 200, body: { ok: true, written, readiness: setup.readiness, searches: { count: searchCount } } };
}
```

**Apply to new service:** do not launch chat. Reuse `candidateConfigGet`, `buildDbSearchSources`/`sourceConfigPut`, `runSourcedScan({ write: true })`, and sourcing-run verbs. Start route should return `202` for a new background run and `200` when reusing a running/completed run.

### `src/core/onboarding/resume-docx.mjs` (utility, file-I/O/transform)

**Analog:** `src/cli/onboard-route.mjs`

**Filename and binary detection pattern** (lines 178-192):
```javascript
export function sanitizeUploadFilename(name) {
  const base =
    String(name || "")
      .split(/[/\\]/)
      .pop() || "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || "upload";
}

export function looksBinary(text) {
  if (text.indexOf("\0") !== -1) return true;
  if (!text.length) return false;
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  return replacementCount / text.length > 0.01;
}
```

**Text resume parse/save pattern** (lines 724-764):
```javascript
const text = typeof body?.text === "string" ? body.text : "";
if (!text.trim()) {
  sendJson(res, 400, { error: "body.text is required" });
  return;
}
const parsed = parseResume(text);
const profileSeed = deriveProfileSeed(parsed);
const evidenceSeed = deriveEvidenceSeed(parsed);
if (body?.save && dbExists(pathCtx)) {
  candidateArtifactPut({
    ...pathCtx,
    id: "source-resume",
    kind: "source-resume",
    data: { text, savedAt: new Date().toISOString(), source: "resume-text" },
  });
}
sendJson(res, 200, { profileSeed, evidenceSeed, sections });
```

**Binary upload save pattern** (lines 797-816):
```javascript
bytes = await readRawBodyCapped(req, RESUME_AI_MAX_BYTES);
if (!bytes.length) {
  sendJson(res, 400, { error: "request body is empty" });
  return;
}
const savedRelPath = `workspace/intake/resume-uploads/${Date.now()}-${sanitizeUploadFilename(name)}`;
const savedPath = userPath(pathCtx, savedRelPath);
mkdirSync(dirname(savedPath), { recursive: true });
writeFileSync(savedPath, bytes);
```

**Apply to DOCX:** save original bytes first, call `mammoth.extractRawText({ buffer })`, normalize/quality-gate text, and call `candidateArtifactPut({ id: "source-resume" })` only after text is usable. Return an actionable 422/400 response with the saved path when extraction is empty or garbled.

### `src/cli/sourcing-route.mjs` (route, request-response/event-driven)

**Analog:** `src/cli/search-route.mjs`

**Imports and mount pattern** (lines 27-32, 75-80):
```javascript
import { runSourcedScan } from "../../scripts/scan-sourced.mjs";
import { sourceConfigGet } from "../core/db/verbs/source-config.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

export function mountSearchRoutes({ addRoute, repoRoot, env = process.env, fetchImpl = fetch }) {
  const pathCtx = { repoRoot, env };
  let scanning = false;
```

**Request/error pattern** (lines 84-123):
```javascript
addRoute("POST", "/api/search/scan", async (req, res) => {
  try {
    await readJsonBodyCapped(req, MAX_BODY_BYTES);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }
  if (scanning) {
    sendJson(res, 409, { error: "a scan is already running" });
    return;
  }
  scanning = true;
  try {
    const summary = await runSourcedScan({ repoRoot, env, fetchImpl, write: true });
    sendJson(res, 200, summary);
  } catch (err) {
    if (sendDbError(res, err)) return;
    sendJson(res, 500, { error: err.message });
  } finally {
    scanning = false;
  }
});
```

**Apply to new route:** mount `GET /api/sourcing/runs/latest`, `POST /api/sourcing/first-run/start`, and possibly `POST /api/sourcing/search/start` for Jobs reruns. Reuse `readJsonBodyCapped`, `sendJson`, `sendDbError`, injected `fetchImpl`, and no chat/session-browser calls.

### `src/cli/onboard-route.mjs` (route, request-response/file-I/O)

**Analog:** `src/cli/onboard-route.mjs`

**DB state surface pattern** (lines 622-645):
```javascript
addRoute("GET", "/api/onboard/state", (_req, res) => {
  if (dbExists(pathCtx)) {
    const config = candidateConfigGet(pathCtx);
    sendJson(res, 200, {
      files: dbCandidateFiles(repoRoot, pathCtx, config),
      data: {
        profile: config.profile,
        targeting: config.targeting,
        "form-defaults": config["form-defaults"],
        modes: config.modes,
        setup: config.setup,
      },
      sourceResumePresent: dbSourceResumePresent(pathCtx),
      searchSourcesPresent: dbSearchSourcesPresent(pathCtx),
    });
    return;
  }
});
```

**Quick-start route to replace/split** (lines 1079-1085):
```javascript
// POST /api/onboard/quick-start — search-ready DB setup -> sourcing handoff.
addRoute("POST", "/api/onboard/quick-start", (_req, res) => {
  const result = prepareQuickStartSourcing({ repoRoot, env });
  sendJson(res, result.status, result.body);
});
```

**Apply to Phase 7:** keep `/api/onboard/state` as the React source of readiness, add durable run state to that payload or expose a new sourcing route, and change quick-start so it starts deterministic sourcing rather than returning `nextSkill`/discovery chat guidance.

### `src/cli/search-route.mjs` (route, request-response/batch)

**Analog:** `src/cli/search-route.mjs`

**DB source-readiness pattern** (lines 40-53):
```javascript
function hasConfiguredDbSourcesOnly(pathCtx) {
  const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  const searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
  return Boolean(
    (Array.isArray(sourcedScan.tracked_companies) && sourcedScan.tracked_companies.length > 0) ||
      (Array.isArray(searchSources.searches) && searchSources.searches.length > 0)
  );
}

function sendDbError(res, error) {
  if (error?.code !== "NO_DATABASE") return false;
  sendJson(res, 409, { ok: false, error: error.message });
  return true;
}
```

**Sources summary pattern** (lines 160-179):
```javascript
addRoute("GET", "/api/search/sources", (_req, res) => {
  try {
    const searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
    const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
    const list = Array.isArray(searchSources.searches) ? searchSources.searches : [];
    const tracked = Array.isArray(sourcedScan.tracked_companies) ? sourcedScan.tracked_companies : [];
    sendJson(res, 200, {
      searches: { enabled: list.filter((s) => s && s.enabled !== false).length, total: list.length },
      trackedCompanies: tracked.length,
    });
  } catch (err) {
    if (sendDbError(res, err)) return;
    sendJson(res, 500, { error: err.message });
  }
});
```

**Apply to manual Jobs rerun:** gate the button from DB source setup, return durable run state, and keep legacy YAML out of readiness.

### `scripts/scan-sourced.mjs` and `src/core/scoring/sourced-scanner.mjs` (batch/transform)

**Analogs:** same files.

**Deterministic-only source filter** (`src/core/scoring/sourced-scanner.mjs` lines 507-530):
```javascript
export async function scanSearchSources(searchSources, { fetchImpl = fetch } = {}) {
  const sources = (searchSources?.sources || searchSources?.searches || [])
    .filter((s) => s && s.enabled !== false)
    .filter((s) => s.source_type === "rss" || s.rssUrl);

  const results = [];
  const errors = [];
  for (const source of sources) {
    try {
      const offers = await fetchRss(source, fetchImpl);
      results.push(...offers.map((offer) => ({ ...offer, source: source.label || offer.source || "rss" })));
    } catch (error) {
      errors.push({ company: source.label || source.provider || "rss", error: error.message });
    }
  }
  return { offers: results, errors };
}
```

**JD capture and DB persistence pattern** (`src/core/scoring/sourced-persistence.mjs` lines 129-208):
```javascript
export function captureSourcedOfferJob({ repoRoot, env, offer, savedAt = new Date() } = {}) {
  const relPath = jobCaptureRelPath(offer);
  const absPath = userPath(pathCtx, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  atomicWriteFile(absPath, renderCapturedJob({ offer, savedAt }));
  return relPath;
}

export function captureAndPersistOffersIfDb({ repoRoot, env, offers, savedAt = new Date() } = {}) {
  if (!dbExists({ repoRoot, env })) return null;
  const capturedOffers = offersWithCapturedJobs({ repoRoot, env, offers, savedAt });
  const persisted = persistScanOffersIfDb({ repoRoot, env, offers: capturedOffers, nowIso: savedAt.toISOString() });
  return { ok: true, persistedRows: (persisted?.created || 0) + (persisted?.updated || 0), offers: capturedOffers, persisted };
}
```

**Apply to Phase 7:** use scanner output as the first-run summary. If adding deterministic-source counts, add a pure helper near `scanSearchSources` that counts enabled RSS entries and ATS tracked companies separately.

### `src/core/profile/generate-search-sources.mjs` and `config/targeting.schema.json` (config/transform)

**Analogs:** same files.

**Schema pattern** (`config/targeting.schema.json` lines 37-51):
```json
"search_preferences": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "posting_age": {
      "type": "object",
      "additionalProperties": false,
      "required": ["mode"],
      "properties": {
        "mode": { "type": "string", "enum": ["since-last-run", "fixed-days"] },
        "days": { "type": "number" }
      }
    }
  }
}
```

**Recency transform pattern** (`src/core/profile/generate-search-sources.mjs` lines 33-49, 107-121):
```javascript
function generatedRecency(targeting) {
  const postingAge = targeting?.search_preferences?.posting_age;
  if (postingAge?.mode === "fixed-days") {
    const days = Number(postingAge.days);
    if (Number.isFinite(days) && days > 0) {
      return { mode: "fixed-hours", hours: Math.round(days * 24 * 100) / 100, safetyMinutes: 30 };
    }
  }
  return { mode: "since-last-run", safetyMinutes: 30 };
}
```

**Apply to cadence:** add `search_preferences.cadence` or equivalent schema beside `posting_age`; map Daily / Every 3 days / Weekly / Manual only into source recency or saved preference without implying a scheduler.

### `apps/web/src/lib/api.js` (utility, request-response)

**Analog:** `apps/web/src/lib/api.js`

**Fetch/error pattern** (lines 10-37):
```javascript
export class ApiError extends Error {
  constructor(status, body) {
    super(`request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const text = await res.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}
```

**Raw file upload pattern** (lines 88-115):
```javascript
export async function extractResumeAi(file) {
  const res = await fetch(`/api/onboard/resume-ai?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
  });
  const text = await res.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  if (body?.ok === true && body?.data && typeof body.data === "object") return body.data;
  return body;
}
```

**Apply to new wrappers:** add `extractResumeDocx(file)`, `getSourcingRun()`, `startFirstSearchRun(payload)`, and `startSearchRun(payload)` using the same `ApiError` contract. For binary DOCX use the raw upload pattern, not `apiFetch`.

### `apps/web/src/onboarding/steps/FinishStep.jsx` (component, request-response/event-driven)

**Analog:** `apps/web/src/onboarding/steps/FinishStep.jsx`

**Readiness row pattern** (lines 16-37, 78-92):
```javascript
const READINESS_ROWS = [
  { key: "search_ready", label: "Search", readyDetail: "CareerRat can start sourcing roles now." },
  { key: "gate_ready", label: "Gate", readyDetail: "Jobs can be evaluated without guessing." },
  { key: "apply_ready", label: "Apply", readyDetail: "Tailoring and application flows are unlocked." },
  { key: "deep_ingest_complete", label: "Deep ingest", readyDetail: "Optional coaching context is complete." },
];

export function buildReadinessRows(state) {
  const setup = state?.data?.setup || {};
  const readiness = setup.readiness || {};
  const missing = setup.missing || {};
  return READINESS_ROWS.map((row) => {
    const ready = readiness[row.key] === true;
    return { key: row.key, label: row.label, status: ready ? "Ready" : "Needs setup", detail: ready ? row.readyDetail : missingDetail(missing[row.key]), ready };
  });
}
```

**Action state pattern** (lines 247-262):
```javascript
async function handleQuickStart() {
  setQuickStarting(true);
  setError(null);
  try {
    const { result, chat, chatError } = await runQuickStartHandoff({ refreshWorkspace });
    setQuickStartResult(result);
    setWritten(result.written || []);
    setDiscoveryChat(chat);
    setDiscoveryChatError(chatError);
  } catch (err) {
    setError(errorMessage(err, "quick-start failed"));
  } finally {
    setQuickStarting(false);
  }
}
```

**Card rendering pattern** (lines 318-374):
```jsx
<Card title="Setup readiness">
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
    {readinessRows.map((row) => (
      <div key={row.key} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, minHeight: 96 }}>
        <div className="field__hint" style={{ margin: 0 }}>{row.label}</div>
        <strong>{row.status}</strong>
        <p className="field__hint" style={{ margin: "6px 0 0" }}>{row.detail}</p>
      </div>
    ))}
  </div>
</Card>
```

**Apply to Phase 7:** remove `DiscoveryChatPanel` from the first-search path. Add cadence choices and a compact first-search task with `not_started` / `running` / `completed` / `failed`; keep deep onboarding links available while running.

### `apps/web/src/onboarding/steps/ResumeStep.jsx` (component, file-I/O/request-response)

**Analog:** `apps/web/src/onboarding/steps/ResumeStep.jsx`

**Extension split pattern** (lines 14-19, 85-110):
```javascript
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown"]);
const BINARY_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "webp"]);

async function handleFile(file) {
  const ext = extOf(file.name);
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = await readAsText(file);
    const result = await parseResumeText(text, { save: true });
    applySeed(result);
    return;
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    if (!aiEnabled) {
      setError("Add an AI key in the previous step to extract a PDF/image resume — or paste your resume text below.");
      return;
    }
    const result = await extractResumeAi(file);
    applySeed(result);
    return;
  }
}
```

**Dropzone and fallback pattern** (lines 181-219, 221-248):
```jsx
const accept = aiEnabled ? ".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.markdown" : ".txt,.md,.markdown";

<button type="button" className={`dropzone${dragActive ? " dropzone--active" : ""}`} onClick={() => fileInputRef.current?.click()} disabled={busy}>
  <span className="dropzone__icon"><UploadIcon /></span>
  <span>{busy ? "Reading…" : "Drag a file here, or click to choose one"}</span>
</button>
<input ref={fileInputRef} type="file" accept={accept} style={{ display: "none" }} onChange={(e) => handleFile(e.target.files?.[0])} />
```

**Apply to DOCX:** add `"docx"` to a deterministic local set, always include `.docx` in `accept`, call `extractResumeDocx(file)`, and on 422 show the UI-SPEC fallback copy plus `setShowPaste(true)`.

### `apps/web/src/pages/SetupReadinessCard.jsx` (component, request-response)

**Analog:** `apps/web/src/pages/SetupReadinessCard.jsx`

**Compact checklist pattern** (lines 52-99):
```jsx
export function SetupReadinessCard({ setup }) {
  if (!setup || isComplete(setup)) return null;
  const readiness = setup.readiness || {};
  const missing = setup.missing || {};
  const searchReady = readiness.search_ready === true;

  return (
    <Card title="Setup readiness" actions={<Link className="btn btn--secondary" to="/onboarding">Finish setup</Link>}>
      <p className="field__hint" style={{ margin: 0 }}>
        {searchReady ? "Searching now — finish setup to unlock gating and applying." : "Finish Search to start searching; Gate and Apply unlock as setup fills in."}
      </p>
      <div className="chip-row">
        {READINESS_ROWS.map((row) => {
          const ready = readiness[row.key] === true;
          const Icon = ready ? CheckCircleIcon : ClockIcon;
          return <div className="chip" key={row.key}>{/* icon + label + hint */}</div>;
        })}
      </div>
    </Card>
  );
}
```

**Apply to first-search task:** add a row/chip for first search status only if the setup model exposes it. Keep it compact; do not create a nag modal.

### `apps/web/src/jobs/JobsPage.jsx` (component, request-response)

**Analog:** `apps/web/src/jobs/JobsPage.jsx`

**Page scaffold pattern** (lines 61-67):
```jsx
return (
  <PageScaffold
    title="Jobs"
    subtitle="Every application and sourced role, one list — gate sourced roles from here before they enter the active pipeline."
    wide
  >
    {error ? <InlineAlert message={error} /> : null}
```

**Filter/list pattern** (lines 74-97):
```jsx
<div className="inbox-filters">
  {TABS.map((t) => (
    <button key={t.key} type="button" className={`inbox-filter${tab === t.key ? " inbox-filter--active" : ""}`} onClick={() => setTab(t.key)}>
      {t.label}
    </button>
  ))}
</div>
{filtered.length === 0 ? (
  <p className="field__hint">Nothing here for this filter.</p>
) : (
  <div className="job-list">
    {filtered.map((row) => <JobRow key={row.id} row={row} onOpen={openDrawer} />)}
  </div>
)}
```

**Apply to rerun action:** use `PageScaffold`'s `actions` slot from `apps/web/src/components/PageScaffold.jsx` lines 6-15. Gate `Search jobs` on DB source setup; while running, disable and label `Searching...`.

### `apps/web/src/styles/app.css` and shared components (config/presentation)

**Analogs:** `Button.jsx`, `Card.jsx`, `Toast.jsx`, `icons.jsx`, `app.css`

**Button pattern** (`Button.jsx` lines 1-19):
```jsx
export function Button({ variant = "primary", type = "button", disabled, className = "", children, ...rest }) {
  return (
    <button type={type} className={`btn btn--${variant} ${className}`.trim()} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
```

**Card rule** (`Card.jsx` lines 1-16):
```jsx
// Card — surface + border + shadow only. NEVER a left-edge accent strip.
export function Card({ title, actions, children, className = "" }) {
  return (
    <section className={`card ${className}`.trim()}>
      {title || actions ? <header className="card__header">{/* title/actions */}</header> : null}
      <div className="card__body">{children}</div>
    </section>
  );
}
```

**Status/dropzone styles** (`app.css` lines 456-485, 587-608):
```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}
.badge--ok { background: var(--teal-light); color: var(--teal); }
.badge--warn { background: var(--mustard-light); color: var(--mustard); }
.badge--error { background: var(--m-error-container); color: var(--m-error); }

.dropzone {
  padding: 28px 16px;
  border: 1px dashed var(--paper-edge-strong);
  border-radius: 8px;
}
.dropzone--active {
  border-color: var(--m-secondary);
  background: var(--paper-band);
}
```

**Apply to UI:** use local components and these existing classes. Do not add left-border accent strips, nested cards, landing/hero surfaces, chat panels for first search, or hardcoded light-only colors.

## Test Pattern Assignments

### `tests/sourcing-runs.test.mjs` (test, CRUD/request-response)

**Analogs:** `tests/db-source-config.test.mjs`, `tests/db-migrations.test.mjs`

**Temp DB verb test pattern** (`tests/db-source-config.test.mjs` lines 17-28, 30-60):
```javascript
function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-db-source-config-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

test("company ATS verbs keep sourced-scan config in SQLite without writing compatibility JSON", () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  const added = companyAtsUpsert({ repoRoot, entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" } });
  assert.equal(added.status, "added");
  assert.equal(existsSync(userPath({ repoRoot }, "config/sourced-scan.json")), false);
});
```

**Migration test pattern** (`tests/db-migrations.test.mjs` lines 19-41):
```javascript
test("empty db -> latest: applies every migration ascending, sets user_version, logs _migrations", () => {
  const db = freshDb();
  const result = runMigrations(db);
  assert.equal(result.to, ALL_MIGRATIONS.at(-1).id);
  const logged = db.prepare("SELECT id, name FROM _migrations ORDER BY id ASC").all();
  assert.deepEqual(logged.map((r) => r.id), ALL_MIGRATIONS.map((m) => m.id));
});
```

**Apply to new tests:** cover latest run lookup, start idempotency, running duplicate handling, complete/fail transitions, persisted summary/error JSON, and migration registration.

### `tests/onboard-route.test.mjs` (test, request-response/file-I/O)

**Analog:** `tests/onboard-route.test.mjs`

**Route harness pattern** (lines 95-118, 158-166):
```javascript
function bootServer(repoRoot, env = {}, extra = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountOnboardRoutes({ addRoute, repoRoot, env, ...extra });
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) { res.writeHead(404).end(); return; }
    route(req, res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, env })));
}
```

**Binary upload tests pattern** (lines 591-650, 696-711, 838-848):
```javascript
const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
assert.equal(status, 200);
assert.equal(body.ok, true);
assert.equal(body.data.source, "ai");
assert.equal(state.sourceResumePresent, true);

const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
const { status } = await postResumeAi(server, "resume.pdf", oversized);
assert.equal(status, 413);
```

**Quick-start tests to replace** (lines 1254-1387):
```javascript
const { status, body } = await postJson(server, "/api/onboard/quick-start", {});
assert.equal(status, 200);
assert.equal(body.ok, true);
assert.equal(body.readiness.search_ready, true);
assert.equal(body.nextSkill, "research-boards");
assert.match(body.nextMessage, /discover-companies/i);
```

**Apply to Phase 7:** change assertions so quick-start returns first-search run state and never `nextSkill`, `chat`, `chatId`, `/api/chat/*`, `research-boards`, `discover-companies`, or `search-jobs`. Add DOCX cases for valid text, empty/garbled extraction, oversized bytes, and no-AI path.

### `tests/search-route.test.mjs` (test, request-response/batch)

**Analog:** `tests/search-route.test.mjs`

**Injected fetch and DB source pattern** (lines 97-115, 137-154, 185-223):
```javascript
function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountSearchRoutes({ addRoute, repoRoot, env: {}, ...opts });
  const server = createServer((req, res) => { /* route map dispatch */ });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function leverFetchStub() {
  return async (url) => {
    if (String(url).includes("api.lever.co")) return new Response(JSON.stringify([{ text: "Director of IT", hostedUrl: "https://jobs.lever.co/acme/abc" }]), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
}
```

**DB-only source readiness assertions** (lines 248-273, 441-470):
```javascript
test("POST /api/search/scan: DB mode ignores legacy source files when DB source config is empty", async () => {
  openDb({ repoRoot });
  writeSourcedScanConfig(repoRoot, [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }]);
  const { status, body } = await postJson(server, "/api/search/scan", {});
  assert.equal(status, 400);
  assert.match(body.error, /No search config/);
});

assert.deepEqual(body, { searches: { enabled: 2, total: 3 }, trackedCompanies: 1 });
```

**Apply to Phase 7:** add durable run route tests for Jobs reruns and first-run reuse, with stubbed fetch and DB source config. Keep legacy files insufficient.

### React component tests (Vitest/renderToStaticMarkup)

**Analogs:** `FinishStep.test.jsx`, `SetupReadinessCard.test.jsx`

**Mocking/import pattern** (`FinishStep.test.jsx` lines 1-41):
```javascript
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardMock = vi.hoisted(() => ({ snapshot: { data: null, noDatabase: false, refetch: async () => {} } }));
vi.mock("../../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => dashboardMock.snapshot,
}));
```

**Pure helper tests pattern** (`FinishStep.test.jsx` lines 61-112):
```javascript
describe("buildReadinessRows", () => {
  it("maps DB setup readiness into quick-start status rows", () => {
    const rows = buildReadinessRows({ data: { setup: { readiness: { search_ready: true }, missing: {} } } });
    expect(rows[0]).toEqual({
      key: "search_ready",
      label: "Search",
      status: "Ready",
      detail: "CareerRat can start sourcing roles now.",
      ready: true,
    });
  });
});
```

**Static render pattern** (`SetupReadinessCard.test.jsx` lines 36-67):
```javascript
function renderCard(setup) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SetupReadinessCard setup={setup} />
    </MemoryRouter>
  );
}

expect(markup).toContain("Setup readiness");
expect(markup).toContain("/onboarding");
```

**Apply to new tests:** create `ResumeStep.test.jsx` and `JobsPage.test.jsx` with this style. Mock API functions, render to static markup for copy/visibility, and test pure status/cadence helper functions where possible.

## Shared Patterns

### Staged Readiness
**Source:** `src/core/db/verbs/candidate.mjs`
**Apply to:** onboarding route, first-search service, FinishStep, SetupReadinessCard, tests

```javascript
const searchMissing = [];
if (!hasSourceResume) searchMissing.push("source resume");
if (!titlesReady) searchMissing.push("role titles");
if (!locationReady) searchMissing.push("search location or remote posture");

const gateMissing = [];
if (!titlesReady) gateMissing.push("role titles");
if (!locationReady) gateMissing.push("location posture");
if (!compReady) gateMissing.push("compensation floor");
if (!authReady) gateMissing.push("work authorization");

return {
  readiness: {
    search_ready: searchMissing.length === 0,
    gate_ready: gateMissing.length === 0,
    apply_ready: applyMissing.length === 0,
    deep_ingest_complete: deepMissing.length === 0,
  },
};
```

### Candidate Artifact Readiness
**Source:** `src/core/db/verbs/candidate.mjs`
**Apply to:** DOCX route/service and resume tests

```javascript
export function candidateArtifactPut({ repoRoot, env, id, kind, data } = {}) {
  if (!id || !kind) {
    const err = new Error("id and kind are required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    db.prepare(
      `INSERT INTO candidate_artifacts (id, kind, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, data=excluded.data, updated_at=excluded.updated_at`
    ).run(String(id), String(kind), JSON.stringify(data || {}), new Date().toISOString());
    return { ok: true, setup: refreshCandidateSetup(db) };
  });
}
```

**Important:** do not call this with `id: "source-resume"` for DOCX until extracted text passes the usability gate.

### DB Source Config Is Product State
**Source:** `src/cli/search-route.mjs`, `tests/search-route.test.mjs`, `src/cli/onboard-route.mjs`
**Apply to:** first-search gate, Jobs search button, setup task

```javascript
const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
const searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
return Boolean(
  (Array.isArray(sourcedScan.tracked_companies) && sourcedScan.tracked_companies.length > 0) ||
    (Array.isArray(searchSources.searches) && searchSources.searches.length > 0)
);
```

### No Chat First Search
**Source:** `07-CONTEXT.md`, `07-UI-SPEC.md`, current anti-pattern in `FinishStep.jsx`
**Apply to:** first-search routes and UI

Current analog to remove from first-search flow:
```javascript
import {
  startDiscoveryNext,
  startDiscoveryQuickStart,
} from "../../lib/api.js";

const DISCOVERY_CHAT_SKILLS = ["research-boards", "discover-companies", "search-jobs"];
```

Planner should keep discovery chat for explicit discovery handoffs only, not for first sourcing.

### Local React/CSS System
**Source:** `apps/web/src/components/*`, `apps/web/src/styles/app.css`, `07-UI-SPEC.md`
**Apply to:** all Phase 7 React components

Use `Button`, `Card`, `InlineAlert`, `.badge--ok`, `.badge--warn`, `.badge--error`, `.chip-row`, `.dropzone`, and `PageScaffold.actions`. Do not introduce shadcn, Tailwind, Radix, new global tokens, left-edge card strips, nested cards, or chat panels for first search.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/web/src/jobs/JobsPage.test.jsx` | test | component/request-response | No Jobs page test exists today. Use `SetupReadinessCard.test.jsx` and `FinishStep.test.jsx` as test analogs. |

## Metadata

**Analog search scope:** `src/core/db`, `src/core/onboarding`, `src/core/profile`, `src/core/scoring`, `src/cli`, `scripts`, `apps/web/src`, `tests`, `config`, `package.json`
**Files scanned:** 60+
**Pattern extraction date:** 2026-07-05
