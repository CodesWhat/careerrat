# Phase 10: Local Packet Engine - Context

**Gathered:** 2026-07-06T13:43:32Z
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 10 moves the apply-packet path into the local app runtime. The phase should provide app-local APIs for evaluate/gate orchestration, packet generation, application-question capture, non-EEO answer drafting, export generation, and DB artifact stamping. The product default should no longer launch `evaluate-job`, `tailor-application`, or `answer-question` through the full skill runtime for ordinary packet work.

This phase does not build auto-submit, broad browser-authenticated form filling, or default full-skill execution. Application submission remains supervised user action; this phase prepares the materials.

</domain>

<decisions>
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product Direction
- `.planning/PROJECT.md` - App-first local runtime, bounded-AI policy, DB source-of-truth posture, and Phase 10 product decision that PDF is the standard packet format.
- `.planning/APP-PRODUCT-PLAN.md` - Phase 10 product gap: packet generation still leans on skill runtime and should move to app-local evaluate/tailor/answer APIs.
- `.planning/ROADMAP.md` - Phase 10 goal and PKT-01 through PKT-04 success criteria.
- `.planning/REQUIREMENTS.md` - Local Packet Engine requirements and traceability.
- `AGENTS.md` - Repository DB write contract, paste-intake/JD capture invariant, completed-action invariants, tracker content register, and app-first routing expectations.
- `docs/ARCHITECTURE.md` - Local API/DB layer, bounded AI layer, retained full skill runtime boundary, and apply-cycle skill contracts.

### Prior Phase Decisions
- `.planning/phases/ROL-API-06-canonical-db-app-shell/06-CONTEXT.md` - `/app` plus SQLite is canonical; generated tracker/activity files are export/debug only.
- `.planning/phases/07-quick-onboarding-and-auto-sourcing/07-CONTEXT.md` - Search starts early; gate/apply readiness stays stricter than search readiness; deterministic local work must not hide skill runtime.
- `.planning/phases/08-deep-ingest-lane/08-CONTEXT.md` - Candidate evidence, stories, honesty boundaries, writing voice, and role signals are DB-backed, proposal-first, and reviewed before becoming reusable facts.
- `.planning/phases/09-public-company-intelligence-and-scanner-cascade/09-CONTEXT.md` - Public company/job-board intelligence is separate from private candidate data and may support packet context without leaking private state.
- `.planning/phases/02-bounded-ai-foundation/02-CONTEXT.md` - Bounded AI envelopes, schema validation, no-AI/manual degradation, and metadata-only telemetry.
- `.planning/phases/03-company-discovery-api/03-CONTEXT.md` - Thin local APIs, deterministic validation around AI output, confirm-first writes, and DB-owned proposal state.

### Architecture Contracts
- `.planning/architecture/runtime-routing-policy.md` - Cheapest-correct route ladder and prohibition on default full-skill runtime when local owners exist.
- `.planning/architecture/skill-decomposition.yml` - Current decomposition for `evaluate-job`, `apply-job`, `tailor-application`, and retained runtime boundaries.

### Existing Runtime Owners
- `src/cli/packet-route.mjs` - Current DB-derived read-only packet list/detail/artifact API surface and binary artifact resolution.
- `src/core/onboarding/packet-page.mjs` - Legacy/static packet page that currently launches `tailor-application` through `POST /api/skill/run`; Phase 10 should replace this product path.
- `src/core/ai/answer-page.mjs` - Legacy/static answer page that currently launches `answer-question` through `POST /api/skill/run`; useful as migration context, not the target default.
- `src/core/documents/tailor.mjs` - Existing deterministic resume/cover-letter/short-answer assembly and validation helpers: evidence selection, forbidden wording, placeholders, and ATS-safety checks.
- `src/core/apply/form-questions.mjs` - Deterministic Greenhouse/Ashby/manual application-question normalization and demographic/EEOC section exclusion.
- `config/form-questions.schema.json` - Normalized application-question schema, including `demographicSectionPresent`.
- `src/core/db/verbs/app.mjs` - `appRegisterArtifact()` and application row update behavior.
- `src/cli/data-route.mjs` - Existing `/api/data/app/artifact` route over the artifact registration DB verb.
- `src/core/ai/call-ai.mjs` - Provider/proxy AI invocation owner with usage labels.
- `src/core/ai/structured-oneshot.mjs` - Schema-validated bounded AI helper for finite JSON outputs.

