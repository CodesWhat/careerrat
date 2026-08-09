# Architecture

CareerRat is organized around deterministic local APIs, bounded AI assists,
explicit chat handoffs, and retained skill runtime.

## Flow

```text
candidate profile  ──────────────────────────────────────────────────────┐
  -> search setup                                                         │
  -> sourced scan                                                         │
  -> gated intake  <── research loop (research-company / -comp / -boards)│
  -> body-read evaluation                                                 │
  -> tailoring                                                            │
  -> communication tracking                                               │
  -> application tracking                                                 │
  -> interview prep                                                       │
  -> outcome tracking ──> reevaluation loop (reevaluate-strategy) ───────┘
```

The research loop feeds evaluation and interview prep with cited company intel
and comp benchmarks. The reevaluation loop reads the full funnel and recommends
targeting, fit-calibration, or channel-mix changes when outcome thresholds trip.

## Intent Router

Root `AGENTS.md` and `CLAUDE.md` instruct agents how to map user intent to the
16 skills. Routes are grouped below by cluster.

### Onboarding

- New workspace or incomplete profile → `ingest-profile`
- "Scan my projects folder / repo" → `ingest-profile` (projects-scan mode)
- "Sync / import email, pull recruiter replies" (Apple Mail or opted-in Gmail/Outlook webmail) → `ingest-mail`
- "Sync / check LinkedIn or Wellfound messages/DMs" (opt-in browser) → `ingest-messages`

### Apply Cycle

- "Apply", "submit", or a JD URL with apply intent → `apply-job`
  (`apply-job` must run or verify `evaluate-job` as step zero; LinkedIn Easy Apply
  postings can use the opt-in authenticated one-click path gated by the
  `one_click_apply` capability — no new skill, stays within `apply-job`)
- "Gate", "should I apply", or a JD URL without apply intent → `evaluate-job`
- "Find jobs", "source", "search", "refresh queue" → `search-jobs`
- "Set up searches", "build search config" → `setup-searches`
- "Tailor résumé / cover letter / short answer" (after gate passes) →
  `tailor-application`

### Research Loop

- "Research this company" / company URL or name pasted → `research-company`
- "What's market comp", "benchmark my salary ask" → `research-comp`
- "Find more boards", "what sources should I add", stale queue → `research-boards`

### Communications

- Email or recruiter message: draft, reply, follow-up, thank-you, scheduling,
  written negotiation counter → `email-comms`
- Live / verbal offer call, real-time negotiation coaching, rehearsal →
  `interview-prep`

### Interview & Story Bank

- Interview invite, screen, panel, assessment → `interview-prep`
- Building behavioral / STAR stories, story bank → `interview-prep`

### Outcomes & Strategy

- Rejection, offer, status change, outcome update → `track-outcomes`
- "Check my statuses", "sync my pipeline", poll ATS dashboards → `sync-status`
  (opt-in browser automation; reads portals, hands transitions to `track-outcomes`)
- "Why am I getting filtered", strategy review, re-rank, or when outcome
  thresholds trip → `reevaluate-strategy`

### Settings

- "Change a setting", comp floor/target, exclusions, writing style, form defaults,
  search sources, usage mode, application mode, browser automation, or session
  browser → `configure`

`apply-job` must run or verify `evaluate-job` as step zero.

## Layers

### Local API and DB Layer

Deterministic code owns the default app path:

- validate setup and runtime capabilities
- build source URLs from config
- scan supported providers
- dedupe sourced roles and companies
- resolve safe careers URLs
- capture reachable job bodies
- persist confirmed writes through DB verbs

Company discovery uses the local company proposal APIs by default. The app calls
`/api/discovery/company-proposals` to create/read proposal batches and
`/api/discovery/company-proposal-decisions` to approve, reject, suppress,
escalate, or refresh a proposal. Local proposal errors stay local; they do not
silently start chat or the full skill runtime.
Confirmed company writes remain confirm-first source config or DB-owner work,
not React state, generated tracker files, or model output.

Public company intelligence is a separate local data lane. Migration 009 creates
`public_*` SQLite tables for company metadata, board metadata, careers-page scan
metadata, review items, and the public sync preference. These rows are public
metadata only: company/domain, careers or board URLs, ATS/provider hints,
confidence, freshness, provenance, conflicts, and scan status. Candidate profile
data, resumes, applications, sourced rows, tracker ids, compensation, fit scores,
private notes, local paths, raw prompts, model text, page bodies, and individual
job postings are blocked by scrub validation before public writes or sync
preview.

The public-intel scanner path is local-first:

1. Resolve supported ATS boards deterministically.
2. Extract public careers-page links and metadata without AI.
3. Record clean no-results, empty pages, blocked pages, robots-disallowed pages,
   login-gated pages, and useless pages as metadata only.
4. Use bounded AI only for ambiguous reachable public text, with schema
   validation and one corrective retry.
5. Treat model-suggested URLs/providers as advisory until deterministic
   validation passes.
6. Put only ambiguous or conflicting findings in the public-intel review queue.

Public-intel routes live under `/api/discovery/public-intel/*`. They return
local API envelopes and do not start chat, call `POST /api/skill/run`, or write
source config except through explicit supported-ATS review approval.

The apply-packet engine is also local-first. Ordinary product packet work uses
`src/cli/packet-route.mjs` and the `src/core/packet/*` services instead of
launching retained skills:

