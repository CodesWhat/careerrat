---
phase: 02-bounded-ai-foundation
plan: "05"
subsystem: ai-runtime
tags: [bounded-ai, intake-classification, structured-output, node-test]

requires:
  - phase: 02-bounded-ai-foundation
    provides: [bounded AI helper contract, native-preferred helper mode]
provides:
  - Intake classification migration to runBoundedAI()
  - Exact intake skill/action/operation labels for AI classification
  - Manual needs-user fallback mapping for schema exhaustion and no-AI routes
  - Regression coverage for deterministic AI-free shortcuts
affects: [intake-classification, paste-intake, bounded-ai-helper, route-migration]

tech-stack:
  added: []
  patterns:
    - "Core runtime consumers call runBoundedAI() after deterministic shortcut misses."
    - "Helper envelopes are translated back into existing domain result shapes at module boundaries."
    - "SDK_NOT_INSTALLED is normalized to NO_AI_ROUTE for shared no-AI degradation."

key-files:
  created: []
  modified:
    - src/core/intake/classify.mjs
    - tests/intake-classify.test.mjs

key-decisions:
  - "Intake classification now calls runBoundedAI() in fallback mode only after classifyDeterministically() returns null."
  - "AI_SCHEMA_INVALID and NO_AI_ROUTE helper envelopes become existing needs-user intake classifications instead of thrown errors."
  - "SDK_NOT_INSTALLED is normalized into the shared NO_AI_ROUTE degradation so callers see one manual no-AI path."

patterns-established:
  - "Non-route bounded consumer pattern: deterministic precheck, runBoundedAI(), domain-shape envelope translation."
  - "Intake label contract: skill:\"intake\", action:\"classify\", operation:\"intake.classify\"."
  - "Prompt safety remains local to buildIntakeClassifyPrompt(): pasted content is data, and tracker matches are deterministic context only."

requirements-completed:
  - AIR-01
  - AIR-02
  - AIR-03

coverage:
  - id: D1
    description: "Fully resolved known-ATS URL intake classification stays deterministic and does not invoke AI."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/intake-classify.test.mjs#classifyIntakeItem: a fully-resolved known-ATS URL skips AI entirely"
        status: pass
      - kind: other
        ref: "node --test tests/intake-classify.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Text and unresolved URL intake classification use runBoundedAI() with exact intake labels and retry metadata."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/intake-classify.test.mjs#classifyIntakeItem: a text input goes through bounded AI with intake labels"
        status: pass
      - kind: unit
        ref: "tests/intake-classify.test.mjs#classifyIntakeItem: retry-then-ok"
        status: pass
      - kind: other
        ref: "node --test tests/intake-classify.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Schema exhaustion remains an ok:true needs-user classification instead of throwing."
    requirement: AIR-02
    verification:
      - kind: unit
        ref: "tests/intake-classify.test.mjs#classifyIntakeItem: never produces valid output even after the retry"
        status: pass
      - kind: other
        ref: "node --test tests/intake-classify.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D4
    description: "No-AI and SDK-missing paths produce manual needs-user classifications with degraded:\"NO_AI_ROUTE\"."
    requirement: AIR-03
    verification:
      - kind: unit
        ref: "tests/intake-classify.test.mjs#classifyIntakeItem: no AI route configured"
        status: pass
      - kind: unit
        ref: "tests/intake-classify.test.mjs#classifyIntakeItem: SDK devDependency missing"
        status: pass
      - kind: other
        ref: "node --test tests/intake-classify.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D5
    description: "Prompt construction stays pure and preserves the pasted-content-is-data and deterministic tracker-context rules."
    requirement: AIR-02
    verification:
      - kind: unit
        ref: "tests/intake-classify.test.mjs#buildIntakeClassifyPrompt tests"
        status: pass
      - kind: other
        ref: "node --test tests/intake-classify.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false

duration: 3 min
completed: 2026-07-04
status: complete
---

# Phase 02 Plan 05: Intake Classification Bounded Helper Migration Summary

