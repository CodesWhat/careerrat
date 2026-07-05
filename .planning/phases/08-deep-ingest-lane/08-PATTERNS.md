# Phase 8: Deep Ingest Lane - Pattern Map

**Mapped:** 2026-07-05  
**Files analyzed:** 46  
**Analogs found:** 46 / 46

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---:|---|---|
| `src/core/db/migrations/008-deep-ingest.mjs` | migration | CRUD, batch | `src/core/db/migrations/003-candidate-setup.mjs`; `src/core/db/migrations/006-company-discovery-cache.mjs` | exact |
| `src/core/db/migrations.mjs` | config | batch | `src/core/db/migrations.mjs` | exact |
| `src/core/db/verbs/deep-ingest.mjs` | service | CRUD, transform | `src/core/db/verbs/candidate.mjs`; `src/core/db/verbs/intake.mjs`; `src/core/db/verbs/company-discovery.mjs` | exact |
| `src/core/db/verbs/index.mjs` | config | transform | `src/core/db/verbs/index.mjs` | exact |
| `src/core/db/verbs.mjs` | config | transform | `src/core/db/verbs.mjs` | exact |
| `src/cli/data.mjs` | route/CLI | request-response | `src/cli/data.mjs` candidate + intake sections | role-match |
| `src/cli/deep-ingest-route.mjs` | route | request-response, file-I/O | `src/cli/data-route.mjs`; `src/cli/intake-route.mjs`; `src/cli/discovery-route.mjs` | exact |
| `src/cli/tracker-dev.mjs` | config/route mount | request-response | `src/cli/tracker-dev.mjs` route mount table | exact |
| `src/core/deep-ingest/source-normalize.mjs` | utility | transform | `src/core/intake/classify.mjs`; `src/cli/intake-route.mjs` | role-match |
| `src/core/deep-ingest/source-fetch.mjs` | service | request-response, file-I/O | `src/core/intake/resolve.mjs` | exact |
| `src/core/deep-ingest/source-scanner.mjs` | service | file-I/O, request-response, transform | `src/cli/intake-route.mjs`; `src/core/intake/resolve.mjs` | role-match |
| `src/core/deep-ingest/repo-scanner.mjs` | service | file-I/O, batch, transform | `src/core/profile/writing-style.mjs` | partial |
| `src/core/deep-ingest/proposals/evidence.mjs` | service | AI request-response, transform | `src/core/intake/classify.mjs`; `src/core/profile/evidence-writer.mjs` | exact |
| `src/core/deep-ingest/proposals/stories.mjs` | service | AI request-response, transform | `src/core/intake/classify.mjs`; `src/core/interview/story-bank.mjs` | exact |
| `src/core/deep-ingest/proposals/honesty.mjs` | service | AI request-response, transform | `src/core/intake/classify.mjs`; `src/core/profile/comp-guard.mjs` | role-match |
| `src/core/deep-ingest/proposals/voice.mjs` | service | AI request-response, transform | `src/core/profile/writing-style.mjs`; `src/core/ai/bounded-ai.mjs` | role-match |
| `src/core/deep-ingest/proposals/role-signals.mjs` | service | AI request-response, transform | `src/core/intake/classify.mjs`; `src/core/db/verbs/candidate.mjs` | role-match |
| `src/core/deep-ingest/proposals/gaps.mjs` | service | AI request-response, transform | `src/core/intake/classify.mjs`; `src/core/tracker/library-snapshot.mjs` | role-match |
| `src/core/deep-ingest/validators/grounding.mjs` | utility | transform | `src/core/interview/story-bank.mjs`; `src/core/profile/evidence-writer.mjs` | exact |
| `src/core/deep-ingest/validators/privacy.mjs` | utility | transform | `src/core/profile/comp-guard.mjs`; `src/core/profile/evidence-writer.mjs` | exact |
| `src/core/deep-ingest/validators/lane-state.mjs` | utility | transform | `src/core/db/verbs/candidate.mjs`; `apps/web/src/onboarding/steps/FinishStep.jsx` | role-match |
| `src/core/deep-ingest/view-model.mjs` | utility | transform | `src/core/tracker/library-snapshot.mjs` | exact |
| `config/deep-ingest-source.schema.json` | config | validation | `config/intake-classify.schema.json` | exact |
| `config/deep-ingest-proposal.schema.json` | config | validation | `config/evidence.schema.json`; `config/stories.schema.json` | exact |
| `config/deep-ingest-lanes.schema.json` | config | validation | `config/intake-classify.schema.json` | role-match |
| `config/intake-classify.schema.json` | config | validation | `config/intake-classify.schema.json` | exact |
| `config/paste-intake-routes.json` | config | request-response dispatch | `config/paste-intake-routes.json`; `src/cli/intake-route.mjs` | exact |
| `apps/web/src/deep-ingest/DeepIngestPage.jsx` | component/page | request-response, event-driven, file-I/O | `apps/web/src/library/LibraryPage.jsx`; `apps/web/src/app-shell/CaptureBar.jsx`; `apps/web/src/inbox/InboxPage.jsx` | role-match |
| `apps/web/src/deep-ingest/DeepIngestPage.css` | component/style | transform | `apps/web/src/library/LibraryPage.css`; `apps/web/src/styles/app.css`; `apps/web/src/styles/tokens.css` | role-match |
| `apps/web/src/deep-ingest/DeepIngestPage.test.jsx` | test | request-response, event-driven | `apps/web/src/library/LibraryPage.test.jsx`; `apps/web/src/onboarding/steps/FinishStep.test.jsx` | role-match |
| `apps/web/src/App.jsx` | config/route | request-response | `apps/web/src/App.jsx` | exact |
| `apps/web/src/lib/api.js` | utility | request-response | `apps/web/src/lib/api.js` intake + dashboard wrappers | exact |
| `apps/web/src/app-shell/CaptureBar.jsx` | component | event-driven, file-I/O | `apps/web/src/app-shell/CaptureBar.jsx` | exact |
| `apps/web/src/library/LibraryPage.jsx` | component/page | request-response, transform | `apps/web/src/library/LibraryPage.jsx` | exact |
| `apps/web/src/library/LibraryPage.css` | component/style | transform | `apps/web/src/library/LibraryPage.css` | exact |
| `src/core/tracker/library-snapshot.mjs` | utility/view-model | transform | `src/core/tracker/library-snapshot.mjs`; `src/core/deep-ingest/view-model.mjs` | role-match |
| `apps/web/src/onboarding/steps/FinishStep.jsx` | component/page | request-response, transform | `apps/web/src/onboarding/steps/FinishStep.jsx` | exact |
| `tests/deep-ingest-db.test.mjs` | test | CRUD, batch | `tests/db-intake-verbs.test.mjs`; `tests/db-verbs.test.mjs`; `tests/company-discovery-cache-db.test.mjs` | exact |
| `tests/deep-ingest-route.test.mjs` | test | request-response, file-I/O | `tests/data-route.test.mjs`; `tests/intake-route.test.mjs` | exact |
| `tests/deep-ingest-ai.test.mjs` | test | AI request-response, validation | `tests/bounded-ai.test.mjs` | exact |
| `tests/deep-ingest-source-scanner.test.mjs` | test | file-I/O, request-response | `tests/intake-route.test.mjs`; `src/core/intake/resolve.mjs` tests by pattern | role-match |
| `tests/db-verbs.test.mjs` | test | CRUD, transform | `tests/db-verbs.test.mjs` candidate readiness tests | exact |
| `tests/data-route.test.mjs` | test | request-response | `tests/data-route.test.mjs` candidate route tests | exact |
| `tests/intake-route.test.mjs` | test | request-response, file-I/O | `tests/intake-route.test.mjs` capture/upload/confirm tests | exact |
| `apps/web/src/library/LibraryPage.test.jsx` | test | request-response, transform | `apps/web/src/library/LibraryPage.test.jsx` | exact |
| `apps/web/src/onboarding/steps/FinishStep.test.jsx` | test | request-response, transform | `apps/web/src/onboarding/steps/FinishStep.test.jsx` | exact |

