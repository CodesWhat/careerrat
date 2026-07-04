---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 02
status: In Progress
stopped_at: Completed 02-07-PLAN.md
last_updated: "2026-07-04T22:36:51.983Z"
progress:
  total_phases: 5
  completed_phases: 2
  total_plans: 11
  completed_plans: 11
  percent: 100
---

# State: Rolester Skill-to-API Runtime

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-07-04)

**Core value:** Rolester must complete job-search work locally with predictable cost: deterministic code does deterministic work, and AI is reserved for judgment that actually needs a model.
**Current focus:** Phase 02 — bounded-ai-foundation

## Current Status

- **Project initialized:** 2026-07-04
- **Current phase:** 02
- **Current phase status:** In Progress
- **Next command:** `$gsd-execute-phase 2`
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

1. Execute Phase 2 with `$gsd-execute-phase 2`.
2. After Phase 2 execution and verification, continue to Phase 3: Company Discovery API.

---
*State initialized: 2026-07-04*

## Session

**Last session:** 2026-07-04T22:36:26.759Z
**Stopped at:** Completed 02-07-PLAN.md
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
