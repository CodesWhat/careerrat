# Phase 8: Deep Ingest Lane - Context

**Gathered:** 2026-07-05T20:18:48Z
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 8 builds the app-native deep ingest lane for rich candidate context after quick onboarding. It accepts raw material such as resumes, notes, LinkedIn/project links, repositories, portfolio links, pasted facts, recruiter/job context, and writing samples; turns that material into reviewable evidence, stories, honesty boundaries, writing voice, role-specific signals, and visible gaps; and persists progress in durable DB state while background sourcing can continue independently.

This phase does not build a full role/job-aware AI interview. It may use bounded AI extraction/proposal calls, but the conversational interview lane is deferred.

</domain>

<decisions>
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product Direction
- `.planning/PROJECT.md` — App-first runtime definition, v2 product requirements, and decisions that skills are contracts rather than default app runtime.
- `.planning/APP-PRODUCT-PLAN.md` — Product sequence, Phase 8 role in the app-first milestone, and deep ingest product gap.
- `.planning/ROADMAP.md` — Phase 8 goal, ING-01 through ING-04 success criteria, and neighboring Phase 7/9/10 boundaries.
- `.planning/REQUIREMENTS.md` — Deep ingest requirements and traceability.
- `AGENTS.md` — Repository operating contract, DB write contract, paste-intake invariant, and app-first routing expectations.
- `candidate/AGENTS.md` — Local candidate context and existing job-search routing rules that deep ingest must not contradict.

### Prior Phase Decisions
- `.planning/phases/ROL-API-06-canonical-db-app-shell/06-CONTEXT.md` — DB-only product state, no generated-file fallback, and strict app-route regression posture.
- `.planning/phases/03-company-discovery-api/03-CONTEXT.md` — Thin local APIs, confirm-first writes, bounded AI as untrusted proposal input, and DB-owned app state.
- `.planning/phases/02-bounded-ai-foundation/02-CONTEXT.md` — Shared bounded-AI envelopes, schema validation, no-AI degradation, and metadata-only telemetry.

### Existing Runtime Owners
- `src/core/db/verbs/candidate.mjs` — Current candidate profile, targeting, evidence, honesty, artifacts, and readiness computation.
- `src/core/db/verbs/intake.mjs` — Existing durable intake queue and confirm-first state model.
- `src/cli/intake-route.mjs` — Current app intake routes for capture, upload, classify, confirm, dismiss, and dispatch.
- `apps/web/src/app-shell/CaptureBar.jsx` — Existing global drop/paste entry point.
- `apps/web/src/library/LibraryPage.jsx` — Existing evidence/story/voice browser that Phase 8 should make DB-backed for product use.
- `src/core/tracker/library-snapshot.mjs` — Current library view-model builder and evidence/story/voice read behavior.
- `src/core/interview/story-bank.mjs` — Current STAR+R story validation, evidence tracing, and honesty firewall.
- `src/core/profile/evidence-writer.mjs` — Current guarded evidence write logic and claim validation ideas.
- `src/core/profile/writing-style.mjs` — Existing writing sample analysis and writing voice profile behavior.
- `config/intake-classify.schema.json` — Current intake classifier output shape and active/deferred kinds.
- `config/paste-intake-routes.json` — Paste-intake source of truth and deferred profile/project/company rows relevant to Phase 8.

### Tests and Guards
- `tests/db-verbs.test.mjs` — Candidate setup readiness expectations, including `deep_ingest_complete`.
- `tests/data-route.test.mjs` — Candidate config/evidence API behavior over SQLite.
- `tests/db-intake-verbs.test.mjs` — Intake queue state machine and confirm/dismiss behavior.
- `tests/intake-route.test.mjs` — Intake route behavior, upload behavior, and dispatch guarantees.
- `tests/story-bank.test.mjs` — Story validation, evidence trace, coverage gaps, and write safety.
- `tests/writing-style.test.mjs` — Writing-style signal extraction.
- `apps/web/src/library/LibraryPage.test.jsx` — Library rendering expectations.
- `apps/web/src/onboarding/steps/FinishStep.test.jsx` — Setup readiness display expectations.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `candidateConfigGet`, `candidateConfigPatch`, `candidateEvidenceMerge`, and `candidateArtifactPut` in `src/core/db/verbs/candidate.mjs` already establish SQLite candidate setup as app state and recompute readiness after writes.
- `intakeCapture`, `intakeUpdate`, `intakeDecide`, and `intakeList` in `src/core/db/verbs/intake.mjs` already provide durable pre-domain capture and confirm-first review semantics.
- `mountIntakeRoutes()` in `src/cli/intake-route.mjs` already handles text/url capture, binary upload, classification, match context, dispatch resolution, and no-DB fail-closed behavior.
- `CaptureBar` already gives the React app a scoped paste/drop surface on every route.
- `LibraryPage` already renders a reusable evidence/story/voice bank, including filters and readiness tiles.
- `story-bank.mjs`, `evidence-writer.mjs`, and `writing-style.mjs` contain validation and extraction ideas that can be adapted into DB-backed Phase 8 owners.

### Established Patterns
- Product routes fail closed on missing SQLite instead of falling back to generated files.
- Route modules should stay thin and call core modules/DB verbs for durable behavior.
- AI calls should be bounded, schema-first, label-carrying, and manually recoverable when no AI route exists.
- Candidate facts require review and honesty safeguards before they become outbound reusable truth.
- Existing intake queue state is workflow bookkeeping, not tracker-visible domain data; Phase 8 should decide which new deep-ingest state is product state and expose it through DB-backed APIs.

### Integration Points
- Add new DB tables or verbs near candidate/intake ownership rather than expanding generated tracker or candidate YAML as product state.
- Add local API routes under the app/data/intake area that expose deep-ingest lanes, proposals, confirmation, deferral, not-available state, and progress.
- Make Library and onboarding readiness read the new DB-backed deep-ingest state instead of relying on `candidate/stories.yml`, `candidate/writing-style.md`, or generated `workspace/library.json` as product data.
- Reuse bounded AI helpers from `src/core/ai/` for extraction proposals and no-AI/manual fallback.
- Extend capture/drop flows so a source can carry a target shape when launched from Library/Evidence, while the generic CaptureBar remains available for unknown material.

</code_context>

<specifics>
## Specific Ideas

- The user explicitly does not want Phase 8 to get bogged down in migration or compatibility. Treat this as a new structure.
- A Library/Evidence add flow should feel like: choose target type from a control, paste/drop/link the material, click ingest, review the proposed structured result, then confirm/edit/defer.
- "Ingest what is pasted, try to scan" means the product should do best-effort extraction from text, files, links, repos, and project sources, with honest gaps for things it cannot access or safely read.
- `deep_ingest_complete` should be terminal-state driven: completed, not available, or deferred as a visible todo.

</specifics>

<deferred>
## Deferred Ideas

- Full role/job-aware AI interview lane — future phase.
- Full unbounded repository cloning or authenticated private-source scanning — future work unless the planner can provide a small, explicitly consented, bounded path inside Phase 8.

</deferred>

---

*Phase: 8-Deep Ingest Lane*
*Context gathered: 2026-07-05T20:18:48Z*
