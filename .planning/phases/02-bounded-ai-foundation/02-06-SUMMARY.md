---
phase: 02-bounded-ai-foundation
plan: "06"
subsystem: ai-runtime
tags: [bounded-ai, resume-ai, onboarding, shared-envelope, node-test]

requires:
  - phase: 02-bounded-ai-foundation
    provides: [bounded AI helper contract, fallback structured mode, route migration pattern]
provides:
  - Resume-AI route migration to runBoundedAI() fallback mode
  - Shared resume-AI success, schema-failure, no-AI, and provider-failure envelopes
  - Exact resume-extract skill/action/operation labels for upload extraction
  - Client-side resume-AI data unwrap for ResumeStep.applySeed()
affects: [resume-ai, onboarding-resume-step, bounded-ai-helper, route-migration]

tech-stack:
  added: []
  patterns:
    - "Routes that need a retained skill adapter can still call runBoundedAI() with structuredMode:\"fallback\" and a custom invoke."
    - "Resume/image upload extraction keeps runSkillStream({ skill:\"resume-extract\", tools:[\"Read\"] }) inside the custom invoke."
    - "Raw-upload web wrappers unwrap body.data only at the route-specific boundary."

key-files:
  created:
    - .planning/phases/02-bounded-ai-foundation/02-06-SUMMARY.md
  modified:
    - src/cli/onboard-route.mjs
    - tests/onboard-route.test.mjs
    - apps/web/src/lib/api.js

key-decisions:
  - "POST /api/onboard/resume-ai uses runBoundedAI() in fallback mode while preserving the resume-extract Read-tool skill runtime adapter."
  - "Resume-AI success transforms validated model data into body.data.profileSeed/evidenceSeed/sections/targetingSeed/source while preserving bounded ai/manual metadata."
  - "Only true NO_AI_ROUTE failures return 501; SDK, allowlist, provider, proxy, timeout, transport, and skill-runtime failures return AI_PROVIDER_FAILED with status 502."
  - "extractResumeAi() unwraps shared body.data for ResumeStep.applySeed() while preserving ApiError bodies for non-2xx responses."

patterns-established:
  - "Retained-skill bounded route: validate upload, save local artifact, runBoundedAI fallback with a custom Read-only skill invoke, transform body.data on success."
  - "Resume-AI label contract: skill:\"resume-extract\", action:\"resume-ai\", operation:\"onboard.resume-ai\"."
  - "No-raw schema-failure contract: AI_SCHEMA_INVALID responses expose validation metadata only, never raw model text."

requirements-completed:
  - AIR-01
  - AIR-02
  - AIR-03

coverage:
  - id: D1
    description: "Resume-AI success uses the shared bounded AI envelope with seed data under body.data and exact labels."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/onboard-route.test.mjs#POST /api/onboard/resume-ai happy path"
        status: pass
      - kind: other
        ref: "node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Resume-AI schema exhaustion returns AI_SCHEMA_INVALID with manual fallback metadata and no raw model output."
    requirement: AIR-02
    verification:
      - kind: unit
        ref: "tests/onboard-route.test.mjs#POST /api/onboard/resume-ai 422s when the model never produces valid structured output"
        status: pass
      - kind: other
        ref: "node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Resume-AI true no-AI configuration returns NO_AI_ROUTE 501 while SDK/provider/runtime failures return AI_PROVIDER_FAILED 502."
    requirement: AIR-03
    verification:
      - kind: unit
        ref: "tests/onboard-route.test.mjs#POST /api/onboard/resume-ai no-AI and provider failure tests"
        status: pass
      - kind: other
        ref: "node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D4
    description: "Resume extraction keeps the resume-extract skill runtime constrained to tools:[\"Read\"]."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/onboard-route.test.mjs#POST /api/onboard/resume-ai keeps resume-extract constrained to the Read tool surface"
        status: pass
      - kind: other
        ref: "node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D5
    description: "extractResumeAi() returns the seed object shape consumed by ResumeStep.applySeed() and preserves ApiError bodies on failures."
    requirement: AIR-03
    verification:
      - kind: unit
        ref: "tests/onboard-route.test.mjs#extractResumeAi unwraps shared success envelope data for ResumeStep.applySeed()"
        status: pass
      - kind: unit
        ref: "tests/onboard-route.test.mjs#extractResumeAi preserves ApiError body for shared error envelopes"
        status: pass
      - kind: other
        ref: "node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false

duration: 3 min
completed: 2026-07-04
status: complete
---

# Phase 02 Plan 06: Resume-AI Shared Envelope Migration Summary

**Resume-AI uploads now use the shared bounded AI envelope while retaining the read-only resume-extract skill adapter**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-04T22:24:35Z
- **Completed:** 2026-07-04T22:28:03Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments

