# Phase 10: Local Packet Engine - Research

**Researched:** 2026-07-06  
**Domain:** Local app API migration, bounded AI packet generation, ATS document export  
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

Copied verbatim from `.planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md`. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]

### Locked Decisions

## Phase Boundary

Phase 10 moves the apply-packet path into the local app runtime. The phase should provide app-local APIs for evaluate/gate orchestration, packet generation, application-question capture, non-EEO answer drafting, export generation, and DB artifact stamping. The product default should no longer launch `evaluate-job`, `tailor-application`, or `answer-question` through the full skill runtime for ordinary packet work.

This phase does not build auto-submit, broad browser-authenticated form filling, or default full-skill execution. Application submission remains supervised user action; this phase prepares the materials.

## Implementation Decisions

### Gate Verdict Boundary
- **D-01:** Evaluation is allowed to use AI. The desired change is not "no AI"; it is "no full `evaluate-job` skill runtime by default." A local API should own the workflow and call bounded, schema-validated AI for body-read judgment when model judgment is needed.
- **D-02:** Deterministic code should still own cheap prework around the gate: JD/body capture, saved application context, hard validation, obvious unsupported/missing data handling, and DB writes.
- **D-03:** When AI is unavailable, evidence is missing, or the verdict is ambiguous, the local API should return a manual/reviewable state rather than fabricating a KEEP/CUT decision.

### Packet Workflow Shape
- **D-04:** If a role passes the gate and the user is going to apply, the app should generate the needed packet materials in one product flow instead of asking the user to run separate skills.
- **D-05:** The packet should include an ATS-ready resume, cover letter when appropriate, and application-answer material for captured non-EEO questions.
- **D-06:** Regeneration of individual artifacts can exist as a convenience, but the main happy path is "passed gate -> generate the stuff needed to apply."
- **D-07:** Packet generation prepares artifacts only. It must not submit the application automatically.

### Evidence and Honesty Rules
- **D-08:** Generated prose may use all available local sources: candidate profile, resume, confirmed evidence, stories, writing voice, honesty boundaries, deep-ingest outputs, captured JD text, captured application questions, company research/intelligence, and public company/job-board context.
- **D-09:** The engine should ask for more information or mark `NEEDS YOU` when the available sources are insufficient. It must not invent candidate facts, tools, credentials, employers, metrics, education, or company-specific claims.
- **D-10:** Raw or proposed ingest material can inform gaps and prompts, but reusable candidate claims should come from reviewed/confirmed evidence or be clearly marked for user confirmation before they leave the app.

### Application Questions and EEO Exclusion
- **D-11:** When the app can capture an application page or provider form, it should capture the questions for packet generation.
- **D-12:** EEO, disability, veteran, demographic, and similar voluntary self-identification questions must be filtered out of generated-answer automation.
- **D-13:** The UI may show that a demographic/compliance section was detected and excluded, but it should not draft or auto-answer those fields.
- **D-14:** Supported provider extraction should be used where available, with manual paste as the fallback for unsupported or changed forms.

### Export and Artifact Stamping
- **D-15:** PDF is the normal user-facing packet export format.
- **D-16:** DOCX should be generated only when the board/upload flow requires it or when the user explicitly chooses it from an export option.
- **D-17:** Markdown/source artifacts should be saved internally as source of truth or build input, but they do not need to be surfaced as the normal user-facing format.
- **D-18:** Generated artifacts must be stamped through DB-owned application artifact paths, with enough metadata for the app to show what exists and when it was generated.

### the agent's Discretion
The user delegated implementation mechanics to planning and execution: exact route names, schemas, table shapes, packet manifest format, AI prompt/schema structure, export libraries, PDF/DOCX rendering path, UI placement, and test file layout. Preserve the locked product intent above: bounded AI inside local APIs, automatic packet creation after a passed gate and apply intent, all local evidence sources with honesty gates, explicit EEO/demographic exclusion, PDF default, DOCX only when required or selected, and internal markdown/source persistence.

### Deferred Ideas (OUT OF SCOPE)

## Deferred Ideas

- Auto-submitting applications remains out of scope.
- Broad browser-authenticated apply/form-fill automation remains out of scope unless a later phase explicitly opts into it.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PKT-01 | Evaluate/gate, packet generation, and artifact stamping are app-local APIs that write through DB verbs. [CITED: .planning/REQUIREMENTS.md] | Use thin local packet routes over `requireDb()`, `evaluateGate()`, bounded AI helpers, and `appRegisterArtifact()`; replace ordinary `/api/skill/run` page actions. [CITED: src/cli/packet-route.mjs] [CITED: src/core/evaluate/gate.mjs] [CITED: src/core/db/verbs/app.mjs] |
| PKT-02 | Packets include ATS-optimized resumes, cover letters when appropriate, and evidence-grounded answers with honesty/placeholder gates. [CITED: .planning/REQUIREMENTS.md] | Build on `src/core/documents/tailor.mjs`, which already selects evidence, blocks forbidden wording, lints placeholders, validates ATS-safe markdown, and builds resume, cover letter, and short-answer artifacts. [CITED: src/core/documents/tailor.mjs] |
| PKT-03 | Company-specific questions such as "why this company" or recent tools are captured and answered; EEO, disability, and demographic questions are excluded from generated-answer automation. [CITED: .planning/REQUIREMENTS.md] | Use `fetchFormQuestions()`/manual paste normalization and preserve the existing Greenhouse/Ashby demographic-section exclusion behavior; add generated answers only for normalized non-EEO `questions[]`. [CITED: src/core/apply/form-questions.mjs] [CITED: config/form-questions.schema.json] |
| PKT-04 | Exports support board-required formats, with PDF as standard and DOCX where upload workflows require it. [CITED: .planning/REQUIREMENTS.md] | Reuse `exportArtifact()` and `rolester export`: PDF is default, DOCX auto-detects pandoc, LibreOffice, then built-in OOXML fallback. [CITED: src/core/documents/export.mjs] [CITED: src/cli/export.mjs] |
</phase_requirements>

## Project Constraints (from AGENTS.md)

