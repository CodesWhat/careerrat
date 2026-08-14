# Phase 10: Local Packet Engine - Pattern Map

**Mapped:** 2026-07-06
**Files analyzed:** 19
**Analogs found:** 19 / 19

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/cli/packet-route.mjs` | route/controller | request-response, CRUD | `src/cli/packet-route.mjs` + `src/cli/data-route.mjs` | exact |
| `src/core/packet/context.mjs` | service | CRUD, transform | `src/core/discovery/company-context.mjs` | role-match |
| `src/core/packet/gate.mjs` | service | request-response, transform, bounded-AI | `src/core/evaluate/gate.mjs` + `src/core/discovery/company-seeds.mjs` | role-match |
| `src/core/packet/generate.mjs` | service/orchestrator | CRUD, file-I/O, transform, bounded-AI | `src/core/discovery/company-proposals.mjs` | role-match |
| `src/core/packet/answers.mjs` | service | request-response, transform, bounded-AI | `src/core/discovery/company-seeds.mjs` + `src/core/documents/tailor.mjs` | role-match |
| `src/core/packet/questions.mjs` | service | request-response, transform | `src/core/apply/form-questions.mjs` | exact |
| `src/core/packet/exports.mjs` | utility/service | file-I/O, transform | `src/core/documents/export.mjs` + `src/cli/export.mjs` | exact |
| `src/core/packet/schemas/packet-schemas.mjs` | config/utility | transform, validation | `src/core/discovery/company-seeds.mjs` | role-match |
| `src/core/apply/form-questions.mjs` | utility/service | request-response, transform | `src/core/apply/form-questions.mjs` | exact |
| `src/core/db/verbs/app.mjs` | service/model | CRUD | `src/core/db/verbs/app.mjs` + `src/core/db/verbs/shared.mjs` | exact |
| `src/core/onboarding/packet-page.mjs` | component/page | event-driven, request-response | `src/core/onboarding/packet-page.mjs` | exact |
| `src/core/ai/answer-page.mjs` | component/page | event-driven, request-response | `src/core/ai/answer-page.mjs` | exact |
| `tests/packet-generate-route.test.mjs` | test | request-response, CRUD | `tests/packet-route.test.mjs` + `tests/data-route.test.mjs` | role-match |
| `tests/packet-engine.test.mjs` | test | CRUD, file-I/O, transform | `tests/documents-tailor.test.mjs` + `tests/bounded-ai.test.mjs` | role-match |
| `tests/packet-answers.test.mjs` | test | request-response, transform, bounded-AI | `tests/form-questions.test.mjs` + `tests/documents-tailor.test.mjs` | role-match |
| `tests/packet-export.test.mjs` | test | file-I/O | `src/cli/export.mjs` + `tests/packet-route.test.mjs` | partial |
| `tests/packet-runtime-boundary.test.mjs` | test/static guard | transform | `tests/company-discovery-regression.test.mjs` | role-match |
| `tests/packet-page.test.mjs` | test | event-driven, request-response | `tests/packet-page.test.mjs` | exact |
| `tests/answer-page.test.mjs` | test | event-driven, request-response | `tests/answer-page.test.mjs` | exact |

## Pattern Assignments

### `src/cli/packet-route.mjs` (route/controller, request-response)

**Analogs:** `src/cli/packet-route.mjs`, `src/cli/data-route.mjs`, `src/cli/discovery-route.mjs`

**Imports pattern** (`src/cli/packet-route.mjs` lines 53-61):

```javascript
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";
import { requireDb } from "../core/db/connection.mjs";
import { assembleTrackerObject } from "../core/db/export-to-tracker.mjs";
import { markdownToHtml } from "../core/documents/export.mjs";
import { lintArtifact } from "../core/documents/placeholder-lint.mjs";
import { resolveUserPaths } from "../core/paths/workspace.mjs";
import { classifyStage } from "../core/tracker/dashboard.mjs";
import { sendJson } from "./skill-run-route.mjs";
```

**Capped body + verb response pattern** (`src/cli/data-route.mjs` lines 78-114):

```javascript
async function readBody(req) {
  return readJsonBodyCapped(req, MAX_BODY_BYTES);
}

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

**Route shape to copy** (`src/cli/data-route.mjs` lines 270-276):

```javascript
addRoute("POST", "/api/data/app/artifact", async (req, res) => {
  await withBodyVerb(req, res, (body) => {
    if (!body?.id || !body?.kind || !body?.path) {
      throw badRequest("body.id, body.kind, and body.path are required");
    }
    return appRegisterArtifact({ ...pathCtx, ...body });
  });
});
```

**Read-only packet route pattern** (`src/cli/packet-route.mjs` lines 211-226, 235-263):

```javascript
export function readPacketApplicationsFromDb({ repoRoot, env = process.env } = {}) {
  const db = requireDb({ repoRoot, env });
  const tracker = assembleTrackerObject(db);
  return {
    applications: Array.isArray(tracker.applications) ? tracker.applications : [],
    stages: tracker.stages,
  };
}

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  return 500;
}

function respondError(res, err) {
  sendJson(res, statusForError(err), { ok: false, error: err?.message || String(err) });
}
```

```javascript
addRoute("GET", "/api/packet/list", (_req, res) => {
  let packetRows;
  try {
    packetRows = readPacketApplicationsFromDb(pathCtx);
  } catch (err) {
    respondError(res, err);
    return;
  }

  const workspaceDir = resolveUserPaths(pathCtx).workspaceDir;
  const { applications, stages } = packetRows;

  const rows = applications
    .filter((app) => isGatedIn(app, stages))
    .map((app) => {
      const artifacts = app.artifacts || {};
      return {
        id: app.id,
        company: app.company ?? null,
        role: app.role ?? null,
        status: app.status ?? null,
        hasResume: Boolean(artifacts.resume),
        hasCoverLetter: Boolean(artifacts.coverLetter),
        hasAnswers: Boolean(artifacts.answers),
        needsYouCount: countNeedsYou(workspaceDir, artifacts.answers),
      };
    });

  sendJson(res, 200, rows);
});
```

**Discovery route pattern for local bounded API POSTs** (`src/cli/discovery-route.mjs` lines 313-348):

