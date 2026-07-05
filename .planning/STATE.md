---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 03
status: In Progress
stopped_at: Completed 03-07-PLAN.md
last_updated: "2026-07-05T00:54:35.800Z"
progress:
  total_phases: 5
  completed_phases: 3
  total_plans: 18
  completed_plans: 18
  percent: 100
---

# State: Rolester Skill-to-API Runtime

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-07-04)

**Core value:** Rolester must complete job-search work locally with predictable cost: deterministic code does deterministic work, and AI is reserved for judgment that actually needs a model.
**Current focus:** Phase 03 — company-discovery-api

## Current Status

- **Project initialized:** 2026-07-04
- **Current phase:** 03
- **Current phase status:** Complete
- **Next command:** `$gsd-verify-work 03-company-discovery-api`
- **Research mode:** Skipped during initialization; repo context and current roadmap are sufficient for the first pass.
- **Execution mode:** YOLO with coarse vertical-MVP phases.
- **Model profile:** inherit

## Working Assumptions

- GSD should operate from `/Users/sbenson/code/rolester/.planning`, not the parent `/Users/sbenson/code/.planning`.
- Formal GSD project subagents are not installed in this runtime, so initialization was performed inline.
- Existing user changes in `tests/release-safety.test.mjs` and `tmp-skill-conversion/` are not part of this GSD initialization.
- The first implementation target is `discover-companies` because the AI-vs-code boundary is clear and cost-sensitive.

## Open Questions

- What exact schema should company seed generation return?
- Should the migrated discovery API be exposed as a new `/api/discovery/companies/*` route, a `rolester data` verb, or both?
- Which current app screen should own proposal confirmation: `/search`, `/app`, or a dedicated discovery drawer?
- Should skill decomposition live in docs only, or as machine-readable metadata that routes can consume?

## Next Steps

1. Verify Phase 3 with `$gsd-verify-work 03-company-discovery-api`.
2. Discuss or plan Phase 4 runtime routing when ready.

---
*State initialized: 2026-07-04*

## Session

**Last session:** 2026-07-05T00:54:35.791Z
**Stopped at:** Completed 03-07-PLAN.md
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
