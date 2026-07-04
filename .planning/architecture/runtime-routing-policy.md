# Runtime Routing Policy

This policy defines how Rolester UI controls, CLI commands, and agent workflows
choose between deterministic local APIs, DB verbs, bounded AI assists,
conversational handoffs, and the retained full skill runtime.

## Phase Boundary

Phase 1 is documentation and validation only. This policy does not create new
routes, DB verbs, schemas, migrations, UI controls, or runtime behavior. Later
implementation phases may use it to update callers, but those plans must still
change runtime source explicitly and test the changed behavior.

The routing boundary is:

- Use existing deterministic code, local API routes, DB verbs, and CLI helpers
  for work that already has a local owner.
- Use bounded structured AI only for model-shaped judgment or ambiguity where a
  small schema-validated result is enough.
- Use `/api/chat/*` for conversational skill handoffs where the user is present
  and the workflow should proceed turn by turn.
- Use `POST /api/skill/run` only for allowlisted full skill execution that needs
  broad tools, long orchestration, live stream visibility, or retained
  human-watched agent behavior.

## Principles

1. Cheapest correct route first. Per D-02, callers must prefer existing
   DB/source config, cached resolution, deterministic scanners or local
   scrapers, cheap API lanes, targeted extractors, bounded AI, and only then the
   full skill runtime.
2. AI is for judgment and ambiguity. Per D-03, models may propose seeds, rank
   ambiguous options, summarize finite context, or resolve gaps. They must not
   own deterministic scans, URL validation, dedupe, persistence, or confirmed
   writes when local owners exist.
3. Skills remain workflow contracts. Per D-12, `.agents/skills/*/SKILL.md`
   files keep the gates, user prompts, and operational procedure. Product
   runtime should decompose their deterministic pieces into local APIs, DB verbs,
   scanners, and bounded AI instead of launching a whole skill for cheap work.
4. Deterministic scans, DB writes, validation, dedupe, and confirmed source writes must not start a full skill runtime when local owners exist.
5. Structured model output is untrusted until validated. Bounded AI output must
   pass schema validation through `runStructuredOneshot()` before downstream code
   consumes it, and final URLs or source writes still require deterministic
   validation and confirmation.
6. Full skill runtime stays allowlisted. `POST /api/skill/run` is retained, but
   it is not the default implementation route for UI buttons or CLI helpers.

## Decision Matrix

| Route class | Use when | Current or planned owner | Do not use for |
| --- | --- | --- | --- |
| deterministic local code | Inputs are already available locally and the work is scanning, filtering, scoring, dedupe, validation, file capture, rendering, or route orchestration. | `scripts/scan-sourced.mjs`, `src/core/scoring/sourced-scanner.mjs`, `src/core/scoring/sourced-persistence.mjs`, local route mounters such as `src/cli/search-route.mjs`. | Open-ended research, ambiguous judgment, browser-authenticated tasks, or long user-led workflows. |
| DB verb or CLI helper | The action mutates canonical state or source config and a DB verb or CLI already owns validation, idempotency, export, activity, or compatibility behavior. | `src/core/db/verbs/source-config.mjs`, `src/core/db/verbs/sourced.mjs`, `src/cli/data-route.mjs`, `src/cli/companies.mjs`, `src/cli/searches.mjs`. | Direct edits to generated workspace state, model-generated writes, or source updates that bypass existing validation. |
| bounded structured AI | The caller needs a small finite model judgment, seed list, rewrite, classification, or normalization that can be expressed as schema-validated JSON. | `callAI()` in `src/core/ai/call-ai.mjs`, `runStructuredOneshot()` in `src/core/ai/structured-oneshot.mjs`, and route wrappers such as `src/cli/assist-route.mjs`. | Streaming tool loops, user interviews, confirmed writes, trusted final URLs, unrestricted web search, or anything that needs persistent agent state. |
| conversational skill handoff | The user wants an agent-led workflow, the flow is confirm-first, or the skill needs turn-by-turn questions while keeping the app in control. | `/api/chat/*` backed by `src/core/ai/chat-runtime.mjs`, with current discovery handoffs from `src/cli/discovery-route.mjs` for `/api/discovery/quick-start` and `/api/discovery/next`. | Cheap deterministic scans, DB writes with local verbs, or one-shot bounded assists that do not need a live skill session. |
| full skill runtime | The workflow is tool-heavy, long-running, broad, hard to bound, watched by the user, or still intentionally retained as SKILL.md execution. Use `POST /api/skill/run` only through the allowlisted runtime surface. | `src/cli/skill-run-route.mjs` and `runSkillStream` in `src/core/ai/skill-runtime.mjs`. | Routine scan/search refreshes, source-config writes, deterministic validation, dedupe, schema-only model assists, or confirmed source writes with existing local owners. |