```javascript
addRoute("POST", "/api/discovery/company-proposals", async (req, res) => {
  let body;
  try {
    body = await readJsonBodyCapped(req, COMPANY_PROPOSAL_BODY_MAX_BYTES);
  } catch (err) {
    sendJson(res, err.status || 400, {
      ok: false,
      code: err.status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
      error: { message: err.message },
    });
    return;
  }

  try {
    const result = await createCompanyProposalBatch({
      repoRoot,
      env,
      body,
      fetchImpl,
      resolveCompanyBoard,
      scanCompaniesImpl,
      seedCall,
      now,
    });
    if (result.body) {
      sendJson(res, result.status || 500, result.body);
      return;
    }
    sendJson(res, 200, { ok: true, data: result.data, meta: result.meta });
  } catch (err) {
    sendJson(res, err.status || 500, {
      ok: false,
      code: err.code || "COMPANY_PROPOSAL_FAILED",
      error: { message: err.message },
    });
  }
});
```

**Apply to Phase 10:** add `POST /api/packet/gate`, `POST /api/packet/generate`, `POST /api/packet/questions`, `POST /api/packet/answers`, and optionally `POST /api/packet/export` in this same route module. Keep handlers thin: parse body, require DB, call `src/core/packet/*`, translate service result to `sendJson`.

---

### `src/core/packet/context.mjs` (service, CRUD/transform)

**Analog:** `src/core/discovery/company-context.mjs`

**Imports pattern** (lines 1-6):

```javascript
import { existsSync, readFileSync } from "node:fs";
import { dbExists, requireDb } from "../db/connection.mjs";
import { candidateConfigGet, sourceConfigGet } from "../db/verbs.mjs";
import { userPath } from "../paths/workspace.mjs";
import { loadCandidateConfig } from "../profile/config-store.mjs";
import { loadScannerConfig } from "../scoring/sourced-scanner.mjs";
```

**DB row read pattern** (lines 72-78):

```javascript
function readDbRows({ repoRoot, env }, table) {
  const db = requireDb({ repoRoot, env });
  return db
    .prepare(`SELECT data FROM ${table} ORDER BY rowid ASC`)
    .all()
    .map((row) => JSON.parse(row.data));
}
```

**Context assembly pattern** (lines 121-168):

```javascript
export function buildCompanySeedContext({ repoRoot, env = process.env } = {}) {
  const pathCtx = { repoRoot, env };
  const usingDb = dbExists(pathCtx);
  const candidateConfig = usingDb
    ? candidateConfigGet(pathCtx)
    : loadCandidateConfig({ repoRoot, env, fallbackToTemplate: false });
  const profile = candidateConfig.profile || {};
  const targeting = candidateConfig.targeting || {};
  const sourceCompanies = usingDb
    ? readDbSourceCompanies(pathCtx)
    : readLegacySourceCompanies(pathCtx);
  const applicationRows = usingDb
    ? readDbRows(pathCtx, "applications")
    : readLegacyTrackerRows(pathCtx, "applications");
  const sourcedRows = usingDb
    ? readDbRows(pathCtx, "sourced")
    : readLegacyTrackerRows(pathCtx, "sourced");

  return {
    profileDomain: trimString(profile.candidate?.domain || profile.candidate?.headline),
    roleFamilies: roleFamiliesFromTargeting(targeting),
    locationPosture: locationPostureFromProfile(profile),
    keepSignals: compactStrings(targeting.keep_signals),
    cutSignals: compactStrings(targeting.cut_signals),
    excludedCompanies,
    trackedCompanies,
    applications,
    sourcedCompanies,
    compensationFloors: compensationFloorsFromProfile(profile),
    dedupe: {
      companies: dedupeCompanies,
      keys: compactStrings(dedupeCompanies.map(normalizeCompanyKey)),
    },
  };
}
```

**Apply to Phase 10:** build packet context from SQLite-first candidate config, application/sourced row, saved JD artifact, evidence/stories/honesty/writing voice/deep-ingest/public-intel references. Do not include private compensation fields in prompt/context output. Use generated tracker files only as legacy fallback if the planner explicitly keeps a non-DB compatibility path.

---

### `src/core/packet/gate.mjs` (service, request-response/transform/bounded-AI)

**Analogs:** `src/core/evaluate/gate.mjs`, `src/core/discovery/company-seeds.mjs`

**Pure gate helper imports** (`src/core/evaluate/gate.mjs` lines 4-8):

```javascript
import { shouldReviewMediumBodyReadFits } from "../profile/modes.mjs";
import { parseYaml } from "../profile/yaml.mjs";
import { extractCompBand } from "../scoring/sourced-scanner.mjs";
import { classifyEstimateAgainstFloor, estimateCompFromComparables } from "./comp-comparables.mjs";
import { assessLegitimacy } from "./legitimacy.mjs";
```

**Saved JD parse pattern** (`src/core/evaluate/gate.mjs` lines 28-50):

```javascript
export function parseSavedJob(markdown) {
  const text = String(markdown || "");
  let frontmatter = {};
  let rest = text;

  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    const parsed = parseYaml(fmMatch[1]);
    frontmatter =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    rest = fmMatch[2];
  }

  const jdMatch = rest.match(/(?:^|\n)#\s*Job Description\s*\r?\n([\s\S]*?)(?=\n#\s|$)/);
  const gnMatch = rest.match(/(?:^|\n)#\s*Gate Notes\s*\r?\n([\s\S]*?)(?=\n#\s|$)/);

  const body = jdMatch ? jdMatch[1].trim() : "";
  const gateNotes = gnMatch ? gnMatch[1].trim() : "";

  return { frontmatter, body, gateNotes };
}
```

**Deterministic review/keep/cut pattern** (`src/core/evaluate/gate.mjs` lines 598-668):

```javascript
const reviewReasons = [];

if (legitimacy.verdict === "suspect") {
  reviewReasons.push(`legitimacy suspect: ${legitimacy.reason}`);
}
if (comp.verdict === "below-floor") {
  reviewReasons.push(`comp below floor: ${comp.reason}`);
}
if (fit.tier === "stretch") {
  reviewReasons.push(`fit is stretch (score ${fit.score})`);
}
if (fit.tier === "med" && shouldReviewMediumBodyReadFits(modes)) {
  reviewReasons.push("application mode selective: medium fit requires manual review");
}
if (!location.ok) {
  reviewReasons.push(`location concern: ${location.reason}`);
}

if (reviewReasons.length > 0) {
  return {
    gate: "REVIEW",
    fit,
    comp,
    anchor,
    location,
    legitimacy,
    action:
      comp.verdict === "below-floor" || comp.verdict === "estimated-below-floor"
        ? "hold"
        : "manual",
    reasons: reviewReasons,
  };
}

return {
  gate: "KEEP",
  fit,
  comp,
  anchor,
  location,
  legitimacy,
  action: "apply-now",
  reasons,
};
```

