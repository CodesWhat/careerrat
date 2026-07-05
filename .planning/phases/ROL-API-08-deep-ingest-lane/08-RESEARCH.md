# Phase 8: Deep Ingest Lane - Research

**Researched:** 2026-07-05  
**Domain:** SQLite-native local app intake, bounded AI proposal extraction, and React review UX  
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

All content in this section is copied from `.planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md`. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]

### Locked Decisions

## Implementation Decisions

### SQLite-Native Structure
- **D-01:** Build Phase 8 as a new SQLite-native product structure. Do not spend phase scope on migration choreography, legacy candidate-file compatibility, or preserving old ingest-profile file shapes as product requirements.
- **D-02:** Existing candidate files and generated compatibility exports may remain for older flows, but they are not the source of truth or acceptance target for this phase. The React app and local APIs should read/write the new DB-backed deep-ingest state.
- **D-03:** Downstream planning should define the correct DB shape for deep ingest outputs, including evidence claims, story bank entries, honesty boundaries, writing voice, role-specific signals, source artifacts, gaps, and per-lane completion state.

### Context-Aware Review Flow
- **D-04:** Review material according to where the user added it. If the user drops material while working in an evidence flow, the proposed output should be reviewed as evidence. If the user adds material from the Library/Evidence area, the UI should let them choose the target shape, such as evidence, story, writing voice, honesty boundary, role signal, paste, or link, then run ingest for that shape.
- **D-05:** Ingest output is proposal-first. AI or scanners may propose structured updates, but user-visible review/edit/confirm is required before trusted candidate facts become reusable evidence, stories, honesty boundaries, or writing voice.
- **D-06:** A general capture/inbox queue can remain useful for unknown or cross-cutting drops, but Phase 8 should not force every deep-ingest action through a generic Inbox card when a type-specific review surface is clearer.

### Bounded Extraction, Not AI Interview
- **D-07:** Defer the full role/job-aware AI interview to a later phase. Do not build a guided chat/interview lane in Phase 8.
- **D-08:** Use bounded, schema-validated AI calls for extraction and transformation where deterministic parsing is insufficient: evidence extraction, story draft proposals, writing-voice summaries, honesty-boundary candidates, role-signal classification, and gap detection.
- **D-09:** Bounded AI output remains untrusted until it passes schema validation, deterministic safety checks, and user review. It must not directly write final candidate facts without confirmation.

### Completion Semantics
- **D-10:** `deep_ingest_complete` means the full deep-ingest checklist has reached terminal states, not that every possible artifact exists.
- **D-11:** Each required lane is terminal when it is completed, explicitly marked not available, or deferred as a visible todo. This handles users who do not have every source artifact or story ready.
- **D-12:** Progress must be durable, resumable, and visible in onboarding/dashboard readiness. Deep ingest should not block already-running sourcing once quick onboarding has reached `search_ready`.

### Source and Repository Scanning
- **D-13:** Ingest should actively try to parse, fetch, scan, and extract from what the user provides rather than storing links as inert notes by default.
- **D-14:** Pasted text and text files should be read directly. URLs should be fetched/extracted when public and safe. Public repo links should be scanned within bounded limits for README/docs/package metadata and key project context. Local paths may be scanned when explicitly provided by the user.
- **D-15:** Private, huge, unsupported, login-gated, truncated, or unreadable sources should produce explicit review gaps or "not available" states instead of blocking the flow or pretending extraction succeeded.

### the agent's Discretion

The user delegated implementation details to the planner and executor: choose exact table names, route names, API envelopes, lane names, bounded scan limits, file-type coverage, extraction schemas, validation tests, and UI layout. Preserve the locked product intent above: new DB-backed structure, context-aware review, bounded extraction calls, no full AI interview in this phase, active best-effort scanning, and checklist-terminal completion.

### Deferred Ideas (OUT OF SCOPE)

- Full role/job-aware AI interview lane — future phase.
- Full unbounded repository cloning or authenticated private-source scanning — future work unless the planner can provide a small, explicitly consented, bounded path inside Phase 8.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ING-01 | Accept a drop-all intake for resumes, notes, LinkedIn/project links, repos, portfolios, pasted facts, recruiter context, and job context. [VERIFIED: .planning/REQUIREMENTS.md] | Plan a target-aware Deep ingest source API plus React intake surface that handles paste, file, URL, repo, portfolio, recruiter/job context, and explicit local path sources; every source must become a proposal, gap, deferred item, not-available item, manual fallback, or failure row. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |
| ING-02 | Derive evidence, story bank entries, honesty boundaries, writing voice, role-specific signals, and unanswered gaps into DB state. [VERIFIED: .planning/REQUIREMENTS.md] | Plan new SQLite-native deep-ingest source/proposal/lane tables and DB verbs that confirm reviewed proposals into trusted candidate evidence plus new DB-backed story, honesty, voice, role-signal, and gap state. [VERIFIED: src/core/db/verbs/candidate.mjs] |
| ING-03 | Provide deeper context through structured React forms and an optional AI interview. [VERIFIED: .planning/REQUIREMENTS.md] | Reconcile roadmap text with locked Phase 8 scope: build structured forms and bounded AI proposal extraction/manual fallback now; do not plan a chat/interview lane because D-07 defers it. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |
| ING-04 | Make deep-ingest progress durable, resumable, visible in readiness, and independent from already-running sourcing. [VERIFIED: .planning/REQUIREMENTS.md] | Plan terminal lane state in DB, recompute `deep_ingest_complete` from lane terminality, update onboarding/dashboard readiness, and avoid coupling deep ingest to sourcing run execution. [VERIFIED: src/core/db/verbs/candidate.mjs] |
</phase_requirements>

## Summary

Phase 8 should be planned as a new SQLite-native product subsystem, not as a retrofit of `candidate/` files, generated tracker artifacts, or the legacy `ingest-profile` skill path. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] The existing codebase already has the core pieces the planner should reuse: DB migrations and verbs through `node:sqlite`, fail-closed local app routes, bounded AI envelopes, intake capture/upload patterns, candidate readiness computation, library/onboarding UI patterns, and validation logic for evidence, stories, writing style, placeholders, and private compensation leakage. [VERIFIED: src/core/db/connection.mjs] [VERIFIED: src/core/ai/bounded-ai.mjs] [VERIFIED: src/core/interview/story-bank.mjs]

