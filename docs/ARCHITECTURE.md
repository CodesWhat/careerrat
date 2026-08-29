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

The root router in `AGENTS.md` maps user intent to 26 user-facing skills;
`CLAUDE.md` adds Claude-specific reminders without defining a second contract.
`intake-extract` and `resume-extract` are backend-only helpers invoked by the
Universal Intake and onboarding upload routes, not user-intent destinations.
Routes are grouped below by cluster.

### Onboarding

- New workspace or incomplete profile → `ingest-profile`
- "Scan my projects folder / repo" → `ingest-profile` (projects-scan mode)
- "Sync / import email, pull recruiter replies" (Apple Mail or opted-in Gmail/Outlook webmail) → `ingest-mail`
- "Sync / check LinkedIn or Wellfound messages/DMs" (opt-in browser) → `ingest-messages`

### Apply Cycle

- "Apply", "submit", or a JD URL with apply intent → `apply-job`
  (`apply-job` must run or verify `evaluate-job` as step zero; LinkedIn Easy Apply
  postings can use opt-in authenticated form preparation gated by the
  `authenticated_apply_preparation` capability; final submission stays manual)
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
  (opt-in browser automation; applies verified advances atomically and leaves
  regressions or low-confidence labels for review)
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

### CareerRat-owned private-account browser workflows

The in-app private-account browser workflows read permitted Apple Mail, Gmail,
Outlook, LinkedIn, Wellfound, Greenhouse, Workday, Ashby, and Lever surfaces
without delegating the product action to the selected agent CLI. Their contextual
permissions remain off by default and are checked per capability and platform.
Saved job-source login is separate: when a source is added or first used and login
is needed, CareerRat asks one site-specific Yes/No question instead of using the
permission matrix. Login walls, captchas, 2FA, and other challenges return visible
retry state without advancing the workflow watermark.

Mail and message reads capture relevant communications locally. Relationship
sourcing writes review-only leads. LinkedIn optimization writes proposal batches;
approvals remain local until a separate `profile_apply` permission and per-field
confirmation authorize a live edit. Status sync applies only `autoApplicable`
results atomically, including stale portal-CTA cleanup, activity, and analytics.
Regressions and low-confidence labels remain review-only. `track-outcomes` still
owns candidate-reported outcome follow-up, coaching, learning capture, and
strategy checks; the native portal poll does not invent that context.

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
3. Record clean no-results, empty pages, blocked pages, login-gated pages, and
   useless pages as metadata only.
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
do not treat generated `.careerrat/workspace/tracker.json` or `activity.jsonl` exports as
product source of truth. Generated packet source markdown and manifests remain
internal artifacts; user-facing exports default to PDF. DOCX is generated only
when an upload requirement requests it or a user explicitly selects it. EEO,
disability, veteran, demographic, and other voluntary self-identification
questions are excluded from AI drafting. They stay blank by default and may be
filled only from an explicit saved local policy or exact answer in **Profile >
Application defaults**. That setting is redacted from agent context, so no model
can infer or rewrite it. Packet generation prepares materials only and does not
submit applications automatically.

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

### Bounded Skill and Chat Runtime

`POST /api/skill/run` exposes only `intake-extract` and `resume-extract`. Each
installed run receives one canonical uploaded file plus its isolated skill
copy. App workflows, browser work, and durable mutations stay behind their
typed routes and the workspace agent. The generic chat surface exposes only
`ingest-profile`, `research-boards`, `research-company`, `research-comp`, and
`company-health`. Company discovery stays on the app-owned reviewed proposal
path, and `search-jobs` stays on its dedicated AI web-search route.
`CAREERRAT_RUNTIME_SKILLS` controls only the generic `POST /api/skill/run`
surface. An explicitly empty generic allowlist does not disable dedicated,
app-owned routes such as AI web search; each dedicated route grants only its
own scoped skill for that call.

CareerRat owns the workflow executor, durable threads, context assembly, and
write-back. That product layer is provider-neutral. Runtime adapters translate a
capability-scoped request into one local CLI call and normalize text, activity,
usage, cancellation, and errors back into the same app contract.

