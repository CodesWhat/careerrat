---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: app-product milestone
current_phase: 06
status: In Progress
stopped_at: Completed 06-09-PLAN.md
last_updated: "2026-07-05T19:08:36.574Z"
progress:
  total_phases: 11
  completed_phases: 5
  total_plans: 38
  completed_plans: 37
  percent: 54
---

# State: Rolester App-First Job Search Runtime

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-07-05)

**Core value:** Rolester must complete job-search work locally with predictable cost: deterministic code does deterministic work, and AI is reserved for judgment that actually needs a model.
**Current focus:** Phase 06 — Canonical DB App Shell

## Current Status

- **Project initialized:** 2026-07-04
- **Current phase:** 06
- **Current phase status:** In Progress
- **Next command:** `$gsd-execute-phase 6`
- **Research mode:** Skipped during initialization; repo context and current roadmap are sufficient for the first pass.
- **Execution mode:** YOLO with coarse vertical-MVP phases.
- **Model profile:** inherit

## Working Assumptions

- GSD should operate from `/Users/sbenson/code/rolester/.planning`, not the parent `/Users/sbenson/code/.planning`.
- Formal GSD project subagents are not installed in this runtime, so initialization was performed inline.
- Existing user changes in `tests/release-safety.test.mjs` and `tmp-skill-conversion/` are not part of this GSD initialization.
- `discover-companies` is now the proof-point migration: local proposal APIs are the default app path, and full skill/chat paths remain explicit.
- Phase 5 completed all five verification/docs plans across three waves and passed canonical verification.
- Compatibility surfaces are not product requirements for v2; `/app` plus DB-derived state is the canonical product path.
- Quick onboarding should trigger background sourcing as soon as the candidate is `search_ready`, then continue into deeper profile ingest.
- Public company/job-board sync-home is opt-in, enabled by default, and limited to scrubbed public records with no PII or candidate-private state.
- Deep ingest should support both drop-all intake and role/job-aware AI interview paths.
- PDF is the standard packet format, with DOCX or other board-required formats supported where needed.

## Open Questions

- None blocking for Phase 6 planning.

## Next Steps

1. Continue Phase 6 Wave 3 with 06-10 DB-mode onboarding source-readiness and compatibility export-copy gap closure.
2. Re-run the Phase 6 verification rollup after 06-10 lands.
3. Keep phases 7-11 in order unless implementation evidence shows a dependency needs to move.

---
*State initialized: 2026-07-04*

## Session

**Last session:** 2026-07-05T19:08:36.564Z
**Stopped at:** Completed 06-09-PLAN.md
**Resume file:** None

## Performance Metrics

