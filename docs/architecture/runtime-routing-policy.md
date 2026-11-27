# Runtime Routing Policy

This policy defines how CareerRat terminal workspace actions, CLI commands, and agent workflows
choose between deterministic local code, DB verbs, bounded AI assists,
conversational handoffs, and the retained full skill runtime.

## Phase Boundary

Phase 1 is documentation and validation only; this document originated as that
planning artifact and remains the routing contract future phases are measured
against. Phase 4 made the policy operational for company discovery: the default
path is the local company proposal pipeline in `src/core/discovery/` and
`careerrat companies`, with proposal create/read/decision handled before any
chat workflow is started.
For company discovery, bounded AI is limited to company seed judgment; seed
output is advisory until deterministic validation, resolver/scanner/gate checks,
and confirm-first source config or DB-owner writes approve it.
Phase 10 made the apply-packet path operational under the same boundary. Packet
work goes through the local services in `src/core/packet/`: gate judgment,
provider or pasted question capture (`careerrat questions`), non-EEO answer
drafting, packet source generation, PDF/DOCX export (`careerrat export`), and DB
artifact stamping, all before any retained skill workflow is started.

The HTTP API that once fronted these owners (the `/api/*` routes served by the
browser workspace) was deleted in v0.26.0 together with the browser workspace,
the Electron app and the in-app workspace agent. The owners themselves stayed.
The terminal workspace and the CLI call them directly.

The retained routing boundary is:

- Use existing deterministic code, DB verbs, and CLI helpers for work that
  already has a local owner.
- Use bounded structured AI only for model-shaped judgment or ambiguity where a
  small schema-validated result is enough.
- Use a visible agent session in the terminal workspace for conversational skill
  handoffs where the user is present and the workflow should proceed turn by
  turn.
- Use the allowlisted full skill runtime only for full skill execution that
  needs broad tools, long orchestration, live stream visibility, or retained
  human-watched agent behavior.

## Principles

1. Cheapest correct route first. Per D-02, callers must prefer existing
   DB/source config, cached resolution, deterministic scanners or local
   scrapers, cheap API lanes, targeted extractors, bounded AI, and only then the
   full skill runtime. Treat this order as the cost tier ladder for routing:
   cached/local work first, free or cheap APIs next, bounded model calls only
   when they add judgment, and full skill runtime last.
2. AI is for judgment and ambiguity. Per D-03, models may propose seeds, rank
   ambiguous options, summarize finite context, or resolve gaps. They must not
   own deterministic scans, URL validation, dedupe, persistence, or confirmed
   writes when local owners exist.
3. Skills remain workflow contracts. Per D-12, `.agents/skills/*/SKILL.md`
   files keep the gates, user prompts, and operational procedure. Product
   runtime should decompose their deterministic pieces into local modules, DB verbs,
   scanners, and bounded AI instead of launching a whole skill for cheap work.
4. Deterministic scans, DB writes, validation, dedupe, and confirmed source writes must not start a full skill runtime when local owners exist.
5. Structured model output is untrusted until validated. Bounded AI output must
   pass schema validation through `runStructuredOneshot()` before downstream code
   consumes it, and final URLs or source writes still require deterministic
   validation and confirmation.
6. Full skill runtime stays allowlisted. `runSkillStream` is retained, but
   it is not the default implementation route for workspace actions or CLI helpers.

## Decision Matrix

| Route class | Use when | Current or planned owner | Do not use for |
| --- | --- | --- | --- |
| deterministic local code | Inputs are already available locally and the work is scanning, filtering, scoring, dedupe, validation, file capture, rendering, proposal orchestration, or CLI orchestration. Saved job-source capture may coordinate one exact session-browser source after its point-of-use Yes/No handoff. | `scripts/scan-sourced.mjs`, `src/core/scoring/sourced-scanner.mjs`, `src/core/scoring/sourced-persistence.mjs`, the CLI front ends `src/cli/search.mjs` and `src/cli/companies.mjs`. | Open-ended research, ambiguous judgment, private-account or open-ended browser workflows, or long user-led workflows. |
| DB verb or CLI helper | The action mutates canonical state or source config and a DB verb or CLI already owns validation, idempotency, export, activity, or compatibility behavior. | `src/core/db/verbs/source-config.mjs`, `src/core/db/verbs/sourced.mjs`, `src/cli/data.mjs`, `src/cli/companies.mjs`, `src/cli/searches.mjs`. | Direct edits to generated workspace state, model-generated writes, or source updates that bypass existing validation. |
| bounded structured AI | The caller needs a small finite model judgment, seed list, rewrite, classification, or normalization that can be expressed as schema-validated JSON. | `callAI()` in `src/core/ai/call-ai.mjs`, `runStructuredOneshot()` in `src/core/ai/structured-oneshot.mjs`, and the CLI commands that wrap them. | Streaming tool loops, user interviews, confirmed writes, trusted final URLs, unrestricted web search, or anything that needs persistent agent state. |
| packet services | The caller is gating a known application, capturing application questions, drafting non-EEO answers, generating packet artifacts, or exporting packet files. | `src/core/packet/context.mjs`, `gate.mjs`, `questions.mjs`, `answers.mjs`, `generate.mjs`, and `exports.mjs`. | Auto-submit, broad browser-authenticated form filling, unsupported provider exploration, or open-ended evidence gathering. |
| conversational skill handoff | The user wants an agent-led workflow, the flow is confirm-first, or the skill needs turn-by-turn questions while keeping the app in control. | Visible agent sessions in the terminal workspace, backed by `src/core/ai/chat-runtime.mjs`. | Cheap deterministic scans, DB writes with local verbs, or one-shot bounded assists that do not need a live skill session. |
| full skill runtime | The workflow is tool-heavy, long-running, broad, hard to bound, watched by the user, or still intentionally retained as SKILL.md execution. Use it only through the allowlisted runtime surface. | `runSkillStream` in `src/core/ai/skill-runtime.mjs`. | Routine scan/search refreshes, source-config writes, deterministic validation, dedupe, schema-only model assists, or confirmed source writes with existing local owners. |