The planner should create a vertical MVP that captures sources, scans/fetches within explicit limits, stores source artifacts and proposal rows, validates proposals, shows a context-aware review/editor UI, and only writes trusted candidate facts after user confirmation. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md] The full AI interview is out of scope for Phase 8; any plan that builds `/chat`, an interview transcript UI, or default `POST /api/skill/run` routing for deep ingest contradicts the locked decisions. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] [VERIFIED: AGENTS.md]

**Primary recommendation:** Use existing Rolester DB verbs/routes, `runBoundedAI`, schema validators, and bespoke React/CSS components to build a proposal-first Deep ingest lane with no new runtime packages. [VERIFIED: package.json]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Target-aware source intake | Browser / Client | API / Backend | The user chooses target shape and submits paste/file/link material in React; the API persists the source and enforces body/file caps. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md] |
| File, URL, repo, and local-path scanning | API / Backend | Database / Storage | Deterministic scanning/fetching belongs outside the browser and before AI; source artifacts and scan outcomes must be durable DB state. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md] |
| Bounded extraction proposals | API / Backend | External AI service | `runBoundedAI` owns schema validation, provider/no-provider fallback, labels, and safe error envelopes; model output remains a proposal, not trusted fact. [VERIFIED: src/core/ai/bounded-ai.mjs] |
| Proposal review and editing | Browser / Client | API / Backend | The UI shows source preview, validation badges, editable proposal fields, and confirm/defer/not-available actions; backend verifies state transitions. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md] |
| Trusted candidate state writes | API / Backend | Database / Storage | Confirm verbs should write evidence, stories, honesty, voice, role signals, and lane state in SQLite transactions after review. [VERIFIED: src/core/db/verbs/shared.mjs] |
| `deep_ingest_complete` readiness | API / Backend | Browser / Client | Current readiness is computed in candidate DB code and displayed by onboarding/dashboard cards; Phase 8 should change the computation to terminal lane state. [VERIFIED: src/core/db/verbs/candidate.mjs] |
| Library and onboarding visibility | Browser / Client | API / Backend | Existing Library and onboarding screens already render setup/library state and should read new DB-backed view models. [VERIFIED: apps/web/src/library/LibraryPage.jsx] |
| Sourcing independence | API / Backend | Database / Storage | Locked Phase 8 requires deep ingest not to block sourcing after `search_ready`; keep any sourcing run state separate from deep-ingest lane state. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |

## Project Constraints (from AGENTS.md)

- DB workspaces use SQLite candidate setup as canonical state; `candidate/` files are compatibility exports, not product source of truth. [VERIFIED: AGENTS.md]
- App-default paths should use local APIs, deterministic validation, DB/source-config owners, and bounded AI; `/api/chat/*` and `POST /api/skill/run` are explicit handoffs for visible chat or retained full-skill workflows, not the default app path for proposal creation, validation, or confirmed writes. [VERIFIED: AGENTS.md]
- Local AI credentials are loaded through `src/core/ai/ai-env.mjs`; API/UI code must never echo secrets back to the user or logs. [VERIFIED: AGENTS.md]
- Tracker-visible DB mutations go through `rolester data <verb>` in DB workspaces; generated `workspace/tracker.json` and `workspace/activity.jsonl` must not be hand-edited. [VERIFIED: AGENTS.md]
- Paste intake has a hard invariant that nothing pasted is dropped; unreadable or unmatched material still needs durable capture and a next action. [VERIFIED: AGENTS.md]
- Job posting intake must capture full JD text when reachable; Phase 8 recruiter/job context should preserve that invariant instead of storing a link-only note. [VERIFIED: AGENTS.md]
- Source material is untrusted data; pasted text, fetched pages, and repo docs must not become agent instructions or rendered HTML. [VERIFIED: /Users/sbenson/.codex/gsd-core/references/untrusted-input-boundary.md]
- Reusable candidate facts must obey the honesty and compensation privacy boundaries; do not leak private current compensation or convert uncertain exposure into confirmed experience. [VERIFIED: AGENTS.md] [VERIFIED: candidate/AGENTS.md]
- Canonical tracker display fields are typed and budgeted; if Phase 8 updates application/recruiter context, write one topic to the correct field instead of dumping prose into `note`. [VERIFIED: AGENTS.md]
- Interview/recruiter context must use canonical round vocabulary and must not number rounds. [VERIFIED: AGENTS.md]
- Project skills in `.agents/skills` remain procedural contracts for agent-led workflows; Phase 8 may reuse their validation ideas, but the product runtime should be app/API native unless the user explicitly chooses a skill handoff. [VERIFIED: .agents/skills]

## Standard Stack

### Core