### Tests and Guards
- `tests/packet-route.test.mjs` - Current DB-derived packet read route behavior and artifact resolution safety.
- `tests/packet-page.test.mjs` - Current regression proving the old page calls `tailor-application`; Phase 10 should change or replace this expectation.
- `tests/answer-page.test.mjs` - Current regression proving the old page calls `answer-question`; Phase 10 should change or replace this expectation.
- `tests/form-questions.test.mjs` - Provider question normalization and demographic/EEOC exclusion coverage.
- `tests/documents-tailor.test.mjs` - Existing tailoring helper behavior, placeholder linting, forbidden wording, and ATS safety.
- `tests/bounded-ai.test.mjs` and `tests/structured-oneshot.test.mjs` - Bounded AI envelope and schema-validation behavior.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/cli/packet-route.mjs` already reads application rows from SQLite via `assembleTrackerObject(db)` and exposes packet artifacts without reading generated tracker exports.
- `appRegisterArtifact()` already stamps application artifact paths plus generated timestamps and activity events.
- `src/core/documents/tailor.mjs` already assembles ATS-safe markdown without fabricating content, checks placeholders, blocks forbidden wording, and validates short answers.
- `src/core/apply/form-questions.mjs` already fetches/normalizes Greenhouse questions, extracts Ashby embedded application form data, supports manual-paste questions, and flags demographic/compliance sections while excluding them from `questions[]`.
- Bounded AI helpers already provide schema validation, no-AI/manual degradation, usage labels, and telemetry-safe envelopes.

### Established Patterns
- Product routes fail closed without SQLite and do not treat `workspace/tracker.json` or `workspace/activity.jsonl` as product state.
- Route modules should stay thin; durable behavior belongs in core modules and DB verbs.
- AI output remains untrusted until schema validation and deterministic checks pass.
- Full skill runtime remains explicit/allowlisted; local app flows should not silently start `POST /api/skill/run`.
- Candidate facts require honesty safeguards and user-confirmed evidence before becoming outbound reusable truth.
- Existing artifact reads use path traversal guards and collapse unsafe/unreadable artifacts to the same "not available" shape.

### Integration Points
- Add or extend local packet APIs near `src/cli/packet-route.mjs` for gate, generate, question capture, export, and artifact stamping.
- Build packet generation on DB candidate/deep-ingest state rather than candidate compatibility files or generated tracker exports.
- Use `appRegisterArtifact()` or a richer DB-owned packet/artifact verb to stamp resume, cover letter, answers, source markdown, PDF, and optional DOCX outputs.
- Replace normal UI calls to `tailor-application`, `answer-question`, and `evaluate-job` skill runtime with local APIs plus bounded AI where needed.
- Extend or reuse form-question extraction so captured application questions feed answer generation while EEO/demographic sections stay excluded.
- Add static/regression checks so app-default packet actions do not call `POST /api/skill/run` when local packet owners exist.

</code_context>

<specifics>
## Specific Ideas

- The user clarified that evaluate/gate can still be an AI call. The boundary is bounded AI inside a local API, not the old full skill runtime as the product default.
- Once a job passes and the user intends to apply, the app should generate the packet materials automatically.
- The packet engine should use all available local sources and ask for more when needed.
- Application-page questions should be captured, with EEO/demographic/disability questions filtered out of generated-answer automation.
- PDF is the common path. DOCX should be an option only when required by the application/upload flow. Markdown/source should be saved internally rather than presented as the normal user format.
- Research consulted during discussion: EEOC/OFCCP guidance treats demographic/disability self-identification as voluntary/sensitive; Greenhouse/Ashby expose separable application-question and demographic/survey concepts; Greenhouse and Ashby support standard document upload formats including PDF/DOC/DOCX. Downstream implementation should verify current provider docs if it changes provider-specific extraction or export assumptions.

</specifics>

<deferred>
## Deferred Ideas

- Auto-submitting applications remains out of scope.
- Broad browser-authenticated apply/form-fill automation remains out of scope unless a later phase explicitly opts into it.

</deferred>

---

*Phase: 10-Local Packet Engine*
*Context gathered: 2026-07-06T13:43:32Z*