## Pattern Assignments

### SQLite Migration And Registry

**Applies to:** `src/core/db/migrations/008-deep-ingest.mjs`, `src/core/db/migrations.mjs`

**Analogs:** `src/core/db/migrations/003-candidate-setup.mjs`, `src/core/db/migrations/002-intake.mjs`, `src/core/db/migrations/006-company-discovery-cache.mjs`, `src/core/db/migrations.mjs`

**Table pattern** (`003-candidate-setup.mjs` lines 11-88; `002-intake.mjs` lines 24-42):
```javascript
export default {
  version: 3,
  name: "candidate setup",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS candidate_profile (... data TEXT NOT NULL CHECK (json_valid(data)) ...);
      CREATE TABLE IF NOT EXISTS candidate_search_tracks (... name TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL ...);
      CREATE INDEX IF NOT EXISTS idx_candidate_search_tracks_priority ON candidate_search_tracks(priority);
    `);
  },
};
```

**Proposal/cache table pattern** (`006-company-discovery-cache.mjs` lines 8-43):
```javascript
db.exec(`
  CREATE TABLE IF NOT EXISTS company_discovery_proposal_batches (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_company_discovery_proposal_batches_created_at
    ON company_discovery_proposal_batches(created_at);
`);
```

**Registry pattern** (`src/core/db/migrations.mjs` lines 14-82):
```javascript
import migration006 from "./migrations/006-company-discovery-cache.mjs";

export const ALL_MIGRATIONS = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
];