- DB workspaces use `rolester data <verb>`/DB verbs for tracker-visible mutations; agents must not hand-edit generated `workspace/tracker.json` or `workspace/activity.jsonl` in DB mode. [CITED: AGENTS.md]
- Any grabbed posting must capture the full job description locally at grab time and mirror it to row artifact metadata; a link is not a substitute. [CITED: AGENTS.md]
- Long generated artifacts belong under local workspace artifact paths such as `workspace/tailored/*`, while DB rows hold references and metadata. [CITED: AGENTS.md]
- `current_base` and similar private compensation fields must never leave local config or appear in outbound packet prose. [CITED: AGENTS.md] [CITED: .agents/skills/tailor-application/SKILL.md]
- Unresolved placeholders and `NEEDS YOU` markers block upload-ready artifacts; draft artifacts may exist only as explicitly reviewable/manual state. [CITED: .agents/skills/tailor-application/SKILL.md]
- EEO/default form data can exist for user-supervised form work, but Phase 10's locked decision excludes EEO, disability, veteran, and demographic self-identification from generated-answer automation. [CITED: AGENTS.md] [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]
- Application submission remains supervised and out of scope; packet generation must not click submit or silently start broad browser-authenticated apply automation. [CITED: AGENTS.md] [CITED: .planning/REQUIREMENTS.md]
- `candidate/AGENTS.md` exists and was read; research must preserve candidate-specific privacy and avoid copying private candidate targeting details into plan artifacts. [VERIFIED: codebase grep]

## Summary

Phase 10 should be planned as a local packet engine, not as a UI wrapper around existing skills. The correct product path is a thin set of app-local APIs over core modules and DB verbs: gate orchestration, packet generation, question capture, answer drafting, export, and artifact stamping all stay inside the local app runtime. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md] [CITED: .planning/architecture/runtime-routing-policy.md] [CITED: docs/ARCHITECTURE.md]

The repo already has most primitive pieces: DB-derived packet read routes, deterministic gate checks, Greenhouse/Ashby/manual question capture, document assembly/linting, bounded AI envelopes, and PDF/DOCX export helpers. [CITED: src/cli/packet-route.mjs] [CITED: src/core/evaluate/gate.mjs] [CITED: src/core/apply/form-questions.mjs] [CITED: src/core/documents/tailor.mjs] [CITED: src/core/ai/bounded-ai.mjs] [CITED: src/core/documents/export.mjs] Planning should focus on the missing orchestration layer and on replacing the current page defaults that still call `tailor-application` and `answer-question` through `/api/skill/run`. [CITED: src/core/onboarding/packet-page.mjs] [CITED: src/core/ai/answer-page.mjs]

External provider research supports the existing provider boundary: Greenhouse and Ashby expose application questions separately from demographic/compliance/survey structures, while EEOC/OFCCP guidance treats self-identification as voluntary and sensitive. [CITED: https://developers.greenhouse.io/job-board.html] [CITED: https://developers.ashbyhq.com/docs/creating-a-custom-careers-page] [CITED: https://www.eeoc.gov/publications/employers-guide] [CITED: https://www.dol.gov/agencies/ofccp/self-id-forms]

**Primary recommendation:** Build `src/core/packet/*` plus local `POST /api/packet/gate`, `POST /api/packet/generate`, `POST /api/packet/questions`, and `POST /api/packet/answers` routes; reuse existing DB verbs, bounded AI helpers, form-question extraction, document validators, and export helpers; make `/api/skill/run` a non-default handoff only. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Gate prework and verdict orchestration | API / Backend | Bounded AI | The API owns JD context, deterministic validation, DB writes, and manual/no-AI states; AI only supplies schema-validated body-read judgment when needed. [CITED: src/core/evaluate/gate.mjs] [CITED: src/core/ai/bounded-ai.mjs] |
| Packet generation | API / Backend | Bounded AI, Database / Storage | The backend assembles context, asks bounded AI for finite prose/answer proposals, runs deterministic validators, then writes artifacts through DB-owned paths. [CITED: src/core/documents/tailor.mjs] [CITED: src/core/db/verbs/app.mjs] |
| Application-question capture | API / Backend | Browser / Client manual paste | Existing provider fetches are deterministic backend work; unsupported or changed forms fall back to manual paste, not browser automation. [CITED: src/core/apply/form-questions.mjs] |
| EEO/demographic exclusion | API / Backend | Browser / Client display | The backend must filter excluded sections before generation; the UI can show that a section was detected and excluded. [CITED: config/form-questions.schema.json] [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md] |
| PDF/DOCX export | API / Backend | Filesystem Storage | `exportArtifact()` owns rendering and writes output files; routes should only choose formats and stamp resulting paths. [CITED: src/core/documents/export.mjs] |
| Artifact discovery and preview | API / Backend | Browser / Client | Current packet read routes already resolve artifacts from SQLite-derived application rows and safely return markdown/html/binary metadata to the client. [CITED: src/cli/packet-route.mjs] |
| User review and apply intent | Browser / Client | API / Backend | The client collects intent and manual answers; backend remains source of truth for packet state and artifacts. [CITED: src/core/onboarding/packet-page.mjs] |
| Full skill runtime | Retained Runtime Boundary | API / Backend explicit handoff | Full skills remain allowlisted for tool-heavy or watched workflows, but not ordinary packet generation. [CITED: .planning/architecture/runtime-routing-policy.md] |

## Standard Stack

### Core

| Library / Module | Version | Purpose | Why Standard |
|------------------|---------|---------|--------------|
| Node.js ESM runtime | v24.18.0 observed; project requires `>=24` | Route/core implementation, tests, built-in SQLite access | Matches repo engine and existing CLI/API modules. [VERIFIED: node --version] [CITED: package.json] |
| Rolester SQLite DB verbs | Local code | Product source of truth and artifact stamping | `runVerb()` centralizes transaction, meta bump, activity, and export behavior; `appRegisterArtifact()` already stamps artifact paths/timestamps. [CITED: src/core/db/verbs/shared.mjs] [CITED: src/core/db/verbs/app.mjs] |
| `src/cli/packet-route.mjs` | Local code | Existing packet list/detail/artifact HTTP surface | Already reads SQLite-derived application rows and guards artifact path traversal; extend rather than replace. [CITED: src/cli/packet-route.mjs] |
| `src/core/evaluate/gate.mjs` | Local code | Deterministic gate prework | Already evaluates keep/cut signals, compensation, excluded companies, sponsorship mismatch, and renders gate blocks. [CITED: src/core/evaluate/gate.mjs] |
| `runBoundedAI()` / `runStructuredOneshot()` | Local code | Schema-validated finite AI assists | Existing helpers provide labels, schema validation, corrective retry, no-AI 501/manual envelopes, and telemetry-safe metadata. [CITED: src/core/ai/bounded-ai.mjs] [CITED: src/core/ai/structured-oneshot.mjs] |
| `src/core/apply/form-questions.mjs` | Local code | Greenhouse/Ashby/manual question extraction | Existing normalizers exclude provider demographic/survey sections from `questions[]` and flag `demographicSectionPresent`. [CITED: src/core/apply/form-questions.mjs] |
| `src/core/documents/tailor.mjs` | Local code | Resume, cover-letter scaffold, answer validation | Already enforces evidence selection, forbidden wording, placeholder lint, and ATS-safe markdown. [CITED: src/core/documents/tailor.mjs] |
| `src/core/documents/export.mjs` | Local code | PDF default and DOCX optional rendering | Already normalizes ATS text, renders PDF through Playwright, and DOCX through pandoc/soffice/built-in fallback. [CITED: src/core/documents/export.mjs] |
| `playwright` | Installed `^1.60.0`; latest `1.61.1` | PDF rendering via bundled Chromium | Repo already depends on it and export helper uses `page.pdf()`; no new install/upgrade should be planned without a checkpoint because the legitimacy seam flagged the package name as SUS due a very recent latest publish. [CITED: package.json] [CITED: https://playwright.dev/docs/api/class-page] [WARNING: flagged as suspicious for fresh install/upgrade - verify before using.] |

### Supporting

| Library / Tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| `pandoc` | 3.10 available | Preferred DOCX conversion path | Use only when board/upload requires DOCX or user selects DOCX export. [VERIFIED: command probe] |
| `soffice` / LibreOffice | LibreOfficeDev 26.8.0.0.alpha0 available | Secondary DOCX conversion path | Let `renderDocx()` auto-detect it after pandoc. [VERIFIED: command probe] |
| Built-in OOXML writer | Local code | Final DOCX fallback | Keep as fallback when external converters are missing. [CITED: src/core/documents/export.mjs] |
| `mammoth` | Installed/latest `1.12.0` | DOCX-to-HTML/text dependency elsewhere in repo | Do not make it the Phase 10 DOCX writer; packet export already has writer paths. [CITED: package.json] [VERIFIED: npm registry] |
| `node src/cli/questions.mjs` | Local CLI | Deterministic provider/manual question capture | Use as implementation reference and integration smoke target. [CITED: src/cli/questions.mjs] |
| `node src/cli/export.mjs` | Local CLI | Export smoke target | Use to verify PDF default and DOCX optional behavior. [CITED: src/cli/export.mjs] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Local packet APIs | Full `evaluate-job`, `tailor-application`, `answer-question` skill runtime | Violates Phase 10 product boundary for ordinary packet work; retain only explicit watched/tool-heavy handoffs. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md] |
| Existing export helper | New PDF/DOCX npm library | Adds package risk and duplicate rendering behavior; current helper already covers PDF default and DOCX fallbacks. [CITED: src/core/documents/export.mjs] |
| Provider question normalizers | Browser automation for every form | Broad browser-authenticated apply/form-fill automation is deferred and out of scope. [CITED: .planning/REQUIREMENTS.md] |
| Internal markdown source + PDF/DOCX outputs | User-facing markdown-only packet | Locked decision says markdown/source is internal and PDF is the normal user-facing format. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md] |

