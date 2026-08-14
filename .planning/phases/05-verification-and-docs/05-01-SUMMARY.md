---
phase: 05-verification-and-docs
plan: "01"
subsystem: testing
tags: [company-discovery, regression, cost-boundary, no-ai, tdd]

requires:
  - phase: 03-company-discovery-api
    provides: company discovery seed, resolver, proposal, gate, refresh, read, and confirmed-write paths
  - phase: 04-runtime-routing
    provides: local company proposal routes, explicit chat handoffs, and retained full skill runtime boundaries
provides:
  - VER-01 regression lock proving deterministic discovery paths do not call direct AI seams
  - Static local proposal route-slice checks forbidding chat and retained full skill runtime references
  - Mounted-route refresh assertion that deterministic refresh starts no chat session
affects: [company-discovery-api, runtime-routing, verification-and-docs]

tech-stack:
  added: []
  patterns:
    - TDD regression scaffold followed by a focused static and mounted-route boundary lock
    - Source-slice assertions for route classes that intentionally coexist in one route module

key-files:
  created:
    - .planning/phases/05-verification-and-docs/05-01-SUMMARY.md
  modified:
    - tests/company-discovery-regression.test.mjs

key-decisions:
  - "Company seed generation remains the only discovery module allowed to use bounded AI; deterministic resolver, context, gate, proposal, and decision modules are statically forbidden from direct AI seams."
  - "Local company proposal create/read/decision route slices are checked separately so explicit quick-start/next chat handoff routes can remain available outside the local proposal path."

patterns-established:
  - "VER-01 cost-boundary tests assert allowed and forbidden owners, not just forbidden strings globally."
  - "Route modules with mixed local and chat behavior should be tested through narrow source slices."

requirements-completed: [VER-01]

coverage:
  - id: D1
    description: "Deterministic company discovery resolver, context, proposal gate, proposal orchestration, refresh, proposal read, and confirmed-write paths are locked against direct AI, chat, and retained full skill runtime seams."
    requirement: VER-01
    verification:
      - kind: integration
        ref: "node --test tests/company-discovery-regression.test.mjs"
        status: pass
      - kind: other
        ref: "tests/company-discovery-regression.test.mjs#VER-01 deterministic discovery paths do not call AI, chat, or retained full skill runtime"
        status: pass
    human_judgment: false

duration: 4 min
completed: 2026-07-05
status: complete
---

# Phase 05 Plan 01: Cost-Boundary Regression Lock Summary

**VER-01 regression coverage now proves deterministic company discovery paths stay local while bounded AI remains isolated to company seed generation.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-05T12:35:39Z
- **Completed:** 2026-07-05T12:39:38Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Added a purpose-named VER-01 regression that forbids `callAI(` and `runBoundedAI` outside `src/core/discovery/company-seeds.mjs`.
- Added local proposal create/read/decision route-slice assertions that forbid `runSkillStream`, `startSession`, and `/api/skill/run`.
- Strengthened the refresh regression so deterministic refresh also proves `chatRuntime.starts.length === 0`.

## Task Commits

1. **Task 1 RED: failing VER-01 cost-boundary scaffold** - `6c5dc00` (test)
2. **Task 1 GREEN: deterministic discovery boundary lock** - `3b536ca` (feat)

_Note: This was a TDD-marked regression task, so RED and GREEN were committed separately. No refactor commit was needed._

## Files Created/Modified

- `tests/company-discovery-regression.test.mjs` - Adds explicit VER-01 source-owner and route-slice assertions, plus a no-chat refresh assertion.
- `.planning/phases/05-verification-and-docs/05-01-SUMMARY.md` - Records the plan outcome and verification evidence.

## Decisions Made

- Kept the regression in the existing discovery regression file because it already owns the hermetic temp repo, fake chat runtime, and static ownership patterns for this API slice.
- Checked source slices inside `src/cli/discovery-route.mjs` instead of scanning the whole file, because explicit discovery chat handoff routes are intentionally present outside the local company proposal path.
- Left production code unchanged because the new regression lock passed against the existing implementation after replacing the RED scaffold.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The RED commit failed intentionally on the scaffold; the GREEN commit replaced it with real assertions and the focused regression command passed.
- During close-out, `roadmap.update-plan-progress` rewrote the Phase 5 overview row into a malformed table row. I corrected only that row while preserving the SDK-updated `1/5` progress and plan checkbox state.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub-pattern scanning found only normal test helper defaults, local accumulator arrays, and route-test null/default guards.

## Threat Flags

None. This plan added test-only verification and introduced no new endpoint, auth path, file-access boundary, schema, or runtime write surface.

## TDD Gate Compliance

- **RED:** `6c5dc00 test(05-01): add failing VER-01 cost-boundary regression scaffold` - `node --test tests/company-discovery-regression.test.mjs` failed only on the new scaffold.
- **GREEN:** `3b536ca feat(05-01): lock deterministic discovery cost boundaries` - `node --test tests/company-discovery-regression.test.mjs` passed with 7 tests.
- **REFACTOR:** not needed.

## Verification

- Baseline command before RED: `node --test tests/company-discovery-regression.test.mjs` - PASS (6 tests).
- RED command: `node --test tests/company-discovery-regression.test.mjs` - FAIL as expected on `VER-01 cost-boundary regression assertions are not implemented yet`.
- Final command: `node --test tests/company-discovery-regression.test.mjs` - PASS (7 tests).
- Acceptance scan: `rg -n "VER-01|callAI\\(|runBoundedAI|runSkillStream|startSession|/api/skill/run" tests/company-discovery-regression.test.mjs` - PASS (named VER-01 assertion and runtime-seam checks present).
- Source seam scan: `rg -n "runSkillStream|startSession|/api/skill/run|callAI\\(|runBoundedAI" src/core/discovery src/cli/discovery-route.mjs` - PASS (expected matches only in explicit chat handoff route and allowed company seed bounded-AI owner).

## Acceptance Criteria

- `node --test tests/company-discovery-regression.test.mjs` passes - PASS.
- `tests/company-discovery-regression.test.mjs` contains purpose-named VER-01 assertions proving deterministic discovery paths do not call AI, chat, or retained full skill runtime - PASS.
- No schema/ORM files, package dependencies, tracker exports, or `tests/release-safety.test.mjs` were touched - PASS.

## Next Phase Readiness

Plan 05-01 is complete. Plan 05-02 can build on this boundary lock to add structured-output and no-AI route negative coverage.

## Self-Check: PASSED

- Verified `tests/company-discovery-regression.test.mjs` exists.
- Verified `.planning/phases/05-verification-and-docs/05-01-SUMMARY.md` exists.
- Verified commits `6c5dc00` and `3b536ca` exist in git history.
- Verified the plan automated command exits 0 after GREEN.
- Verified task commits did not delete tracked files.

---
*Phase: 05-verification-and-docs*
*Completed: 2026-07-05*