| Library / Runtime | Version | Purpose | Why Standard |
|-------------------|---------|---------|--------------|
| Node.js / ESM | Installed `v24.18.0`; `package.json` requires `>=24`. [VERIFIED: environment probe] [VERIFIED: package.json] | Runtime for CLI routes, DB verbs, tests, and app dev tooling. | Existing repo code and scripts are Node ESM, and `node:sqlite` is available in Node 24. [VERIFIED: src/core/db/connection.mjs] [CITED: https://nodejs.org/api/sqlite.html] |
| `node:sqlite` `DatabaseSync` | Built into Node 24. [CITED: https://nodejs.org/api/sqlite.html] | SQLite connection, migrations, transactions, JSON table access. | Existing DB layer uses `DatabaseSync`, WAL, foreign keys, busy timeout, and fail-closed DB access. [VERIFIED: src/core/db/connection.mjs] |
| SQLite | CLI `3.51.0` installed. [VERIFIED: environment probe] | Persistent local DB for source artifacts, proposals, candidate state, and lane terminality. | Existing migrations use JSON blobs with `CHECK(json_valid(data))`, generated columns, and indexes; SQLite documents generated columns and JSON functions for this pattern. [VERIFIED: src/core/db/migrations/003-candidate-setup.mjs] [CITED: https://sqlite.org/gencol.html] [CITED: https://sqlite.org/json1.html] |
| Rolester DB verb layer | Local modules. [VERIFIED: src/core/db/verbs/index.mjs] | Transactional domain writes, exports, setup recomputation, and activity patterns. | New durable behavior should follow `requireDb`, `withTransaction`, and verb exports instead of ad hoc route-side SQL. [VERIFIED: src/core/db/verbs/shared.mjs] |
| Rolester bounded AI runtime | Local modules. [VERIFIED: src/core/ai/bounded-ai.mjs] | Schema-validated extraction proposals with no-AI/manual fallback. | AI-SPEC selects `runBoundedAI` + `callAI` + `runStructuredOneshot` and explicitly rejects a new AI framework for Phase 8. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md] |
| React / React DOM | Installed `19.2.7`; app declares `^19.0.0`. [VERIFIED: npm ls] [VERIFIED: apps/web/package.json] | Deep ingest page, target selector, source preview, proposal editor, and readiness UI. | Existing app is a bespoke React app; UI-SPEC requires local components and CSS, not a new design system. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md] |
| Vite / Vitest | Installed Vite `6.4.3`, Vitest `3.2.6`. [VERIFIED: npm ls] | Frontend dev server, build, and React unit tests. | Existing web workspace already uses Vite/Vitest scripts. [VERIFIED: apps/web/package.json] |
| `node:test` | Built into Node. [CITED: https://nodejs.org/api/test.html] | Backend DB, route, scanner, and bounded-AI unit tests. | Existing backend tests are `.test.mjs` files run by `node --test`. [VERIFIED: package.json] |

### Supporting

| Library / Module | Version | Purpose | When to Use |
|------------------|---------|---------|-------------|
| `src/core/profile/schema-validator.mjs` | Local. [VERIFIED: src/core/profile/schema-validator.mjs] | JSON Schema validation for proposals and confirmed candidate state. | Use for every new `config/deep-ingest-*.schema.json` before DB writes. [VERIFIED: config/evidence.schema.json] |
| `src/core/interview/story-bank.mjs` | Local. [VERIFIED: src/core/interview/story-bank.mjs] | STAR+R validation, evidence reference checks, placeholder and comp leakage guards. | Port/reuse validation rules when adding DB-backed story proposals and confirmations. [VERIFIED: tests/story-bank.test.mjs] |
| `src/core/profile/evidence-writer.mjs` | Local. [VERIFIED: src/core/profile/evidence-writer.mjs] | Guarded evidence claim write pattern and schema round-trip checks. | Reuse validation ideas, but write confirmed Phase 8 evidence through DB verbs. [VERIFIED: src/core/db/verbs/candidate.mjs] |
| `src/core/profile/writing-style.mjs` | Local. [VERIFIED: src/core/profile/writing-style.mjs] | Writing sample signal extraction without importing facts from samples. | Use as deterministic baseline for writing voice proposals and tests. [VERIFIED: tests/writing-style.test.mjs] |
| `src/cli/skill-run-route.mjs` body readers | Local. [VERIFIED: src/cli/skill-run-route.mjs] | Capped JSON/raw request body helpers and upload-safe behavior. | Reuse or mirror for deep-ingest upload/source routes. [VERIFIED: src/cli/intake-route.mjs] |
| Local React components and CSS tokens | Local. [VERIFIED: apps/web/src/styles/app.css] | Page scaffolding, cards, buttons, form controls, alerts, chips, icons. | Use for all Phase 8 UI surfaces. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Rolester DB verbs | ORM or ad hoc SQL in routes | Adds migration/write paths that bypass existing fail-closed DB and export patterns. Use current DB verb layer. [VERIFIED: src/core/db/verbs/shared.mjs] |
| `runBoundedAI` | LangChain, LlamaIndex, or agent framework | Phase 8 is bounded extraction, not tool orchestration; AI-SPEC rejects a new external framework. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md] |
| Thin local route modules | Express, multer, or a new HTTP framework | The current dev server mounts exact route handlers; adding Express is unnecessary scope. [VERIFIED: src/cli/tracker-dev.mjs] |
| DB-backed Library state | `candidate/stories.yml` / `candidate/writing-style.md` | Locked context says existing files may remain compatibility surfaces but are not product acceptance targets. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |
| Target-aware Deep ingest page | Generic Inbox-only review | D-04/D-06 require context-aware review surfaces when type-specific review is clearer. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |

**Installation:**
```bash
# No new runtime packages are recommended for Phase 8.
npm install
```

**Version verification:** Existing package versions were verified with `npm ls react react-dom vite vitest @vitejs/plugin-react @biomejs/biome @anthropic-ai/claude-agent-sdk`; current registry versions were checked with `npm view <package> version time.modified`. [VERIFIED: npm registry] React/React DOM were installed and current at `19.2.7`; Vite, Vitest, `@vitejs/plugin-react`, Biome, and `@anthropic-ai/claude-agent-sdk` had newer registry versions, but no upgrade is required to plan Phase 8. [VERIFIED: npm registry]

## Package Legitimacy Audit

Phase 8 should install no new external packages, so the package legitimacy gate is not required for the recommended plan. [VERIFIED: package.json]

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| None | npm | — | — | — | — | No new packages recommended. [VERIFIED: package.json] |

**Packages removed due to [SLOP] verdict:** none. [VERIFIED: package.json]  
**Packages flagged as suspicious [SUS]:** none. [VERIFIED: package.json]

If the planner adds any new dependency for file parsing, URL extraction, repo scanning, or AI evaluation, it must run `gsd_run query package-legitimacy check --ecosystem npm <pkg>` plus `npm view <pkg> version` before adding that package to a plan. [VERIFIED: /Users/sbenson/.codex/gsd-core/references/research-verification-protocol.md]

## Architecture Patterns

### System Architecture Diagram

```text
User source
  -> DeepIngestPage target selector / paste / drop / link / local path
  -> POST /api/deep-ingest/sources
  -> source normalizer + caps + filename/path/URL safety checks
  -> deep_ingest_sources row + source artifact/chunks
  -> deterministic scanner
       -> text/file/url/repo readable
            -> lane-specific proposal builder
            -> optional runBoundedAI(schema, labels, native-preferred)
            -> schema validation + grounding + privacy/honesty checks
            -> deep_ingest_proposals rows
       -> unreadable/private/huge/login-gated/truncated
            -> explicit gap/deferred/not_available row
  -> GET /api/deep-ingest/state
  -> review queue + source preview + proposal editor
  -> user confirms, edits, defers, or marks not available
  -> POST /api/deep-ingest/proposals/:id/decision
  -> transaction writes trusted candidate DB state + lane terminal state
  -> dashboard/onboarding/library read DB-backed view models

Quick onboarding / sourcing:
  search_ready true -> sourcing may continue independently
  deep_ingest_complete -> computed separately from lane terminal states
```

This architecture keeps source acquisition, model calls, validation, review, and trusted writes as separate stages so unreadable sources and failed AI routes become visible states instead of silent success. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md]