**Installation:**

```bash
# No new npm packages are recommended for Phase 10.
npm install
```

**Version verification:** `npm ls playwright mammoth --depth=0`, `npm view playwright version time.created time.modified repository.url dist-tags.latest`, and `npm view mammoth version time.created time.modified repository.url dist-tags.latest` were run. `playwright` package was created 2015-01-23, latest is 1.61.1, and package metadata was modified 2026-07-06; repo currently installs `^1.60.0`. `mammoth` package was created 2013-05-06 and latest/current is 1.12.0. [VERIFIED: npm registry] [CITED: package.json]

## Package Legitimacy Audit

No new external package installs are recommended. Existing package names used by the packet/export path were audited because the phase depends on existing export behavior. [VERIFIED: package-legitimacy seam]

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `playwright` | npm | 11 years | 63.8M/week | github.com/microsoft/playwright | SUS | Already installed in repo; use existing dependency only. Planner must add `checkpoint:human-verify` before any install or upgrade because the seam flagged the latest package publish as too new. [WARNING: flagged as suspicious - verify before using.] |
| `mammoth` | npm | 13 years | 5.18M/week | github.com/mwilliamson/mammoth.js | OK | Approved as existing dependency; not recommended as a new packet-generation install. [VERIFIED: npm registry] |

**Packages removed due to [SLOP] verdict:** none.  
**Packages flagged as suspicious [SUS]:** `playwright` for fresh install/upgrade only; no Phase 10 package install is recommended.  

*Packages discovered via WebSearch or training data that have not been verified against an authoritative source are tagged `[ASSUMED]` and the planner must gate each install behind a `checkpoint:human-verify` task.*

## Architecture Patterns

### System Architecture Diagram

```text
User apply intent / packet action
        |
        v
Local Packet API (POST /api/packet/gate|generate|questions|answers)
        |
        +--> DB context reader
        |       |-- candidate profile / confirmed evidence / honesty / writing voice
        |       |-- application or sourced row / saved JD artifact
        |       |-- company/public intelligence when available
        |
        +--> Gate preflight (deterministic)
        |       |-- missing JD/body -> manual state
        |       |-- hard cuts / comp review / obvious fit -> verdict state
        |       v
        |   Optional bounded AI body-read judgment
        |       |-- schema valid KEEP/CUT/REVIEW -> continue
        |       |-- no-AI / ambiguous / invalid -> manual review state
        |
        +--> Question capture
        |       |-- Greenhouse/Ashby provider normalizers
        |       |-- unsupported provider -> manual paste
        |       |-- EEO/demographic/survey sections -> excluded badge only
        |
        +--> Bounded AI packet proposal
        |       |-- resume summary / cover-letter blocks / answer drafts
        |       |-- evidence ids + gap markers only
        |
        +--> Deterministic assembly and validation
        |       |-- placeholder lint
        |       |-- forbidden wording / honesty checks
        |       |-- ATS-safe markdown validation
        |
        +--> Export
        |       |-- PDF always for user-facing packet
        |       |-- DOCX only if required/selected
        |
        v
DB artifact stamping via appRegisterArtifact() / richer packet verb
        |
        v
GET /api/packet/list and GET /api/packet?id=... preview existing artifacts
```