- Migrated `POST /api/onboard/resume-ai` from route-local `runStructuredOneshot()` response mapping to `runBoundedAI()` in fallback mode.
- Preserved the retained `runSkillStream({ skill:"resume-extract", tools:["Read"] })` adapter inside the custom invoke so PDF/image extraction can read the saved upload.
- Returned success data under `body.data` with `profileSeed`, `evidenceSeed`, `sections`, `targetingSeed`, and `source:"ai"`, plus bounded `ai` and `manual` metadata.
- Removed raw assistant text from schema-failure responses and mapped only true missing AI config to `NO_AI_ROUTE` 501; provider/runtime failures now use `AI_PROVIDER_FAILED` 502.
- Updated `extractResumeAi()` so `ResumeStep.applySeed()` still receives the original top-level seed object shape.

## TDD Gate Compliance

- **RED:** `0da959a` - `test(02-06): add failing resume AI envelope tests`
- **GREEN:** `2081612` - `feat(02-06): route resume AI through bounded envelope`
- **REFACTOR:** No refactor commit needed; post-green review found the implementation scoped to the planned route migration and all verification stayed green.

## Task Commits

1. **Task 1 RED: TDD resume-AI route envelope and no-raw failure** - `0da959a` (test)
2. **Task 1 GREEN: TDD resume-AI route envelope and no-raw failure** - `2081612` (feat)

**Plan metadata:** pending final docs/state commit.

## Files Created/Modified

- `src/cli/onboard-route.mjs` - Calls `runBoundedAI()` with resume-extract labels/manual metadata, preserves upload validation, binary save, DB artifact registration, `normalizeTargetingSeed()`, and Read-only skill invocation.
- `tests/onboard-route.test.mjs` - Adds RED/GREEN coverage for shared success envelopes, schema failure without raw leakage, no-AI 501, provider/runtime 502, Read-tool preservation, and web wrapper unwrapping.
- `apps/web/src/lib/api.js` - Unwraps `body.data` on successful resume-AI uploads while preserving `ApiError` bodies on non-2xx responses.

## Verification

- RED verification: `node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs` failed before implementation with 44 passing and 11 failing tests for legacy top-level response fields, raw schema-failure output, old 501/500 error mapping, and wrapper envelope return.
- GREEN verification: `node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs` passed with 55/55 tests.
- Final verification: `node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs` passed with 55/55 tests after commits.
- TDD gate check: `git log --oneline --grep="^test(02-06)" --grep="^feat(02-06)" --grep="^refactor(02-06)" --all` found RED and GREEN commits in order.

## Decisions Made

- `POST /api/onboard/resume-ai` uses `runBoundedAI()` in fallback mode because this route still needs a custom `resume-extract` skill invocation with file `Read`.
- Success transforms validated model output into route-specific seed data under `body.data` after the bounded helper returns, rather than exposing raw model schema fields directly to the browser.
- `extractResumeAi()` owns the UI compatibility boundary by unwrapping successful shared envelopes for `ResumeStep.applySeed()`.
- SDK, allowlist, provider, proxy, timeout, transport, and skill-runtime failures are provider/runtime failures for this route, not no-AI configuration failures.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Scoped resume-AI envelope unwrap to the raw-upload wrapper**
- **Found during:** Task 1 GREEN verification
- **Issue:** The first implementation attempt added generic `body.data` unwrapping in shared `apiFetch()`, which would have changed other client wrappers such as `suggestAssist()`.
- **Fix:** Moved the unwrap into `extractResumeAi()` only, preserving shared `apiFetch()` behavior for other endpoints.
- **Files modified:** `apps/web/src/lib/api.js`
- **Verification:** `node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs` passed with 55/55 tests.
- **Committed in:** `2081612`

---

**Total deviations:** 1 auto-fixed (1 bug).
**Impact on plan:** The auto-fix kept the implementation inside the requested route-wrapper scope and prevented unrelated API wrapper behavior changes.

## Issues Encountered

- The first GREEN run passed all route assertions but failed the new `extractResumeAi()` unwrap test, exposing that the unwrap had been placed at the wrong abstraction boundary. It was fixed before the GREEN commit.

## Known Stubs

None. Stub-pattern scan matched raw-upload/raw-text terminology, test fixtures, and existing nullable/default handling, not unfinished UI/data stubs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 02-07. The final named bounded consumer route now uses the shared helper/envelope pattern while preserving its retained read-only skill runtime adapter.

## Self-Check: PASSED

- Modified files exist: `src/cli/onboard-route.mjs`, `tests/onboard-route.test.mjs`, `apps/web/src/lib/api.js`.
- Summary file exists: `.planning/phases/02-bounded-ai-foundation/02-06-SUMMARY.md`.
- TDD commits exist: `0da959a`, `2081612`.
- Required verification passed: `node --test tests/onboard-route.test.mjs tests/bounded-ai.test.mjs`.
- No tracked files were deleted by task commits.
- Pre-existing dirty files `tests/release-safety.test.mjs` and `tmp-skill-conversion/` were not staged or modified by this plan.

---
*Phase: 02-bounded-ai-foundation*
*Completed: 2026-07-04*
