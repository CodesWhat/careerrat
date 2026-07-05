# Rolester App-First Job Search Runtime

## What This Is

Rolester is a local-first job-search engine that is moving from agent-only skill execution toward an Electron/React app runtime where most work is deterministic TypeScript and AI is used only for bounded judgment. The project keeps the existing skill files as orchestration specs for CLI agents, but product flows should run through local APIs, DB verbs, scanners, validators, and small structured AI calls.

The paid app and the free BYO-agent surface should use the same core engine. UI buttons, CLI commands, and agents should converge on one local data/API layer instead of starting a whole `SKILL.md` loop for work that code can perform cheaply and reliably. Compatibility exports can remain for agents and debugging, but they are not product requirements.

## Core Value

Rolester must complete job-search work locally with predictable cost: deterministic code does deterministic work, and AI is reserved for judgment that actually needs a model.

## Business Context

- **Customer**: Job seekers who want a managed local app without giving up the open-core agent workflow.
- **Revenue model**: Paid convenience layer for managed AI, packaged desktop UX, updates, and future billing/auth; free BYO-agent remains the funnel.
- **Success metric**: A pilot user can onboard, have sourcing start automatically once enough data exists, keep enriching their profile, discover roles, evaluate, and prepare apply packets from the app with lower AI spend than full skill-agent runs.
- **Strategy notes**: `ROADMAP.md` Productization and App-first rework sections remain the source for the broader open-core plan.

## Requirements

### Validated

- Rolester has a local dashboard/dev server and Electron shell that can host app-first flows.
- Rolester has SQLite DB verbs as the atomic write path in DB workspaces.
- Rolester has `callAI()` for BYOK/proxy routing and usage labeling.
- Rolester has `runStructuredOneshot()` for schema-validated JSON AI outputs.
- Rolester has `POST /api/skill/run` for full `SKILL.md` execution through the embedded Agent SDK.
- Rolester has provider scanners for supported ATS boards: Ashby, Greenhouse, Lever, Workable, and SmartRecruiters.
- Phase 1 validated a skill decomposition inventory that classifies priority workflows into deterministic code, bounded structured AI, retained full-skill runtime, prompt/spec, and deferred owners.
- Phase 1 validated a `discover-companies` target contract with AI seed schema, deterministic board resolution cache, scanner/extractor cascade, confirmation gate, write path, and bakeoff metrics.
- Phase 1 validated a routing policy for when UI, CLI, and agents should call local APIs, DB/CLI owners, bounded AI assists, chat, or retained `POST /api/skill/run`.
- Phase 2 validated the bounded-AI foundation: shared helper envelopes, provider-native structured-output support behind `callAI()`, bounded assist/intake/resume-AI migrations, no-AI/manual degradation, and metadata-only telemetry/privacy regressions.
- Phase 3 validated the Company Discovery API: bounded/manual company seeds, deterministic safe ATS resolution/cache, provider scanning, JD capture, proposal gating, latest-pending reads, refresh decisions, and confirmed writes through existing company/source paths.
- Phase 4 validated Runtime Routing: app discovery controls default to local proposal APIs, runtime config drives AI/chat capability gating, explicit discovery chat handoffs remain available, and retained `POST /api/skill/run` stays allowlisted/documented for tool-heavy workflows.
- Phase 5 validated verification and docs: deterministic discovery paths are AI-free, structured/no-AI failures degrade safely, confirm-first company writes are locked, docs match route behavior, and the final focused backend/frontend/static gate passes.

### Active

- Make Electron/React `/app` the canonical DB-backed product surface and remove compatibility surfaces from normal UX.
- Start background sourcing automatically when quick onboarding first reaches `search_ready`, then return the user to deeper onboarding.
- Build deep ingest as both "drop everything you have" intake and an optional role/job-aware AI interview.
- Store public company/job-board intelligence separately from private candidate data, with sync-home opt-in, on by default, and scrubbed of PII/private context.
- Generate ATS-ready resume, cover letter, and non-EEO answer packets through local APIs and bounded AI.
- Lock down app-default runtime paths so broad tool-heavy skill execution is explicit, not the normal button behavior.

### Out of Scope

- Hosted SaaS data storage - Shape 2 keeps candidate data, browser state, and job artifacts local.
- Browser automation for LinkedIn, Wellfound, webmail, or authenticated ATS portals - defer until after the app-first local/API path is solid.
- Auto-submit applications - the current app remains apply-packet first.
- Rewriting every skill in one pass - migrate by high-leverage flows, starting with discovery.
- Replacing the skill docs - skills remain the agent-facing contract and a useful source of truth.

## Context

The current app already contains both runtime shapes. `src/core/ai/skill-runtime.mjs` can run full skills headlessly through the Claude Agent SDK, while `src/core/ai/call-ai.mjs` and `src/core/ai/structured-oneshot.mjs` support cheaper single-purpose model calls. `src/core/db/verbs/` provides atomic write operations, and `src/core/scoring/sourced-scanner.mjs` already knows how to scan supported ATS providers without AI.