### Recommended Project Structure

```text
src/core/deep-ingest/
├── source-scanner.mjs        # deterministic text/file/url/repo scan orchestration
├── source-normalize.mjs      # target shape, source kind, labels, caps
├── source-fetch.mjs          # safe public URL fetch/extract path
├── repo-scanner.mjs          # bounded public repo README/docs/package metadata scan
├── proposals/
│   ├── evidence.mjs          # lane-specific proposal builder
│   ├── stories.mjs
│   ├── honesty.mjs
│   ├── voice.mjs
│   ├── role-signals.mjs
│   └── gaps.mjs
├── validators/
│   ├── grounding.mjs
│   ├── privacy.mjs
│   └── lane-state.mjs
└── view-model.mjs            # dashboard/library/deep-ingest UI model

src/core/db/migrations/007-deep-ingest.mjs
src/core/db/verbs/deep-ingest.mjs
src/cli/deep-ingest-route.mjs
config/deep-ingest-source.schema.json
config/deep-ingest-proposal.schema.json
config/deep-ingest-lanes.schema.json
apps/web/src/deep-ingest/DeepIngestPage.jsx
apps/web/src/deep-ingest/DeepIngestPage.css
apps/web/src/deep-ingest/DeepIngestPage.test.jsx
tests/deep-ingest-db.test.mjs
tests/deep-ingest-route.test.mjs
tests/deep-ingest-ai.test.mjs
tests/deep-ingest-source-scanner.test.mjs
```

Use migration version 7 because the live migration head is `006-company-discovery-cache.mjs`. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-PATTERNS.md]

### Pattern 1: SQLite-Native Source, Proposal, and Lane State

**What:** Add DB tables for source artifacts, proposals, proposal decisions, lane status, and confirmed DB-backed story/voice/honesty/role-signal state. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]  
**When to use:** Any data that the Deep ingest UI, Library, onboarding readiness, or downstream application generation will reuse. [VERIFIED: .planning/REQUIREMENTS.md]  
**Example:**
```sql
-- Source: src/core/db/migrations/003-candidate-setup.mjs and SQLite generated columns docs.
CREATE TABLE IF NOT EXISTS deep_ingest_sources (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data)),
  target_shape TEXT GENERATED ALWAYS AS (json_extract(data, '$.targetShape')) VIRTUAL,
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.updatedAt')) VIRTUAL
);

CREATE INDEX IF NOT EXISTS idx_deep_ingest_sources_status
  ON deep_ingest_sources(status);
```

### Pattern 2: Thin Routes, Core Modules, and Fail-Closed DB

**What:** Route modules should parse/cap input, call core scanner/proposal/verb modules, and translate DB absence to a 409 response; durable behavior belongs in core modules and DB verbs. [VERIFIED: src/cli/data-route.mjs]  
**When to use:** Every `/api/deep-ingest/*` endpoint. [VERIFIED: src/cli/tracker-dev.mjs]  
**Example:**
```javascript
// Source: src/cli/data-route.mjs and src/cli/intake-route.mjs
export function mountDeepIngestRoutes({ root, server }) {
  server.on("request", async (req, res) => {
    if (req.method !== "POST" || req.url !== "/api/deep-ingest/sources") return;
    try {
      const body = await readJsonBodyCapped(req, { limitBytes: 1_000_000 });
      const result = await createDeepIngestSource({ root, input: body });
      sendJson(res, 200, { ok: true, data: result });
    } catch (error) {
      sendJson(res, error.code === "NO_DATABASE" ? 409 : 400, {
        ok: false,
        error: error.code || "DEEP_INGEST_FAILED",
        message: error.message,
      });
    }
  });
}
```

### Pattern 3: Proposal-First Bounded AI

**What:** Deterministic scanning prepares source text/chunks, bounded AI proposes lane-specific JSON, validators mark proposal state, and the user must confirm or edit before trusted writes. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md]  
**When to use:** Evidence, story, writing voice, honesty, role signal, and gap extraction when deterministic parsing is insufficient. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]  
**Example:**
```javascript
// Source: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md
const envelope = await runBoundedAI({
  labels: {
    skill: "deep-ingest",
    action: "evidence-propose",
    operation: "deep_ingest.evidence.propose",
  },
  schema: evidenceProposalSchema,
  manual: {
    available: true,
    reason: "manual-deep-ingest-review",
    action: "Review this source and enter evidence or gaps manually.",
  },
  structuredMode: "native-preferred",
  outputName: "deep_ingest_evidence_proposal",
  maxRetries: 1,
  root,
  env,
  system: "Return only grounded candidate evidence proposals. Do not invent facts.",
  messages: [{ role: "user", content: sourceText }],
});
```

### Pattern 4: Grounding, Privacy, and Honesty Validators

**What:** Treat schema validity as necessary but insufficient; each proposal needs source provenance, quote/span support when text exists, conflict/privacy checks, and user review status. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md]  
**When to use:** Before storing a proposal as reviewable and again before confirmation. [VERIFIED: src/core/interview/story-bank.mjs]  
**Example:**
```javascript
// Source: Phase 8 AI-SPEC grounding example, adapted for planning.
export function validateGrounding({ sourceId, sourceText, items }) {
  return items.map((item) => {
    const sameSource = item.sourceId === sourceId;
    const quoteFound = item.supportingQuote && sourceText.includes(item.supportingQuote);
    return {
      ...item,
      validation: sameSource && quoteFound ? "grounded" : "needs_quote",
    };
  });
}
```

### Pattern 5: Terminal Lane Readiness

