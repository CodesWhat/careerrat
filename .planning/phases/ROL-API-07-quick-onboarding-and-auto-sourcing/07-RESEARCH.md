# Phase 7: Quick Onboarding and Auto Sourcing - Research

**Researched:** 2026-07-05
**Domain:** React onboarding, Node local APIs, SQLite durable sourcing runs, resume intake
**Confidence:** HIGH for repo architecture; MEDIUM for external DOCX library guidance

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
### Search Readiness
- **D-01:** Starting search should be cheap and early. Do not require a
  compensation floor before the first search; comp can gate evaluation/apply
  later.
- **D-02:** The minimum search-start gate remains resume plus target role/title
  plus location or remote posture. Search cadence is collected before or at the
  first run, but missing deep-ingest data must not block first sourcing.
- **D-03:** `gate_ready` and `apply_ready` stay stricter than `search_ready`.
  Planning must preserve the existing staged readiness model instead of merging
  all setup requirements into one gate.

### First Search Trigger
- **D-04:** Auto-sourcing is core behavior. When onboarding first reaches
  search-ready state, the app should guide the user into the first search rather
  than telling them to run an agent skill.
- **D-05:** The first-run prompt should ask "search now?" with the yes/default
  path selected. Continuing onboarding from that prompt should start the first
  deterministic search unless the user explicitly declines.
- **D-06:** Later searches are manual from the Jobs page. The Jobs page should
  show a `Search jobs` action only after DB source setup exists.
- **D-07:** The app should ask how often the user wants to search. The
  recommendation should be data-backed when data exists; if no useful local or
  shipped data exists, the UI should be transparent that it is using a default
  recommendation.

### Search Mechanism
- **D-08:** Do not use chat to search. Quick onboarding must not start
  `research-boards`, `discover-companies`, `search-jobs`, or any visible chat as
  the first-search path.
- **D-09:** The first search should use deterministic, unauthenticated sources
  only. Authenticated/browser sources can appear as setup tasks or later
  enhancements, but they are not part of the automatic run.
- **D-10:** DB source setup is product state. Compatibility files remain
  CLI/debug output and must not become the readiness signal.

### Setup Task Surface
- **D-11:** The first search belongs in the setup/checklist model, not as a
  nagging reminder. It should read like "did this happen?" alongside simple
  setup and deep setup items.
- **D-12:** First-search task statuses should be `Not started`, `Running`,
  `Completed`, and `Failed`. `Failed` must be actionable.
- **D-13:** The run surface can be a compact banner/card/checklist row. It
  should keep the user oriented while returning them to deeper onboarding.

### Resume Intake
- **D-14:** Accept DOCX resume uploads in quick onboarding.
- **D-15:** Save the original DOCX and extract plain text locally with a
  deterministic parser. Do not feed DOCX to AI by default.
- **D-16:** If DOCX extraction is empty or garbled, keep the original file but
  do not treat extracted text as search-ready. Ask the user for copy-paste, PDF,
  text, or markdown instead.
- **D-17:** PDF remains a standard resume format. Existing PDF/image AI
  extraction can remain for formats that need visual/file interpretation, but
  DOCX support should not depend on AI.

### the agent's Discretion
- The exact persistence shape for first-search run state is open, but it must be
  DB-backed, durable across reloads, and visible to React.
- The exact cadence recommendation algorithm is open. Use local/source history
  when available; otherwise choose a conservative transparent default rather
  than inventing data.
- If a deterministic search completes successfully with zero results, planners
  may choose whether the first-search task counts as `Completed` with refinement
  guidance or `Failed`/`Needs setup`, as long as the UI tells the truth about the
  run.

### Deferred Ideas (OUT OF SCOPE)
- Authenticated/browser-based sourcing can be represented as setup work, but it
  is not part of the automatic first run in this phase.
- A fully autonomous recurring scheduler is not locked by this discussion. At
  minimum, Phase 7 must capture cadence preference and avoid implying a hidden
  scheduler unless a durable start/stop/run-state implementation is included.
</user_constraints>

## Project Constraints (from AGENTS.md)

- App-visible job-search state in DB workspaces must be written through DB verbs, not by hand-editing `workspace/tracker.json` or `workspace/activity.jsonl`. [VERIFIED: ./AGENTS.md]
- DB source setup is canonical product state; compatibility YAML and candidate exports are support/debug surfaces. [VERIFIED: ./AGENTS.md]
- The local company proposal path and deterministic validation must not silently start chat, `/api/chat/*`, or `POST /api/skill/run`. [VERIFIED: ./AGENTS.md]
- First-search code must preserve the JD-body capture invariant when postings are grabbed: reachable full job descriptions are saved under `workspace/jobs/*` and mirrored on the row artifact. [VERIFIED: ./AGENTS.md]
- Authenticated browser sourcing requires explicit capability consent and is not a default automatic path. [VERIFIED: ./AGENTS.md]
- Candidate private compensation such as `current_base` must not be surfaced in outbound or shareable artifacts. [VERIFIED: ./AGENTS.md]
- Tracker-visible writes must keep typed fields single-topic and within dashboard budgets. [VERIFIED: ./AGENTS.md]

## Summary