**Intake classification now uses the shared bounded AI helper after deterministic shortcuts, with strict labels and manual no-AI/schema fallback**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-04T22:18:05Z
- **Completed:** 2026-07-04T22:20:36Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Migrated `classifyIntakeItem()` from a direct `runStructuredOneshot()` call to `runBoundedAI()` after deterministic classification misses.
- Added exact intake bounded-AI labels: `skill:"intake"`, `action:"classify"`, and `operation:"intake.classify"`.
- Preserved the AI-free deterministic known-ATS URL shortcut and prompt safety rule that pasted content is data, never instructions.
- Mapped helper `AI_SCHEMA_INVALID` and `NO_AI_ROUTE` envelopes back into the existing `ok:true` needs-user intake classification shape.

## TDD Gate Compliance

- **RED:** `898e88e` - `test(02-05): add failing intake bounded AI tests`
- **GREEN:** `0909892` - `feat(02-05): route intake classification through bounded AI`
- **REFACTOR:** No refactor commit needed; post-green review found the implementation scoped to the planned classifier migration and all verification stayed green.

## Task Commits

1. **Task 1 RED: TDD intake classification migration to bounded helper** - `898e88e` (test)
2. **Task 1 GREEN: TDD intake classification migration to bounded helper** - `0909892` (feat)

**Plan metadata:** pending final docs commit.

## Files Created/Modified

- `src/core/intake/classify.mjs` - Calls `runBoundedAI()` with strict intake labels, preserves deterministic shortcut order, and translates schema/no-AI helper envelopes into manual intake results.
- `tests/intake-classify.test.mjs` - Adds RED/GREEN coverage for AI-free known-ATS classification, bounded metadata labels, retry metadata, schema fallback, no-AI fallback, and SDK-missing degradation.

## Verification

- RED verification: `node --test tests/intake-classify.test.mjs tests/bounded-ai.test.mjs` failed before implementation with 16 passing, 5 failing, and 1 skipped integration test. Failures covered missing bounded `ai` metadata and the old `SDK_NOT_INSTALLED` degradation.
- GREEN verification: `node --test tests/intake-classify.test.mjs tests/bounded-ai.test.mjs` passed with 21 passing tests and 1 skipped integration test.
- Final verification: `node --test tests/intake-classify.test.mjs tests/bounded-ai.test.mjs` passed with 21 passing tests and 1 skipped integration test.
- TDD gate check: `git log --oneline --all | rg '898e88e|0909892'` found RED and GREEN commits in order.

## Decisions Made

- Intake classification now calls `runBoundedAI()` in fallback mode only after `classifyDeterministically()` returns null, so fully resolved known-ATS URL inputs remain AI-free.
- `AI_SCHEMA_INVALID` and `NO_AI_ROUTE` helper envelopes become existing needs-user intake classifications instead of thrown errors.
- `SDK_NOT_INSTALLED` is normalized into the shared `NO_AI_ROUTE` degradation so callers see one manual no-AI path.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- Pre-commit hooks passed. Biome reported the existing gated `process.env.ANTHROPIC_API_KEY` integration-test skip as a Turborepo env-var warning during the RED commit, but it did not block the commit and was outside this plan's behavior change.

## Known Stubs

None. Stub-pattern scan matched only ordinary test accumulators and nullable/default parameters, not unfinished UI/data stubs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 02-06. Intake classification now demonstrates the shared bounded helper pattern for non-route core runtime code while preserving deterministic shortcuts and manual fallback capture.

## Self-Check: PASSED

- Modified files exist: `src/core/intake/classify.mjs`, `tests/intake-classify.test.mjs`.
- TDD commits exist: `898e88e`, `0909892`.
- Required verification passed: `node --test tests/intake-classify.test.mjs tests/bounded-ai.test.mjs`.
- No tracked files were deleted by task commits.
- Pre-existing dirty files `tests/release-safety.test.mjs` and `tmp-skill-conversion/` were not staged or modified by this plan.

---
*Phase: 02-bounded-ai-foundation*
*Completed: 2026-07-04*