**What:** `deep_ingest_complete` is true only when every required lane is terminal: `completed`, `deferred`, or `not_available`. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]  
**When to use:** Candidate setup recomputation and onboarding/dashboard readiness. [VERIFIED: apps/web/src/onboarding/steps/FinishStep.jsx]  
**Example:**
```javascript
// Source: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md
const TERMINAL_LANE_STATUSES = new Set(["completed", "deferred", "not_available"]);

export function computeDeepIngestComplete(lanes) {
  return REQUIRED_DEEP_INGEST_LANES.every((lane) =>
    TERMINAL_LANE_STATUSES.has(lanes[lane]?.status),
  );
}
```

### Anti-Patterns to Avoid

- **Expanding `intake_items` into the product data model:** Intake is workflow bookkeeping; Deep ingest needs reusable candidate state and lane progress. [VERIFIED: src/core/db/migrations/002-intake.mjs]
- **Direct AI-to-trusted-write:** Bounded AI output must pass schema validation, deterministic checks, and user confirmation before trusted candidate facts change. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]
- **Building the deferred AI interview:** D-07 explicitly defers chat/interview UX to a future phase. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]
- **Using `candidate/stories.yml` or `candidate/writing-style.md` as acceptance targets:** Existing files may remain compatibility surfaces, but Phase 8 product state should be DB-backed. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]
- **Rendering fetched source HTML:** Source text is untrusted data and should be shown as escaped/sanitized plain preview. [VERIFIED: /Users/sbenson/.codex/gsd-core/references/untrusted-input-boundary.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQLite connection and migration plumbing | Route-side `sqlite3` wrappers or generated-file writes | `openDb`, `requireDb`, migrations, and DB verbs | Existing DB layer sets WAL, foreign keys, fail-closed behavior, and shared transaction semantics. [VERIFIED: src/core/db/connection.mjs] |
| Model invocation, retry, and safe envelopes | Custom fetch-to-AI code | `runBoundedAI`, `callAI`, `runStructuredOneshot` | Existing runtime handles labels, no-route/manual fallback, schema retries, and safe error envelopes. [VERIFIED: src/core/ai/bounded-ai.mjs] |
| JSON schema validation | Ad hoc object checks | `schema-validator.mjs` plus config schemas | Existing candidate/evidence/story paths validate schema round trips. [VERIFIED: src/core/profile/schema-validator.mjs] |
| Evidence/story honesty checks | New loose string heuristics only | Existing evidence/story validators, placeholder lint, comp guard patterns | Current modules already catch missing refs, placeholders, and private comp leakage. [VERIFIED: src/core/interview/story-bank.mjs] |
| Generic ingest UI from scratch | A new design system or chat UI | `PageScaffold`, local buttons/forms/cards/chips, Deep ingest page contract | UI-SPEC locks bespoke React/CSS components and forbids chat/interview UI for this phase. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md] |
| Full repository crawling | Unbounded `git clone`, authenticated scan, or recursive fetch | Bounded public README/docs/package metadata scan | D-14/D-15 require bounded best-effort scanning and explicit gaps for private/huge/unreadable sources. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |
| HTML preview or source instruction handling | Render remote HTML or obey source-provided instructions | Escaped plain text preview and fixed extraction prompts | Source material is untrusted input. [VERIFIED: /Users/sbenson/.codex/gsd-core/references/untrusted-input-boundary.md] |

**Key insight:** Phase 8 is mostly an orchestration and state-modeling phase; the hard part is preserving provenance, terminal lane semantics, and confirm-first writes across deterministic scanners, optional AI, and manual fallback. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md]

## Common Pitfalls

### Pitfall 1: Treating Saved Source As Successful Ingest
**What goes wrong:** A source row exists, but it produced no proposal, gap, manual fallback, deferred item, or not-available reason. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md]  
**Why it happens:** The implementation stops at upload/capture and does not model scan/proposal outcome states. [VERIFIED: src/core/db/migrations/002-intake.mjs]  
**How to avoid:** Every source submit must resolve to exactly one visible review state. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md]  
**Warning signs:** UI says complete while source status is only `captured` or `uploaded`. [ASSUMED]

### Pitfall 2: Letting Model Output Become Trusted Candidate Truth
**What goes wrong:** Schema-valid model JSON becomes reusable evidence, stories, or voice without user confirmation. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md]  
**Why it happens:** The plan combines proposal generation and candidate writes in one endpoint. [ASSUMED]  
**How to avoid:** Separate proposal rows from confirm/edit/defer/not-available verbs. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]  
**Warning signs:** A route named `extract-and-save` or a DB transaction containing a model call. [ASSUMED]

### Pitfall 3: Reintroducing The Deferred Interview
**What goes wrong:** The plan adds chat UX, role/job follow-up interview prompts, or `/api/chat/*` as the Deep ingest completion path. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]  
**Why it happens:** ING-03 still mentions an optional AI interview in the roadmap requirements. [VERIFIED: .planning/REQUIREMENTS.md]  
**How to avoid:** Treat D-07 as the binding refinement: structured forms and bounded extraction only in Phase 8. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]  
**Warning signs:** Visible copy says "AI interview", "chat", "agent", or "automation". [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md]

### Pitfall 4: Counting Artifacts Instead Of Terminal Lanes
**What goes wrong:** `deep_ingest_complete` stays false for users who intentionally mark a lane not available, or true after only one artifact is saved. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]  
**Why it happens:** Current candidate readiness heuristics use older evidence/company/signal checks rather than lane terminality. [VERIFIED: src/core/db/verbs/candidate.mjs]  
**How to avoid:** Store per-lane status/reason and compute readiness from required terminal lane statuses. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md]  
**Warning signs:** `deep_ingest_complete` depends only on evidence count or target companies. [VERIFIED: src/core/db/verbs/candidate.mjs]

### Pitfall 5: Privacy Leakage Through Proposals Or Logs
**What goes wrong:** Private current compensation, contact details, protected-trait inferences, local file paths, or proprietary source bodies leak into proposal text, telemetry, or outbound-ready evidence. [VERIFIED: AGENTS.md]  
**Why it happens:** Proposal validation only checks JSON shape and ignores privacy/honesty boundaries. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md]  
**How to avoid:** Add privacy/honesty validators before proposal display and confirmation; keep AI telemetry metadata-only. [VERIFIED: src/core/ai/call-ai.mjs]  
**Warning signs:** Tests assert schema success but do not assert absence of `current_base`, source bodies, or protected-trait fields. [ASSUMED]

