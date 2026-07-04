# Rolester Skill-to-API Runtime

## What This Is

Rolester is a local-first job-search engine that is moving from agent-only skill execution toward an app runtime where most work is deterministic TypeScript and AI is used only for bounded judgment. The project keeps the existing skill files as orchestration specs for CLI agents, but decomposes product flows into local APIs, DB verbs, scanners, validators, and small structured AI calls.

The paid app and the free BYO-agent surface should use the same core engine. UI buttons, CLI commands, and agents should converge on one local data/API layer instead of starting a whole `SKILL.md` loop for work that code can perform cheaply and reliably.

## Core Value

Rolester must complete job-search work locally with predictable cost: deterministic code does deterministic work, and AI is reserved for judgment that actually needs a model.

## Business Context

- **Customer**: Job seekers who want a managed local app without giving up the open-core agent workflow.
- **Revenue model**: Paid convenience layer for managed AI, packaged desktop UX, updates, and future billing/auth; free BYO-agent remains the funnel.
- **Success metric**: A pilot user can onboard, discover roles, evaluate, and prepare apply packets from the app with lower AI spend than full skill-agent runs.
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

### Active

- [ ] Make structured AI assists the default app path for cheap bounded judgment tasks.
- [ ] Migrate `discover-companies` from a whole-skill app action into seed-generation AI plus deterministic ATS resolution, scanning, dedupe, confirmation, and DB writes.
- [ ] Keep `POST /api/skill/run` available only for workflows that need tool loops, long orchestration, or human-watched agent behavior.
- [ ] Add cost and no-AI regression tests so deterministic routes cannot accidentally call a model.
- [ ] Update routing docs so agents, UI, and APIs agree on which layer owns each action.

### Out of Scope

- Hosted SaaS data storage - Shape 2 keeps candidate data, browser state, and job artifacts local.
- Browser automation for LinkedIn, Wellfound, webmail, or authenticated ATS portals - defer to the v2 browser surface.
- Auto-submit applications - the current app remains apply-packet first.
- Rewriting every skill in one pass - migrate by high-leverage flows, starting with discovery.
- Replacing the skill docs - skills remain the agent-facing contract and a useful source of truth.

## Context

The current app already contains both runtime shapes. `src/core/ai/skill-runtime.mjs` can run full skills headlessly through the Claude Agent SDK, while `src/core/ai/call-ai.mjs` and `src/core/ai/structured-oneshot.mjs` support cheaper single-purpose model calls. `src/core/db/verbs/` provides atomic write operations, and `src/core/scoring/sourced-scanner.mjs` already knows how to scan supported ATS providers without AI.

The new architectural decision is to treat a skill as a product contract, not the default implementation mechanism. For example, `discover-companies` should not run an entire agent skill just to find employer names. A bounded AI call can propose candidate company seeds as JSON, then TypeScript can resolve careers URLs, scan roles through existing provider APIs, enforce dedupe/exclusion rules, present proposals, and write confirmed additions through `rolester companies` or DB source-config verbs.

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
*Last updated: 2026-07-04 after Phase 1 verification*