**Bounded AI proposal pattern** (`src/core/discovery/company-seeds.mjs` lines 164-208):

```javascript
const result = await runBoundedAI({
  labels: COMPANY_SEED_LABELS,
  schema: companySeedSchema,
  manual: MANUAL_SEED_FALLBACK,
  structuredMode: "native-preferred",
  outputName: "company_seed_response",
  maxTokens: 1200,
  root: repoRoot,
  env,
  call,
  system:
    "You generate company seed JSON for a confirm-first company-discovery proposal route. Return only JSON matching the supplied schema.",
  messages: [
    {
      role: "user",
      content: seedPrompt({ context: safeContext, maxCompanies, now }),
    },
  ],
});

if (!result.body?.ok) return result;

const validation = validateCompanySeedResponse(result.body.data);
if (!validation.valid) {
  return makeBoundedAIEnvelope({
    ok: false,
    status: 422,
    code: BOUNDED_AI_CODES.AI_SCHEMA_INVALID,
    error: {
      message: "Model output did not match the route schema.",
      details: validation.errors,
    },
    ai: result.body.ai,
    manual: MANUAL_SEED_FALLBACK,
  });
}
```

**Apply to Phase 10:** deterministic gate preflight owns JD/body capture state, missing data, obvious cuts, comp/location/app-limit checks, and manual states. AI may only propose a finite body-read judgment using `runBoundedAI()`; invalid/no-AI/ambiguous output returns a review/manual envelope, not KEEP/CUT fabrication.

---

### `src/core/packet/generate.mjs` (service/orchestrator, CRUD/file-I/O/transform)

**Analogs:** `src/core/discovery/company-proposals.mjs`, `src/core/db/verbs/app.mjs`, `src/core/documents/export.mjs`

**Orchestrator dependencies pattern** (`src/core/discovery/company-proposals.mjs` lines 1-17):

```javascript
import { createHash } from "node:crypto";
import { companyProposalBatchPut } from "../db/verbs/company-discovery.mjs";
import { offersWithCapturedJobs as defaultOffersWithCapturedJobs } from "../scoring/sourced-persistence.mjs";
import {
  buildLocationFilter,
  buildTitleFilter,
  filterAndDedupeOffers,
  scanCompanies,
} from "../scoring/sourced-scanner.mjs";
import { buildCompanySeedContext } from "./company-context.mjs";
import { buildCompanyProposal } from "./company-proposal-gate.mjs";
import { generateCompanySeeds } from "./company-seeds.mjs";
```

**Service orchestration pattern** (`src/core/discovery/company-proposals.mjs` lines 168-192, 220-248):

```javascript
export async function createCompanyProposalBatch({
  repoRoot,
  env = process.env,
  body = {},
  fetchImpl = fetch,
  resolveCompanyBoard = defaultResolveCompanyBoard,
  scanCompaniesImpl = scanCompanies,
  offersWithCapturedJobs = defaultOffersWithCapturedJobs,
  buildSeedContext = buildCompanySeedContext,
  generateSeeds = generateCompanySeeds,
  seedCall,
  now = new Date(),
} = {}) {
  const manualSeeds = manualSeedsFromBody(body);
  const context = buildSeedContext({ repoRoot, env });
  const seedResult = await generateSeeds({
    repoRoot,
    env,
    context,
    manualSeeds,
    requestedCount: requestedCountFromBody(body),
    call: seedCall,
    now,
  });
  if (!seedResult.body?.ok) return { status: seedResult.status, body: seedResult.body };
```

```javascript
const batch = {
  batchId,
  status: "pending",
  createdAt,
  version: 1,
  proposals,
  rejected,
  counts: {
    seeds: seeds.length,
    proposals: proposals.length,
    rejected: rejected.length,
  },
};
companyProposalBatchPut({ repoRoot, env, batch });

return {
  data: {
    batchId,
    proposals,
    rejected,
    counts: batch.counts,
  },
  meta: {
    version: batch.version,
    ai: seedResult.body.ai,
    manual: seedResult.body.manual,
    seedSource: seedResult.body.ai?.used ? "ai" : "manual",
  },
};
```

**DB artifact stamping pattern** (`src/core/db/verbs/app.mjs` lines 163-185):

```javascript
export function appRegisterArtifact({ repoRoot, env, id, kind, path, note } = {}) {
  if (!kind || !path) throw new Error("appRegisterArtifact: kind and path are required");
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const artifacts = { ...(app.artifacts || {}) };
    artifacts[kind] = path;
    artifacts[`${kind}GeneratedAt`] = nowIso();
    if (note) artifacts[`${kind}Note`] = note;

    const updated = { ...app, artifacts };
    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "tailored",
      title: `${app.company || id} - ${kind} artifact registered`,
      refs: { applicationId: id, company: app.company, role: app.role },
    });
    return { id, meta, event };
  });
}
```

**Export helper pattern** (`src/core/documents/export.mjs` lines 1453-1477):

```javascript
export async function exportArtifact({
  markdown,
  outBase,
  formats,
  title = "Document",
  ats = false,
}) {
  const result = {};

  for (const fmt of formats) {
    if (fmt === "pdf") {
      const pdfPath = `${outBase}.pdf`;
      await renderPdf({ markdown, outPath: pdfPath, title, ats });
      result.pdf = pdfPath;
    } else if (fmt === "docx") {
      const docxPath = `${outBase}.docx`;
      const info = await renderDocx({ markdown, outPath: docxPath, title });
      result.docx = docxPath;
      result.docxTool = info.tool;
      result.docxLabel = info.label;
    }
  }

  return result;
}
```

**Apply to Phase 10:** `generatePacket()` should gate first when needed, assemble markdown source artifacts, validate them, export PDF by default, optionally DOCX, then stamp every source/export sibling through `appRegisterArtifact()` or a richer DB verb. Preserve the one shared write path.

---

### `src/core/packet/answers.mjs` (service, request-response/transform/bounded-AI)

**Analogs:** `src/core/discovery/company-seeds.mjs`, `src/core/documents/tailor.mjs`, `src/core/apply/form-questions.mjs`

**Schema + labels pattern** (`src/core/discovery/company-seeds.mjs` lines 6-43):