### Pitfall 6: Migration Number Collision
**What goes wrong:** Phase 8 creates a stale or non-sequential migration file number after the live head has already been observed. [ASSUMED]  
**Why it happens:** A plan carries an older migration assumption instead of matching the live migration registry. [VERIFIED: src/core/db/migrations.mjs]  
**How to avoid:** Use `src/core/db/migrations/007-deep-ingest.mjs` and register migration version 7 because the live head is `006-company-discovery-cache.mjs`. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-PATTERNS.md]  
**Warning signs:** Plan references a stale higher-number migration or blocks on another phase occupying version 7. [ASSUMED]

### Pitfall 7: Inaccessible File Controls
**What goes wrong:** A drag/drop-only source input is not keyboard-usable or screen-reader discoverable. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop]  
**Why it happens:** The file input is hidden in a way that removes it from interaction instead of being associated with a labeled control. [CITED: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file]  
**How to avoid:** Use a visible button/label pattern plus drag/drop, and keep `Ingest source` disabled until target shape and content are valid. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md]  
**Warning signs:** The only affordance says "drop files here" and has no keyboard path. [ASSUMED]

## Code Examples

Verified patterns from official/local sources:

### Bounded AI Manual Fallback Envelope
```javascript
// Source: src/core/ai/bounded-ai.mjs and 08-AI-SPEC.md
const result = await runBoundedAI({
  labels: {
    skill: "deep-ingest",
    action: "story-propose",
    operation: "deep_ingest.story.propose",
  },
  schema: storyProposalSchema,
  manual: {
    available: true,
    reason: "manual-story-review",
    action: "Enter the story draft manually or defer this lane.",
  },
  structuredMode: "native-preferred",
  outputName: "deep_ingest_story_proposal",
  maxRetries: 1,
  root,
  env,
  messages: [{ role: "user", content: cappedSourceText }],
});
```

### Confirm Verb Shape
```javascript
// Source: src/core/db/verbs/shared.mjs and src/core/db/verbs/candidate.mjs
export function confirmDeepIngestProposal({ root, proposalId, edits, decision }) {
  return runVerb({
    root,
    operation: "deep_ingest.proposal.confirm",
    fn: ({ db, now }) => {
      return withTransaction(db, () => {
        const proposal = loadProposalForUpdate(db, proposalId);
        const validated = validateConfirmedProposal({ proposal, edits, decision, now });
        writeTrustedCandidateState(db, validated);
        updateProposalDecision(db, proposalId, { decision: "confirmed", now });
        refreshDeepIngestReadiness(db, { now });
        return loadDeepIngestState(db);
      });
    },
  });
}
```

