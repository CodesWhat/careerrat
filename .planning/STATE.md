---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: app-product milestone
current_phase: 11
status: Ready to plan
stopped_at: Phase 11 context gathered
last_updated: "2026-07-06T15:03:46.206Z"
progress:
  total_phases: 11
  completed_phases: 7
  total_plans: 65
  completed_plans: 44
  percent: 64
---

# State: Rolester App-First Job Search Runtime

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-07-05)

**Core value:** Rolester must complete job-search work locally with predictable cost: deterministic code does deterministic work, and AI is reserved for judgment that actually needs a model.
**Current focus:** Phase 11 — Runtime Lockdown and Desktop Release

## Current Status

- **Project initialized:** 2026-07-04
- **Current phase:** 11
- **Current phase status:** Ready to plan
- **Next command:** `$gsd-plan-phase 10`
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

- None blocking for Phase 9 execution.

## Next Steps

1. Start Phase 10 Local Packet Engine planning from the captured context.
2. Before treating repo-wide `npm test` as green, resolve the existing Phase 08 `tests/deep-ingest-ai.test.mjs` gaps for missing proposal schema/modules and grounding/privacy validators.
3. Preserve the public/private data boundary: public metadata only, no candidate profile, comp, fit, tracker, private notes, local paths, raw AI data, page bodies, or job postings.

---
*State initialized: 2026-07-04*

## Session