A provider-neutral operation policy resolves **Automatic**, **Faster**,
**Balanced**, or **Best** quality plus **Automatic**, **Low**, **Medium**, or
**High** thinking depth before each call. Automatic keeps Paul and high-stakes
judgment on the strongest path, routes web research to the balanced path, and
uses the faster path for small bounded classification. The resolved execution
plan is immutable for the life of the operation and its retries. Adapters map
that plan to Claude Code or OpenAI Codex; the user never needs to choose a
provider based on model capability.

Claude Code 2.1.241 or newer and OpenAI Codex 0.149.1 or newer are the supported
engines for the complete CareerRat product. Each runtime must pass local
availability, authentication, and the complete readiness check before
selection. Both adapters run from disposable task directories with bounded
input, approved-file reads, the guarded CareerRat public web MCP, structured
output, live activity, and canonical CareerRat resume. Claude receives a fixed
tool allowlist. Codex ignores user config for the call and receives only the
scoped CareerRat MCP tools required by the request. Each child inherits an
allowlisted process environment, not server credentials. A failed boundary
stops that request; the app never silently switches engines.

CareerOps uses one canonical skill body plus thin provider discovery wrappers.
CareerRat keeps that portable skill shape, then adds a stricter distinction:
finding an executable on `PATH` is detection, not proof that its app boundary is
ready. Fixed invocation, authentication, capability, cancellation, and output
checks decide what the app can actually offer.

Visible chat handoffs are separate from app-default actions. They are explicit
user-selected sessions, not hidden fallbacks from local API errors.

The React product at `/app` is the only HTML product surface. First-run state,
workspace operations, and agent-led handoffs all stay inside that shell.

The chat-first shell persists threads and missions independently of any one AI
vendor. See [CHAT_FIRST_RUNTIME.md](CHAT_FIRST_RUNTIME.md).

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
bodies and summaries live in `.careerrat/workspace/comms/`.

`email-comms` should read both before drafting so the user does not need to
re-provide thread history.

### Source Layer

Search sources are provider adapters under `src/core/providers/`.

- URL-query sources build stable URLs from config before Playwright opens them.
- RSS/Atom sources should poll feeds before browser capture.
- ATS sources should use stable public endpoints where possible.
- Browser-rendered sources should preserve the generated URL, raw capture, and
  exact recency cutoff.
- AI open-web discovery preserves a credible specific role as explicitly
  unverified when the full body cannot be fetched. Evaluate owns later liveness
  and full-description verification.
- Hospitality baselines use OysterLink, Hcareers, Hospitality Online, and
  iHireHospitality; engineering baselines keep their engineering, remote, ATS,
  and general sources.

See [SOURCES.md](SOURCES.md).

### User Layer

Candidate facts, generated artifacts, and tracker state stay local.

### Desktop Update Layer

Packaged macOS builds use `electron-updater 6.8.9` as the single desktop update
path. The Electron main process owns release checks, downloads, persisted
preferences, and installation. An isolated preload exposes typed IPC methods and
state to the React shell. The renderer never fetches GitHub releases, handles a
native updater exception, or receives filesystem access through this bridge.

The macOS feed is one release-bound trust unit: the direct-install DMG, signed
updater ZIP carrying the exact app version, and `latest-mac.yml`. Before upload,
the release verifier selects exactly one version-matching ZIP and recomputes its
SHA-512 and size against the manifest. Draft publication gates then require all
three assets. The updater rejects prereleases and downgrades, and the signed app
identity remains the operating-system trust boundary after download.

An update downloads in the background but does not install silently. The shell
shows progress and a **Restart and install** action only after the native updater
reports the package ready. Accepting it enters the normal service shutdown path,
stops watchers, connected clients, agent children, and the local server, then
hands the cached package to `quitAndInstall`. An ordinary quit exits normally and
never installs the cached package.

Windows self-update remains disabled. The current SignPath path signs the NSIS
installer after builder metadata is generated, so the signed public installer
does not yet have a feed and blockmap proven against its final bytes. Unsigned
Windows builds remain QA artifacts, and the app exposes no unsupported update
control. Windows can be enabled only after a signed-installer-first feed is built
and verified atomically.

### System Layer

Reusable skills, scripts, templates, and schemas are public-safe.

See [DATA_CONTRACT.md](DATA_CONTRACT.md).