for (let i = 0; i < ALL_MIGRATIONS.length; i += 1) {
  if (ALL_MIGRATIONS[i].version !== i + 1) {
    throw new Error("migrations must be sequential");
  }
}
```

**Planner note:** Current migration files include `007-sourcing-runs.mjs`; create `008-deep-ingest.mjs` as the next migration unless another migration lands first. Use JSON payload columns plus generated columns for lane/status/source indexes. Do not create legacy `candidate/` YAML as part of migration.

---

### DB Verbs And Candidate Readiness

**Applies to:** `src/core/db/verbs/deep-ingest.mjs`, `src/core/db/verbs/index.mjs`, `src/core/db/verbs.mjs`, `src/cli/data.mjs`, `tests/deep-ingest-db.test.mjs`, `tests/db-verbs.test.mjs`

**Analogs:** `src/core/db/verbs/shared.mjs`, `src/core/db/verbs/candidate.mjs`, `src/core/db/verbs/intake.mjs`, `src/core/db/verbs/company-discovery.mjs`, `src/cli/data.mjs`

**Transactional write wrapper** (`src/core/db/verbs/shared.mjs` lines 142-153):
```javascript
export function runVerb({ repoRoot, env, operation, activity, mutate, exportAfter = true }) {
  const db = requireDb({ repoRoot, env });
  const result = db.transaction(() => {
    const data = mutate(db);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, activity);
    return { ok: true, data, meta, event };
  })();
  if (exportAfter) exportToTracker({ repoRoot, env });
  return result;
}
```

**Non-tracker queue verb pattern** (`src/core/db/verbs/intake.mjs` lines 1-49, 65-96):
```javascript
// Intake items are durable queue state, not tracker-visible rows.
function runIntakeVerb({ repoRoot, env, mutate }) {
  const db = requireDb({ repoRoot, env });
  return db.transaction(() => mutate(db))();
}