**Last session:** 2026-07-06T14:04:45.180Z
**Stopped at:** Phase 11 context gathered
**Resume file:** .planning/phases/11-runtime-lockdown-and-desktop-release/11-CONTEXT.md

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
| Phase 06 P10 | 6 min | 2 tasks | 5 files |
| Phase 07 P01 | 6 min | 3 tasks | 2 files |
| Phase 07 P02 | 5 min | 2 tasks | 4 files |
| Phase 07 P03 | 4 min | 2 tasks | 4 files |
| Phase 07 P04 | 8 min | 3 tasks | 10 files |
| Phase 07 P05 | 3 min | 2 tasks | 5 files |
| Phase 07 P06 | 12 min | 2 tasks | 9 files |
| Phase 07 P07 | 8 min | 2 tasks | 7 files |
| Phase 07 P08 | 7m44s | 3 tasks | 4 files |
| Phase 08 P01 | 9 min | 3 tasks | 10 files |
| Phase 08-deep-ingest-lane P02 | 7 min | 2 tasks | 7 files |
| Phase 09 P01 | 10 min | 3 tasks | 7 files |
| Phase 09 P02 | 16 min | 4 tasks | 9 files |
| Phase 09 P03 | 5 min | 3 tasks | 4 files |
| Phase 09 P04 | 4 min | 3 tasks | 3 files |
| Phase 09 P05 | 3 min | 3 tasks | 2 files |
| Phase 09 P06 | 5 min | 3 tasks | 7 files |

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
- [Phase 06]: DB-mode onboarding source readiness now comes from SQLite `sourceConfigGet({ name: "search-sources" })` and requires a stored row with an enabled configured source. — Compatibility YAML, default rows, empty arrays, and source-catalog metadata no longer mark setup ready.
- [Phase 06]: FinishStep separates SQLite source setup readiness from compatibility export freshness. — The export button is explicit CLI/debug support, not normal product source setup state.
- [Phase 06]: LinkedIn saved-search additions in onboarding report DB source setup, not `config/search-sources.yml`. — This keeps `/app` source setup aligned with DB source-of-truth decisions D-04, D-06, and D-07.
- [Phase 07]: Plan 07-01 is intentionally RED and test-only; implementation remains in later Phase 7 plans. — This preserves ONB-02 contracts before DOCX parser/UI implementation begins.
- [Phase 07]: DOCX backend tests generate a minimal valid DOCX fixture in test code instead of committing a binary fixture. — This keeps fixtures source-visible while still requiring real DOCX byte parsing.
- [Phase 07]: ResumeStep tests separate resume input parsing from packet output-format preferences. — form-defaults.document_formats records PDF/DOCX export needs without routing DOCX through AI.
- [Phase 07]: Plan 07-02 is intentionally RED and test-only; implementation remains in later Phase 7 plans. — This preserves RUN-01/RUN-02 contracts before sourcing run state and first-search routing are implemented.
- [Phase 07]: The sourcing_runs contract requires generated JSON columns and explicit latest-purpose/running-status indexes. — This keeps durable run reads queryable while preserving JSON state payloads for summary and error details.
- [Phase 07]: First-search route responses are forbidden from carrying chat, skill-runtime, or discovery-skill handoff tokens. — This locks the first search to deterministic local code instead of hidden agent runtime.
- [Phase 07]: Deterministic source counts distinguish fetchable RSS and supported ATS companies from browser/auth/url-query-only sources. — This keeps automatic first search on unauthenticated deterministic sources only.
- [Phase 07]: Plan 07-03 remained test-only and intentionally RED; implementation is left to later Phase 7 plans. — The plan's purpose is to define failing contracts for subsequent implementation work.
- [Phase 07]: Document format contracts use form-defaults.document_formats.default_packet_format and required_export_formats. — PDF remains the default packet format while board-required exports such as DOCX are explicitly modeled.
- [Phase 07]: First-search UI contracts replace discovery-chat quick-start expectations with local sourcing-run expectations. — Phase 7 routes first search through deterministic sourcing run state instead of chat or retained skill runtime.
- [Phase 07]: Use mammoth.extractRawText({ buffer }) only for DOCX intake; no DOCX HTML conversion or external file access. — This satisfies ONB-02 and T-07-03 while keeping DOCX uploads deterministic and local.
- [Phase 07]: Save DOCX originals before parsing, but write source-resume only after usable text passes the quality gate. — This preserves recovery/fallback while preventing malformed DOCX files from unlocking search readiness.
- [Phase 07]: Keep PDF as form-defaults.document_formats.default_packet_format and record DOCX only as a required_export_formats board need. — Packet export preferences should not route DOCX bytes or text through AI and should be available to later packet-generation plans.
- [Phase 07]: Store sourcing run payloads as JSON while exposing generated purpose/status/timestamp columns for reload-safe lookups. — This keeps later route/UI plans flexible while preserving efficient latest-purpose and running-status queries.
- [Phase 07]: Return existing first-search rows for running, completed, and failed display states unless retryFailed:true is explicitly requested. — This preserves duplicate-run protection while keeping failed first-search rows visible and actionable.
- [Phase 07]: Create failed first-search retry work as a fresh running row with metadata.retryOf pointing at the failed run. — This backs D-12 actionability with a durable transition instead of only changing UI copy.
- [Phase 07]: Keep stored run timestamps snake_case and return camelCase aliases for route consumers. — The DB payload remains canonical while later HTTP/React code can use route-facing field names without another transform.
- [Phase 07]: Onboarding quick-start now starts local deterministic first-search work, while explicit discovery quick-start remains the chat handoff. — This keeps first search deterministic without removing the user-selected discovery path.
- [Phase 07]: First-search retry is driven by latest durable failed run state and passes retryFailed:true server-side. — The client does not need to infer retry behavior from stale UI state.
- [Phase 07]: Cadence is stored under targeting.search_preferences.cadence with a daily/default baseline and does not affect search_ready. — Search scheduling preference remains separate from quick-onboarding readiness.
- [Phase 07]: First-search start/retry uses startFirstSearchRun() and /api/sourcing/first-run/start; no discovery/chat/skill route is used by the first-search task. — This preserves deterministic local first-search behavior.
- [Phase 07]: The explicit deeper interview link remains separate from the first-search task. — This keeps deep onboarding available without treating it as first-search runtime escalation.
- [Phase 07]: Jobs manual reruns use POST /api/sourcing/search/start and the no-hidden-runtime regression guard remains slice-scoped to first/manual search paths. — Keeps repeat sourcing deterministic while allowing explicit retained chat/deep-interview routes outside this slice.
- [Phase 08]: Plan 08-01 is intentionally RED and test-only; production Deep ingest implementation remains in later Phase 8 plans.
- [Phase 08]: Deep ingest contracts are SQLite-native and do not require candidate/ compatibility files for product readiness.
- [Phase 08]: Every source submission must resolve to exactly one visible outcome instead of silently invoking chat or the full skill runtime.
- [Phase 08]: Proposal generation remains untrusted until schema validation, grounding/privacy checks, and explicit user confirmation.
- [Phase 08]: Finish and Library contracts route Deep ingest work to /deep-ingest, not the old deeper-interview chat handoff.
- [Phase 08-deep-ingest-lane]: Deep ingest source/proposal/lane writes are SQLite product workflow state and intentionally do not export tracker/activity compatibility files. — Preserves the Phase 8 proposal/workflow boundary while later confirmation paths own trusted candidate fact writes.
- [Phase 08-deep-ingest-lane]: Deep ingest completion is terminal-lane driven: completed, deferred, or not_available for every required lane. — Matches D-10 through D-12 and keeps deep ingest progress independent from search readiness.
- [Phase 09]: Public-intel state lives in dedicated public_* SQLite tables and is scrubbed before write and preview. — This preserves the sync-home public/private boundary before scanner output starts writing metadata.
- [Phase 09]: Public sync preference is default-on, local, and user-toggleable through onboarding. — Users can opt out before public metadata is prepared for future sync-home behavior.
- [Phase 09]: Public preference API responses omit the internal row id and expose only enabled/source/updatedAt. — This keeps DB implementation details out of the onboarding contract.
- [Phase 09]: Deterministic public scanning handles supported ATS links and custom public-page metadata before any AI fallback. — This preserves the save-AI-calls requirement and keeps clean no-results silent.
- [Phase 09]: Ambiguous public pages create public review items instead of writing source config. — Supported ATS source-config writes remain explicit review/decision behavior.
- [Phase 09]: Bounded AI fallback runs only for ambiguous reachable public text and uses native-preferred structured output with one retry. — This preserves the cost boundary while reducing manual review for genuinely ambiguous pages.
- [Phase 09]: AI-suggested URLs/providers remain advisory until deterministic validation passes. — Model output cannot write source config or become final provider identity by itself.
- [Phase 09]: Scanner review UI lives on the local search page and posts decisions to public-intel routes. — Ambiguous/conflicting items are visible without launching chat or the retained skill runtime.
- [Phase 09]: Public-intel route and scanner module source are statically guarded against chat, retained skill runtime, and /api/skill/run seams. — Future scanner changes fail fast if they reintroduce hidden runtime escalation.
- [Phase 09]: Public sync-preview scrub now blocks source config, search sources, sourced rows, job postings, page text, raw AI, local paths, and candidate-private fields. — This preserves the public-only sync-home boundary.
- [Phase 09]: Public company intelligence documentation now defines public metadata scope, scanner branch order, no-AI no-result states, and explicit supported-ATS review approval. — Maintainers have a source-of-truth for the Phase 09 privacy and runtime contract.

### Blockers

- None for Phase 09 completion. Repo-wide `npm test` remains blocked by pre-existing Phase 08 Deep ingest AI gaps in `tests/deep-ingest-ai.test.mjs`: missing `config/deep-ingest-proposal.schema.json`, `src/core/deep-ingest/proposals/*`, and `src/core/deep-ingest/validators/{grounding,privacy}.mjs`.