## Caller Rules

### UI

- Prefer local API routes for button-driven app actions that map to deterministic
  or DB-owned work. A search refresh uses `/api/search/scan`, not a full skill
  session, because `src/cli/search-route.mjs` already calls `runSourcedScan()`.
- Use `/api/data/*` routes from `src/cli/data-route.mjs` for state mutations that
  map to DB verbs. The UI should not hand-edit `workspace/tracker.json`,
  `workspace/activity.jsonl`, or compatibility source files.
- Use bounded AI routes for small assistive suggestions, where missing AI config
  can return a clear no-AI response and the UI can offer manual input.
- Use `/api/discovery/quick-start` and `/api/discovery/next` for current
  supervised discovery chat handoffs until later phases replace specific
  decomposed pieces with local APIs.
- Use `POST /api/skill/run` only for explicit full-skill actions that the
  runtime allowlist permits and that need streamed tool visibility or retained
  skill execution.

### CLI

- Prefer DB verbs and existing CLI helpers for durable writes: `rolester data`,
  `rolester searches`, `rolester companies`, and source-config verbs own
  validation and DB-vs-compat behavior.
- Prefer direct deterministic commands for scans and verification. The sourced
  sweep uses `scripts/scan-sourced.mjs`; it must not call AI.
- Use bounded AI only when a CLI command needs finite model output and can
  validate it with `runStructuredOneshot()` before using it.
- Use skill or chat runtimes only when the CLI is intentionally starting an
  agent-led workflow, not as a shortcut around a local command.
- Keep package installs out of this policy path. Phase 1 adds no packages.

### Agents

- Treat skill files as procedural contracts, not as evidence that every step
  must run through the full skill runtime.
- Before invoking `/api/chat/*` or `POST /api/skill/run`, check whether the
  requested work already has a deterministic route, DB verb, CLI helper, or
  bounded AI owner.
- For job discovery, follow the existing operating order from `AGENTS.md`:
  `setup-searches -> research-boards -> discover-companies -> search-jobs`.
  Within each step, prefer local owners for deterministic substeps and retain
  chat or full skill runtime for confirm-first, exploratory, or tool-heavy
  portions.
- Never treat model output as a confirmed write. Agents must route final source
  writes through the same DB verbs or CLI helpers that UI and CLI callers use.
- Escalate to `/api/chat/*` for turn-by-turn user-led skill work and to
  `POST /api/skill/run` only when the task is allowlisted and requires the full
  tool loop.

## Existing Route Owners

- `src/cli/search-route.mjs` owns `/api/search/scan`, `/api/search/results`, and
  `/api/search/sources`. `POST /api/search/scan` calls
  `runSourcedScan()` from `scripts/scan-sourced.mjs` and is the current local
  deterministic scan route owner.
- `scripts/scan-sourced.mjs` owns the importable deterministic sourced sweep,
  including supported ATS/RSS scanning orchestration, summary output, JD capture
  handoff, scan-result writing, and intake rendering.
- `src/core/scoring/sourced-scanner.mjs` owns provider inference, supported ATS
  and RSS fetchers, scoring, title/location filters, dedupe inputs, and offer
  normalization.
- `src/core/db/verbs/source-config.mjs` owns DB-backed `search-sources` and
  `sourced-scan` config plus `companyAtsUpsert()` for supported ATS tracked
  companies.
- `src/core/db/verbs/sourced.mjs` owns sourced-row batch upserts and sourced
  promotion through DB transactions.
- `src/cli/data-route.mjs` owns the HTTP shim over data verbs under `/api/data/*`.
- `src/cli/assist-route.mjs` owns the current bounded structured assist route,
  using `runStructuredOneshot()` and the AI routing helpers for small
  schema-validated suggestions.
- `src/core/ai/call-ai.mjs` owns `callAI()` and AI route selection between BYOK,
  managed proxy, and no-AI responses.
- `src/core/ai/structured-oneshot.mjs` owns `runStructuredOneshot()`,
  fenced-JSON extraction, schema validation, and one corrective retry.