Phase 7 should extend the existing DB-first onboarding and deterministic scan path instead of introducing a new sourcing engine. `candidate_setup.search_ready` already excludes compensation and requires only source resume, role titles, and search location or remote posture, while `gate_ready` and `apply_ready` stay stricter. [VERIFIED: src/core/db/verbs/candidate.mjs] The existing scan route already runs `runSourcedScan({ write: true })`, and the scan persistence path captures JD bodies and writes sourced rows through DB verbs. [VERIFIED: src/cli/search-route.mjs] [VERIFIED: scripts/scan-sourced.mjs] [VERIFIED: src/core/scoring/sourced-persistence.mjs]

The largest planning gap is durable run orchestration. `/api/search/scan` currently uses an in-module `scanning` flag and returns the summary only to the active request, so React cannot reload into durable first-run status without a new DB-backed run record. [VERIFIED: src/cli/search-route.mjs] The recommended plan is a migration plus DB verb module for `sourcing_runs`, with an idempotent first-run start route that prepares DB source config, records `Running`, launches the deterministic scan in process, and updates `Completed` or `Failed`. [VERIFIED: src/core/db/migrations.mjs]

DOCX support should use a vetted parser, not a custom OOXML reader. Mammoth documents raw DOCX text extraction for Node inputs by path or buffer and warns that converted output is not sanitized. [CITED: https://github.com/mwilliamson/mammoth.js/] The package `mammoth` version `1.12.0` exists on npm, points to `mwilliamson/mammoth.js`, has no postinstall script, and passed the GSD package-legitimacy check. [VERIFIED: npm registry]

**Primary recommendation:** Add a DB-backed first-search run state machine and deterministic DOCX intake around the current candidate/source/scan modules; do not route the first run through chat, skills, Playwright, or compatibility files. [VERIFIED: codebase rg]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Quick readiness and cadence capture | Browser / Client | API / Backend | The React onboarding flow owns the prompt and form state, while `/api/onboard/candidate/*` persists validated profile and targeting patches. [VERIFIED: apps/web/src/onboarding] [VERIFIED: src/cli/onboard-route.mjs] |
| DOCX resume upload | API / Backend | Database / Storage | The server must save the original file, extract text, quality-gate readiness, and write candidate artifacts. [VERIFIED: src/cli/onboard-route.mjs] |
| First source setup | API / Backend | Database / Storage | Source generation already lives in server-side profile code and source configs already persist in SQLite. [VERIFIED: src/core/profile/generate-search-sources.mjs] [VERIFIED: src/core/db/verbs/source-config.mjs] |
| First sourcing run | API / Backend | External public ATS/RSS | The local route should orchestrate `runSourcedScan`; the scanner fetches public ATS/RSS sources and writes results. [VERIFIED: src/cli/search-route.mjs] [VERIFIED: scripts/scan-sourced.mjs] |
| Run progress and results UI | Browser / Client | API / Backend | React should display durable status while polling or refreshing API state; the DB-backed API owns truth. [VERIFIED: apps/web/src/onboarding/steps/FinishStep.jsx] [VERIFIED: apps/web/src/lib/api.js] |
| Manual repeat search | Browser / Client | API / Backend | The Jobs page is the product surface for later searches, and `/api/search/sources` already exposes DB source availability. [VERIFIED: apps/web/src/jobs/JobsPage.jsx] [VERIFIED: src/cli/search-route.mjs] |

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ONB-01 | Quick onboarding captures the minimum profile, resume, role, location, comp, and search posture needed to start searching. | Existing `search_ready` excludes comp, so planning should add cadence/search posture capture without widening the gate. [VERIFIED: .planning/REQUIREMENTS.md] [VERIFIED: src/core/db/verbs/candidate.mjs] |
| ONB-02 | Resume support treats PDF as the standard, keeps text/markdown fallback, and records board-required import/export formats such as DOCX where needed. | Existing text/markdown and PDF/image paths can remain; add DOCX deterministic extraction plus original-file storage and toolchain/export preference capture. [VERIFIED: .planning/REQUIREMENTS.md] [VERIFIED: apps/web/src/onboarding/steps/ResumeStep.jsx] [VERIFIED: config/profile.schema.json] |
| RUN-01 | A DB-backed sourcing run starts automatically when candidate setup first reaches `search_ready`. | Add durable `sourcing_runs` state and make the first-run start path idempotent against the existing DB source setup and scanner. [VERIFIED: .planning/REQUIREMENTS.md] |
| RUN-02 | React surfaces durable sourcing run progress, errors, and results while returning the user to deeper onboarding. | Finish/setup UI should read DB run state, show status/errors/results, and continue deep ingest while the scanner runs. [VERIFIED: .planning/REQUIREMENTS.md] [VERIFIED: apps/web/src/onboarding/steps/FinishStep.jsx] |
</phase_requirements>

## Standard Stack

### Core

| Library / Module | Version | Purpose | Why Standard |
|------------------|---------|---------|--------------|
| Node.js `node:sqlite` / `DatabaseSync` | Node `v24.18.0` local runtime | Durable local DB state for candidate setup, source configs, sourced rows, and new run records. | The repo already uses `node:sqlite` for DB connection and migrations; official docs describe `DatabaseSync` as a SQLite connection with prepared statements. [VERIFIED: src/core/db/connection.mjs] [CITED: https://nodejs.org/api/sqlite.html] |
| React | Lockfile `19.2.7`; registry latest `19.2.7` modified 2026-07-03 | Onboarding, setup checklist, Jobs page UI. | Existing app uses React 19 and React Router; no UI framework swap is needed. [VERIFIED: package-lock.json] [VERIFIED: apps/web/package.json] |
| React Router DOM | Lockfile `7.18.1`; registry latest `7.18.1` modified 2026-06-29 | Client routing for `/app`. | Existing app shell routes onboarding and Jobs pages through this stack. [VERIFIED: package-lock.json] [VERIFIED: apps/web/src] |
| Vite | Lockfile `6.4.3`; registry latest `8.1.3` modified 2026-07-02 | React dev/test build. | The repo pins Vite 6 in the app workspace; Phase 7 should not bundle a Vite major upgrade. [VERIFIED: package-lock.json] [VERIFIED: apps/web/vite.config.js] |
| Vitest | Lockfile `3.2.6`; registry latest `4.1.9` modified 2026-06-15 | React component tests. | Existing web tests use Vitest and `renderToStaticMarkup`; keep this for Finish/Resume/Jobs UI tests. [VERIFIED: package-lock.json] [VERIFIED: apps/web/src/onboarding/steps/FinishStep.test.jsx] |
| Node test runner | Node `v24.18.0` | Backend route, DB, scanner, migration tests. | Existing backend tests use `node:test` and temp repo fixtures. [VERIFIED: tests/onboard-route.test.mjs] [VERIFIED: tests/search-route.test.mjs] |
| `mammoth` | `1.12.0`, published 2026-03-12 | Deterministic DOCX-to-text extraction. | Official README documents raw text extraction and npm/package-legitimacy checks passed with no postinstall script. [CITED: https://github.com/mwilliamson/mammoth.js/] [VERIFIED: npm registry] |

### Supporting

| Library / Module | Version | Purpose | When to Use |
|------------------|---------|---------|-------------|
| `runSourcedScan` | Existing repo module | Deterministic ATS/RSS scanning with DB persistence. | Use for first search and manual Jobs-page searches instead of a new sourcing path. [VERIFIED: scripts/scan-sourced.mjs] |
| `sourceConfigPut` / `sourceConfigGet` | Existing repo module | DB source config reads/writes. | Use for product source setup; do not key readiness off YAML exports. [VERIFIED: src/core/db/verbs/source-config.mjs] |
| `candidateArtifactPut` | Existing repo module | Source resume artifact and readiness refresh. | Use only after DOCX/text/PDF extraction is usable enough to satisfy `search_ready`. [VERIFIED: src/core/db/verbs/candidate.mjs] |
| `exportArtifact` / `detectDocxCapability` | Existing repo module | Packet/resume PDF/DOCX export support. | Use to record and later satisfy board-required export needs; do not solve DOCX intake with export code. [VERIFIED: src/core/documents/export.mjs] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| DB-backed first-run table | In-memory `scanning` flag only | In-memory state cannot survive reloads and cannot satisfy durable React progress. [VERIFIED: src/cli/search-route.mjs] |
| Deterministic scanner | Chat handoff to `research-boards` / `search-jobs` | Locked decisions forbid chat/skill first search. [VERIFIED: 07-CONTEXT.md] |
| `mammoth` for DOCX | Custom ZIP/XML parsing | The official package exposes the needed raw-text API, so planner should not budget custom OOXML parsing. [CITED: https://github.com/mwilliamson/mammoth.js/] |
| In-process background promise | External queue package | The project is a local SQLite app, and a queue dependency is not needed for a single local server first-run task. [VERIFIED: .planning/PROJECT.md] [ASSUMED] |
| Public ATS/RSS first run | Playwright browser capture | Auth/browser sources are explicitly deferred from automatic first run. [VERIFIED: 07-CONTEXT.md] |

**Installation:**
```bash
npm install mammoth
```

**Version verification performed:**
```bash
npm view mammoth version time.created time.modified repository.url homepage license description dist.unpackedSize scripts.postinstall
npm view react version time.modified repository.url license scripts.postinstall
npm view react-router-dom version time.modified repository.url license scripts.postinstall
npm view vite version time.modified repository.url license scripts.postinstall
npm view vitest version time.modified repository.url license scripts.postinstall
```

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `mammoth` | npm | Created 2013-05-06; modified 2026-03-12 | 5,166,283/week | `github.com/mwilliamson/mammoth.js` | OK | Approved for DOCX text extraction. [VERIFIED: npm registry] |

**Packages removed due to [SLOP] verdict:** none. [VERIFIED: package-legitimacy check]
**Packages flagged as suspicious [SUS]:** none. [VERIFIED: package-legitimacy check]

*Packages discovered via WebSearch or training data that have not been verified against an authoritative source should be treated as assumed and the planner must gate each install behind a `checkpoint:human-verify` task.*

## Architecture Patterns

### System Architecture Diagram

```text
Resume / Role / Location / Cadence input
  -> React onboarding steps
  -> /api/onboard/resume|resume-ai|resume-docx and /api/onboard/candidate/*
  -> SQLite candidate profile / targeting / artifacts
  -> candidate_setup readiness recompute
  -> search_ready first true?
      no -> continue onboarding with missing fields
      yes -> first-run prompt (yes selected by default)
          -> POST /api/sourcing/first-run/start
          -> DB source setup via buildSearchSources + sourceConfigPut
          -> sourcing_runs row: Running
          -> async runSourcedScan({ write: true })
              -> public ATS APIs and RSS only
              -> JD body capture + sourcedUpsertBatch
              -> sourcing_runs row: Completed or Failed
          -> React setup task polls/refreshes run state
          -> user continues deep onboarding
```

The diagram reflects the recommended data flow through existing modules plus a new durable run-state owner. [VERIFIED: codebase rg]

### Recommended Project Structure

```text
src/
├── core/onboarding/
│   ├── first-search-run.mjs        # first-run idempotency, status transitions
│   └── resume-docx.mjs             # DOCX extraction and quality gate
├── core/db/migrations/
│   └── 007-sourcing-runs.mjs       # durable run table
├── core/db/verbs/
│   └── sourcing-runs.mjs           # create/start/complete/fail/read latest
├── cli/
│   └── sourcing-route.mjs          # first-run and manual run HTTP surface
apps/web/src/
├── onboarding/steps/FinishStep.jsx # prompt, checklist row, run state display
├── onboarding/steps/ResumeStep.jsx # DOCX accept path and fallback copy
└── jobs/JobsPage.jsx               # gated Search jobs action
tests/
├── sourcing-runs.test.mjs
├── onboard-route.test.mjs
├── search-route.test.mjs
└── scan-sourced.test.mjs
```

The exact filenames can vary, but the planner should keep DB verbs, HTTP routes, scanner orchestration, and React display separate. [VERIFIED: repo conventions]

### Pattern 1: Durable First-Run State Machine

**What:** Store first-search state in SQLite with statuses `not_started`, `running`, `completed`, and `failed`, then map those to UI labels `Not started`, `Running`, `Completed`, and `Failed`. [VERIFIED: 07-CONTEXT.md]

**When to use:** Use this for the first search and for manual Jobs-page runs if the manual action needs durable progress after reload.

**Example:**
```javascript
// Source: repo DB verb patterns in src/core/db/verbs/shared.mjs
export function markSourcingRunRunning({ repoRoot, env, id }) {
  const db = openDb({ repoRoot, env });
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE sourcing_runs
       SET status = 'running', started_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('not_started', 'failed')`
    ).run(now, now, id);
    return readSourcingRun(db, id);
  });
}
```

### Pattern 2: Idempotent Search-Ready Trigger

**What:** Detect first readiness in React/API state, but make the server route idempotent by looking for an existing `purpose='first-search'` run before creating a new one. [VERIFIED: src/core/db/verbs/candidate.mjs]

**When to use:** Use this whenever a user reloads, clicks continue twice, or reaches `search_ready` through resume, role, or location edits.

**Example:**
```javascript
// Source: repo route patterns in src/cli/onboard-route.mjs and src/cli/search-route.mjs
addRoute("POST", "/api/sourcing/first-run/start", async (_req, res) => {
  const existing = getLatestFirstSearchRun(pathCtx);
  if (existing?.status === "running" || existing?.status === "completed") {
    sendJson(res, 200, { ok: true, run: existing, reused: true });
    return;
  }
  const run = startFirstSearchRun(pathCtx);
  void runFirstSearchInBackground({ ...pathCtx, runId: run.id, fetchImpl });
  sendJson(res, 202, { ok: true, run });
});
```

### Pattern 3: DOCX Intake With Quality Gate

**What:** Save original DOCX bytes, extract raw text server-side, then only write the canonical `source-resume` artifact if extracted text passes a basic usability check. [VERIFIED: 07-CONTEXT.md] [CITED: https://github.com/mwilliamson/mammoth.js/]

**When to use:** Use for `.docx` uploads in quick onboarding; keep PDF/image on existing AI extraction and text/markdown on deterministic parse. [VERIFIED: apps/web/src/onboarding/steps/ResumeStep.jsx]

**Example:**
```javascript
// Source: Mammoth README extractRawText API; route storage pattern from src/cli/onboard-route.mjs
import mammoth from "mammoth";