```javascript
export const COMPANY_SEED_LABELS = Object.freeze({
  skill: "discover-companies",
  action: "seed-generate",
  operation: "company-seeds",
});

const MANUAL_SEED_FALLBACK = Object.freeze({
  available: true,
  reason: "manual-company-seeds",
  action: "Paste company names or homepages to generate a proposal batch without AI.",
});

export const companySeedSchema = Object.freeze({
  type: "object",
  required: ["companies"],
  additionalProperties: false,
  properties: {
    companies: {
      type: "array",
      maxItems: COMPANY_DISCOVERY_BATCH_MAX,
      items: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          domain_hint: { type: "string" },
          why: { type: "string" },
          role_family_hint: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          source_hint: { type: "string" },
        },
      },
    },
  },
});
```

**Answer validation pattern** (`src/core/documents/tailor.mjs` lines 364-388):

```javascript
export function buildShortAnswer({ question, answer, honesty, forbidden = [] }) {
  const trimmed = (answer || "").trim();

  if (trimmed.length === 0) {
    throw new Error(
      `buildShortAnswer: answer is empty for question "${question}". ` +
        "The agent must supply the answer text."
    );
  }

  const { clean, findings } = lintArtifact(trimmed);
  if (!clean) {
    const detail = findings.map((f) => `line ${f.line}: ${f.text}`).join("; ");
    throw new Error(
      `buildShortAnswer: answer contains unresolved placeholders for question "${question}": ${detail}`
    );
  }

  const allForbidden = [...(forbidden || []), ...forbiddenWordingFor([], honesty || {})];
  assertNoForbidden(trimmed, allForbidden);

  return trimmed;
}
```

**Apply to Phase 10:** AI answer proposals must include evidence IDs or gap markers. Feed only non-EEO questions into AI. Run every proposed answer through `buildShortAnswer()`, plus packet-specific evidence/honesty checks. A truthful gap should become a reviewable `NEEDS YOU: <reason>` marker and block upload-ready state.

---

### `src/core/packet/questions.mjs` and `src/core/apply/form-questions.mjs` (service/utility, request-response/transform)

**Analog:** `src/core/apply/form-questions.mjs`

**Provider normalization and demographic exclusion pattern** (Greenhouse, lines 217-253):

```javascript
export function normalizeGreenhouseQuestions(json, { url = "", fetchedAt } = {}) {
  const j = json && typeof json === "object" ? json : {};
  const blocks = [
    ...(Array.isArray(j.questions) ? j.questions : []),
    ...(Array.isArray(j.location_questions) ? j.location_questions : []),
  ];
  const questions = blocks.map(normalizeGreenhouseBlock).filter(Boolean);

  const complianceHasQuestions =
    Array.isArray(j.compliance) &&
    j.compliance.some((block) => Array.isArray(block?.questions) && block.questions.length > 0);
  const demographic = j.demographic_questions;
  const demographicHasContent = Array.isArray(demographic)
    ? demographic.length > 0
    : demographic != null && typeof demographic === "object"
      ? Object.keys(demographic).length > 0
      : Boolean(demographic);

  return {
    source: "greenhouse",
    url: url || String(j.absolute_url || ""),
    fetchedAt: fetchedAt || new Date().toISOString(),
    questions,
    demographicSectionPresent: complianceHasQuestions || demographicHasContent,
  };
}
```

**Provider normalization and demographic exclusion pattern** (Ashby, lines 376-395):

```javascript
export function normalizeAshbyForm(posting, { url = "", fetchedAt } = {}) {
  const p = posting && typeof posting === "object" ? posting : {};
  const fieldEntries = Array.isArray(p.applicationForm?.fieldEntries)
    ? p.applicationForm.fieldEntries
    : [];

  const questions = fieldEntries.map(normalizeAshbyEntry).filter(Boolean);

  const surveyForms = Array.isArray(p.surveyForms) ? p.surveyForms : [];
  const demographicSectionPresent =
    surveyForms.some((f) => Array.isArray(f?.fieldEntries) && f.fieldEntries.length > 0) ||
    (Array.isArray(p.surveyFormDefinitionIds) && p.surveyFormDefinitionIds.length > 0);

  return {
    source: "ashby",
    url,
    fetchedAt: fetchedAt || new Date().toISOString(),
    questions,
    demographicSectionPresent,
  };
}
```

**Manual paste fallback pattern** (lines 439-470):

```javascript
export function parseManualQuestions(text, { url = "", fetchedAt } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const questions = [];
  let n = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const stripped = line.replace(LIST_MARKER, "").trim();
    if (!stripped) continue;

    const wasListMarked = stripped !== line;
    if (!wasListMarked && !/\?\s*$/.test(stripped)) continue;

    n += 1;
    questions.push({
      id: `q${n}`,
      label: stripped,
      type: "text",
      required: true,
      options: null,
    });
  }

  return {
    source: "manual",
    url,
    fetchedAt: fetchedAt || new Date().toISOString(),
    questions,
  };
}
```

**Fetch/fail-closed pattern** (lines 484-530):

```javascript
export async function fetchFormQuestions(jobUrl, { fetchImpl = fetch } = {}) {
  const req = buildQuestionsRequest(jobUrl);
  if (!req) {
    throw new Error(
      `Unsupported host for question-fetch: ${jobUrl} - paste the questions instead (careerrat questions --paste).`
    );
  }

  const fetchedAt = new Date().toISOString();
  const response = await fetchImpl(req.url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Posting not found (404) at ${req.url} - it may have closed. Paste the questions instead (careerrat questions --paste).`
      );
    }
    throw new Error(
      `${req.url} returned HTTP ${response.status} - paste the questions instead (careerrat questions --paste).`
    );
  }

  if (req.provider === "greenhouse") {
    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error(
        `Non-JSON response from Greenhouse at ${req.url} - paste the questions instead (careerrat questions --paste).`
      );
    }
    return normalizeGreenhouseQuestions(json, {
      url: String(json?.absolute_url || jobUrl),
      fetchedAt,
    });
  }

  const html = await response.text();
  const posting = extractAshbyAppData(html);
  if (!posting) {
    throw new Error(
      `Could not find the embedded application form on ${req.url} (Ashby page layout may have changed) - paste the questions instead (careerrat questions --paste).`
    );
  }
  return normalizeAshbyForm(posting, { url: req.url, fetchedAt });
}
```

**Apply to Phase 10:** keep provider extraction deterministic. Add or wrap a conservative self-identification classifier for manual-pasted questions before answers are generated. Excluded questions should be visible as metadata only; never send them to answer drafting.

---

### `src/core/packet/exports.mjs` (utility/service, file-I/O)

**Analogs:** `src/core/documents/export.mjs`, `src/cli/export.mjs`

**ATS normalization + markdown/HTML pattern** (`src/core/documents/export.mjs` lines 1-3, 40-47, 73-90):

```javascript
// export.mjs - render tailored artifacts (resume, cover letter, packet) to PDF or DOCX.
// Zero NEW runtime dependencies: PDF via Playwright Chromium (already a devDep);
// DOCX via pandoc -> soffice -> hand-rolled OOXML, detected in that priority order.