The new architectural decision is to treat a skill as a product contract, not the default implementation mechanism. For example, `discover-companies` should not run an entire agent skill just to find employer names. A bounded AI call can propose candidate company seeds as JSON, then TypeScript can resolve careers URLs, scan roles through existing provider APIs, enforce dedupe/exclusion rules, present proposals, and write confirmed additions through `rolester companies` or DB source-config verbs.

Phase 3 turned that `discover-companies` split into working local APIs. Phase 4 routed app surfaces to those APIs by default while keeping explicit chat handoffs and the allowlisted full skill runtime available for workflows that still need tool loops or human-watched orchestration. Phase 5 locked those boundaries with final cost/no-AI regressions, confirm-first write-safety coverage, documentation alignment, and a passing focused verification rollup.

The next milestone applies that foundation to the actual product shape: the Electron/React app becomes canonical, DB state is the product source of truth, quick onboarding triggers background sourcing, deep ingest keeps enriching the candidate while sourcing runs, public company intelligence can sync home without PII, and packet generation moves out of default whole-skill runtime.

The concise product brief for this milestone is `.planning/APP-PRODUCT-PLAN.md`.

## Constraints

- **Cost**: Whole-skill agent runs are too expensive for cheap bounded app actions.
- **Privacy**: Candidate facts and job-search state stay local; cloud calls must go through BYOK or the stateless managed-AI proxy.
- **Reliability**: Deterministic APIs own URLs, DB writes, validation, dedupe, and activity logging.
- **Schema discipline**: AI output must be schema-validated JSON before any downstream action.
- **No-AI degradation**: Missing AI configuration returns explicit 501-style failures and leaves manual paths available.
- **Brownfield**: Existing DB verbs, scanner adapters, dashboard routes, and skill contracts should be reused rather than replaced.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Skills become orchestration specs, not default app runtime | Product UI needs cheap, predictable actions; skills still encode gates and agent behavior | Validated in Phase 1 |
| Deterministic code owns source discovery plumbing | ATS resolution, provider fetches, dedupe, validation, confirmation, and writes are code-shaped work | Validated in Phase 1 |
| Structured AI owns candidate judgment seeds | Models are useful for "what companies might fit this profile" and reasons, but not trusted writes | Validated in Phase 1 |
| `discover-companies` is the first migration target | It has obvious AI-vs-code boundaries and directly affects sourcing cost | Validated in Phase 1 |
| GSD setup skips external research for now | The repo already contains the relevant direction in `ROADMAP.md`, `docs/ARCHITECTURE.md`, and current code | Completed in Phase 1 |
| Bounded AI helpers own schemas, envelopes, no-AI degradation, and telemetry labels | Routes need one cheap structured-output contract before higher-level migrations can safely reuse AI | Validated in Phase 2 |
| Company discovery proposals remain confirm-first | Seed generation, resolution, scanning, and gating can be automated, but tracked source and sourced-row writes require explicit approval | Validated in Phase 3 |
| Runtime config is the UI capability source | App controls need server-owned booleans for AI, local proposals, manual seeds, chat handoffs, and retained full skill runtime | Validated in Phase 4 |
| Local company proposal routes are the app default | Company discovery in the app should create/read/decide local proposals before any chat/full skill runtime is considered | Validated in Phase 4 |
| Discovery chat and full skill runtime are explicit paths | Agent-led workflows remain available, but only after user action and runtime capability gating | Validated in Phase 4 |
| Focused verification is the Phase 5 signal | Unrelated local edits in `tests/release-safety.test.mjs` make full `npm test` a noisy signal for this phase | Validated in Phase 5 |
| Compatibility surfaces are not product requirements | The Electron/React app and DB are the user-facing product; generated tracker/dashboard surfaces can remain as export/debug aids only | Planned for Phase 6 |
| Quick onboarding should trigger sourcing immediately | The user should not wait for a full profile interview before Rolester starts finding jobs | Planned for Phase 7 |
| Public intelligence sync is opt-in and on by default | Building shared company/board knowledge is useful, but only scrubbed public records may leave the machine | Planned for Phase 9 |
| Deep ingest uses both drop-all intake and AI interview | Different candidates have different evidence sources; the app should accept raw material and ask targeted follow-ups based on role/job context | Planned for Phase 8 |
| PDF is the standard packet format, with board-required formats supported | Job boards commonly accept PDF, but the product must handle upload requirements such as DOCX when needed | Planned for Phase 10 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `$gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `$gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check - still the right priority?
3. Business Context check - customer, revenue model, success metric still accurate?
4. Audit Out of Scope - reasons still valid?
5. Update Context with current state

---
*Last updated: 2026-07-05 after v2 app-product planning*