| Phase | Plan | Duration | Notes |
|-------|------|----------|-------|
| Phase 01-decomposition-map P01 | 40min | 1 tasks | 1 files |
| Phase 01-decomposition-map P02 | 2min | 1 tasks | 1 files |
| Phase 01-decomposition-map P03 | 2min | 1 tasks | 1 files |
| Phase 01-decomposition-map P04 | 2 min | 1 tasks | 1 files |
| Phase 02-bounded-ai-foundation P01 | 3 min | 1 tasks | 2 files |
| Phase 02-bounded-ai-foundation P02 | 2 min | 1 tasks | 2 files |
| Phase 02-bounded-ai-foundation P03 | 3 min | 1 tasks | 2 files |
| Phase 02-bounded-ai-foundation P04 | 3 min | 1 tasks | 3 files |
| Phase 02-bounded-ai-foundation P05 | 3 min | 1 tasks | 2 files |
| Phase 02-bounded-ai-foundation P06 | 3 min | 1 tasks | 3 files |
| Phase 02-bounded-ai-foundation P07 | 3 min | 1 tasks | 5 files |
| Phase 03-company-discovery-api P01 | 4min | 1 tasks | 9 files |
| Phase 03-company-discovery-api P02 | 4min | 1 tasks | 4 files |
| Phase 03-company-discovery-api P03 | 6min | 1 tasks | 2 files |
| Phase 03-company-discovery-api P04 | 12min | 1 tasks | 6 files |
| Phase 03-company-discovery-api P05 | 7min | 1 tasks | 3 files |
| Phase 03-company-discovery-api P06 | 6 min | 1 tasks | 3 files |
| Phase 03-company-discovery-api P07 | 4 min | 1 tasks | 2 files |
| Phase 04-runtime-routing P01 | 3 min | 3 tasks | 4 files |
| Phase 04-runtime-routing P02 | 3min | 3 tasks | 3 files |
| Phase 04-runtime-routing P03 | 3min | 3 tasks | 3 files |
| Phase 04-runtime-routing P04 | 3min | 3 tasks | 2 files |
| Phase 04-runtime-routing P05 | 3min | 3 tasks | 4 files |
| Phase 05-verification-and-docs P01 | planned | 1 tasks | 1 files |
| Phase 05-verification-and-docs P02 | planned | 2 tasks | 2 files |
| Phase 05-verification-and-docs P03 | planned | 2 tasks | 3 files |
| Phase 05-verification-and-docs P04 | planned | 2 tasks | 4 files |
| Phase 05-verification-and-docs P05 | planned | 1 tasks | 1 files |
| Phase 05-verification-and-docs P01 | 4 min | 1 tasks | 2 files |
| Phase 05-verification-and-docs P02 | 3 min | 2 tasks | 3 files |
| Phase 06 P01 | 3 min | 2 tasks | 3 files |
| Phase 06 P02 | 1 min | 1 tasks | 2 files |
| Phase 06 P03 | 5 min | 3 tasks | 4 files |
| Phase 06 P04 | 5 min | 2 tasks | 4 files |
| Phase 06 P05 | 1 min | 1 tasks | 3 files |
| Phase 06 P06 | 4 min | 1 tasks | 2 files |
| Phase 06 P07 | 4 min | 3 tasks | 5 files |
| Phase 06 P09 | 3 min | 2 tasks | 5 files |

## Decisions