export function normalizeAtsText(text) {
  return text
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "");
}

export function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  const listStack = [];
  let inPara = false;
  let pendingBlank = false;
```

**CLI default-format policy** (`src/cli/export.mjs` lines 36-43, 96-113):

```javascript
const wantPdf = args.includes("--pdf");
const wantDocx = args.includes("--docx");
const wantAts = args.includes("--ats");
const formats = [];
if (wantPdf) formats.push("pdf");
if (wantDocx) formats.push("docx");
if (formats.length === 0) formats.push("pdf"); // default
```

```javascript
let result;
try {
  result = await exportArtifact({ markdown, outBase, formats, title, ats: wantAts });
} catch (err) {
  console.error(`Export failed: ${err.message}`);
  if (/Chromium not found/.test(err.message)) {
    console.error("Run: npx playwright install chromium");
  }
  process.exit(1);
}

if (result.pdf) {
  console.log(`PDF  -> ${result.pdf}`);
}
if (result.docx) {
  console.log(`DOCX -> ${result.docx}  (${result.docxLabel})`);
}
```

**Apply to Phase 10:** default packet exports to `formats: ["pdf"]` with `ats: true` for upload-ready resume/cover-letter copies. Add DOCX only when captured upload metadata or explicit user choice requires it.

---

### `src/core/packet/schemas/packet-schemas.mjs` (config/utility, validation)

**Analogs:** `src/core/discovery/company-seeds.mjs`, `src/core/ai/structured-oneshot.mjs`

**Schema pattern** (`src/core/discovery/company-seeds.mjs` lines 20-43):

```javascript
export const companySeedSchema = Object.freeze({
  type: "object",
  required: ["companies"],
  additionalProperties: false,
  properties: {
    companies: {
      type: "array",
      maxItems: COMPANY_DISCOVERY_BATCH_MAX,
      items: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          domain_hint: { type: "string" },
          why: { type: "string" },
          role_family_hint: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          source_hint: { type: "string" },
        },
      },
    },
  },
});
```

**Parse + schema validation pattern** (`src/core/ai/structured-oneshot.mjs` lines 58-71):

```javascript
export function parseStructuredJson(rawText, schema) {
  const candidate = extractFencedJson(rawText);
  if (!candidate) {
    return { ok: false, errors: [{ path: "", message: "reply contained no text to parse" }] };
  }
  let data;
  try {
    data = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, errors: [{ path: "", message: `invalid JSON: ${err.message}` }] };
  }
  const { valid, errors } = validate(data, schema);
  if (!valid) return { ok: false, data, errors };
  return { ok: true, data };
}
```

**Apply to Phase 10:** define schemas for gate AI verdicts, answer proposals, packet manifests, and route request bodies with `additionalProperties: false`. Keep AI output schema finite and require explicit manual/gap states.

---

### `src/core/db/verbs/app.mjs` (service/model, CRUD)

**Analogs:** `src/core/db/verbs/app.mjs`, `src/core/db/verbs/shared.mjs`

**Shared write path contract** (`src/core/db/verbs/shared.mjs` lines 142-153):

```javascript
export function runVerb({ repoRoot, env }, fn) {
  const pathCtx = { repoRoot, env };
  const db = requireDb(pathCtx);
  const result = withTransaction(db, () => fn(db, pathCtx));
  const exported = exportToTracker(pathCtx);
  return { ok: true, ...result, exported };
}
```

**Meta bump + activity pattern** (`src/core/db/verbs/shared.mjs` lines 57-88, 95-106):

```javascript
export function bumpMeta(db, at = nowIso()) {
  const current = db.prepare("SELECT extra FROM meta WHERE id = 1").get();
  const extra = current?.extra ? JSON.parse(current.extra) : {};
  const extraJson = Object.keys(extra).length ? JSON.stringify(extra) : null;

  const row = db
    .prepare(
      "UPDATE meta SET version = version + 1, last_updated_at = ?, extra = ? WHERE id = 1 RETURNING version, last_updated_at"
    )
    .get(at, extraJson);
  if (row) return { version: row.version, lastUpdatedAt: row.last_updated_at };
  db.prepare("INSERT INTO meta (id, version, last_updated_at, extra) VALUES (1, 1, ?, ?)").run(
    at,
    extraJson
  );
  return { version: 1, lastUpdatedAt: at };
}
```

```javascript
export function logActivityEvent(db, input, { now = new Date() } = {}) {
  const plan = computeAppend({ event: input, now });
  if (!plan.ok) {
    const err = new Error(`activity event refused: ${plan.error}`);
    err.code = "ACTIVITY_REFUSED";
    throw err;
  }
  db.prepare(
    "INSERT INTO activity_events (id, at, type, actor, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
  ).run(plan.event.id, plan.event.at, plan.event.type, plan.event.actor, plan.line);
  return plan.event;
}
```

**Apply to Phase 10:** if current `appRegisterArtifact()` cannot represent a manifest/source/PDF/DOCX sibling set, add a DB verb that still uses `runVerb()`. Do not hand-edit generated tracker/activity files.

---

### `src/core/onboarding/packet-page.mjs` (component/page, event-driven)

**Analog:** `src/core/onboarding/packet-page.mjs`

**Static page pattern** (lines 32-80):

```javascript
export const PACKET_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Packet - CareerRat</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --panel: #f6f7f9;
    --text: #1c1f24;
    --muted: #5b6270;
    --border: #dde1e7;
    --accent: #2f5fda;