### Recommended Project Structure

```text
src/
├── core/
│   ├── packet/
│   │   ├── context.mjs       # DB-backed packet context assembly
│   │   ├── gate.mjs          # local gate orchestration over deterministic + bounded AI
│   │   ├── generate.mjs      # packet orchestration and manifest writing
│   │   ├── answers.mjs       # non-EEO question answer generation/validation
│   │   ├── questions.mjs     # wrapper over form-question capture + manual paste
│   │   ├── exports.mjs       # PDF/DOCX format policy over exportArtifact()
│   │   └── schemas/          # AI output schemas and packet manifest schemas
│   └── documents/
│       └── tailor.mjs        # keep existing deterministic builders here
├── cli/
│   └── packet-route.mjs      # extend existing route module with local POST APIs
└── core/onboarding/
    └── packet-page.mjs       # replace default skill-runtime action with local API calls
```

### Pattern 1: Thin Route, Durable Core

**What:** Route handlers validate request shape, open the DB with `requireDb()`, call `src/core/packet/*`, and translate the service result into HTTP status/envelope. [CITED: src/cli/data-route.mjs]  
**When to use:** Every Phase 10 route, especially generate/gate endpoints that mutate artifact state.  
**Example:**

```javascript
// Source: local route pattern in src/cli/data-route.mjs and DB access in src/core/db/connection.mjs
if (method === "POST" && pathname === "/api/packet/generate") {
  const body = await readJsonBody(req);
  const db = requireDb(root);
  const result = await generatePacket({ db, root, appId: body.appId, formats: body.formats });
  return sendJson(res, result.statusCode, result.body);
}
```

### Pattern 2: Bounded AI Is a Proposal Source, Not an Authority

**What:** AI returns finite JSON with evidence IDs, proposed text, and gaps; deterministic code validates the output before writing artifacts. [CITED: src/core/ai/bounded-ai.mjs] [CITED: src/core/documents/tailor.mjs]  
**When to use:** Body-read gate judgment, cover-letter block proposals, resume summary proposals, and non-EEO answer drafts.  
**Example:**

```javascript
// Source: src/core/ai/bounded-ai.mjs and src/core/ai/structured-oneshot.mjs
const envelope = await runBoundedAI({
  root,
  labels: { skill: "packet-engine", action: "answer-questions", operation: "packet:answers" },
  structuredMode: "native-preferred",
  outputSchema: packetAnswersSchema,
  manual: {
    available: true,
    reason: "AI route unavailable or packet answer schema invalid",
    action: "Show reviewable questions with NEEDS YOU markers"
  },
  messages
});

if (envelope.status !== "ok") return envelope;
```

### Pattern 3: Store Source Markdown Internally, Surface PDF/DOCX

**What:** Generate markdown source first, lint it, export PDF as the normal packet, then optionally export DOCX and stamp every output through DB-owned artifact metadata. [CITED: src/core/documents/export.mjs] [CITED: src/core/db/verbs/app.mjs]  
**When to use:** Resume, cover letter, and application-answer artifacts.  
**Example:**

```javascript
// Source: src/core/documents/export.mjs and src/core/db/verbs/app.mjs
const pdfPath = await exportArtifact(markdownPath, { pdf: true, ats: true, out: outputBase });
await appRegisterArtifact({
  db,
  root,
  id: appId,
  kind: "resume",
  path: pdfPath,
  note: "ATS PDF generated by local packet engine"
});
```

### Pattern 4: Treat Provider Questions and Public Job Text as Untrusted Input

**What:** Normalize provider/manual questions as data, filter excluded sections before AI, and never execute instructions embedded in job descriptions or form prompts. [CITED: src/core/apply/form-questions.mjs] [CITED: /Users/sbenson/.codex/gsd-core/references/untrusted-input-boundary.md]  
**When to use:** All question capture and generated-answer prompts.  
**Example:**

```javascript
// Source: src/core/apply/form-questions.mjs
const captured = await fetchFormQuestions(url, { fetchImpl });
const answerableQuestions = captured.questions.filter((question) => question.type !== "file");
const excludedSelfId = Boolean(captured.demographicSectionPresent);
```

### Anti-Patterns to Avoid