## Caller Rules

### Terminal workspace

- Prefer the local owners for actions that map to deterministic or DB-owned
  work. A search refresh calls `runSourcedScan()` through `careerrat search`,
  not a full skill session.
- Use the company proposal pipeline in `src/core/discovery/` as the default
  company discovery path. Local proposal failures must surface locally; they
  must not silently fall through to chat or the full skill runtime.
- Use the data verbs (`careerrat data`, from `src/cli/data.mjs`) for state
  mutations that map to DB verbs. Nothing should hand-edit `workspace/tracker.json`,
  `workspace/activity.jsonl`, or compatibility source files.
- Use the packet services for ordinary packet work. Packet and answer defaults
  call `src/core/packet/` (`questions.mjs`, `answers.mjs`, `generate.mjs`,
  `exports.mjs`) rather than running `evaluate-job`, `tailor-application`, or
  `answer-question` through the full skill runtime.
- Use bounded AI for small assistive suggestions, where missing AI config
  returns a clear no-AI result and the user can type the value instead.
- Use a visible agent session when the user chooses the agent-led workflow.
- Use the full skill runtime only for explicit actions that its allowlist
  permits and that need streamed tool visibility or retained skill execution.

### CLI

- Prefer DB verbs and existing CLI helpers for durable writes: `careerrat data`,
  `careerrat searches`, `careerrat companies`, and source-config verbs own
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
- Before starting a chat session or the full skill runtime, check whether the
  requested work already has a deterministic owner, DB verb, CLI helper, or
  bounded AI owner.
- For job discovery, follow the existing operating order from `AGENTS.md`:
  `setup-searches -> research-boards -> discover-companies -> search-jobs`.
  Within each step, prefer local owners for deterministic substeps and retain
  chat or full skill runtime for confirm-first, exploratory, or tool-heavy
  portions.
- Never treat model output as a confirmed write. Agents must route final source
  writes through the same DB verbs or CLI helpers that every other caller uses.
- Escalate to a visible agent session for turn-by-turn user-led skill work and
  to the full skill runtime only when the task is allowlisted and requires the
  full tool loop.

## Existing Owners

- `src/cli/search.mjs` owns the `careerrat search` front end.
  It calls `runSourcedScan()` from `scripts/scan-sourced.mjs`, the current local
  deterministic scan owner.
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
- `src/cli/data.mjs` owns the `careerrat data` front end over the data verbs.
- `src/core/ai/call-ai.mjs` owns `callAI()` and AI route selection between BYOK,
  managed proxy, and no-AI responses.
- `src/core/ai/structured-oneshot.mjs` owns `runStructuredOneshot()`,
  fenced-JSON extraction, schema validation, and one corrective retry.
- `src/core/discovery/` owns the local company proposal pipeline, and
  `src/cli/companies.mjs` is its CLI front end.
- `src/core/packet/context.mjs` owns packet context assembly from local
  candidate/application evidence; `gate.mjs` owns finite packet gate judgment;
  `questions.mjs` owns question capture and self-identification exclusion;
  `answers.mjs` owns non-EEO answer drafting; `generate.mjs` owns packet source
  generation and manifest construction; `exports.mjs` owns PDF-default and
  conditional-DOCX packet exports.
- `src/core/db/verbs/app.mjs` owns DB artifact stamping for captured question
  metadata, packet manifests, source markdown, and export paths. Generated
  tracker/activity compatibility files are not packet source of truth.
- `src/core/ai/chat-runtime.mjs` owns multi-turn conversational skill sessions
  for visible agent sessions.
