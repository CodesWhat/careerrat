---
phase: 02-bounded-ai-foundation
plan: "01"
subsystem: ai-runtime
tags: [bounded-ai, structured-output, node-test, telemetry-labels]

requires:
  - phase: 01-decomposition-map
    provides: [runtime routing policy, bounded AI ownership decisions]
provides:
  - Shared bounded AI helper contract with strict labels
  - Safe bounded AI response envelopes for success, schema failure, no-AI, and provider failure
  - Hermetic node:test coverage for helper-level AIR behavior
affects: [company-discovery-api, runtime-routing, ai-telemetry]

tech-stack:
  added: []
  patterns:
    - "Bounded AI routes call a shared helper with explicit skill/action/operation labels."
    - "Fallback structured output delegates parse, validation, and retry to runStructuredOneshot()."
    - "Route envelopes whitelist ai/error/manual metadata and never expose raw model text."

key-files:
  created:
    - src/core/ai/bounded-ai.mjs
    - tests/bounded-ai.test.mjs
  modified: []

key-decisions:
  - "Plan 02-01 ships fallback structured invocation through runStructuredOneshot(); native provider request support remains a later adapter concern."
  - "Bounded AI public envelopes whitelist metadata fields so raw prompts, model text, resumes, JDs, candidate facts, and page bodies stay out of responses."
  - "Missing bounded AI labels return a safe AI_LABELS_INVALID envelope from runBoundedAI while requireBoundedAILabels remains a throwing guard for direct callers."

patterns-established:
  - "Label guard: require skill, action, and operation before invoking any AI callback."
  - "Envelope builder: normalize all helper outcomes into { status, body }."
  - "Hermetic invocation seam: tests inject invoke() callbacks and never require live AI credentials."

requirements-completed:
  - AIR-01
  - AIR-02
  - AIR-03
  - AIR-04

coverage:
  - id: D1
    description: "Strict bounded AI labels are enforced before invocation."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#requireBoundedAILabels rejects missing or blank labels before invocation"
        status: pass
      - kind: other
        ref: "rg -n \"runStructuredOneshot|runSkillStream\" src/core/ai/bounded-ai.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Successful bounded AI calls return status 200 with route data and non-sensitive AI metadata."
    requirement: AIR-04
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#runBoundedAI returns a success envelope with route data and non-sensitive AI metadata"
        status: pass
    human_judgment: false
  - id: D3
    description: "Schema exhaustion returns a safe AI_SCHEMA_INVALID manual envelope."
    requirement: AIR-02
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#runBoundedAI maps parse and schema exhaustion to a safe 422 manual envelope"
        status: pass
    human_judgment: false
  - id: D4
    description: "No-AI route failures return a 501 manual envelope without marking AI as used."
    requirement: AIR-03
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#runBoundedAI maps no-AI route errors to a 501 manual envelope without marking AI used"
        status: pass
    human_judgment: false
  - id: D5
    description: "Generic provider failures return a safe AI_PROVIDER_FAILED manual envelope."
    requirement: AIR-04
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#runBoundedAI maps generic provider errors to a safe 502 manual envelope"
        status: pass
    human_judgment: false

duration: 3 min
completed: 2026-07-04
status: complete
---

# Phase 02 Plan 01: Bounded AI Helper Contract Summary

**Shared bounded AI helper with strict telemetry labels, structured-output fallback validation, and safe route envelopes**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-04T21:05:10Z
- **Completed:** 2026-07-04T21:08:13Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Created `src/core/ai/bounded-ai.mjs` with `BOUNDED_AI_CODES`, `BOUNDED_AI_MODES`, `requireBoundedAILabels`, `makeBoundedAIEnvelope`, and `runBoundedAI`.
- Added `tests/bounded-ai.test.mjs` covering strict labels, success metadata, schema exhaustion, no-AI fallback, provider failure, and no raw-content leakage in response bodies.
- Kept fallback parse/validate/retry ownership in `runStructuredOneshot()` and avoided `runSkillStream()`, live SDK calls, or new dependencies.

## TDD Gate Compliance

- **RED:** `bc6641d` - `test(02-01): add failing bounded AI helper contract`
- **GREEN:** `f9940db` - `feat(02-01): implement bounded AI helper contract`
- **REFACTOR:** No refactor commit needed; post-green review found the implementation already small and dependency-injected.

## Task Commits

1. **Task 1 RED: TDD shared bounded AI helper and envelope contract** - `bc6641d` (test)
2. **Task 1 GREEN: TDD shared bounded AI helper and envelope contract** - `f9940db` (feat)

**Plan metadata:** pending final docs commit.

## Files Created/Modified

- `src/core/ai/bounded-ai.mjs` - Shared bounded AI helper, label guard, envelope builder, and fallback structured invocation.
- `tests/bounded-ai.test.mjs` - Hermetic contract tests for labels, envelopes, schema retry exhaustion, no-AI fallback, provider failure, and response leak prevention.

## Verification

- `node --test tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs` - PASS, 21 tests passing.
- `rg -n "runStructuredOneshot|runSkillStream" src/core/ai/bounded-ai.mjs` - PASS, only `runStructuredOneshot` is referenced.
- `test -f src/core/ai/bounded-ai.mjs && test -f tests/bounded-ai.test.mjs` - PASS.

## Decisions Made

- Plan 02-01 ships fallback structured invocation through `runStructuredOneshot()`; native provider request support remains a later adapter concern.
- Public bounded AI envelopes whitelist metadata fields so raw prompts, model text, resumes, JDs, candidate facts, and page bodies stay out of responses.
- Missing bounded AI labels return a safe `AI_LABELS_INVALID` envelope from `runBoundedAI` while `requireBoundedAILabels` remains a throwing guard for direct callers.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

None.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 02-02. The bounded helper now gives later native provider and route-migration plans a stable helper contract and hermetic tests.

## Self-Check: PASSED

- Created files exist: `src/core/ai/bounded-ai.mjs`, `tests/bounded-ai.test.mjs`.
- TDD commits exist: `bc6641d`, `f9940db`.
- Required verification passed: `node --test tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs`.
- No tracked files were deleted by task commits.
- Pre-existing dirty files `tests/release-safety.test.mjs` and `tmp-skill-conversion/` were not staged or modified by this plan.

---
*Phase: 02-bounded-ai-foundation*
*Completed: 2026-07-04*
