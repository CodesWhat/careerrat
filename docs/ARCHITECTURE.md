# Architecture

Rolester is organized around deterministic local APIs, bounded AI assists,
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

### Bounded AI Layer

Model calls are reserved for small schema-validated judgments:

- seed company suggestions
- classify finite pasted content
- suggest bounded onboarding fields
- normalize or rewrite a small artifact

Bounded AI flows call `callAI()` or `runStructuredOneshot()`, return explicit
no-AI/manual fallbacks, and treat model output as advisory until deterministic
validation passes.
For company discovery, bounded AI is limited to company seed judgment; the
resolver, scanner, proposal gate, and confirmed writes stay deterministic.

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