- [Phase 01]: Plan 01-01 remains planning-only; runtime source under src/ was not modified. — The decomposition inventory is an architecture artifact for later implementation plans.
- [Phase 01]: Skill runtime extraction is split into deterministic, bounded-AI, retained-runtime, prompt-spec, and deferred buckets. — This keeps future runtime work traceable to the cheapest correct owner before source changes begin.
- [Phase 01]: Plan 01-02 remains planning-only; runtime source under src/ was not modified. — The discover-companies target contract is an architecture artifact for later implementation plans.
- [Phase 01]: companySeedSchema output is advisory and not write-ready. — Deterministic resolver and confirmation paths own final URLs and writes.
- [Phase 01]: Supported ATS promotion and unsupported public-page cache stay separate. — This preserves current scannable company writes while planning generic public-page extraction.
- [Phase 01-decomposition-map]: Plan 01-03 remains planning-only; runtime source under src/ was not modified. — The routing policy is an architecture artifact for later implementation plans.
- [Phase 01-decomposition-map]: UI, CLI, and agents must choose local deterministic or DB-owned routes before retained skill runtime. — This preserves the cheapest-correct route from D-02 and prevents full skill runtime overuse for deterministic scans, validation, dedupe, and writes.
- [Phase 01-decomposition-map]: Bounded AI uses callAI() and runStructuredOneshot(); model output remains untrusted until schema and deterministic validation pass. — This preserves the D-03 boundary for judgment and ambiguity while keeping final writes deterministic.
- [Phase 01-decomposition-map]: POST /api/skill/run is retained for allowlisted tool-heavy, long-running, or human-watched workflows only. — The full skill runtime remains available without becoming the default path for cheap app or CLI work.
- [Phase 01-decomposition-map]: Plan 01-04 kept Phase 1 runtime-free; no src/ files were modified. — The validation guard is a planning artifact test and did not require runtime implementation.
- [Phase 01-decomposition-map]: The validation guard accepts explicit planned: owners and rejects bare missing owner paths. — This keeps future ownership explicit while proving current owner paths resolve in the repo.
- [Phase 02-bounded-ai-foundation]: Plan 02-01 ships fallback structured invocation through runStructuredOneshot(); native provider request support remains a later adapter concern. — This keeps parse, validation, and retry ownership in the existing structured helper while later plans add native provider request adapters behind the same bounded contract.
- [Phase 02-bounded-ai-foundation]: Bounded AI public envelopes whitelist metadata fields so raw prompts, model text, resumes, JDs, candidate facts, and page bodies stay out of responses. — This preserves the Phase 02 privacy and telemetry boundary while still returning renderable manual fallback metadata.
- [Phase 02-bounded-ai-foundation]: Missing bounded AI labels return a safe AI_LABELS_INVALID envelope from runBoundedAI while requireBoundedAILabels remains a throwing guard for direct callers. — Routes get a stable response shape, and lower-level callers can still fail fast on label regressions before any invocation.
- [Phase 02-bounded-ai-foundation]: callAI() exposes provider-neutral outputSchema, outputName, and outputMode options while keeping Anthropic output_config construction inside callAI(). — This preserves D-16 by keeping provider-native request bodies below route modules.
- [Phase 02-bounded-ai-foundation]: Native structured-output proxy calls preserve x-rolester-skill and x-rolester-action headers while client-side usage logging remains BYOK-only. — This preserves D-09 and D-12 telemetry behavior across native output mode.
- [Phase 02-bounded-ai-foundation]: runBoundedAI() treats provider-native structured output as a reliability optimization, not a trust boundary; native responses still pass through parseStructuredJson(). — This preserves D-14 and keeps Rolester local validation as the final boundary before route data is exposed.
- [Phase 02-bounded-ai-foundation]: Native-preferred mode calls callAI() or an injected call seam with outputMode:"native" and outputSchema while routes keep provider-specific request bodies out of their code. — This preserves D-16 by keeping native provider request details inside the helper/callAI boundary.
- [Phase 02-bounded-ai-foundation]: Fallback mode remains explicit via structuredMode:"fallback" so custom invoke routes continue to use runStructuredOneshot(). — This preserves D-15 compatibility for routes that cannot use provider-native structured output yet.
- [Phase 02-bounded-ai-foundation]: POST /api/assist/suggest now uses runBoundedAI() fallback mode around the existing tool-less runBareOneshot() path. — This preserves the cheap no-tool assist posture while moving schema retry, no-AI, and envelope behavior into the shared bounded helper.
- [Phase 02-bounded-ai-foundation]: suggestAssist() unwraps body.data into the existing UI contract so TargetingStep.jsx stays unchanged. — The app wrapper owns envelope normalization, keeping the onboarding targeting step stable while preserving ai/manual metadata.
- [Phase 02-bounded-ai-foundation]: Intake classification now calls runBoundedAI() in fallback mode only after classifyDeterministically() returns null. — This preserves deterministic known-ATS shortcuts while moving model-shaped classification to the shared bounded helper.
- [Phase 02-bounded-ai-foundation]: AI_SCHEMA_INVALID and NO_AI_ROUTE helper envelopes become existing needs-user intake classifications instead of thrown errors. — Raw paste capture stays manually actionable when schema validation exhausts or no AI route is configured.
- [Phase 02-bounded-ai-foundation]: SDK_NOT_INSTALLED is normalized into the shared NO_AI_ROUTE degradation for intake classification. — Callers get one manual no-AI path with consistent bounded metadata.
- [Phase 02-bounded-ai-foundation]: POST /api/onboard/resume-ai uses runBoundedAI() fallback mode while preserving the resume-extract Read-tool skill runtime adapter. — PDF/image extraction still needs local file Read, but response mapping now uses the shared bounded envelope.
- [Phase 02-bounded-ai-foundation]: Resume-AI success transforms validated model output under body.data while extractResumeAi() unwraps that data for ResumeStep.applySeed(). — The route exposes shared ai/manual metadata without changing the onboarding review UI's seed contract.
- [Phase 02-bounded-ai-foundation]: Only true NO_AI_ROUTE failures return 501 for resume-AI; SDK, allowlist, provider, proxy, timeout, transport, and skill-runtime failures return AI_PROVIDER_FAILED 502. — This keeps missing configuration separate from runtime/provider failures per the Phase 2 envelope policy.
- [Phase 02-bounded-ai-foundation]: Plan 02-07 stayed test-only because final regressions passed against production code from Plans 02-01 through 02-06. — No production leakage or dropped-label regression was exposed, so the plan did not patch production files.
- [Phase 03-company-discovery-api]: Proposal creation is limited to pending DB proposal state; tracked company source config and sourced rows are left for explicit decision routes. — Preserves the Phase 03 confirm-first boundary and prevents generation from becoming a write path.
- [Phase 03-company-discovery-api]: The Phase 03 batch maximum is pinned at COMPANY_DISCOVERY_BATCH_MAX = 12. — Keeps manual seed proposal generation bounded for cost, latency, and denial-of-service control.
- [Phase 03-company-discovery-api]: The route is an exact thin adapter that delegates resolver, scanner, and persistence behavior to core seams. — Matches the established discovery-route pattern and keeps tests hermetic through injection.
- [Phase 03-company-discovery-api]: Resolver cache and proposal state remain DB-owned app state; source-config, sourced rows, activity, and generated tracker/dashboard files are not written by these verbs. — Preserves D-29/D-30 and keeps proposal generation separate from confirmed discovery writes.
- [Phase 03-company-discovery-api]: Due-refresh logic uses the pinned Phase 03 constants: 14-day TTL, failure threshold 2, and zero-job threshold 2. — Keeps cache invalidation deterministic and aligned with the resolved research decisions.
- [Phase 03-company-discovery-api]: Proposal state patches require expectedVersion and return code CONFLICT without mutating stored JSON on stale attempts. — Provides the D-23 conflict boundary for later decision routes.
- [Phase 03-company-discovery-api]: Seed URL hints remain untrusted until resolver checks scheme, host, DNS/lookup result, redirects, and supported provider identity. — Preserves DISC-02 deterministic URL authority and prevents model/manual hints from becoming final write authority.
- [Phase 03-company-discovery-api]: Supported ATS promotion uses sourced-scanner inferProvider(); unsupported public pages are persisted as cache-only and non-promotable. — Preserves the supported/unsupported split and keeps unsupported public pages out of approve-supported-ats flows.
- [Phase 03-company-discovery-api]: Resolver refresh policy exports the pinned Phase 03 constants and REFRESH_REASONS enum for downstream decision plans. — Keeps TTL, zero-job, failure, scan-status, and explicit refresh behavior consistent across resolver and later decision routes.
- [Phase 03-company-discovery-api]: Company seed output is advisory only; schema excludes final URL, provider, API URL, approval, and write-state fields. — Keeps AI/manual seed input from becoming trusted write authority.
- [Phase 03-company-discovery-api]: Candidate seed prompts may include minimum base and OE floor only; current compensation keys and values are excluded. — Preserves the AGENTS.md current-comp privacy boundary while still allowing fit-aware seed generation.
- [Phase 03-company-discovery-api]: No manual seeds plus no AI route returns the shared bounded-AI 501 manual fallback envelope instead of launching chat/full skill. — Preserves deterministic API behavior and avoids hidden runtime escalation.
- [Phase 03-company-discovery-api]: High-confidence proposals require supported ATS proof, current viable role evidence, JD capture, clean dedupe/exclusion/in-play checks, and comp clearing minimum_base. — This keeps discovery proposals confirm-first and prevents weak scanner hits from becoming approval actions.
- [Phase 03-company-discovery-api]: Unposted, uncertain, or top-of-band-only compensation remains borderline/review-only; below-floor posted compensation rejects with comp-below-floor. — Proposal confidence now reflects D-24/D-25 comp plausibility without using current compensation.
- [Phase 03-company-discovery-api]: Proposal generation captures JD artifacts with offersWithCapturedJobs() but does not persist sourced rows before approval. — Captured evidence is available for Plan 03-06 while preserving the confirmation-only write boundary.
- [Phase 03-company-discovery-api]: Only approve-supported-ats can call companyAtsUpsert() or sourcedUpsertBatch(); reject, suppress, escalate, and refresh patch proposal state only. — Preserves the DISC-05 confirmation boundary and prevents non-approval decisions from becoming write paths.
- [Phase 03-company-discovery-api]: Refresh calls resolveCompanyBoard() with forceRefresh:true and refreshReason:"explicit-refresh", rescans supported ATS boards, reruns the gate, and returns refreshed proposal or rejection metadata. — Keeps refresh as resolver/scanner/gate behavior instead of metadata-only state patching.
- [Phase 03-company-discovery-api]: Decision expectedVersion is checked against the proposal version while the DB patch uses the current batch version. — This keeps user-visible stale proposal checks and DB-level conflict-safe writes aligned.
- [Phase 04-runtime-routing]: GET /api/runtime/config exposes only skill names, route type, and booleans; secrets and raw env values remain unreported.
- [Phase 04-runtime-routing]: Discovery chat handoff availability is derived from chat runtime allowlist membership for research-boards, discover-companies, or search-jobs.
- [Phase 04-runtime-routing]: Onboarding AI controls now derive from runtimeConfig.ai.available instead of state.keyConfigured. — Managed proxy AI can enable controls without a local key while runtime config failure keeps local/manual discovery available.
- [Phase 04-runtime-routing]: OnboardingPage remains the only runtime capability loader; steps receive runtimeCapabilities as props. — This keeps runtime capability requests centralized and prevents individual steps from hardcoding runtime-route behavior.
- [Phase 04-runtime-routing]: CompaniesStep uses local proposal create/read routes as the primary company discovery action. — The discover-companies chat handoff is only shown as an explicit secondary path when runtime capabilities allow it.
- [Phase 04-runtime-routing]: Proposal decisions route through the local Phase 3 decision endpoint with expectedVersion. — Stale conflicts reload proposals and stay in the local panel instead of launching chat or retained skill runtime.
- [Phase 04-runtime-routing]: FinishStep discovery handoffs remain explicit button-triggered chat sessions. — Quick-start/next routes are gated by runtimeCapabilities.discoveryChatHandoffs.
- [Phase 04-runtime-routing]: Proposal review UAT passed after a mobile action-row overflow fix. — Browser UAT covered desktop/mobile local proposal, conflict, refresh, no-AI, and no /api/skill/run behavior.
- [Phase 05-verification-and-docs]: Phase 5 planning is verification-first and fail-closed. — The final rollup plan cannot complete unless backend tests, frontend tests, and static scans all pass.
- [Phase 05-verification-and-docs]: Company seed generation remains the only discovery module allowed to use bounded AI; deterministic resolver, context, gate, proposal, and decision modules are statically forbidden from direct AI seams. — This preserves VER-01 by keeping model use in the bounded seed owner and making deterministic discovery owners mechanically AI-free.
- [Phase 05-verification-and-docs]: Local company proposal create/read/decision route slices are checked separately so explicit quick-start/next chat handoff routes can remain available outside the local proposal path. — The route module intentionally contains both local proposal routes and explicit chat handoff routes, so slice-based checks avoid weakening either boundary.
- [Phase 05-verification-and-docs]: Structured-output negative coverage stayed test-only because existing production code already returns safe bounded-AI envelopes for malformed, schema-invalid, and no-AI paths. — This preserves Phase 05 scope while locking VER-02 and VER-03 behavior through hermetic tests.
- [Phase 05-verification-and-docs]: Route failure side-effect assertions compare source config to the fixture pre-failure state instead of assuming an empty source config. — This proves failures do not write while preserving seeded prompt and dedupe context.
- [Phase 06]: Wave 0 remains intentionally test-only; both new 06-01 tests are RED against current source and are verified through commands that require nonzero underlying test exits. — This preserves RED coverage before DB app shell implementation begins.
- [Phase 06]: The 06-01 static guard strips JavaScript comments before token scans and requires tracker-dev compatibility routes to move behind named debug/export classification symbols. — This keeps generated-file access auditable and prevents comments from creating false positives.
- [Phase 06]: The 06-01 NavList regression preserves canonical SPA labels and the Inbox badge while failing the Classic `/tracker` affordance. — This isolates APP-01 coverage from unrelated app shell behavior.
- [Phase 06]: Wave 0 packet route coverage stays test-only and RED against the current tracker-export-backed implementation. — This preserves APP-02 and APP-03 coverage before the packet product API migrates to DB-derived reads.
- [Phase 06]: Packet fixtures seed SQLite through importFromTracker while asserting workspace/tracker.json is absent from the temp runtime workspace. — This prevents the RED tests from passing through generated tracker exports.
- [Phase 06]: Wave 0 source setup and scanner coverage stays test-only and RED against current file-backed product route behavior. — Implementation moves to Phase 6 Wave 1 after all RED contracts are present.
- [Phase 06]: Source setup and scanner product routes are specified as fail-closed HTTP 409 when SQLite is absent; legacy config and scan-result files are not sufficient product state. — This preserves APP-02/APP-03 and decisions D-04 through D-08.
- [Phase 06]: DB-mode scanner seen sets must come from SQLite application and sourced rows, not from generated workspace/tracker.json exports. — Generated tracker exports are compatibility artifacts only.
- [Phase 06]: Normal React app navigation now contains only /app SPA product routes; legacy /tracker remains outside the nav. — This makes APP-01 green for the NavList RED guard.
- [Phase 06]: tracker-dev keeps generated dashboard, raw tracker/activity, and storage-adapter feed routes only as named debug/export compatibility routes. — This keeps remaining generated-file access auditable for APP-04.
- [Phase 06]: Missing generated tracker exports skip only the debug/export render path; /app and DB APIs still boot. — This preserves APP-03 by preventing compatibility exports from becoming product prerequisites.
- [Phase 06]: Packet product APIs now read application rows through requireDb() and assembleTrackerObject(db), not generated tracker exports. — This makes the APP-02 packet route contract green while preserving existing tracker-shaped stage classification.
- [Phase 06]: Packet list/detail routes translate missing SQLite state to HTTP 409 setup errors. — This preserves APP-03 by treating missing DB as a product setup failure instead of falling back to workspace/tracker.json.
- [Phase 06]: Board additions now read and write DB `search-sources` config through source-config verbs instead of `config/search-sources.yml`. — This makes the APP-02 source setup write contract green and keeps legacy YAML as non-canonical compatibility state.
- [Phase 06]: Malformed board URLs are validated before DB access so bad input remains HTTP 400 while missing DB remains HTTP 409. — This preserves the D-04/D-06 API boundary between request validation and setup failure.
- [Phase 06]: Board preview remains deterministic and DB-free. — Preview URL construction stays a pure helper-backed route while only persisted source setup requires SQLite.
- [Phase 06]: DB scanner context reads only SQLite application and sourced rows; generated tracker exports are not part of DB-mode duplicate context. — This preserves APP-02/APP-03 DB source-of-truth boundaries for scanner context.
- [Phase 06]: Legacy tracker-export seen sets remain available only when no SQLite database exists, preserving compatibility CLI mode outside product routes. — This keeps existing non-product CLI compatibility while product search routes fail closed without DB.
- [Phase 06]: Search product routes now require SQLite for scan, sources, and results; legacy config and scan-result files are ignored as product state. — This mitigates generated-file dependency regressions in the search route boundary.
- [Phase 06]: React /app onboarding keeps only the canonical Get started action; the legacy /onboard page is not presented as a user fallback. — This closes the APP-01 onboarding legacy-affordance gap.
- [Phase 06]: Retained byte-static pages remain mounted, but tracker-dev route discovery now classifies them as compatibility/debug/export surfaces. — This keeps compatibility pages explicit without making them normal product UX.
- [Phase 06]: Static guard coverage now includes normal React onboarding product pages beyond NavList. — This preserves APP-04 coverage for legacy static-page affordances in product pages.