### Source Outcome State
```javascript
// Source: .planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md
const SOURCE_OUTCOME_STATUSES = [
  "proposal_ready",
  "manual_fallback",
  "gap",
  "deferred",
  "not_available",
  "failed",
];
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Candidate setup and rich profile material lived primarily in `candidate/` files. | App-first SQLite product state is canonical; candidate files are compatibility exports. | Locked by prior app/DB phases and AGENTS.md. [VERIFIED: AGENTS.md] | Phase 8 should add DB-backed story, voice, honesty, role-signal, source, and lane state. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |
| Generic paste intake deferred profile/project material to `ingest-profile`. | Deep ingest should provide target-aware review and confirmation inside the app. | Phase 8 context. [VERIFIED: config/paste-intake-routes.json] | Update generic capture routing only as an entry point; do not force all review through Inbox. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |
| Full skill runtime or chat could own complex setup workflows. | Local app APIs and bounded AI proposals own default product flows; full skill runtime remains allowlisted for human-watched workflows. | AGENTS runtime routing contract. [VERIFIED: AGENTS.md] | Deep ingest routes should not call `/api/skill/run` by default. [VERIFIED: AGENTS.md] |
| Schema-valid AI output could be mistaken for usable extracted data. | Schema validation, grounding, privacy checks, and user confirmation are all required. | Phase 8 AI-SPEC and locked decisions. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md] | Planner must include validator tests and proposal state tests. [VERIFIED: tests/bounded-ai.test.mjs] |

**Deprecated/outdated:**
- Using the full AI interview as Phase 8 scope is outdated because D-07 defers it. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]
- Treating `candidate/stories.yml` and `candidate/writing-style.md` as product acceptance targets is outdated for this phase. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]
- Link-only profile/project capture is insufficient because D-13/D-15 require active best-effort scan/fetch/parse and explicit gaps. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Suggested table/module names such as `deep_ingest_sources`, `deep_ingest_proposals`, and `src/core/deep-ingest/` are recommended planning names, not locked product decisions. [ASSUMED] | Recommended Project Structure | Low; planner can rename while preserving architecture. |
| A2 | The live migration head is `006-company-discovery-cache.mjs`, so Phase 8 uses `src/core/db/migrations/007-deep-ingest.mjs` and migration version 7. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-PATTERNS.md] | Recommended Project Structure / Pitfalls | Low; stale higher-number or external dependency references would break DB migration order. |
| A3 | MVP public URL extraction can rely on built-in `fetch` plus plain-text extraction/caps without adding a package. [ASSUMED] | Standard Stack / Open Questions | Medium; complex pages may require manual fallback or future parser package. |

## Open Questions (RESOLVED)

1. **Exact DB table split for confirmed story, voice, honesty, and role-signal state**
   - What we know: existing candidate DB state covers evidence and some honesty/profile setup, while stories and writing style are still file-backed. [VERIFIED: src/core/db/verbs/candidate.mjs] [VERIFIED: src/core/interview/story-bank.mjs]
   - What's unclear: whether to store each lane in separate normalized tables, JSON blob tables with generated columns, or a mixed model. [ASSUMED]
   - Recommendation: use JSON blob tables with generated searchable columns for the MVP, matching current candidate migrations. [VERIFIED: src/core/db/migrations/003-candidate-setup.mjs]
   - RESOLVED: Use new SQLite-native Deep ingest tables for sources, source chunks, proposals, lane states, story bank, writing voice, honesty boundaries, and role signals. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-01-PLAN.md]

2. **Whether deep-ingest writes should create tracker activity events**
   - What we know: candidate setup/intake DB verbs exist outside the full tracker-visible write contract, while tracker-visible domain verbs use `runVerb` and activity logging patterns. [VERIFIED: src/core/db/verbs/intake.mjs] [VERIFIED: src/core/db/verbs/shared.mjs]
   - What's unclear: whether every confirmed deep-ingest candidate fact should appear in Activity Pulse. [ASSUMED]
   - Recommendation: log user-visible confirmations/defer/not-available decisions through the shared DB write pattern, but do not treat scanner progress as tracker outcome state. [ASSUMED]
   - RESOLVED: Confirmed trusted candidate/lane-state changes are tracker-visible and should emit activity/metadata through the new DB verbs; raw source/proposal creation can stay internal unless surfaced in readiness or Library. [VERIFIED: AGENTS.md]

3. **Bounded repo and URL scan limits**
   - What we know: D-14 requires bounded public repo README/docs/package metadata scanning and explicit gaps for unsupported/private/huge sources. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]
   - What's unclear: exact file count, byte count, timeout, and host allow/deny rules. [ASSUMED]
   - Recommendation: planner should set small constants in one module and include tests for too-large, login-gated, and unsupported sources. [ASSUMED]
   - RESOLVED: Plans must set bounded defaults explicitly: capped request/file bodies, capped source text/chunks, URL timeout/byte cap, and a repo allowlist for README/docs/package metadata with file-count and aggregate-byte caps. Exact constants are named in Plan 08-03. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-03-PLAN.md]

4. **Phase 7 dependency surface**
   - What we know: Phase 7 is in progress and owns quick onboarding/auto-sourcing context that Phase 8 must not block. [VERIFIED: .planning/STATE.md]
   - What's unclear: final names for Phase 7 sourcing run tables/routes if they land before Phase 8. [ASSUMED]
   - Recommendation: Wave 0 should inspect actual migration and route files before creating Phase 8 DB tasks. [ASSUMED]
   - RESOLVED: The live migration head is 006, so Phase 8 uses `src/core/db/migrations/007-deep-ingest.mjs` and registers migration version 7. There is no Phase 7 migration dependency for Phase 8 execution. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-PATTERNS.md]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Backend routes, DB verbs, tests, Vite tooling | yes | `v24.18.0` [VERIFIED: environment probe] | Blocking if missing; install Node 24+. |
| npm | Dependency install and workspace scripts | yes | `11.16.0` [VERIFIED: environment probe] | Blocking if missing. |
| SQLite CLI | Manual DB inspection during planning/execution | yes | `3.51.0` [VERIFIED: environment probe] | Node `node:sqlite` can still run app/tests. |
| ripgrep | Codebase inspection | yes | `15.1.0` [VERIFIED: environment probe] | Use `grep` if unavailable. |
| git | Commit/review workflow | yes | `2.53.0` [VERIFIED: environment probe] | Blocking for commit automation. |
| AI route | Optional bounded extraction proposals | no | `ANTHROPIC_API_KEY=false`, `ROLESTER_AI_PROXY_URL=false` [VERIFIED: environment probe] | Required fallback is `NO_AI_ROUTE` manual proposal/defer path. [VERIFIED: src/core/ai/bounded-ai.mjs] |

**Missing dependencies with no fallback:**
- None for research and non-AI MVP planning. [VERIFIED: environment probe]

**Missing dependencies with fallback:**
- AI route is absent; Phase 8 must preserve manual fallback and `NO_AI_ROUTE` behavior. [VERIFIED: src/core/ai/bounded-ai.mjs]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Backend `node:test`; frontend Vitest. [VERIFIED: package.json] [VERIFIED: apps/web/package.json] |
| Config file | Backend: none; frontend: Vite/Vitest workspace config via existing app scripts. [VERIFIED: package.json] |
| Quick run command | `node --test tests/deep-ingest-*.test.mjs tests/bounded-ai.test.mjs` [ASSUMED] |
| Full suite command | `npm test && npm --workspace apps/web run test && npm run app:build` [VERIFIED: package.json] [VERIFIED: apps/web/package.json] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| ING-01 | Source intake accepts paste, file, URL, repo, portfolio, recruiter/job context, and local path input; every source resolves to a visible outcome. [VERIFIED: .planning/REQUIREMENTS.md] | backend + frontend | `node --test tests/deep-ingest-source-scanner.test.mjs tests/deep-ingest-route.test.mjs && npm --workspace apps/web run test -- src/deep-ingest/DeepIngestPage.test.jsx` | no; Wave 0. [VERIFIED: file search] |
| ING-02 | Confirmed proposals write trusted DB-backed evidence, story, honesty, voice, role signal, and gap state only after validation/review. [VERIFIED: .planning/REQUIREMENTS.md] | unit + integration | `node --test tests/deep-ingest-db.test.mjs tests/deep-ingest-ai.test.mjs tests/story-bank.test.mjs tests/writing-style.test.mjs` | no; Wave 0 for new deep-ingest tests. [VERIFIED: file search] |
| ING-03 | Structured forms and bounded AI proposal/manual fallback work; chat/interview UI is absent. [VERIFIED: .planning/REQUIREMENTS.md] [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] | frontend + static guard | `npm --workspace apps/web run test -- src/deep-ingest/DeepIngestPage.test.jsx src/onboarding/steps/FinishStep.test.jsx && node --test tests/deep-ingest-ai.test.mjs` | no; Wave 0 for DeepIngest tests. [VERIFIED: file search] |
| ING-04 | Lane terminality drives `deep_ingest_complete`, onboarding/dashboard readiness, and does not block sourcing after `search_ready`. [VERIFIED: .planning/REQUIREMENTS.md] | unit + integration | `node --test tests/deep-ingest-db.test.mjs tests/db-verbs.test.mjs tests/data-route.test.mjs && npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/library/LibraryPage.test.jsx` | partial; existing readiness/library tests need updates. [VERIFIED: tests/db-verbs.test.mjs] |

### Sampling Rate

- **Per task commit:** `node --test tests/deep-ingest-*.test.mjs tests/bounded-ai.test.mjs` plus the touched frontend Vitest file. [ASSUMED]
- **Per wave merge:** `npm test && npm --workspace apps/web run test`. [VERIFIED: package.json]
- **Phase gate:** Full suite and app build: `npm test && npm --workspace apps/web run test && npm run app:build`. [VERIFIED: package.json] [VERIFIED: apps/web/package.json]

### Wave 0 Gaps

- [ ] `tests/deep-ingest-db.test.mjs` — DB schema, confirm/defer/not-available state, `deep_ingest_complete` terminality. [ASSUMED]
- [ ] `tests/deep-ingest-route.test.mjs` — route caps, no-DB 409, source create/list/decision behavior. [ASSUMED]
- [ ] `tests/deep-ingest-ai.test.mjs` — bounded AI schema, grounding, no-route/manual fallback, privacy guard. [ASSUMED]
- [ ] `tests/deep-ingest-source-scanner.test.mjs` — paste/text/url/repo/local-path, too-large, login-gated, unsupported, truncated outcomes. [ASSUMED]
- [ ] `apps/web/src/deep-ingest/DeepIngestPage.test.jsx` — target selector, source submit, review queue, proposal editor, manual fallback, no chat copy. [ASSUMED]
- [ ] Update `apps/web/src/onboarding/steps/FinishStep.test.jsx` — replace deep-interview chat affordance with Deep ingest/forms flow. [VERIFIED: apps/web/src/onboarding/steps/FinishStep.jsx]
- [ ] Update `apps/web/src/library/LibraryPage.test.jsx` — Library reads DB-backed evidence/story/voice/deep-ingest state. [VERIFIED: apps/web/src/library/LibraryPage.test.jsx]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | Local app Phase 8 does not introduce user authentication; do not add auth assumptions. [VERIFIED: AGENTS.md] |
| V3 Session Management | no | No browser session or server-side session feature is planned for Deep ingest. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |
| V4 Access Control | yes | Confirm-first DB verbs, no default full skill runtime, fail-closed DB routes, and explicit user actions for local path/private source handling. [VERIFIED: AGENTS.md] [VERIFIED: src/cli/data-route.mjs] |
| V5 Input Validation | yes | JSON Schema validation, body caps, target-shape enums, source-kind validation, filename/path/URL safety checks, grounding validators. [VERIFIED: src/core/profile/schema-validator.mjs] [VERIFIED: src/cli/intake-route.mjs] |
| V6 Cryptography | yes | Use existing AI key storage/secret loading; do not implement custom crypto or echo secrets. [VERIFIED: AGENTS.md] |
| V8 Data Protection | yes | Local-first storage, metadata-only AI telemetry, source caps, privacy/honesty guards, and no current-comp leakage. [VERIFIED: AGENTS.md] [VERIFIED: src/core/ai/call-ai.mjs] |

### Known Threat Patterns for Deep Ingest

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection from pasted notes, fetched pages, or repo README content | Tampering | Treat source as data, use fixed system prompts, bounded schemas, no model tools, and no source-instruction execution. [VERIFIED: /Users/sbenson/.codex/gsd-core/references/untrusted-input-boundary.md] |
| SSRF or unsafe URL fetch | Information Disclosure / Tampering | Restrict schemes, cap time/bytes, reject local/private-network targets unless explicitly designed and tested. [ASSUMED] |
| Local path traversal or accidental private file ingestion | Information Disclosure | Require explicit local path input, normalize paths, show source preview/metadata, and store gaps for unsupported/unreadable paths. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |
| Oversized files/repos causing resource exhaustion | Denial of Service | Enforce request body caps, source text caps, chunk caps, timeout caps, and bounded repo file allowlists. [VERIFIED: src/cli/skill-run-route.mjs] |
| Candidate fact fabrication or credential inflation | Tampering | Require grounding quote/span, confidence, validation status, and user confirmation before trusted writes. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md] |
| Current compensation, protected-trait, or proprietary data leakage | Information Disclosure | Use privacy validators, metadata-only telemetry, and AGENTS honesty/compensation boundaries. [VERIFIED: AGENTS.md] [VERIFIED: candidate/AGENTS.md] |
| Bypassing review with direct DB writes | Elevation of Privilege | Separate proposal creation from confirmation verbs; tests must assert unconfirmed proposals do not alter trusted candidate state. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md] |

## Sources

### Primary (HIGH confidence)
- `.planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md` — locked Phase 8 scope, decisions, refs, and deferred ideas.
- `.planning/phases/ROL-API-08-deep-ingest-lane/08-AI-SPEC.md` — bounded AI proposal contract, failure modes, eval strategy.
- `.planning/phases/ROL-API-08-deep-ingest-lane/08-UI-SPEC.md` — required UI layout, controls, copy, statuses, and visual constraints.
- `.planning/REQUIREMENTS.md` — ING-01 through ING-04 requirement text.
- `.planning/ROADMAP.md` — phase goal and success criteria.
- `.planning/STATE.md` — current milestone and prior app/DB/bounded-AI decisions.
- `AGENTS.md` and `candidate/AGENTS.md` — DB write contract, runtime routing, paste intake, honesty/privacy constraints.
- `src/core/db/connection.mjs`, `src/core/db/verbs/*.mjs`, `src/core/ai/*.mjs`, `src/cli/*route.mjs`, `apps/web/src/*` — current implementation owners and patterns.

### Secondary (MEDIUM confidence)
- Node.js test runner docs — `https://nodejs.org/api/test.html`.
- Node.js SQLite docs — `https://nodejs.org/api/sqlite.html`.
- SQLite generated columns docs — `https://sqlite.org/gencol.html`.
- SQLite JSON1 docs — `https://sqlite.org/json1.html`.
- Anthropic structured outputs docs — `https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/structured-outputs`.
- MDN file drag/drop docs — `https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop`.
- MDN file input docs — `https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file`.

### Tertiary (LOW confidence)
- None used as authoritative sources; all speculative items are listed in the Assumptions Log. [VERIFIED: Assumptions Log]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — based on package files, installed versions, local code, and official Node/SQLite docs. [VERIFIED: package.json] [CITED: https://nodejs.org/api/sqlite.html]
- Architecture: HIGH — locked by Phase 8 context, AI-SPEC, UI-SPEC, AGENTS, and current code owners. [VERIFIED: .planning/phases/ROL-API-08-deep-ingest-lane/08-CONTEXT.md]
- Pitfalls: HIGH/MEDIUM — direct conflicts and existing code traps are verified; scan-limit details remain planner assumptions. [VERIFIED: src/core/db/verbs/candidate.mjs] [ASSUMED]

**Research date:** 2026-07-05  
**Valid until:** 2026-08-04