export async function extractDocxResumeText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const text = normalizeResumeText(result.value || "");
  if (!looksLikeUsableResume(text)) {
    return { ok: false, text, messages: result.messages || [] };
  }
  return { ok: true, text, messages: result.messages || [] };
}
```

### Pattern 4: Deterministic Sources Only for First Run

**What:** Use public ATS entries and RSS-bearing search sources; do not call browser capture or authenticated platforms for the automatic run. [VERIFIED: src/core/scoring/sourced-scanner.mjs] [VERIFIED: 07-CONTEXT.md]

**When to use:** Use for the first run started from onboarding. [VERIFIED: 07-CONTEXT.md]

**Example:**
```javascript
// Source: scanSearchSources filters to source_type "rss" or rssUrl.
const deterministicSources = searches.filter(
  (source) => source?.enabled !== false && (source.source_type === "rss" || source.rssUrl)
);
```

### Anti-Patterns to Avoid

- **Launching discovery chat from quick onboarding:** This violates the locked no-chat first-search decision. [VERIFIED: 07-CONTEXT.md]
- **Treating `config/search-sources.yml` as readiness:** Product source setup must come from SQLite source config. [VERIFIED: ./AGENTS.md] [VERIFIED: tests/search-route.test.mjs]
- **Calling browser capture for the first run:** Authenticated/browser sources are deferred from auto sourcing. [VERIFIED: 07-CONTEXT.md]
- **Marking bad DOCX text as `source-resume`:** `candidateArtifactPut` refreshes readiness, so a bad artifact can incorrectly unlock `search_ready`. [VERIFIED: src/core/db/verbs/candidate.mjs]
- **Blocking deep onboarding until search completes:** RUN-02 requires returning the user to deeper onboarding while progress remains visible. [VERIFIED: .planning/REQUIREMENTS.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| DOCX text extraction | Custom ZIP/XML reader | `mammoth.extractRawText` | Official docs support raw DOCX text extraction in Node, and the package passed legitimacy checks. [CITED: https://github.com/mwilliamson/mammoth.js/] [VERIFIED: npm registry] |
| Sourcing scan | New board crawler | `runSourcedScan` | Existing scanner already filters, dedupes, scores, captures JDs, writes DB rows, and stamps RSS watermarks. [VERIFIED: scripts/scan-sourced.mjs] |
| Source setup persistence | YAML freshness checks | `sourceConfigPut` / `sourceConfigGet` | DB source config is the app product state. [VERIFIED: src/core/db/verbs/source-config.mjs] [VERIFIED: ./AGENTS.md] |
| Candidate readiness | New readiness booleans in React | `candidate_setup` from DB | The DB verb already computes staged `search_ready`, `gate_ready`, `apply_ready`, and `deep_ingest_complete`. [VERIFIED: src/core/db/verbs/candidate.mjs] |
| Run queue | External queue package | SQLite run row plus in-process background promise | The app is local and single-server; durable state is more important than a distributed queue. [VERIFIED: .planning/PROJECT.md] [ASSUMED] |
| Manual first-search results storage | Scan-result JSON files | `sourcedUpsertBatch` through scan persistence | DB mode ignores legacy scan-result files as source of truth. [VERIFIED: tests/search-route.test.mjs] |

**Key insight:** The phase is an orchestration and durability problem, not a data-source discovery problem. [VERIFIED: codebase rg] The planner should reuse current scan, persistence, and readiness modules and add the missing run-state boundary. [VERIFIED: codebase rg]

## Common Pitfalls

### Pitfall 1: Widening `search_ready`
**What goes wrong:** The first search waits for compensation, authorization, or deep evidence. [VERIFIED: 07-CONTEXT.md]
**Why it happens:** Engineers may confuse `search_ready` with `gate_ready` or `apply_ready`. [VERIFIED: src/core/db/verbs/candidate.mjs]
**How to avoid:** Keep comp in later gates and add cadence/search posture separately. [VERIFIED: 07-CONTEXT.md]
**Warning signs:** Tests expect `search_ready` false when only comp is missing.

### Pitfall 2: Hidden Chat Handoff
**What goes wrong:** FinishStep starts `/api/discovery/quick-start`, which launches or reuses a chat. [VERIFIED: apps/web/src/onboarding/steps/FinishStep.test.jsx] [VERIFIED: src/cli/discovery-route.mjs]
**Why it happens:** Existing tests and UI still model quick start as a discovery chat handoff. [VERIFIED: apps/web/src/onboarding/steps/FinishStep.test.jsx]
**How to avoid:** Move first search to a local sourcing route and reserve discovery chat for explicit later handoffs. [VERIFIED: 07-CONTEXT.md]
**Warning signs:** Response payloads contain `chat`, `chatId`, `nextSkill`, `research-boards`, or `search-jobs`. [VERIFIED: tests/discovery-route.test.mjs]

### Pitfall 3: Non-Durable Progress
**What goes wrong:** Reloading the app loses whether the first search is running, failed, or completed. [VERIFIED: src/cli/search-route.mjs]
**Why it happens:** `/api/search/scan` uses an in-memory flag and returns only immediate request state. [VERIFIED: src/cli/search-route.mjs]
**How to avoid:** Persist run records and expose a read route used by React.
**Warning signs:** UI state lives only in `useState` or a module-local variable. [VERIFIED: apps/web/src/onboarding/steps/FinishStep.jsx]

### Pitfall 4: Deterministic Source Count Is Misleading
**What goes wrong:** The first run appears to scan sources, but generated HiringCafe/Wellfound browser entries are skipped by the deterministic scanner. [VERIFIED: src/core/profile/generate-search-sources.mjs] [VERIFIED: src/core/scoring/sourced-scanner.mjs]
**Why it happens:** `buildSearchSources` can generate `url-query` and `browser` entries, while `scanSearchSources` only fetches RSS-bearing sources. [VERIFIED: src/core/profile/generate-search-sources.mjs] [VERIFIED: src/core/scoring/sourced-scanner.mjs]
**How to avoid:** Report deterministic fetchable counts separately from total configured sources.
**Warning signs:** A source setup with only HiringCafe/Wellfound reports `Completed` without explaining that no deterministic source was fetchable.

### Pitfall 5: DOCX Unlocks Readiness on Garbage Text
**What goes wrong:** A malformed DOCX writes `source-resume`, making `search_ready` true without usable resume content. [VERIFIED: src/core/db/verbs/candidate.mjs]
**Why it happens:** Resume readiness is keyed by the `source-resume` candidate artifact, not by later parsing success. [VERIFIED: src/core/db/verbs/candidate.mjs]
**How to avoid:** Save the original upload under a non-ready artifact/path, and only write `source-resume` after text passes the quality gate. [VERIFIED: 07-CONTEXT.md] [ASSUMED]
**Warning signs:** DOCX route calls `candidateArtifactPut({ id: "source-resume" })` before checking extracted text. [VERIFIED: src/cli/onboard-route.mjs]

### Pitfall 6: Treating Zero Results as a Network Failure
**What goes wrong:** A successful deterministic run with no matching roles is shown as a technical failure. [VERIFIED: 07-CONTEXT.md]
**Why it happens:** The status model has no separate `Needs refinement` status in the locked list. [VERIFIED: 07-CONTEXT.md]
**How to avoid:** Prefer `Completed` with refinement guidance when the scan finished without errors, and reserve `Failed` for route/scanner errors. [ASSUMED]
**Warning signs:** `summary.errors.length === 0` and `summary.new === 0`, but the UI says the scan failed. [ASSUMED]

## Code Examples

Verified patterns from official sources and the repo:

### DOCX Raw Text Extraction
```javascript
// Source: https://github.com/mwilliamson/mammoth.js/
import mammoth from "mammoth";