- **Defaulting to `/api/skill/run`:** Violates the Phase 10 local API boundary for ordinary packet work. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]
- **Letting AI write directly to DB/artifacts:** AI output is untrusted until schema validation and deterministic linting pass. [CITED: src/core/ai/structured-oneshot.mjs] [CITED: src/core/documents/tailor.mjs]
- **Saving PDF only and discarding source markdown:** Locked decisions require internal markdown/source persistence as source of truth/build input. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]
- **Generating DOCX for every packet:** DOCX is required only for board/upload workflows or explicit user choice. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]
- **Answering self-identification prompts:** EEO/disability/veteran/demographic prompts must be excluded from automation. [CITED: .planning/REQUIREMENTS.md] [CITED: https://www.eeoc.gov/publications/employers-guide]
- **Reading generated tracker files as product state:** Product routes must read DB-derived state, not compatibility exports. [CITED: AGENTS.md] [CITED: src/cli/packet-route.mjs]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF rendering | A new HTML-to-PDF renderer | Existing `renderPdf()` / `exportArtifact()` over Playwright | Already handles ATS font stack, print CSS, Letter format, and local Chromium. [CITED: src/core/documents/export.mjs] [CITED: https://playwright.dev/docs/api/class-page] |
| DOCX conversion | A new DOCX npm dependency | Existing pandoc -> soffice -> built-in OOXML fallback | Existing CLI already auto-detects DOCX renderers. [CITED: src/cli/export.mjs] |
| Application question extraction | New provider parser from scratch | Existing `fetchFormQuestions()` plus manual paste fallback | Existing code handles Greenhouse, Ashby, manual parsing, required flags, options, file fields, and demographic exclusion. [CITED: src/core/apply/form-questions.mjs] |
| DB artifact stamping | Manual JSON/tracker edits | `appRegisterArtifact()` or a new DB verb that follows `runVerb()` | DB verbs centralize transaction/activity/export behavior. [CITED: src/core/db/verbs/app.mjs] [CITED: src/core/db/verbs/shared.mjs] |
| AI JSON parsing/retry | Regex-only AI parsing | `runStructuredOneshot()` / `runBoundedAI()` | Existing helpers validate schema, retry with corrective addendum, and return safe manual envelopes. [CITED: src/core/ai/structured-oneshot.mjs] [CITED: src/core/ai/bounded-ai.mjs] |
| Evidence and placeholder checks | Freeform prompt instructions | `buildResumeMarkdown()`, `buildCoverLetterScaffold()`, `buildShortAnswer()`, `lintArtifact()` | Deterministic helpers already block placeholders and forbidden wording. [CITED: src/core/documents/tailor.mjs] |
| Provider demographic filtering | Prompt-based "do not answer EEO" | Deterministic exclusion before AI | Provider docs and existing code expose separable compliance/survey structures. [CITED: src/core/apply/form-questions.mjs] [CITED: https://developers.greenhouse.io/job-board.html] [CITED: https://developers.ashbyhq.com/docs/creating-a-custom-careers-page] |

**Key insight:** Phase 10 is an orchestration and boundary migration phase. The risky work is not rendering documents; it is ensuring ordinary product actions no longer route through full skills, while preserving evidence, privacy, no-AI, and self-identification safeguards. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]

## Runtime State Inventory

> Included because Phase 10 migrates the packet product path from full skill-runtime defaults to local API ownership. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | No active `.rolester/db/rolester.db` exists in this checkout; `node src/cli/data.mjs status --json` fails closed. Existing legacy `workspace/tracker.json`, `workspace/activity.jsonl`, snapshots, captures, and `workspace/tailored/*` artifacts exist. [VERIFIED: command probe] | Implementation tests should use temp DB fixtures; product smoke requires explicit `data init`/`data import` before live packet mutation. Existing artifact paths must remain readable; do not mass-migrate legacy packet files unless a DB import task explicitly owns it. |
| Live service config | `.internal/ai.env` exists, but no `ANTHROPIC_API_KEY` or `ROLESTER_AI_PROXY_URL` was visible from shell/env-file probe. [VERIFIED: command probe] | No-AI 501/manual review must be a planned acceptance path; do not require AI configuration for deterministic packet UI to load. |
| OS-registered state | `.internal/*pid` and `.rolester/internal/tracker-dev.pid` files exist for local dev servers; no system-level launchd/systemd migration was found in the repo scan. [VERIFIED: command probe] | Do not edit dev-server PID files for Phase 10; route tests should not depend on a running dashboard. |
| Secrets/env vars | AI key storage is owned by `src/core/ai/ai-env.mjs`; AGENTS.md states values are chmod `0600` and never echoed back. [CITED: AGENTS.md] | Packet prompts/envelopes must not log raw prompts, model text, current compensation, or secrets. |
| Build artifacts | Existing generated packet files are present under `workspace/tailored/*`; Playwright browser cache, pandoc, and soffice are available. [VERIFIED: command probe] | Preserve artifact compatibility and write new packets under deterministic workspace paths. Planner should include export smoke tests for PDF and DOCX optional path. |

**Nothing found in category:** No renamed string or globally registered service name is part of this phase. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]

## Common Pitfalls

### Pitfall 1: Migrating UI but Keeping the Skill Runtime as the Hidden Default
**What goes wrong:** `/packet` or `/answer` still posts ordinary work to `/api/skill/run`. [CITED: tests/packet-page.test.mjs] [CITED: tests/answer-page.test.mjs]  
**Why it happens:** Existing regression tests currently encode the old behavior. [CITED: tests/packet-page.test.mjs]  
**How to avoid:** Add replacement tests proving local packet APIs are the default and full skill runtime appears only as an explicit handoff.  
**Warning signs:** New code still references `tailor-application`, `answer-question`, or `evaluate-job` from app-default packet buttons.

### Pitfall 2: No-AI Path Becomes a Broken Generate Button
**What goes wrong:** The product cannot produce a safe packet state when no AI route exists. [VERIFIED: command probe]  
**Why it happens:** Phase 10 permits AI for judgment, but local AI configuration may be absent. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]  
**How to avoid:** Treat bounded AI 501/manual envelopes as first-class results; still save deterministic context and show reviewable gaps. [CITED: src/core/ai/bounded-ai.mjs]  
**Warning signs:** Route returns 500 for missing AI config or writes fabricated answers after AI failure.

### Pitfall 3: AI Invents Candidate Facts or Tool Depth
**What goes wrong:** Resume, cover letter, or short answers contain unsupported claims. [CITED: .agents/skills/tailor-application/SKILL.md]  
**Why it happens:** Model output is accepted as prose instead of evidence-indexed proposals.  
**How to avoid:** Require evidence IDs/gap markers in AI schema and run `assertNoForbidden()`, placeholder lint, and source checks before export. [CITED: src/core/documents/tailor.mjs]  
**Warning signs:** Generated answers mention tools, metrics, credentials, or company-specific claims absent from confirmed local evidence.

### Pitfall 4: Manual-Pasted Questions Bypass EEO Exclusion
**What goes wrong:** Provider-normalized forms exclude demographic sections, but pasted question lists include self-identification prompts. [ASSUMED]  
**Why it happens:** Current manual parser extracts question-looking lines and does not classify EEO by itself. [CITED: src/core/apply/form-questions.mjs]  
**How to avoid:** Add a deterministic self-identification classifier for pasted questions before answer generation, with conservative manual review on uncertain prompts. [ASSUMED]  
**Warning signs:** Pasted prompts asking disability, veteran, race, ethnicity, gender, or voluntary self-ID appear in answer drafts.

### Pitfall 5: Artifact Keys Lose Source/Export Separation
**What goes wrong:** Stamping a PDF under `artifacts.resume` hides the markdown source or DOCX sibling. [ASSUMED]  
**Why it happens:** Current packet read route recognizes `resume`, `coverLetter`, and `answers` as artifact kinds and returns one artifact per kind. [CITED: src/cli/packet-route.mjs]  
**How to avoid:** Plan a packet manifest or richer artifact metadata that tracks source markdown plus PDF/DOCX outputs without breaking current readers. [ASSUMED]  
**Warning signs:** Regeneration cannot find source markdown, or UI cannot distinguish PDF from source markdown.

### Pitfall 6: DOCX Becomes Mandatory Work Every Time
**What goes wrong:** Packet generation slows or fails because DOCX is generated unconditionally.  
**Why it happens:** Board-required format logic is not separated from normal PDF packet generation.  
**How to avoid:** Default to PDF; generate DOCX only when captured form/file requirements or explicit export selection require it. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]  
**Warning signs:** Every packet writes `.docx` even when no upload format requirement was captured.