- `src/cli/discovery-route.mjs` owns current discovery handoff routes:
  `/api/discovery/state`, `/api/discovery/quick-start`, and
  `/api/discovery/next`.
- `src/core/ai/chat-runtime.mjs` owns multi-turn conversational skill sessions
  behind `/api/chat/*`.
- `src/cli/skill-run-route.mjs` owns `GET /api/runtime/config` and
  `POST /api/skill/run`.
- `src/core/ai/skill-runtime.mjs` owns `runSkillStream`, skill discovery,
  allowlist resolution, tool-surface selection, and full skill execution.

## No-AI Degradation

- Deterministic local code and DB routes must continue to work with no AI route
  configured. Missing `ANTHROPIC_API_KEY` or managed proxy settings cannot block
  scans, dedupe, validation, DB writes, source-config reads, or local rendering.
- Bounded AI routes should return an explicit unavailable response, such as the
  current 501-shaped no-AI behavior, and leave the caller with a manual entry or
  local deterministic path.
- `/api/chat/*` and `POST /api/skill/run` may fail closed when no AI route or SDK
  runtime is available. That is a runtime availability issue, not a reason to
  re-route deterministic work into a skill.
- If AI is unavailable during company discovery, the local path can still read
  configured sources, cached board resolutions, supported ATS entries, and
  pasted/manual company inputs. It should skip seed generation rather than
  silently fabricate seed data.
- No-AI mode must never convert model-shaped uncertainty into a trusted write.

## Examples

1. Search refresh from the app:
   - Caller: UI.
   - Correct route: `/api/search/scan`.
   - Reason: deterministic local code already scans configured sources through
     `runSourcedScan()`, captures job bodies, filters, dedupes, and writes scan
     results.
   - Incorrect route: `POST /api/skill/run` with `search-jobs` just to refresh
     existing configured sources.

2. Add a confirmed supported ATS company:
   - Caller: CLI, UI, or agent after confirmation.
   - Correct owner: `rolester companies` or `companyAtsUpsert()` through
     source-config DB ownership.
   - Reason: source-config owners validate supported provider identity and
     preserve DB-vs-compat behavior.
   - Incorrect route: model output or a skill session writing source files
     directly.

3. Generate company seed proposals:
   - Caller: future company discovery API.
   - Correct route class: bounded structured AI via `callAI()` and
     `runStructuredOneshot()`.
   - Reason: seed generation is model-shaped judgment, but output remains
     advisory until deterministic resolver and confirmation paths validate it.
   - Incorrect route: trusting the model's URL hints as final `careers_url`
     writes.

4. Continue a confirm-first discovery workflow:
   - Caller: UI or agent.
   - Correct route: `/api/discovery/next`, which currently starts or reuses a
     `/api/chat/*` session through `src/core/ai/chat-runtime.mjs`.
   - Reason: the workflow remains user-led and confirm-first until later phases
     decompose the specific substeps into local APIs.
   - Incorrect route: a hidden batch process that auto-approves board or company
     writes.

5. Run a watched full skill workflow:
   - Caller: UI or CLI surface that explicitly exposes full skill execution.
   - Correct route: `POST /api/skill/run` if the skill is allowlisted and the
     task needs the full tool loop or streaming visibility.
   - Reason: the retained runtime is for tool-heavy, long-running, or
     human-watched behavior.
   - Incorrect route: using full skill runtime for routine deterministic scans,
     validation, dedupe, or DB writes.

## Drift Checks

- New UI actions must name their route class in design or plan notes:
  deterministic local code, DB verb or CLI helper, bounded structured AI,
  conversational skill handoff, or full skill runtime.
- Any new call to `POST /api/skill/run` must justify why `/api/search/scan`,
  `/api/data/*`, a CLI helper, `callAI()`, `runStructuredOneshot()`, or
  `/api/chat/*` is insufficient.
- Any new bounded AI route must include schema validation, no-AI degradation,
  skill/action usage labels where model traffic is sent, and deterministic
  validation before writes.
- Any new source write must identify the DB verb or CLI helper that owns
  validation and DB-vs-compat behavior.
- Any route that scans, validates, dedupes, writes confirmed sources, or persists
  sourced rows must prove it does not start `runSkillStream` or call
  `POST /api/skill/run` when a local owner exists.
- The decomposition validation test created by Plan 01-04 should include this
  policy's required route classes and owner paths so future edits cannot erase
  ARCH-03 coverage silently.