- `POST /api/packet/gate` runs the packet gate through
  `src/core/packet/gate.mjs`, with bounded schema-validated AI only when finite
  body-read judgment is needed.
- `POST /api/packet/questions` captures supported provider or pasted
  application questions through `src/core/packet/questions.mjs` and
  `src/core/apply/form-questions.mjs`.
- `POST /api/packet/answers` drafts non-EEO answers through
  `src/core/packet/answers.mjs`.
- `POST /api/packet/generate` builds the ATS-ready packet through
  `src/core/packet/context.mjs`, `src/core/packet/generate.mjs`, document
  tailoring helpers, and DB-owned artifact registration.
- `POST /api/packet/export` creates user-facing packet exports through
  `src/core/packet/exports.mjs` and `src/core/documents/export.mjs`.

Packet APIs write canonical application artifacts through SQLite DB verbs. They
do not treat generated `workspace/tracker.json` or `activity.jsonl` exports as
product source of truth. Generated packet source markdown and manifests remain
internal artifacts; user-facing exports default to PDF. DOCX is generated only
when an upload requirement requests it or a user explicitly selects it. EEO,
disability, veteran, demographic, and other voluntary self-identification
questions are excluded before answer drafting; the UI may show skipped metadata
but must not generate answers for those prompts. Packet generation prepares
materials only and does not submit applications automatically.

### Bounded AI Layer

Model calls are reserved for small schema-validated judgments:

- seed company suggestions
- classify finite pasted content
- suggest bounded onboarding fields
- normalize or rewrite a small artifact
- extract structure from ambiguous public careers-page text after deterministic
  scanner branches fail to identify a board

Bounded AI flows call `callAI()` or `runStructuredOneshot()`, return explicit
no-AI/manual fallbacks, and treat model output as advisory until deterministic
validation passes.
For company discovery, bounded AI is limited to company seed judgment; the
resolver, proposal gate, and confirmed writes stay deterministic. For public
company intelligence, bounded AI is a last-resort extraction assist; it cannot
approve a source-config write or become final provider identity by itself.
For packet work, bounded AI is limited to finite schema-validated gate, cover
letter block, and non-EEO answer proposals. Packet services validate evidence
ids, preserve no-AI/manual review states, and mark unsupported material as
reviewable rather than upload-ready.

### Conversational Chat Handoff Layer

Agent-led workflows remain available when the user chooses them. Discovery
quick-start and next actions call `/api/discovery/quick-start` or
`/api/discovery/next`, which start or reuse visible `/api/chat/*` sessions.
`ChatPanel` renders the live session instead of hiding a background runtime
handoff.

### Retained Full Skill Runtime

`POST /api/skill/run` remains the allowlisted full runtime for workflows that
need broad tools, long orchestration, streamed visibility, or retained
`SKILL.md` execution. It is not the default route for deterministic scans,
proposal decisions, source writes, or local app actions with existing owners.
It is also not the ordinary route for packet generation or one-off packet answer
drafting; `evaluate-job`, `tailor-application`, and `answer-question` remain
explicit handoffs for agent-led workflows, broad browser work, nuanced judgment,
and supervised submission flows.

The one-shot runtime has an app-safe default tool profile: Read, Glob, Grep, and Skill.
Those filesystem tools are restricted to the selected skill plus approved
candidate, workspace, config, and template roots; credential and internal-state
paths fail closed. Network research uses a separate profile containing WebSearch, WebFetch, and Skill
but no local filesystem tools, so fetched prompt injection
cannot reach candidate files. Both profiles use programmatic permission checks
and a PreToolUse enforcement hook. Unrelated server environment variables are
not inherited by the Agent SDK child. Unsandboxed tool-heavy execution is disabled;
Write, Edit, and Bash are not exposed by an embedded runtime profile.

Visible chat handoffs are separate from app-default actions. They are explicit
user-selected sessions, not hidden fallbacks from local API errors.

Compatibility/static tracker pages are compatibility/debug/export aids. They
are not normal product UX; the Electron and React product path is `/app`, with
`/app/onboarding` for first-run workspaces.

### Skill Contract Layer

Skills define workflow contracts and judgment gates:

- what to ask during onboarding
- whether a job passes the body-read gate
- how to rate fit
- which evidence should support an application
- how to draft and summarize candidate communications
- what to include in an interview packet

Product runtime decomposes those contracts into the cheapest correct owner:
local APIs and DB verbs first, bounded AI for finite judgment, chat handoff for
turn-by-turn work, and full skill runtime only when the tool loop is actually
needed.

### Communication Layer

Tracker state stores concise communication thread metadata. Longer message
bodies and summaries live in `workspace/comms/`.

`email-comms` should read both before drafting so the user does not need to
re-provide thread history.

### Source Layer

Search sources are provider adapters under `src/core/providers/`.

- URL-query sources build stable URLs from config before Playwright opens them.
- RSS/Atom sources should poll feeds before browser capture.
- ATS sources should use stable public endpoints where possible.
- Browser-rendered sources should preserve the generated URL, raw capture, and
  exact recency cutoff.

See [SOURCES.md](SOURCES.md).

### User Layer

Candidate facts, generated artifacts, and tracker state stay local.

### System Layer

Reusable skills, scripts, templates, and schemas are public-safe.

See [../DATA_CONTRACT.md](../DATA_CONTRACT.md).