```

**Client local-API list/detail pattern** (lines 408-419, 526-539):

```javascript
function loadList() {
  fetch("/api/packet/list")
    .then(function (res) {
      return res.ok ? res.json() : [];
    })
    .then(function (rows) {
      renderList(rows || []);
    })
    .catch(function () {
      renderList([]);
    });
}
```

```javascript
function loadDetail(id) {
  fetch("/api/packet?id=" + encodeURIComponent(id))
    .then(function (res) {
      if (!res.ok) throw new Error("Request failed with status " + res.status);
      return res.json();
    })
    .then(function (data) {
      clearError();
      renderDetail(data);
    })
    .catch(function (err) {
      showError("Could not load packet: " + (err && err.message ? err.message : String(err)));
    });
}
```

**Anti-pattern to replace** (lines 627-685):

```javascript
function runSkill(skill, skillInput, onDone) {
  return fetch("/api/skill/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ skill: skill, input: skillInput })
  }).then(function (res) {
    // ...
  });
}

generateBtn.addEventListener("click", function () {
  if (!currentPacket || generateBtn.disabled) return;
  var input = (currentPacket.company || "") + " - " + (currentPacket.role || "");
  // ...
  runSkill("tailor-application", input, function () {
    runStatus.textContent = "";
    updateGenerateAvailability();
  });
});
```

**Apply to Phase 10:** keep the byte-static self-contained page style and hook tests. Replace skill allowlist gating with local `/api/packet/generate` availability/status handling. Do not stream `/api/skill/run` for ordinary packet generation.

---

### `src/core/ai/answer-page.mjs` (component/page, event-driven)

**Analog:** `src/core/ai/answer-page.mjs`

**Anti-pattern to replace** (lines 408-490):

```javascript
function runSkill(skill, skillInput, onDone) {
  return fetch("/api/skill/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ skill: skill, input: skillInput })
  }).then(function (res) {
    // ...
  });
}

function answerQuestionAllowed() {
  return allowedSkills.indexOf("answer-question") !== -1;
}

runBtn.addEventListener("click", function () {
  var question = questionInput.value.trim();
  if (!question) return;
  var context = contextInput.value.trim();
  // ...
  runSkill("answer-question", composeInput(context, question), function () {
    updateRunAvailability(false);
  });
});
```

**Apply to Phase 10:** keep static HTML/test shape, but post to a local answers API. The page can still show SOURCE/DURABLE/PERSISTED style metadata if the local API returns it, but the default path must not depend on the full skill runtime.

---

## Test Pattern Assignments

### `tests/packet-generate-route.test.mjs` (test, request-response/CRUD)

**Analogs:** `tests/packet-route.test.mjs`, `tests/data-route.test.mjs`

**Bare route server pattern** (`tests/packet-route.test.mjs` lines 55-89):

```javascript
function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountPacketRoutes({ addRoute, repoRoot, env: {}, ...opts });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
```

**POST helper pattern** (`tests/data-route.test.mjs` lines 72-80):

```javascript
async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
```

**DB fixture pattern** (`tests/packet-route.test.mjs` lines 30-47):

```javascript
function importTrackerFixture(repoRoot, applications) {
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      { meta: {}, applications, sourced: [], sources: [], communications: [] },
      null,
      2
    )
  );
  importFromTracker({ repoRoot, sourceDir });
  assert.equal(
    existsSync(join(repoRoot, "workspace/tracker.json")),
    false,
    "packet tests must seed DB rows without creating a generated tracker export"
  );
}
```

**Apply to Phase 10:** test `POST /api/packet/gate` and `POST /api/packet/generate` with seeded DB fixtures, missing DB 409, invalid body 400, no-AI/manual envelope, and successful artifact registration.

---

### `tests/packet-engine.test.mjs` (test, CRUD/file-I/O/transform)

**Analogs:** `tests/documents-tailor.test.mjs`, `tests/bounded-ai.test.mjs`

**Evidence fixture pattern** (`tests/documents-tailor.test.mjs` lines 23-80):

```javascript
const EVIDENCE_BANK = {
  claims: [
    {
      id: "ai-001",
      claim: "Built production AI workflows from prototype to deployment.",
      evidence: "Led the infra team that shipped three agentic pipelines.",
      metrics: ["3 pipelines shipped"],
      links: ["https://example.com/ai-work"],
      role_signals: ["prototype-to-production", "agentic workflow"],
      allowed_wording: ["production AI workflow"],
      forbidden_wording: ["model training"],
    },
  ],
};

const PROFILE = {
  candidate: {
    full_name: "Alex Rivera",
    email: "alex@example.com",
    phone: "+1-555-0199",
    location: "San Francisco, CA",
    linkedin: "linkedin.com/in/alexrivera",
    github: "github.com/alexrivera",
  },
};
```

**Validation assertion pattern** (`tests/documents-tailor.test.mjs` lines 527-583):

```javascript
test("buildShortAnswer returns trimmed answer for valid input", () => {
  const result = buildShortAnswer({
    question: "Why do you want to work here?",
    answer: "  I admire the team's commitment to shipping reliable infrastructure.  ",
    honesty: HONESTY_NO_EDU,
    forbidden: [],
  });
  assert.equal(result, "I admire the team's commitment to shipping reliable infrastructure.");
});

test("buildShortAnswer throws for answer with placeholder", () => {
  assert.throws(
    () =>
      buildShortAnswer({
        question: "Describe a challenge.",
        answer: "I overcame [insert challenge here] through teamwork.",
        honesty: HONESTY_NO_EDU,
        forbidden: [],
      }),
    (err) => {
      assert.ok(err.message.includes("placeholder"));
      return true;
    }
  );
});
```

**Bounded AI success/manual test pattern** (`tests/bounded-ai.test.mjs` lines 136-169, 322-340):

```javascript
const result = await runBoundedAI({
  labels: LABELS,
  schema: SEED_SCHEMA,
  manual: MANUAL,
  invoke: async ({ attempt, correction, labels }) => {
    assert.equal(attempt, 0);
    assert.equal(correction, null);
    assert.deepEqual(labels, LABELS);
    return {
      text: '```json\n{"seeds":[{"company":"Acme AI","reason":"agent workflow fit"}]}\n```',
      model: "claude-haiku-4-5",
    };
  },
});

assert.equal(result.status, 200);
assert.equal(result.body.ok, true);
assertNoSensitiveFields(result.body);
```

```javascript
const err = new Error("no AI route configured: set ANTHROPIC_API_KEY");
err.code = BOUNDED_AI_CODES.NO_AI_ROUTE;

const result = await runBoundedAI({
  labels: LABELS,
  schema: SEED_SCHEMA,
  manual: MANUAL,
  invoke: async () => {
    throw err;
  },
});