- `src/core/ai/skill-runtime.mjs` owns `runSkillStream`, skill discovery,
  allowlist resolution, tool-surface selection, and full skill execution.

## No-AI Degradation

- Deterministic local code and DB verbs must continue to work with no AI route
  configured. Missing `ANTHROPIC_API_KEY` or managed proxy settings cannot block
  scans, dedupe, validation, DB writes, source-config reads, or local rendering.
- Bounded AI calls should return an explicit unavailable response, such as the
  current 501-shaped no-AI behavior, and leave the caller with a manual entry or
  local deterministic path.
- Chat sessions and the full skill runtime may fail closed when no AI route or SDK
  runtime is available. That is a runtime availability issue, not a reason to
  re-route deterministic work into a skill.
- If AI is unavailable during company discovery, the local path can still read
  configured sources, cached board resolutions, supported ATS entries, and
  pasted/manual company inputs. It should skip seed generation rather than
  silently fabricate seed data.
- No-AI mode must never convert model-shaped uncertainty into a trusted write.

## Examples

1. Search refresh from the terminal workspace:
   - Caller: terminal workspace.
   - Correct owner: `careerrat search`, which calls `runSourcedScan()`.
   - Reason: deterministic local code already scans configured sources,
     captures job bodies, filters, dedupes, and writes scan results.
   - Incorrect route: the full skill runtime with `search-jobs` just to refresh
     existing configured sources.

2. Add a confirmed supported ATS company:
   - Caller: CLI, terminal workspace, or agent after confirmation.
   - Correct owner: `careerrat companies` or `companyAtsUpsert()` through
     source-config DB ownership.
   - Reason: source-config owners validate supported provider identity and
     preserve DB-vs-compat behavior.
   - Incorrect route: model output or a skill session writing source files
     directly.

3. Generate and decide company proposals:
   - Caller: terminal workspace or CLI.
   - Correct owner: the proposal pipeline in `src/core/discovery/` through
     `careerrat companies`, with confirmed decisions written through the
     source-config owners.
   - Reason: seed generation may use bounded structured AI or manual seeds, but
     deterministic resolver/scanner/gate code owns proposal evidence and the
     decision step owns confirmed writes.
   - Incorrect route: trusting model URL hints as final `careers_url` writes,
     starting a chat session after a local proposal error, or using the full
     skill runtime for default company discovery.

4. Continue a confirm-first discovery workflow:
   - Caller: terminal workspace or agent.
   - Correct route: a visible agent session in the terminal workspace, backed by
     `src/core/ai/chat-runtime.mjs`.
   - Reason: this is the explicit agent-led path for a user who wants the
     workflow to proceed turn by turn.
   - Incorrect route: a hidden batch process that auto-approves board or company
     writes.

5. Run a watched full skill workflow:
   - Caller: a surface that explicitly exposes full skill execution.
   - Correct route: `runSkillStream` if the skill is allowlisted and the task
     needs the full tool loop or streaming visibility.
   - Reason: the retained runtime is for tool-heavy, long-running, or
     human-watched behavior.
   - Incorrect route: using full skill runtime for routine deterministic scans,
     validation, dedupe, or DB writes.

6. Prepare a packet for a gated application:
   - Caller: terminal workspace or CLI with an application id.
   - Correct owner: capture questions with `careerrat questions`, draft non-EEO
     answers with `src/core/packet/answers.mjs`, generate with
     `src/core/packet/generate.mjs`, and export with `careerrat export`.
   - Reason: local packet services own evidence boundaries, schema validation,
     DB artifact stamping, PDF defaults, and conditional DOCX behavior.
   - Incorrect route: hidden full-skill runs of `tailor-application` or
     `answer-question` for ordinary packet generation.

## Drift Checks

- New terminal workspace actions must name their route class in design or plan notes:
  deterministic local code, DB verb or CLI helper, bounded structured AI,
  conversational skill handoff, or full skill runtime.
- Any new use of the full skill runtime must justify why `careerrat search`,
  the data verbs, a CLI helper, `callAI()`, `runStructuredOneshot()`, or a
  visible agent session is insufficient.
- Any new bounded AI call must include schema validation, no-AI degradation,
  skill/action usage labels where model traffic is sent, and deterministic
  validation before writes.
- Any new source write must identify the DB verb or CLI helper that owns
  validation and DB-vs-compat behavior.
- Anything that scans, validates, dedupes, writes confirmed sources, or persists
  sourced rows must prove it does not start `runSkillStream` when a local owner
  exists.
- Any default packet action must prove it does not start `runSkillStream` when
  local packet owners exist.
- The decomposition validation test created by Plan 01-04 should include this
  policy's required route classes and owner paths so future edits cannot erase
  ARCH-03 coverage silently.