### Pitfall 7: Provider Docs Drift
**What goes wrong:** Greenhouse/Ashby extractors silently miss questions after provider changes.  
**Why it happens:** Provider page/API shapes are external and can change. [CITED: https://developers.greenhouse.io/job-board.html] [CITED: https://developers.ashbyhq.com/docs/creating-a-custom-careers-page]  
**How to avoid:** Keep extractor failures explicit, write manual paste fallback, and test representative provider fixtures. [CITED: tests/form-questions.test.mjs]  
**Warning signs:** Route returns an empty answerable question list without an error or paste prompt.

### Pitfall 8: Full Suite Status Is Misread
**What goes wrong:** Planner treats repo-wide `npm test` as expected green for Phase 10.  
**Why it happens:** `.planning/STATE.md` records that full `npm test` is blocked by pre-existing Phase 08 deep ingest AI gaps. [CITED: .planning/STATE.md]  
**How to avoid:** Use focused Phase 10 tests as per-task checks and report full-suite residual separately until Phase 08 blockers are fixed.  
**Warning signs:** Phase gate fails on unrelated deep-ingest tests and blocks packet validation without triage.

## Code Examples

Verified patterns from local sources and official docs:

### Register an Artifact Through the DB Verb

```javascript
// Source: src/core/db/verbs/app.mjs
await appRegisterArtifact({
  db,
  root,
  id: appId,
  kind: "answers",
  path: answersPdfPath,
  note: "Application answers PDF generated by local packet engine"
});
```

### Export PDF by Default, DOCX Only When Requested

```javascript
// Source: src/core/documents/export.mjs and src/cli/export.mjs
const outputs = {};
outputs.pdf = await exportArtifact(sourceMarkdownPath, {
  pdf: true,
  ats: true,
  out: outputBase
});

if (requiresDocx || userSelectedDocx) {
  outputs.docx = await exportArtifact(sourceMarkdownPath, {
    docx: true,
    out: outputBase
  });
}
```

### Capture Questions and Exclude Demographics Before AI

```javascript
// Source: src/core/apply/form-questions.mjs and config/form-questions.schema.json
const captured = source === "paste"
  ? parseManualQuestions(pastedText, { url })
  : await fetchFormQuestions(url, { fetchImpl });

const nonEeoQuestions = captured.questions.filter((question) => question.type !== "file");
const excludedNotice = captured.demographicSectionPresent
  ? "A demographic/compliance section was detected and excluded."
  : null;
```

### Generate Answers as Structured Proposals

```javascript
// Source: src/core/ai/bounded-ai.mjs and src/core/documents/tailor.mjs
const proposal = await runBoundedAI({
  root,
  labels: { skill: "packet-engine", action: "draft-answers", operation: "packet:answer-draft" },
  structuredMode: "native-preferred",
  outputSchema: answerProposalSchema,
  manual: { available: true, reason: "answer draft needs review", action: "Mark answers NEEDS YOU" },
  messages
});

for (const answer of proposal.body.answers) {
  buildShortAnswer(answer.text, { forbidden: forbiddenWordingFor(context) });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Skills are the ordinary product runtime for packet work | Local API and DB-owned packet orchestration is the Phase 10 target | Phase 10 planning context, 2026-07-06 | Planner should replace default `tailor-application`/`answer-question` calls, not wrap them. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md] |
| Generated tracker/activity files are product state | SQLite DB is canonical; tracker/activity are generated compatibility exports | Phase 6 decisions | Packet APIs must read/write DB and DB verbs. [CITED: .planning/phases/ROL-API-06-canonical-db-app-shell/06-CONTEXT.md] [CITED: AGENTS.md] |
| AI output trusted by prose instruction | Bounded AI returns schema-validated finite JSON, with deterministic validation around it | Phase 2 decisions | Packet engine should require schemas, labels, manual fallback, and deterministic validators. [CITED: src/core/ai/bounded-ai.mjs] [CITED: src/core/ai/structured-oneshot.mjs] |
| Provider application questions handled manually by skills | Greenhouse/Ashby/manual normalizers exist locally | Existing code before Phase 10 | Phase 10 can promote these into the product packet path. [CITED: src/core/apply/form-questions.mjs] |
| DOCX treated as always useful | PDF is the standard packet format; DOCX only when board/upload requires it | Phase 10 locked decision | Planner should make format selection explicit. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md] |
| Ashby survey forms not visible in jobPosting.info | Ashby developer update says `jobPosting.info` returns `surveyFormDefinitions` as of 2025-06-07 | 2025-06-07 | Provider extraction can detect survey/self-ID metadata when using current Ashby docs/API, but implementation should keep manual fallback. [CITED: https://www.ashbyhq.com/product-updates/developer-api-updates] |

**Deprecated/outdated:**
- Default packet UI call to `tailor-application` through `/api/skill/run`: current tests prove it exists, but Phase 10 should replace it. [CITED: tests/packet-page.test.mjs]
- Default answer UI call to `answer-question` through runtime config: current tests prove it exists, but Phase 10 should replace it. [CITED: tests/answer-page.test.mjs]
- Treating a job URL as sufficient application evidence: AGENTS.md requires local JD capture at grab time. [CITED: AGENTS.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Manual-pasted self-identification prompts can be conservatively filtered with deterministic classification before AI. [ASSUMED] | Common Pitfalls, Architecture Patterns | False negatives could draft sensitive EEO answers; false positives could block legitimate prompts. Planner should add fixtures and review language. |
| A2 | A packet manifest or richer artifact metadata can be added without a major DB schema redesign. [ASSUMED] | Common Pitfalls, Architecture Patterns | If existing artifact shape is insufficient, planner must add a migration/DB verb task rather than overloading current keys. |
| A3 | The built-in OOXML fallback is acceptable as a last resort for board-required DOCX after focused export tests. [ASSUMED] | Standard Stack, Validation Architecture | If output quality is insufficient, planner may need a human-verified dependency or stricter pandoc/soffice requirement. |

## Open Questions

1. **Should Phase 10 add a dedicated packet manifest table or store a manifest artifact?**
   - What we know: `appRegisterArtifact()` can stamp kind/path/timestamp, and current packet routes read a fixed artifact map. [CITED: src/core/db/verbs/app.mjs] [CITED: src/cli/packet-route.mjs]
   - What's unclear: Whether source markdown, PDF, DOCX, AI metadata, question capture, and gap counts fit cleanly in current artifact keys.
   - Recommendation: Plan a small packet manifest object first; add a DB table only if tests show artifact metadata cannot express source/export siblings.

2. **Should body-read AI be a separate gate endpoint or part of generate?**
   - What we know: Phase 10 wants "passed gate -> generate packet" as the happy path, while gate ambiguity must return manual/reviewable state. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]
   - What's unclear: UI flow may prefer a separate gate button or an atomic generate endpoint that gates first.
   - Recommendation: Implement both service steps, with `POST /api/packet/generate` calling gate first when no fresh gate exists.

3. **How should board-required DOCX be detected?**
   - What we know: DOCX is only required when board/upload flow requires it or user chooses it. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md]
   - What's unclear: Current question schema captures file fields but may not reliably capture accepted file extensions for every provider. [CITED: config/form-questions.schema.json]
   - Recommendation: Treat captured accept/format metadata as advisory; expose an explicit DOCX export option and default to PDF.

4. **What provider scope is in Phase 10?**
   - What we know: Current deterministic question support is Greenhouse, Ashby, and manual paste; CLI help says other providers require paste. [CITED: src/cli/questions.mjs]
   - What's unclear: Whether the phase should add Lever/Workday question extraction.
   - Recommendation: Do not expand provider scope unless planner finds a requirement gap; make unsupported providers manual paste.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Implementation/tests | yes | v24.18.0 | none needed. [VERIFIED: command probe] |
| npm | Dependency install/test scripts | yes | 11.16.0 | none needed. [VERIFIED: command probe] |
| `rolester` shell command | AGENTS-style operator commands | no | command not found | Use `node src/cli/*.mjs` from repo or add explicit `npm link` setup task. [VERIFIED: command probe] |
| SQLite DB in this checkout | Live product smoke | no | `.rolester/db/rolester.db` absent | Use temp DB tests; live smoke requires explicit `data init`/`data import`. [VERIFIED: command probe] |
| `node:sqlite` | DB layer | yes | Node built-in | none needed. [VERIFIED: command probe] |
| AI route | Bounded AI assists | no configured route visible | `.internal/ai.env` exists, but no key/proxy detected | `runBoundedAI()` no-AI 501/manual envelope. [VERIFIED: command probe] [CITED: src/core/ai/bounded-ai.mjs] |
| Playwright Chromium | PDF export | yes | Chromium cache present; `playwright@^1.60.0` installed | Planner should not upgrade Playwright without checkpoint. [VERIFIED: command probe] [CITED: package.json] |
| pandoc | DOCX export | yes | 3.10 | soffice then built-in OOXML. [VERIFIED: command probe] |
| soffice / LibreOffice | DOCX export | yes | LibreOfficeDev 26.8.0.0.alpha0 | built-in OOXML. [VERIFIED: command probe] |
| Knowledge graph | Semantic relationship discovery | no | `.planning/graphs/graph.json` absent | Use code/doc grep and canonical references. [VERIFIED: command probe] |

**Missing dependencies with no fallback:**
- Active product DB for a real live packet mutation in this checkout; implementation can proceed with temp DB tests, but live validation needs explicit DB initialization/import. [VERIFIED: command probe]

**Missing dependencies with fallback:**
- `rolester` command on PATH: use repo-local `node src/cli/*.mjs` commands or add `npm link` setup.
- AI route: bounded AI routes must return manual/no-AI envelope.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node `node:test` on Node v24.18.0. [VERIFIED: command probe] |
| Config file | none; package script is `node --test 'tests/**/*.test.mjs'`. [CITED: package.json] |
| Quick run command | `node --test tests/packet-route.test.mjs tests/form-questions.test.mjs tests/documents-tailor.test.mjs tests/structured-oneshot.test.mjs tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/evaluate-gate.test.mjs tests/data-route.test.mjs tests/packet-page.test.mjs tests/answer-page.test.mjs` |
| Full suite command | `npm test` |

Focused baseline run on 2026-07-06 passed 208 tests across packet routes, form questions, document helpers, bounded AI, call AI, gate, data routes, and current packet/answer pages. [VERIFIED: command probe]

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| PKT-01 | Local gate/generate APIs write through DB verbs and ordinary product buttons do not call `/api/skill/run`. | integration/static | `node --test tests/packet-generate-route.test.mjs tests/packet-runtime-boundary.test.mjs tests/packet-page.test.mjs tests/answer-page.test.mjs` | partly; new route/boundary tests needed. [CITED: tests/packet-page.test.mjs] [CITED: tests/answer-page.test.mjs] |
| PKT-02 | Resume, cover letter, and answers are evidence-grounded, ATS-safe, and placeholder/forbidden-word clean. | unit/integration | `node --test tests/documents-tailor.test.mjs tests/packet-engine.test.mjs` | partly; packet engine test needed. [CITED: tests/documents-tailor.test.mjs] |
| PKT-03 | Company-specific non-EEO questions are captured and answered; EEO/disability/demographic prompts are excluded. | unit/integration | `node --test tests/form-questions.test.mjs tests/packet-answers.test.mjs` | partly; generated-answer exclusion tests needed. [CITED: tests/form-questions.test.mjs] |
| PKT-04 | PDF is default export; DOCX is emitted only when required/selected and stamped separately. | integration/smoke | `node --test tests/packet-export.test.mjs` | no; Wave 0. |

### Sampling Rate

- **Per task commit:** Focused packet command above, narrowed to touched files when safe.
- **Per wave merge:** Focused packet command plus `node src/cli/export.mjs <fixture.md> --pdf --ats` and a DOCX smoke when export logic changes.
- **Phase gate:** Focused packet suite green; run `npm test` and document unrelated Phase 08 residual if still present. [CITED: .planning/STATE.md]

### Wave 0 Gaps

- [ ] `tests/packet-generate-route.test.mjs` - covers PKT-01 local generate/gate route behavior and DB artifact stamping.
- [ ] `tests/packet-engine.test.mjs` - covers PKT-02 packet orchestration over deterministic document builders and bounded AI envelopes.
- [ ] `tests/packet-answers.test.mjs` - covers PKT-03 non-EEO answer generation and manual-paste exclusion.
- [ ] `tests/packet-export.test.mjs` - covers PKT-04 PDF default and conditional DOCX.
- [ ] Update `tests/packet-page.test.mjs` - old expected skill-runtime post should become a regression that default packet generation calls local APIs.
- [ ] Update `tests/answer-page.test.mjs` - old runtime allowlist expectation should become local answer API behavior or explicit handoff-only behavior.
- [ ] Add static guard for new app-default references to `tailor-application`, `answer-question`, or `evaluate-job` through `/api/skill/run` where local packet owners exist.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | Local app has no new auth layer in this phase; do not add remote auth assumptions. [CITED: docs/ARCHITECTURE.md] |
| V3 Session Management | no | Broad browser-authenticated form filling is deferred and out of scope. [CITED: .planning/REQUIREMENTS.md] |
| V4 Access Control | yes | Keep packet mutations behind local DB verbs and app route boundaries; fail closed when DB is absent. [CITED: src/core/db/connection.mjs] [CITED: src/cli/packet-route.mjs] |
| V5 Input Validation | yes | Validate request JSON, provider question schema, AI output schema, artifact paths, and markdown lint before write/export. [CITED: src/core/ai/structured-oneshot.mjs] [CITED: config/form-questions.schema.json] [CITED: src/core/documents/tailor.mjs] |
| V6 Cryptography | yes | Do not hand-roll crypto; AI key storage remains in existing chmod `0600` env-file path and must never be echoed. [CITED: AGENTS.md] |

### Known Threat Patterns for Local Packet Engine

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection from JD text, company pages, or form questions | Tampering / Information Disclosure | Treat all external text as untrusted data, constrain prompts to schema output, and validate evidence IDs before prose leaves the app. [CITED: /Users/sbenson/.codex/gsd-core/references/untrusted-input-boundary.md] [CITED: src/core/ai/structured-oneshot.mjs] |
| Candidate privacy leak, especially current compensation | Information Disclosure | Never include `current_base` in prompts or artifacts; use target/expected comp only when needed. [CITED: AGENTS.md] [CITED: .agents/skills/tailor-application/SKILL.md] |
| Sensitive self-identification automation | Information Disclosure / Repudiation | Exclude EEO/disability/veteran/demographic prompts before AI and show user-visible excluded state only. [CITED: .planning/REQUIREMENTS.md] [CITED: https://www.eeoc.gov/publications/employers-guide] |
| Path traversal in artifact serving | Tampering / Information Disclosure | Preserve existing artifact resolver behavior that collapses unsafe/unreadable paths to null. [CITED: src/cli/packet-route.mjs] [CITED: tests/packet-route.test.mjs] |
| Malformed or huge request bodies | Denial of Service | Reuse route JSON parsing limits/patterns and return 400 on malformed JSON. [CITED: src/cli/data-route.mjs] [CITED: tests/data-route.test.mjs] |
| AI telemetry captures raw prompts/model text | Information Disclosure | Use bounded AI/callAI metadata-only labels; tests already assert failure envelopes omit raw prompts/model text. [CITED: src/core/ai/bounded-ai.mjs] [CITED: tests/bounded-ai.test.mjs] |
| XSS in artifact preview | Tampering / Information Disclosure | Continue rendering markdown through existing HTML escaping/preview path rather than injecting raw HTML. [CITED: src/cli/packet-route.mjs] |
| Unauthorized external submission | Elevation of Privilege | Packet engine must prepare files only; no submit/click browser automation. [CITED: .planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md] |

## Sources

### Primary (HIGH confidence)

- `.planning/phases/ROL-API-10-local-packet-engine/10-CONTEXT.md` - locked phase decisions, discretion, deferred scope.
- `.planning/REQUIREMENTS.md` - PKT-01 through PKT-04 definitions.
- `.planning/STATE.md` - current project status and known full-suite blocker.
- `AGENTS.md` and `candidate/AGENTS.md` - repo/candidate operating constraints; candidate details intentionally not copied.
- `docs/ARCHITECTURE.md` - local API/DB layer, bounded AI layer, retained full skill runtime boundary.
- `.planning/architecture/runtime-routing-policy.md` - cheapest-correct route ladder and full skill-runtime boundary.
- `src/cli/packet-route.mjs` - current DB-derived packet route behavior.
- `src/core/evaluate/gate.mjs` - deterministic gate behavior.
- `src/core/apply/form-questions.mjs` and `config/form-questions.schema.json` - provider/manual question capture and demographic exclusion.
- `src/core/documents/tailor.mjs` and `src/core/documents/export.mjs` - packet document validation/export helpers.
- `src/core/ai/bounded-ai.mjs`, `src/core/ai/call-ai.mjs`, `src/core/ai/structured-oneshot.mjs` - bounded AI behavior.
- `src/core/db/verbs/app.mjs`, `src/core/db/verbs/shared.mjs`, `src/cli/data-route.mjs` - DB verb/write behavior.
- Focused `node --test` run on 2026-07-06 - 208 passing tests for current packet/form/document/AI/DB baseline.

### Secondary (MEDIUM confidence)

- https://developers.greenhouse.io/job-board.html - Greenhouse Job Board API questions, compliance, demographic question structures, and attachment upload behavior.
- https://developers.ashbyhq.com/docs/public-job-posting-api - Ashby public job posting API overview.
- https://developers.ashbyhq.com/docs/creating-a-custom-careers-page - Ashby application form field definitions, survey form separation, and multipart submission docs.
- https://www.ashbyhq.com/product-updates/developer-api-updates - Ashby 2025-06-07 survey form definition update.
- https://www.eeoc.gov/publications/employers-guide - EEOC voluntary self-identification guidance.
- https://www.dol.gov/agencies/ofccp/self-id-forms - OFCCP voluntary disability self-identification forms.
- https://playwright.dev/docs/api/class-page - Playwright `page.pdf()` behavior and options.
- npm registry checks for `playwright` and `mammoth`.

### Tertiary (LOW confidence)

- None used as authoritative source. Assumptions are listed explicitly in the Assumptions Log.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Core recommendations are existing local modules and verified installed/runtime tools; no new packages are recommended.
- Architecture: HIGH - Boundary is locked by CONTEXT.md and matches existing app-first runtime policy/code.
- Pitfalls: MEDIUM-HIGH - Most pitfalls are verified from current tests/code; manual-paste EEO classifier and packet manifest shape remain assumptions.

**Research date:** 2026-07-06  
**Valid until:** 2026-08-05 for local architecture; 2026-07-13 for Greenhouse/Ashby provider-shape assumptions.