function putIntakeItem(db, item) {
  db.prepare(`
    INSERT INTO intake_items (id, data, created_at, updated_at)
    VALUES (@id, @data, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(...);
}
```

**Confirm-first proposal update pattern** (`src/core/db/verbs/company-discovery.mjs` lines 172-249):
```javascript
export function companyProposalDecisionPatch({ repoRoot, batchId, proposalId, expectedVersion, decision }) {
  return runCompanyDiscoveryVerb({
    repoRoot,
    mutate(db) {
      const batch = readLatestProposalBatch(db);
      if (batch.version !== expectedVersion) {
        const err = new Error("proposal version conflict");
        err.code = "VERSION_CONFLICT";
        throw err;
      }
      // Patch proposal decision state, preserving immutable source data.
    },
  });
}
```

**Candidate readiness source** (`src/core/db/verbs/candidate.mjs` lines 295-345):
```javascript
function computeCandidateSetup(config) {
  const setup = {
    readiness: {
      search_ready: searchMissing.length === 0,
      gate_ready: gateMissing.length === 0,
      apply_ready: applyMissing.length === 0,
      deep_ingest_complete: deepMissing.length === 0,
    },
    missing: { search_ready: searchMissing, gate_ready: gateMissing, apply_ready: applyMissing, deep_ingest_complete: deepMissing },
  };
  return setup;
}
```

**CLI command shape** (`src/cli/data.mjs` lines 1-15, 479-540):
```javascript
// `rolester data <verb>` is a thin argv shim over the exact same lib functions
// the HTTP route (src/cli/data-route.mjs) calls.

function cmdCandidate(sub, rest) {
  switch (sub) {
    case "init":
      return printResult(candidateSetupInitialize(pathCtx));
    case "get":
      return printResult(candidateConfigGet(pathCtx));
    case "patch":
      return printResult(candidateConfigPatch({ ...pathCtx, name, patch: readPayload("candidate patch") }));
  }
}
```

**Test pattern** (`tests/db-verbs.test.mjs` lines 719-875):
```javascript
test("candidate setup recomputes quick-start readiness from SQLite setup facts", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  candidateConfigPatch({ repoRoot, name: "profile", patch: { candidate: { full_name: "Ada Lovelace" } } });
  candidateArtifactPut({ repoRoot, id: "source-resume", kind: "source-resume", data: { path: "candidate/SOURCE_RESUME.md" } });
  const config = candidateConfigGet({ repoRoot });

  assert.equal(config.setup.readiness.search_ready, true);
  assert.equal(config.setup.readiness.deep_ingest_complete, false);
});
```

**Planner note:** Deep ingest lane/proposal verbs are not ordinary tracker mutations unless they promote confirmed facts into candidate config/evidence/stories. Queue/proposal mutations should follow `intake`/`company-discovery` no-meta or proposal-state patterns. Confirmed candidate facts should reuse candidate verbs or the shared transaction path and then recompute setup readiness. Replace the old `deep_ingest_complete` heuristic with terminal-lane state (`completed`, `deferred`, `not_available`) from deep ingest tables.

---

### Local API Route, Body Caps, And Mounting

**Applies to:** `src/cli/deep-ingest-route.mjs`, `src/cli/tracker-dev.mjs`, `tests/deep-ingest-route.test.mjs`, `tests/data-route.test.mjs`

**Analogs:** `src/cli/data-route.mjs`, `src/cli/intake-route.mjs`, `src/cli/discovery-route.mjs`, `src/cli/skill-run-route.mjs`, `src/cli/tracker-dev.mjs`

**Capped body helpers** (`src/cli/skill-run-route.mjs` lines 43-128):
```javascript
export function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

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
      resolve(text ? JSON.parse(text) : {});
    });
  });
}
```

**DB fail-closed wrapper** (`src/cli/data-route.mjs` lines 82-114):
```javascript
export function mountDataRoutes({ addRoute, repoRoot, env = process.env }) {
  function withDb(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        respondError(res, err);
      }
    };
  }

  function withBodyVerb(fn) {
    return withDb(async (req, res) => {
      const body = await readBody(req);
      const result = fn(body);
      respondResult(res, result);
    });
  }
}
```

**Capture route pattern** (`src/cli/intake-route.mjs` lines 364-412, 414-485):
```javascript
addRoute("POST", "/api/intake", async (req, res) => {
  const body = await readJsonBodyCapped(req, MAX_JSON_BODY_BYTES);
  const item = intakeCapture({ repoRoot, rawInput: body.text, inputKind });
  classifyAndPropose(item).catch(...);
  sendJson(res, 200, { ok: true, item });
});

addRoute("POST", "/api/intake/upload", async (req, res) => {
  const bytes = await readRawBodyCapped(req, MAX_UPLOAD_BYTES);
  // write file under workspace/intake/uploads, then queue a needs_you item
});
```

**Discovery proposal pattern** (`src/cli/discovery-route.mjs` lines 186-266):
```javascript
addRoute("POST", "/api/discovery/company-proposals", async (req, res) => {
  let body;
  try {
    body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
  } catch (err) {
    sendJson(res, err.status || 400, { ok: false, error: err.message });
    return;
  }
  const result = await createCompanyProposalBatch({ repoRoot, seeds: body.seeds });
  sendJson(res, 200, result);
});
```

**Mount pattern** (`src/cli/tracker-dev.mjs` lines 282-290, 342-360, 436-443, 485-493):
```javascript
function addRoute(method, path, handler) {
  routes.set(`${method} ${path}`, handler);
}

mountDataRoutes({ addRoute, repoRoot, env });
mountIntakeRoutes({ addRoute, repoRoot, env });
mountDiscoveryRoutes({ addRoute, repoRoot, env });

const route = routes.get(`${req.method} ${pathname}`);
if (route) return route(req, res);
// /app/* falls through to the SPA shell
```

**Route test pattern** (`tests/data-route.test.mjs` lines 36-80, 116-155, 253-320):
```javascript
function bootServer(repoRoot) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDataRoutes({ addRoute, repoRoot, env: {} });
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) return res.writeHead(404).end();
    route(req, res);
  });
}

test("POST /api/data/app/status: 409 when no db exists yet", async () => {
  const { status, body } = await postJson(server, "/api/data/app/status", { id: "app-1", to: "offer" });
  assert.equal(status, 409);
  assert.match(body.error, /no database yet/);
});
```

**Planner note:** Deep ingest routes should be local API routes mounted directly in `tracker-dev`, not chat or `POST /api/skill/run`. Keep body caps explicit. Use `409` for missing DB, `400` for malformed payloads, `413` for caps, `404` for unknown IDs, `409` for proposal version conflicts.

---

### Source Capture, Fetch, And Scanner Handling

**Applies to:** `src/core/deep-ingest/source-normalize.mjs`, `src/core/deep-ingest/source-fetch.mjs`, `src/core/deep-ingest/source-scanner.mjs`, `src/core/deep-ingest/repo-scanner.mjs`, `config/paste-intake-routes.json`, `tests/deep-ingest-source-scanner.test.mjs`, `tests/intake-route.test.mjs`

**Analogs:** `src/core/intake/resolve.mjs`, `src/cli/intake-route.mjs`, `src/core/db/verbs/intake.mjs`, `src/core/profile/writing-style.mjs`

**Deterministic URL fetch/defer pattern** (`src/core/intake/resolve.mjs` lines 1-13, 29-70, 117-162):
```javascript
export async function resolveJobUrl(rawUrl, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { bodyFetchStatus: "deferred", url: rawUrl, provider: null, reason: "invalid URL" };
  }

  if (isSpaJobHost(parsed.hostname) || platformForHost(parsed.hostname)) {
    return {
      bodyFetchStatus: "deferred",
      url: rawUrl,
      provider,
      reason: "SPA-rendered or login-gated host ...",
    };
  }

  return resolvePlainFetch({ url: rawUrl, fetchImpl, timeoutMs, provider });
}
```

**Raw capture pattern** (`src/core/db/verbs/intake.mjs` lines 73-96, 104-132):
```javascript
function writeRawCapture({ repoRoot, id, rawInput }) {
  const relPath = `workspace/intake/pastes/${id}.txt`;
  writeFileSync(userPath({ repoRoot }, relPath), rawInput, "utf8");
  return relPath;
}

export function intakeCapture({ repoRoot, rawInput, inputKind = "text", sourceFilePath = null }) {
  return runIntakeVerb({
    repoRoot,
    mutate(db) {
      const item = { id, rawInput, inputKind, sourceFilePath, status: "captured" };
      putIntakeItem(db, item);
      return item;
    },
  });
}
```

**Upload route test pattern** (`tests/intake-route.test.mjs` lines 391-424):
```javascript
test("POST /api/intake/upload: captures binary files under workspace/intake/uploads and queues a needs_you item", async () => {
  const bytes = Buffer.from("%PDF-1.7\nfake pdf body\n");
  const { status, body } = await postRaw(server, "/api/intake/upload?name=..%2Fprivate%20JD.pdf", bytes, {
    "content-type": "application/pdf",
  });

  assert.equal(status, 200);
  assert.equal(body.item.inputKind, "file");
  assert.equal(body.item.status, "needs_you");
  assert.match(body.item.sourceFilePath, /^workspace\/intake\/uploads\/.+-private_JD\.pdf$/);
});
```

**Writing-sample discovery pattern for repo/local scans** (`src/core/profile/writing-style.mjs` lines 34-78):
```javascript
export function discoverWritingSamples({ repoRoot }) {
  // Find supported text files, skip unavailable paths, and return source metadata.
}

export function analyzeWritingSamples(samples) {
  // Derive style observations only; do not import factual claims from samples.
}
```

**Project/repo evidence-mining boundary** (`.agents/skills/ingest-profile/SKILL.md` lines 139-187):
```text
Scan README/docs, manifests, primary source modules, git log/contributor history,
tests/CI, and scale/usage hints the repo genuinely shows.

A repo proves the work exists and its shape; it does not prove impact.
Draw adoption, revenue, or performance numbers only from candidate confirmation
or a source that actually shows them.
```

**Planner note:** Source scanning must preserve raw provenance and explicit failure states. Fetchers return `resolved`, `deferred`, `not_available`, `truncated`, or equivalent lane/source statuses; they do not hallucinate around private, login-gated, too-large, or unreadable sources. Repo scanning has only a partial analog; keep it small, deterministic, path allowlisted, and test with injected filesystem/network dependencies.

---

### Bounded AI Proposals And Schema Validation

**Applies to:** `src/core/deep-ingest/proposals/evidence.mjs`, `stories.mjs`, `honesty.mjs`, `voice.mjs`, `role-signals.mjs`, `gaps.mjs`, `config/deep-ingest-proposal.schema.json`, `tests/deep-ingest-ai.test.mjs`

**Analogs:** `src/core/ai/bounded-ai.mjs`, `src/core/intake/classify.mjs`, `src/core/ai/structured-oneshot.mjs`, `tests/bounded-ai.test.mjs`

**Bounded AI labels and envelopes** (`src/core/ai/bounded-ai.mjs` lines 25-53, 96-106, 200-272, 274-402):
```javascript
export function requireBoundedAILabels(labels) {
  const missing = ["feature", "operation", "data_classification"].filter((key) => !labels?.[key]);
  if (missing.length) {
    const err = new Error(`bounded AI labels missing: ${missing.join(", ")}`);
    err.code = "BOUNDED_AI_LABELS_MISSING";
    throw err;
  }
}

export async function runBoundedAI({ schema, prompt, labels, env, fetchImpl }) {
  requireBoundedAILabels(labels);
  // Prefer native JSON schema, retry/fallback through schema validation, return manual-safe envelopes.
}
```

**Intake classifier prompt contract** (`src/core/intake/classify.mjs` lines 1-15, 91-147, 159-235):
```javascript
// Pasted content is data, not instructions.
const labels = {
  feature: "universal-intake",
  operation: "classify-paste",
  data_classification: "candidate-local",
};

const result = await runBoundedAI({
  schema,
  prompt,
  labels,
  env,
  fetchImpl,
});

if (!result.ok) {
  return { status: "needs_you", needsUserReason: result.reason };
}
```

**Structured one-shot schema validation** (`src/core/ai/structured-oneshot.mjs` lines 1-23, 48-85, 98-123):
```javascript
export async function runStructuredOneshot({ prompt, schema, callAIImpl }) {
  const response = await callAIImpl({ prompt });
  const data = parseStructuredJson(response.text);
  const validation = validate(data, schema);
  if (!validation.ok) {
    // Retry once with a corrective addendum, then fail schema-invalid.
  }
  return data;
}
```

**AI test pattern** (`tests/bounded-ai.test.mjs` lines 75-134, 221-245, 322-398):
```javascript
test("missing bounded AI labels fails before invoking provider", async () => {
  await assert.rejects(
    () => runBoundedAI({ schema, prompt: "x", labels: {}, fetchImpl }),
    /bounded AI labels missing/
  );
  assert.equal(providerCalls.length, 0);
});

test("schema invalid returns a safe manual envelope", async () => {
  const result = await runBoundedAI({ schema, prompt, labels, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.code, "SCHEMA_INVALID");
});
```

**Planner note:** Each proposal module should produce proposals only, not committed facts. The AI response schema must be loaded from `config/deep-ingest-proposal.schema.json` and validated with `validate`. Use bounded labels per proposal type, keep `source_ids`/provenance required, and return manual-review envelopes on `NO_AI_ROUTE`, provider failure, or schema failure.

---

### Grounding, Privacy, Evidence, Stories, And Voice

**Applies to:** `src/core/deep-ingest/validators/grounding.mjs`, `src/core/deep-ingest/validators/privacy.mjs`, proposal modules, `config/deep-ingest-proposal.schema.json`

**Analogs:** `src/core/profile/evidence-writer.mjs`, `src/core/interview/story-bank.mjs`, `src/core/profile/comp-guard.mjs`, `src/core/profile/writing-style.mjs`

**Evidence validator pattern** (`src/core/profile/evidence-writer.mjs` lines 93-146, 166-245):
```javascript
function validateClaims(claims) {
  for (const claim of claims) {
    if (!claim.claim || !claim.evidence) throw new Error("claim and evidence are required");
    if (findCurrentBaseToken(claim.claim) || findCurrentBaseToken(claim.evidence)) {
      throw new Error("current compensation is private and cannot be written");
    }
  }
}

export function computeEvidenceWrite({ existing, incoming }) {
  const normalized = validateClaims(incoming);
  return upsertClaimsById(existing, normalized);
}
```

**Story grounding pattern** (`src/core/interview/story-bank.mjs` lines 137-220, 317-395):
```javascript
function validateStories(stories, evidenceClaims) {
  for (const story of stories) {
    for (const field of STAR_FIELDS) {
      if (!story[field]) throw new Error(`story.${field} is required`);
    }
    if (!story.evidence_ids?.length) throw new Error("story evidence_ids are required");
    for (const id of story.evidence_ids) {
      if (!evidenceClaims.has(id)) throw new Error(`unknown evidence id: ${id}`);
    }
  }
}
```

**Comp privacy guard** (`src/core/profile/comp-guard.mjs` lines 1-45):
```javascript
export function findCurrentBaseToken(value) {
  const text = String(value || "");
  return CURRENT_BASE_PATTERNS.find((pattern) => pattern.test(text)) || null;
}
```

**Voice/style boundary** (`src/core/profile/writing-style.mjs` lines 80-115):
```javascript
// Style only; factual claims still come from source resume/JD/honesty evidence.
// Do not import facts from writing samples.
```

**Planner note:** Deep ingest validators should reject ungrounded claims, missing source pointers, placeholder text, private current-comp tokens, and proposal fields that try to cross from style/source notes into factual candidate claims. Use `source_ids` to trace every proposed evidence/story/honesty/role-signal/gap item.

---

### View Model, Library Snapshot, And Readiness UI

**Applies to:** `src/core/deep-ingest/view-model.mjs`, `src/core/tracker/library-snapshot.mjs`, `src/core/deep-ingest/validators/lane-state.mjs`, `apps/web/src/library/LibraryPage.jsx`, `apps/web/src/onboarding/steps/FinishStep.jsx`

**Analogs:** `src/core/tracker/library-snapshot.mjs`, `apps/web/src/library/LibraryPage.jsx`, `apps/web/src/onboarding/steps/FinishStep.jsx`

**Library snapshot transform** (`src/core/tracker/library-snapshot.mjs` lines 24-47, 97-169, 194-280):
```javascript
function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function evidenceCards(evidence) {
  return list(evidence.claims).map((claim) => ({
    id: claim.id,
    type: "evidence",
    title: claim.claim,
    meta: claim.evidence,
  }));
}

export function buildLibrarySnapshot({ candidate }) {
  return {
    metrics,
    index,
    filters,
    cards,
    readiness,
    gaps,
    storyLanes,
  };
}
```

**Library page data flow** (`apps/web/src/library/LibraryPage.jsx` lines 60-91, 195-229, 232-397):
```javascript
function filterLibraryCards(cards, filters) {
  return cards.filter((card) => {
    if (filters.type !== "all" && card.type !== filters.type) return false;
    if (filters.query && !card.searchText.includes(filters.query)) return false;
    return true;
  });
}

export default function LibraryPage() {
  const { snapshot, loading, noDatabase } = useDashboardSnapshot();
  const library = normalizeLibrary(snapshot?.library);
  const filteredCards = filterLibraryCards(library.cards, filters);
  // Render summary tiles, lanes, toolbar, aria-live count, card grid, empty state.
}
```

**Finish readiness pattern** (`apps/web/src/onboarding/steps/FinishStep.jsx` lines 16-37, 78-119, 318-351, 456-466):
```javascript
const READINESS_ROWS = [
  { key: "search_ready", label: "Search ready" },
  { key: "gate_ready", label: "Gate ready" },
  { key: "apply_ready", label: "Apply ready" },
  { key: "deep_ingest_complete", label: "Deep ingest complete" },
];

function buildReadinessRows(setup) {
  return READINESS_ROWS.map((row) => ({
    ...row,
    ready: Boolean(setup?.readiness?.[row.key]),
    missing: setup?.missing?.[row.key] || [],
  }));
}
```

**Planner note:** `src/core/deep-ingest/view-model.mjs` should become the DB-backed read model for source lanes, proposals, accepted facts, terminal lane state, and gaps. `library-snapshot.mjs` should consume that model instead of reading candidate files for deep-ingest additions. `FinishStep.jsx` should link to the app-native deep ingest page and remove any "deeper interview/chat" handoff language for this lane.

---

### React Page, API Client, Capture Bar, CSS, And Routing

**Applies to:** `apps/web/src/deep-ingest/DeepIngestPage.jsx`, `DeepIngestPage.css`, `DeepIngestPage.test.jsx`, `apps/web/src/App.jsx`, `apps/web/src/lib/api.js`, `apps/web/src/app-shell/CaptureBar.jsx`, `apps/web/src/library/LibraryPage.css`, `apps/web/src/library/LibraryPage.test.jsx`

**Analogs:** `apps/web/src/library/LibraryPage.jsx`, `apps/web/src/library/LibraryPage.css`, `apps/web/src/components/*`, `apps/web/src/lib/api.js`, `apps/web/src/app-shell/CaptureBar.jsx`, `apps/web/src/App.jsx`

**Route map pattern** (`apps/web/src/App.jsx` lines 1-35):
```javascript
import LibraryPage from "./library/LibraryPage.jsx";

const routes = {
  "/library": LibraryPage,
  "/inbox": InboxPage,
};

export default function App() {
  const Page = routes[window.location.pathname] || HomePage;
  return <Page />;
}
```

**API wrapper pattern** (`apps/web/src/lib/api.js` lines 10-38, 253-330, 342-348):
```javascript
export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.error || "Request failed", { status: response.status, body });
  return body;
}

export function createIntake(payload) {
  return apiFetch("/api/intake", { method: "POST", body: JSON.stringify(payload) });
}
```

**Scoped capture/file handling** (`apps/web/src/app-shell/CaptureBar.jsx` lines 9-26, 54-86, 95-140, 146-185):
```javascript
async function handleSubmit(event) {
  event.preventDefault();
  const result = await createIntake({ text, source: "capture-bar" });
  setResult(result);
  window.dispatchEvent(new CustomEvent("rolester:intake-changed"));
}

async function handleDrop(event) {
  event.preventDefault();
  const files = Array.from(event.dataTransfer.files || []);
  // Read text files client-side; upload binary files through /api/intake/upload.
}
```

**Component primitives** (`apps/web/src/components/PageScaffold.jsx` lines 1-18; `Button.jsx` lines 1-33; `form.jsx` lines 12-155):
```javascript
export function PageScaffold({ eyebrow, title, subtitle, actions, children }) {
  return (
    <main className="page-scaffold">
      <header className="page-scaffold__header">...</header>
      {children}
    </main>
  );
}

export function Button({ variant = "secondary", className = "", ...props }) {
  return <button className={`btn btn--${variant} ${className}`} {...props} />;
}
```

**CSS token/style pattern** (`apps/web/src/styles/tokens.css` lines 23-108; `apps/web/src/styles/app.css` lines 1-4, 227-307, 587-608, 776-825; `apps/web/src/library/LibraryPage.css` lines 1-15, 97-147, 250-264, 380-393):
```css
/* Plain CSS, no Tailwind. */
.library-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-3);
}

.library-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

@media (max-width: 720px) {
  .library-summary {
    grid-template-columns: 1fr;
  }
}
```

**Frontend test pattern** (`apps/web/src/library/LibraryPage.test.jsx` lines 1-17, 19-67, 69-131):
```javascript
vi.mock("../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => ({ snapshot: fixture, loading: false, noDatabase: false }),
}));

function renderPage() {
  return render(<LibraryPage />);
}

it("renders the full uncapped bank", () => {
  renderPage();
  expect(screen.getByText("Evidence")).toBeInTheDocument();
});
```

**Planner note:** Build the actual deep ingest workbench as the first screen. Use the local component primitives, CSS tokens, responsive grids, `aria-live` status text, and fetch wrappers. Do not put the page inside decorative nested cards. For uploads and paste/drop, keep the event handling scoped to the component like `CaptureBar`.

---

### Backend Node Tests

**Applies to:** `tests/deep-ingest-db.test.mjs`, `tests/deep-ingest-route.test.mjs`, `tests/deep-ingest-ai.test.mjs`, `tests/deep-ingest-source-scanner.test.mjs`, updated `tests/db-verbs.test.mjs`, `tests/data-route.test.mjs`, `tests/intake-route.test.mjs`

**Analogs:** `tests/db-intake-verbs.test.mjs`, `tests/db-verbs.test.mjs`, `tests/data-route.test.mjs`, `tests/intake-route.test.mjs`, `tests/bounded-ai.test.mjs`, `tests/company-discovery-cache-db.test.mjs`

**Temp repo + cleanup** (`tests/db-intake-verbs.test.mjs` lines 7-40; `tests/data-route.test.mjs` lines 17-34):
```javascript
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-deep-ingest-"));
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

**Route boot helper** (`tests/intake-route.test.mjs` lines 135-187):
```javascript
function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountIntakeRoutes({ addRoute, repoRoot, env: opts.env ?? PROXY_ENV, fetchImpl: opts.fetchImpl });
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) return res.writeHead(404).end();
    route(req, res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
```

**DB queue assertions** (`tests/db-intake-verbs.test.mjs` lines 50-74, 115-134, 156-181, 194-212, 228-250):
```javascript
test("capture persists a raw text item without bumping tracker meta", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const item = intakeCapture({ repoRoot, rawInput: "hello", inputKind: "text" });
  assert.equal(item.status, "captured");
  assert.match(item.capturedPath, /^workspace\/intake\/pastes\//);
});

test("confirm transitions the queued item and logs activity", () => {
  const result = intakeDecide({ repoRoot, id: item.id, decision: "confirm" });
  assert.equal(result.status, "done");
});
```

**Migration assertions** (`tests/db-migrations.test.mjs` lines 19-55, 91-107, 137-161):
```javascript
test("migrations apply to an empty db and are no-op when rerun", () => {
  const db = openDb({ repoRoot });
  const version = db.pragma("user_version", { simple: true });
  assert.equal(version, ALL_MIGRATIONS.length);
});

test("migration list must stay sequential", () => {
  assert.throws(() => assertSequential([{ version: 1 }, { version: 3 }]));
});
```

**Planner note:** New tests should cover migration shape/indexes, no DB `409`, route body caps, terminal lane readiness, proposal version conflicts, AI schema failure envelopes, source fetch deferrals, and confirm-only writes into candidate facts.

## Shared Patterns

### DB Workspace Contract

**Source:** `AGENTS.md` lines 292-342  
**Apply to:** all deep-ingest DB writes and APIs

DB workspaces write through SQLite verbs, not hand edits to `workspace/tracker.json`. `rolester data` verbs stamp/export where applicable; proposal/queue-only state should follow existing no-export patterns like intake/company discovery. Run route/API work fail-closed when no database exists.

### Local API, Not Chat Runtime

**Source:** `AGENTS.md` lines 114-130  
**Apply to:** deep-ingest APIs, proposal creation, proposal decisions

Deep ingest proposal creation and decisions should stay in local app APIs. Do not silently start chat, `/api/chat/*`, the full skill runtime, or `POST /api/skill/run`. Use explicit user-selected chat handoffs only outside this phase's core path.

### Paste/Source Intake Safety

**Source:** `AGENTS.md` lines 468-516; `src/core/intake/classify.mjs` lines 1-15  
**Apply to:** source scanner, source fetcher, capture bar, deep-ingest route

Every pasted or dropped source is captured durably, and source text is treated as data, not instructions. Unknown/unreadable content becomes a visible `needs_you`, `deferred`, or `not_available` lane state rather than disappearing or becoming a false success.

### Privacy And Honesty

**Source:** `AGENTS.md` lines 697-815, 1134-1164; `src/core/profile/comp-guard.mjs` lines 1-45; `src/core/interview/story-bank.mjs` lines 137-220

Never promote current-comp/private tokens. Every story and evidence proposal must trace to existing source/evidence IDs. Reject or mark gaps for ungrounded facts instead of filling them with model output.

### Schema Validation

**Source:** `src/core/profile/schema-validator.mjs` lines 11-23, 60-134; `config/intake-classify.schema.json` lines 1-41

Use JSON schemas with `required`, `enum`, and `additionalProperties: false`. Validate all AI/proposal payloads before persistence, and format validation errors for route responses/tests.

## No Analog Found

No file is fully without an analog. `src/core/deep-ingest/repo-scanner.mjs` has only a partial match in `src/core/profile/writing-style.mjs`; planner should treat it as a conservative new utility: injected filesystem access, explicit include/exclude rules, caps, no secret scanning beyond source metadata, and clear `deferred`/`not_available` outputs.

## Metadata

**Analog search scope:** `src/core/db`, `src/cli`, `src/core/ai`, `src/core/intake`, `src/core/profile`, `src/core/tracker`, `apps/web/src`, `config`, `tests`  
**Project skills checked:** 26 local `.agents/skills/*/SKILL.md` indexes; relevant contracts folded into shared DB-first, confirm-first, durable-capture, privacy, and repo-evidence notes above  
**Current migration head observed:** `007-sourcing-runs.mjs`  
**Pattern extraction date:** 2026-07-05