export async function parseDocxResume(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: String(result.value || ""),
    warnings: result.messages || [],
  };
}
```

### First-Run Background Wrapper
```javascript
// Source: src/cli/search-route.mjs and scripts/scan-sourced.mjs
async function runFirstSearchInBackground({ repoRoot, env, fetchImpl, runId }) {
  try {
    const summary = await runSourcedScan({ repoRoot, env, fetchImpl, write: true });
    completeSourcingRun({ repoRoot, env, id: runId, summary });
  } catch (error) {
    failSourcingRun({
      repoRoot,
      env,
      id: runId,
      error: { message: error?.message || String(error) },
    });
  }
}
```

### Deterministic Source Health
```javascript
// Source: src/core/scoring/sourced-scanner.mjs
export function countDeterministicSources(searchSources = {}, sourcedScan = {}) {
  const rss = (searchSources.searches || []).filter(
    (source) => source && source.enabled !== false && (source.source_type === "rss" || source.rssUrl)
  ).length;
  const ats = Array.isArray(sourcedScan.tracked_companies)
    ? sourcedScan.tracked_companies.length
    : 0;
  return { rss, ats, total: rss + ats };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Quick start prepares compatibility files and tells the agent to run discovery skills. | Phase 7 should start a local DB-backed deterministic first run with no chat. | Locked by Phase 7 context on 2026-07-05. | Planner must replace existing FinishStep quick-start handoff behavior. [VERIFIED: 07-CONTEXT.md] |
| Product readiness could be confused with generated YAML. | DB source config is the product state and legacy files are support output. | Established before Phase 7 in route/tests and AGENTS contract. | Planner must keep readiness checks against SQLite. [VERIFIED: ./AGENTS.md] [VERIFIED: tests/search-route.test.mjs] |
| Search scan progress is request-local. | Phase 7 needs durable run state in SQLite. | Required by RUN-02. | Planner must add migration, verbs, read route, and UI display. [VERIFIED: .planning/REQUIREMENTS.md] |
| PDF/image resume extraction uses bounded AI and text/markdown is deterministic. | DOCX should be deterministic with original-file preservation and fallback. | Locked by Phase 7 context on 2026-07-05. | Planner must add `.docx` to accept lists and route validation without AI dependency. [VERIFIED: 07-CONTEXT.md] |

**Deprecated/outdated:**
- `/api/discovery/quick-start` as first-search path: it starts supervised discovery chat and is not valid for automatic first search. [VERIFIED: src/cli/discovery-route.mjs] [VERIFIED: 07-CONTEXT.md]
- `config/search-sources.yml` as product readiness: DB mode tests reject legacy-only source configs. [VERIFIED: tests/search-route.test.mjs]
- DOCX through `POST /api/onboard/resume` text fallback: the route rejects binary-looking PDF/DOCX text and tells users to export text/markdown. [VERIFIED: src/cli/onboard-route.mjs]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A SQLite run row plus in-process background promise is sufficient for first-run orchestration in this local app. | Standard Stack / Architecture Patterns | If Rolester needs multi-process workers, run locking and recovery need a stronger queue model. |
| A2 | Basic resume-text quality checks can detect empty/garbled DOCX extraction well enough for onboarding. | Architecture Patterns / Common Pitfalls | If checks are too loose, bad DOCX text can unlock `search_ready`; if too strict, valid resumes need manual fallback. |
| A3 | Successful zero-result scans should usually be `Completed` with refinement guidance rather than `Failed`. | Common Pitfalls | If product wants zero deterministic sources to be actionable failure, UI copy and status mapping must differ. |

## Open Questions

1. **Where should first-search routes live?**
   - What we know: onboarding owns the first prompt and search route owns scan execution. [VERIFIED: src/cli/onboard-route.mjs] [VERIFIED: src/cli/search-route.mjs]
   - What's unclear: whether to add `src/cli/sourcing-route.mjs` or extend existing onboard/search routes.
   - Recommendation: add a small sourcing route if run-state endpoints are shared by onboarding and Jobs.

2. **How should zero deterministic sources be displayed?**
   - What we know: generated source setup may include non-fetchable browser/url-query entries that the deterministic scanner skips. [VERIFIED: src/core/profile/generate-search-sources.mjs] [VERIFIED: src/core/scoring/sourced-scanner.mjs]
   - What's unclear: whether zero fetchable sources should count as `Completed` with guidance or `Failed`/`Needs setup`. [VERIFIED: 07-CONTEXT.md]
   - Recommendation: show `Completed` only when at least one deterministic source was attempted; otherwise show `Failed` with an actionable source-setup message.

3. **What is the exact cadence schema?**
   - What we know: `targeting.search_preferences.posting_age` exists and maps fixed days to generated recency. [VERIFIED: config/targeting.schema.json] [VERIFIED: src/core/profile/generate-search-sources.mjs]
   - What's unclear: whether cadence should be a new `search_preferences.cadence` object or a run-level preference table.
   - Recommendation: add `targeting.search_preferences.cadence` for user preference, and keep actual run history in `sourcing_runs`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Local APIs, `node:sqlite`, tests | Yes | `v24.18.0` | None needed. [VERIFIED: environment command] |
| npm | Package install and scripts | Yes | `11.16.0` | None needed. [VERIFIED: environment command] |
| Rolester CLI on PATH | Manual CLI smoke checks | No | `rolester` missing | Use `node bin/rolester.mjs`; it reports `0.5.2`. [VERIFIED: environment command] |
| SQLite service | DB state | Built into Node | `node:sqlite` | No external service required. [VERIFIED: src/core/db/connection.mjs] |
| Playwright | Existing PDF export and browser capture | Yes in lockfile | `1.60.0` | Not needed for first automatic search. [VERIFIED: package-lock.json] |
| pandoc | DOCX/PDF packet export support | Yes | `pandoc 3.10` | Existing fallback uses LibreOffice or built-in OOXML. [VERIFIED: environment command] [VERIFIED: src/core/documents/export.mjs] |
| LibreOffice `soffice` | DOCX packet export fallback | Yes | `LibreOffice 26.2.4.2` | Built-in OOXML fallback exists. [VERIFIED: environment command] [VERIFIED: src/core/documents/export.mjs] |

**Missing dependencies with no fallback:**
- None for planning or local implementation. [VERIFIED: environment command]

**Missing dependencies with fallback:**
- `rolester` is not on PATH; use `node bin/rolester.mjs` for CLI smoke checks unless the user runs `npm link`. [VERIFIED: environment command] [VERIFIED: ./AGENTS.md]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Backend framework | Node `node:test` under Node `v24.18.0`. [VERIFIED: tests/onboard-route.test.mjs] |
| Frontend framework | Vitest `3.2.6` with React `19.2.7`. [VERIFIED: package-lock.json] |
| Config file | `apps/web/vite.config.js`. [VERIFIED: apps/web/vite.config.js] |
| Quick backend run | `node --test tests/onboard-route.test.mjs tests/search-route.test.mjs tests/scan-sourced.test.mjs tests/db-migrations.test.mjs` |
| Quick frontend run | `npm --workspace apps/web run test -- FinishStep.test.jsx OnboardingPage.test.jsx SetupReadinessCard.test.jsx` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| ONB-01 | `search_ready` stays early while cadence/search posture is captured. | Unit + route | `node --test tests/candidate-setup.test.mjs tests/onboard-route.test.mjs` | Existing plus Wave 0 additions. [VERIFIED: tests/candidate-setup.test.mjs] |
| ONB-02 | DOCX upload saves original, extracts deterministic text, rejects empty/garbled extraction without `source-resume`. | Route + component | `node --test tests/onboard-route.test.mjs && npm --workspace apps/web run test -- ResumeStep.test.jsx` | Backend exists; frontend DOCX test is Wave 0 gap. [VERIFIED: tests/onboard-route.test.mjs] |
| RUN-01 | First DB-backed sourcing run starts once when `search_ready` first becomes true. | DB + route | `node --test tests/sourcing-runs.test.mjs tests/onboard-route.test.mjs` | `tests/sourcing-runs.test.mjs` is Wave 0 gap. |
| RUN-02 | React shows durable run status/progress/errors/results and allows deep onboarding continuation. | Component + route | `npm --workspace apps/web run test -- FinishStep.test.jsx SetupReadinessCard.test.jsx` | Existing tests need updates. [VERIFIED: apps/web/src/onboarding/steps/FinishStep.test.jsx] |

### Sampling Rate

- **Per task commit:** run the targeted backend or frontend command listed for the touched surface. [VERIFIED: repo test layout]
- **Per wave merge:** run `node --test tests/onboard-route.test.mjs tests/search-route.test.mjs tests/scan-sourced.test.mjs tests/db-migrations.test.mjs` and the related Vitest files. [VERIFIED: repo test layout]
- **Phase gate:** run `npm test` before `$gsd-verify-work`. [VERIFIED: package.json]

### Wave 0 Gaps

- [ ] `src/core/db/migrations/007-sourcing-runs.mjs` and migration tests for sequential migration id 7. [VERIFIED: src/core/db/migrations.mjs]
- [ ] `src/core/db/verbs/sourcing-runs.mjs` tests for status transitions, idempotency, and persisted error/summary JSON.
- [ ] DOCX fixture and `tests/onboard-route.test.mjs` cases for valid DOCX, garbled DOCX, oversized DOCX, and no-AI path.
- [ ] Frontend `ResumeStep` DOCX test file because no `ResumeStep.test.jsx` exists today. [VERIFIED: rg --files]
- [ ] Updated `FinishStep.test.jsx` expectations that first search does not return `chat` or discovery `nextSkill`. [VERIFIED: apps/web/src/onboarding/steps/FinishStep.test.jsx]
- [ ] Jobs page test for `Search jobs` button visibility after `/api/search/sources` reports DB source setup.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | No for local first-run route | Do not add auth complexity to local-only onboarding; keep browser/auth platform consent separate. [VERIFIED: ./AGENTS.md] |
| V3 Session Management | No for first deterministic run | Do not create hidden sessions or browser automation for first search. [VERIFIED: 07-CONTEXT.md] |
| V4 Access Control | Yes for local capability boundaries | Keep authenticated/browser sourcing behind existing automation consent and do not call it from first run. [VERIFIED: ./AGENTS.md] |
| V5 Input Validation | Yes | Use capped body reads, extension allowlists, schema validation, sanitized filenames, and DOCX quality gates. [VERIFIED: src/cli/onboard-route.mjs] |
| V6 Cryptography | No new crypto | Do not add custom crypto; existing BYOK storage remains through `ai-env.mjs`. [VERIFIED: ./AGENTS.md] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| DOCX upload with path traversal filename | Tampering | Keep `sanitizeUploadFilename` and save under `workspace/intake/resume-uploads/`. [VERIFIED: src/cli/onboard-route.mjs] |
| DOCX converted content embedded as HTML | XSS | Extract raw text only; do not render Mammoth HTML; treat extracted text as untrusted data. [CITED: https://github.com/mwilliamson/mammoth.js/] |
| DOCX external file references | Information Disclosure | Do not enable Mammoth external file access. [CITED: https://github.com/mwilliamson/mammoth.js/] |
| Oversized upload / decompression-heavy document | Denial of Service | Keep upload size caps and add DOCX-specific maximum byte limit before parsing. [VERIFIED: src/cli/onboard-route.mjs] |
| Run double-click causing duplicate scans | Tampering / Reliability | Enforce DB idempotency and status checks in first-run verb. |
| SQL injection in run state | Tampering | Use prepared statements and JSON validation like existing DB code. [VERIFIED: src/core/db/connection.mjs] [CITED: https://nodejs.org/api/sqlite.html] |
| Hidden authenticated source access | Elevation of Privilege | Automatic first run uses unauthenticated ATS/RSS only. [VERIFIED: 07-CONTEXT.md] |
| Prompt injection from resume/JD content | Spoofing / Tampering | DOCX text path is deterministic and no-AI; PDF/image AI path remains bounded with schema/manual fallback. [VERIFIED: src/cli/onboard-route.mjs] [VERIFIED: .planning/PROJECT.md] |

## Sources

### Primary (HIGH confidence)
- `src/core/db/verbs/candidate.mjs` - readiness computation and source-resume artifact behavior. [VERIFIED: codebase rg]
- `src/cli/onboard-route.mjs` - onboarding state, resume routes, quick-start behavior, filename sanitization. [VERIFIED: codebase rg]
- `src/cli/search-route.mjs` - existing scan/result/source API and in-memory scan flag. [VERIFIED: codebase rg]
- `scripts/scan-sourced.mjs` - deterministic scan orchestration and DB persistence. [VERIFIED: codebase rg]
- `src/core/scoring/sourced-scanner.mjs` - public ATS/RSS scanner behavior and browser/auth skip. [VERIFIED: codebase rg]
- `src/core/scoring/sourced-persistence.mjs` - JD capture and sourced row persistence. [VERIFIED: codebase rg]
- `apps/web/src/onboarding/steps/FinishStep.jsx` and `FinishStep.test.jsx` - existing readiness/quick-start UI and chat-handoff tests. [VERIFIED: codebase rg]
- `.planning/phases/ROL-API-07-quick-onboarding-and-auto-sourcing/07-CONTEXT.md` - locked Phase 7 decisions. [VERIFIED: codebase rg]
- `./AGENTS.md` - app routing, DB write, source setup, privacy, and automation constraints. [VERIFIED: codebase rg]

### Secondary (MEDIUM confidence)
- `https://github.com/mwilliamson/mammoth.js/` - Mammoth raw text extraction API and security notes. [CITED: https://github.com/mwilliamson/mammoth.js/]
- `https://www.npmjs.com/package/mammoth` plus `npm view mammoth ...` - package metadata, latest version, repository, no postinstall script. [VERIFIED: npm registry]
- `https://nodejs.org/api/sqlite.html` - official `node:sqlite` and `DatabaseSync` documentation. [CITED: https://nodejs.org/api/sqlite.html]

### Tertiary (LOW confidence)
- None used as authority. [VERIFIED: research notes]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - existing stack and exact lockfile versions were verified locally; only the new DOCX package is external and passed package legitimacy. [VERIFIED: package-lock.json] [VERIFIED: npm registry]
- Architecture: HIGH - primary flow is grounded in existing DB, onboarding, search, and scanner modules. [VERIFIED: codebase rg]
- Pitfalls: HIGH for codebase pitfalls and MEDIUM for DOCX parser security because Mammoth guidance came from official GitHub/npm sources through web search. [VERIFIED: codebase rg] [CITED: https://github.com/mwilliamson/mammoth.js/]

**Research date:** 2026-07-05
**Valid until:** 2026-08-04 for repo architecture; 2026-07-12 for npm/package-version assumptions.