assert.equal(result.status, 501);
assert.equal(result.body.ok, false);
assert.equal(result.body.ai.used, false);
assert.equal(result.body.manual.available, true);
assertNoSensitiveFields(result.body);
```

---

### `tests/packet-answers.test.mjs` (test, request-response/transform/bounded-AI)

**Analogs:** `tests/form-questions.test.mjs`, `tests/documents-tailor.test.mjs`

**Manual question parse test pattern** (`tests/form-questions.test.mjs` lines 489-537):

```javascript
describe("parseManualQuestions", () => {
  it("parses numbered lines", () => {
    const result = parseManualQuestions(
      "1. What is your favorite color?\n2) Describe your experience."
    );
    assert.equal(result.source, "manual");
    assert.deepEqual(
      result.questions.map((q) => q.label),
      ["What is your favorite color?", "Describe your experience."]
    );
    assert.ok(result.questions.every((q) => q.required === true && q.type === "text"));
    assert.deepEqual(
      result.questions.map((q) => q.id),
      ["q1", "q2"]
    );
  });
});
```

**Provider fetch is hermetic** (`tests/form-questions.test.mjs` lines 543-589):

```javascript
it("fetches and normalizes a Greenhouse job, hitting the derived questions=true URL", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => GH_FIXTURE };
  };

  const result = await fetchFormQuestions(
    "https://job-boards.greenhouse.io/acmerobotics/jobs/1234567",
    { fetchImpl }
  );

  assert.deepEqual(calls, [
    "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/1234567?questions=true",
  ]);
  assert.equal(result.source, "greenhouse");
  assert.ok(result.questions.length > 0);
});
```

**Apply to Phase 10:** add fixtures proving EEO/disability/veteran/demographic prompts are filtered from generated answers for both provider and manual-paste paths.

---

### `tests/packet-export.test.mjs` (test, file-I/O)

**Analogs:** `src/cli/export.mjs`, `tests/packet-route.test.mjs`

**Default PDF policy to assert** (`src/cli/export.mjs` lines 36-43):

```javascript
const wantPdf = args.includes("--pdf");
const wantDocx = args.includes("--docx");
const wantAts = args.includes("--ats");
const formats = [];
if (wantPdf) formats.push("pdf");
if (wantDocx) formats.push("docx");
if (formats.length === 0) formats.push("pdf"); // default
```

**Binary artifact route expectation** (`tests/packet-route.test.mjs` lines 265-307):

```javascript
test("GET /api/packet?id=: PDF artifacts return binary link metadata, not decoded markdown", async () => {
  const repoRoot = tempRepo();
  writeArtifact(repoRoot, "tailored/Acme - Staff Engineer.pdf", "%PDF-1.4\nfake pdf body\n");
  importTrackerFixture(repoRoot, [
    {
      id: "app-pdf",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      artifacts: {
        resume: "workspace/tailored/Acme - Staff Engineer.pdf",
      },
    },
  ]);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet?id=app-pdf");
    assert.equal(status, 200);
    assert.equal(body.artifacts.resume.binary, true);
    assert.equal(body.artifacts.resume.kind, "pdf");
    assert.equal(body.artifacts.resume.url, "/api/packet/artifact?id=app-pdf&kind=resume");
  } finally {
    await closeServer(server);
  }
});
```

---

### `tests/packet-runtime-boundary.test.mjs` (test/static guard)

**Analog:** `tests/company-discovery-regression.test.mjs`

**Static guard pattern** (lines 601-629, 631-656):

```javascript
test("static ownership checks reject generated-file write seams and require supported approval verbs", () => {
  const discoveryFiles = [
    "src/core/discovery/company-board-resolver.mjs",
    "src/core/discovery/company-context.mjs",
    "src/core/discovery/company-seeds.mjs",
    "src/core/discovery/company-proposal-gate.mjs",
    "src/core/discovery/company-proposals.mjs",
    "src/core/discovery/company-proposal-decisions.mjs",
  ];
  for (const file of discoveryFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /runSkillStream|startSession|\/api\/skill\/run/);
    assert.doesNotMatch(source, /writeFileSync|appendFileSync|createWriteStream/);
    assert.doesNotMatch(source, /workspace\/tracker\.html|workspace\/activity\.jsonl/);
  }
});
```

```javascript
test("VER-01 deterministic discovery paths do not call AI, chat, or retained full skill runtime", () => {
  const directAISeams = /\b(?:callAI\s*\(|runBoundedAI\b)/;
  const chatOrFullRuntimeSeams = /\b(?:runSkillStream|startSession)\b|\/api\/skill\/run/;
  const deterministicDiscoveryFiles = [
    "src/core/discovery/company-board-resolver.mjs",
    "src/core/discovery/company-context.mjs",
    "src/core/discovery/company-proposal-gate.mjs",
    "src/core/discovery/company-proposals.mjs",
    "src/core/discovery/company-proposal-decisions.mjs",
  ];

  for (const file of deterministicDiscoveryFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, directAISeams, `${file} must not call direct AI seams`);
    assert.doesNotMatch(
      source,
      chatOrFullRuntimeSeams,
      `${file} must not start chat or retained skill runtime`
    );
  }

  const seedSource = readFileSync("src/core/discovery/company-seeds.mjs", "utf8");
  assert.match(seedSource, /runBoundedAI/, "company seed generation owns bounded AI usage");
  assert.match(seedSource, /skill:\s*"discover-companies"/);
  assert.match(seedSource, /action:\s*"seed-generate"/);
  assert.doesNotMatch(seedSource, /\bcallAI\s*\(/, "seed generation must not bypass bounded AI");
});
```

**Apply to Phase 10:** guard default packet/page/core files against `runSkillStream`, `startSession`, and `/api/skill/run`. Allow `runBoundedAI` only in explicitly bounded files such as `src/core/packet/gate.mjs` and `src/core/packet/answers.mjs`.

---

### `tests/packet-page.test.mjs` and `tests/answer-page.test.mjs` (test, component/event-driven)

**Analogs:** existing same files

**Static page syntax/hook pattern** (`tests/packet-page.test.mjs` lines 49-85, 120-144):

```javascript
test("GET /packet returns HTML with the expected structural hooks", async () => {
  const repoRoot = tempRepo();
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/packet`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    for (const hook of [
      'data-hook="packet-picker"',
      'data-hook="detail-section"',
      'data-hook="detail-title"',
      'data-hook="generate-btn"',
      'data-hook="run-status"',
      'data-hook="feed-section"',
      'data-hook="generate-feed"',
      'data-hook="error-box"',
    ]) {
      assert.ok(html.includes(hook), `expected ${hook} in the page`);
    }
  } finally {
    teardown(dev, repoRoot);
  }
});
```

```javascript
test("packet-page.mjs inline <script> parses as valid JavaScript (no syntax error)", () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(PACKET_PAGE_HTML);
  assert.ok(match, "expected an inline <script> block in the page");
  assert.doesNotThrow(() => {
    new Function(match[1]);
  }, "packet-page.mjs's inline script has a JS syntax error - it would break the live page");
});
```

**Current expectation to replace** (`tests/packet-page.test.mjs` lines 140-144):

```javascript
test("the Generate packet run POSTs tailor-application and is gated by /api/runtime/config, same pattern as evaluate-page.mjs's decision buttons", () => {
  assert.match(PACKET_PAGE_HTML, /runSkill\("tailor-application", input, function/);
  assert.match(PACKET_PAGE_HTML, /fetch\("\/api\/runtime\/config"\)/);
  assert.match(PACKET_PAGE_HTML, /tailorAllowed/);
});
```

**Answer page hooks/syntax pattern** (`tests/answer-page.test.mjs` lines 59-89, 137-144):

```javascript
test("GET /answer returns HTML with the expected structural hooks", async () => {
  const repoRoot = tempRepoWithSkills(["answer-question"]);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/answer`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    for (const hook of [
      'data-hook="question-input"',
      'data-hook="context-input"',
      'data-hook="run-btn"',
      'data-hook="run-status"',
      'data-hook="feed-section"',
      'data-hook="event-feed"',
      'data-hook="error-box"',
      'data-hook="answer-card"',
    ]) {
      assert.ok(html.includes(hook), `expected ${hook} in the page`);
    }
  } finally {
    teardown(dev, repoRoot);
  }
});
```

**Apply to Phase 10:** replace old runtime allowlist expectations with local API assertions and negative checks that ordinary packet/answer actions do not call `/api/skill/run`.

## Shared Patterns

### Thin Routes, Durable Core

**Source:** `src/cli/data-route.mjs` lines 6-13, 100-114
**Apply to:** `src/cli/packet-route.mjs`

Routes should validate body shape, call core/DB functions, and format response envelopes. Durable behavior belongs in `src/core/packet/*` and DB verbs.

### DB Fail-Closed and Single Write Path

**Source:** `src/core/db/verbs/shared.mjs` lines 142-153
**Apply to:** packet generation, artifact registration, any packet manifest write

```javascript
export function runVerb({ repoRoot, env }, fn) {
  const pathCtx = { repoRoot, env };
  const db = requireDb(pathCtx);
  const result = withTransaction(db, () => fn(db, pathCtx));
  const exported = exportToTracker(pathCtx);
  return { ok: true, ...result, exported };
}
```

### Bounded AI Manual Fallback

**Source:** `src/core/ai/bounded-ai.mjs` lines 274-402
**Apply to:** `src/core/packet/gate.mjs`, `src/core/packet/answers.mjs`

Use `labels`, `schema`, `manual`, `structuredMode: "native-preferred"`, and route raw provider errors into safe envelopes. Do not expose prompt/model body text in errors.

### Artifact Path Safety

**Source:** `src/cli/packet-route.mjs` lines 106-170, 181-202
**Apply to:** artifact preview/download, packet manifest readers

```javascript
function resolveArtifactPath(workspaceDir, relPath) {
  const rel = normalize(String(relPath ?? ""));
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\0")) {
    return null;
  }
  const full = join(workspaceDir, rel);
  if (full !== workspaceDir && !full.startsWith(`${workspaceDir}${sep}`)) return null;
  return full;
}
```

Unsafe/unreadable artifacts should collapse to the same missing-artifact shape.

### EEO/Demographic Exclusion

**Source:** `src/core/apply/form-questions.mjs` lines 217-253 and 376-395
**Apply to:** question capture and answer generation

Provider demographic/compliance/survey sections are excluded from `questions[]` and represented only by `demographicSectionPresent`. Extend this pattern to manual paste before answer drafting.

### Deterministic Artifact Validation

**Source:** `src/core/documents/tailor.mjs` lines 254-273, 325-345, 364-388
**Apply to:** resume, cover letter, answer generation

Run placeholder lint, forbidden wording checks, and ATS-safe validation before stamping upload-ready artifacts.

### Runtime Boundary Guard

**Source:** `tests/company-discovery-regression.test.mjs` lines 601-656
**Apply to:** packet core, packet route, packet page, answer page tests

Static tests should forbid ordinary packet paths from calling `runSkillStream`, `startSession`, or `/api/skill/run`. Only bounded AI helpers are permitted in explicitly AI-owned packet files.

## No Analog Found

No Phase 10 file is without a usable analog. `src/core/packet/*` files are new, but each maps to an existing local pattern:

| File | Pattern Source |
|------|----------------|
| `context.mjs` | `src/core/discovery/company-context.mjs` |
| `gate.mjs` | `src/core/evaluate/gate.mjs` + `src/core/discovery/company-seeds.mjs` |
| `generate.mjs` | `src/core/discovery/company-proposals.mjs` |
| `answers.mjs` | `src/core/discovery/company-seeds.mjs` + `src/core/documents/tailor.mjs` |
| `questions.mjs` | `src/core/apply/form-questions.mjs` |
| `exports.mjs` | `src/core/documents/export.mjs` |

## Metadata

**Phase directory:** `.planning/phases/10-local-packet-engine`
**Output file:** `.planning/phases/10-local-packet-engine/10-PATTERNS.md`
**Primary context read:** `10-CONTEXT.md`, `10-RESEARCH.md`, `AGENTS.md`, `candidate/AGENTS.md`
**Relevant skill docs read:** `evaluate-job`, `tailor-application`, `answer-question`
**Analog search scope:** `src/cli`, `src/core`, `tests`, `config`
**Files scanned:** 330
**Strong analogs read:** `packet-route`, `data-route`, `discovery-route`, `company-context`, `company-seeds`, `company-proposals`, `evaluate/gate`, `form-questions`, `documents/tailor`, `documents/export`, `db/verbs/app`, `db/verbs/shared`, packet/answer pages, packet/data/form/document/bounded-AI/static-regression tests
**Pattern extraction date:** 2026-07-06
