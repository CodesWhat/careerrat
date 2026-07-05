---
phase: 07-quick-onboarding-and-auto-sourcing
plan: 08
subsystem: ui
tags: [react, vitest, node-test, sourcing, onboarding, regression]

requires:
  - phase: 07-07
    provides:
      - First-search onboarding UI task and deep-interview handoff separation
provides:
  - Jobs page manual repeat search action gated by DB source setup
  - Slice-scoped no-hidden-runtime regression guard for quick onboarding and auto-sourcing
  - Phase 7 backend/frontend/static verification rollup evidence
affects: [jobs-page, onboarding, sourcing-runs, source-config, verification]

tech-stack:
  added: []
  patterns:
    - PageScaffold header action gated by DB source readiness
    - Slice-scoped static source guards for retained-runtime boundaries

key-files:
  created:
    - tests/quick-onboarding-auto-sourcing-regression.test.mjs
  modified:
    - apps/web/src/lib/api.js
    - apps/web/src/jobs/JobsPage.jsx
    - apps/web/src/jobs/JobsPage.test.jsx

key-decisions:
  - "Jobs-page repeat search uses POST /api/sourcing/search/start through startSearchRun(), keeping manual reruns deterministic and outside chat/discovery/skill/browser runtime paths."
  - "The static regression guard is source-slice scoped so explicit retained chat/deep-interview routes elsewhere in the app remain allowed."
  - "Task 3 was recorded with a verification-only empty commit because the task changed no source files after executing the required rollups."

patterns-established:
  - "Manual Jobs search: show the PageScaffold action only after DB source setup exists; otherwise render a concise setup hint."
  - "Regression guards: scan first-search/manual-search slices for forbidden runtime handoff tokens instead of whole files that intentionally retain other routes."

requirements-completed: [ONB-01, RUN-01, RUN-02]

coverage:
  - id: D1
    description: "Jobs page exposes manual repeat search only after DB source setup exists, disables while running, and surfaces errors inline."
    requirement: RUN-02
    verification:
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/jobs/JobsPage.test.jsx"
        status: pass
      - kind: automated_ui
        ref: "apps/web/src/jobs/JobsPage.test.jsx#JobsPage manual search action"
        status: pass
    human_judgment: false
  - id: D2
    description: "First-search and manual-search paths are guarded against hidden chat, discovery, skill runtime, or browser/auth escalation."
    requirement: RUN-01
    verification:
      - kind: unit
        ref: "node --test tests/quick-onboarding-auto-sourcing-regression.test.mjs"
        status: pass
      - kind: integration
        ref: "node --test tests/onboard-route.test.mjs tests/search-route.test.mjs tests/scan-sourced.test.mjs tests/db-migrations.test.mjs tests/sourcing-runs.test.mjs tests/sourcing-route.test.mjs tests/quick-onboarding-auto-sourcing-regression.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Quick onboarding records search posture/cadence and can start local sourcing before deep ingest or application-gate completion."
    requirement: ONB-01
    verification:
      - kind: integration
        ref: "tests/onboard-route.test.mjs#POST /api/onboard/quick-start"
        status: pass
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/pages/SetupReadinessCard.test.jsx"
        status: pass
    human_judgment: false
  - id: D4
    description: "DOCX remains deterministic raw-text intake while PDF stays the default packet format and DOCX export is optional."
    requirement: ONB-02
    verification:
      - kind: unit
        ref: "node --test tests/quick-onboarding-auto-sourcing-regression.test.mjs#DOCX onboarding remains raw-text only and candidate setup covers export formats"
        status: pass
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/ResumeStep.test.jsx"
        status: pass
    human_judgment: false
  - id: D5
    description: "Full npm test gate passes after updating the company discovery cache test for the latest migration version."
    verification:
      - kind: integration
        ref: "npm test"
        status: pass
      - kind: integration
        ref: "node --test tests/company-discovery-cache-db.test.mjs"
        status: pass
    human_judgment: false

duration: 7m44s
completed: 2026-07-05
status: complete
---

# Phase 07 Plan 08: Jobs Manual Search and Regression Rollup Summary

**Jobs-page manual deterministic search through `/api/sourcing/search/start` with slice-scoped Phase 7 no-hidden-runtime guards.**

## Performance

- **Duration:** 7m44s
- **Started:** 2026-07-05T23:03:47Z
- **Completed:** 2026-07-05T23:11:31Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Added the Jobs page `Search jobs` header action, gated on DB source setup and disabled as `Searching...` while a manual run is active.
- Added `getSearchSources()` and wired Jobs manual reruns to `startSearchRun({ purpose: "manual-search" })`, which calls local `POST /api/sourcing/search/start`.
- Added `tests/quick-onboarding-auto-sourcing-regression.test.mjs` to guard first/manual search against hidden chat/discovery/skill/browser runtime handoffs, enforce DB source-config readiness, and preserve deterministic DOCX raw-text parsing.
- Ran the Phase 7 targeted backend/frontend/static rollups and the full `npm test` gate; after updating a stale company-discovery migration-version expectation for migration 007, the full suite passes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add JobsPage manual search action** - `db9839f` (test RED), `53f634c` (feat GREEN)
2. **Task 2: Add final no-hidden-runtime regression gate** - `cc49d37` (test)
3. **Task 3: Run Phase 7 targeted verification rollup** - `021fd76` (test, verification-only empty commit)

_Note: Task 1 followed the TDD RED/GREEN sequence required by the plan._

## Files Created/Modified

- `apps/web/src/lib/api.js` - Adds `getSearchSources()` for `GET /api/search/sources`; existing `startSearchRun()` remains the manual search wrapper for `/api/sourcing/search/start`.
- `apps/web/src/jobs/JobsPage.jsx` - Adds DB-source-gated header action, source setup hint, running state, and inline manual-search error handling.
- `apps/web/src/jobs/JobsPage.test.jsx` - Covers source-ready, no-source, running, error, API wrapper, and click-helper behavior.
- `tests/quick-onboarding-auto-sourcing-regression.test.mjs` - Adds static and source-slice regression checks for Phase 7 deterministic boundaries.

## Decisions Made

- Jobs manual reruns stay on the local deterministic sourcing API, not chat, discovery, browser/auth capture, or retained full skill runtime.
- The static guard intentionally scans only first-search/manual-search slices because explicit `/chat` and retained runtime surfaces still exist elsewhere for separate user-selected workflows.
- A verification-only empty commit was used for Task 3 so the plan still has an atomic commit for every task without staging unrelated files.

## Requirement Evidence

| Requirement | Evidence |
| --- | --- |
| ONB-01 | FinishStep cadence and quick-start route tests passed in the targeted backend/frontend rollups. |
| ONB-02 | DOCX raw-text/static regression, ResumeStep tests, and candidate setup document-format assertions passed. |
| RUN-01 | Static regression and route tests prove first/manual search avoids hidden chat/discovery/skill/browser runtime paths. |
| RUN-02 | JobsPage tests pass for DB-source-gated manual action, running label, setup hint, and inline error handling. |

## Verification

- `npm --workspace apps/web run test -- src/jobs/JobsPage.test.jsx` - passed, 7 tests.
- `npm exec -- biome check apps/web/src/jobs/JobsPage.jsx apps/web/src/jobs/JobsPage.test.jsx apps/web/src/lib/api.js` - passed.
- `node --test tests/quick-onboarding-auto-sourcing-regression.test.mjs` - passed, 5 tests.
- `npm exec -- biome check tests/quick-onboarding-auto-sourcing-regression.test.mjs` - passed after formatter write.
- `node --test tests/onboard-route.test.mjs tests/search-route.test.mjs tests/scan-sourced.test.mjs tests/db-migrations.test.mjs tests/sourcing-runs.test.mjs tests/sourcing-route.test.mjs tests/quick-onboarding-auto-sourcing-regression.test.mjs` - passed, 106 tests.
- `npm --workspace apps/web run test -- src/onboarding/steps/ResumeStep.test.jsx src/onboarding/steps/FinishStep.test.jsx src/pages/SetupReadinessCard.test.jsx src/jobs/JobsPage.test.jsx` - passed, 31 tests across 4 files.
- `node --test tests/company-discovery-cache-db.test.mjs` - passed, 4 tests.
- `npm test` - passed, 1695 passing, 0 failing, 4 skipped.

## Blocking Verification Gaps

None. The stale migration-version expectation in `tests/company-discovery-cache-db.test.mjs` was updated to compare fully migrated DBs against `ALL_MIGRATIONS.at(-1).id` while still verifying migration 006 is logged as `company-discovery-cache`.

## Deviations from Plan

None - plan executed as written. The only non-source-code commit was the planned verification rollup task, recorded as an empty commit because the task's work was command execution and evidence capture.

## Issues Encountered

- The first draft of the new static regression test had helper false positives around destructured function parameters and multiline calls. The test helper was corrected before the Task 2 commit, and the isolated regression plus Biome check passed.
- The full `npm test` gate initially exposed a stale company-discovery cache version expectation; that test now follows the latest migration registry and the full suite passes.

## Known Stubs

None. Stub-pattern scan hits in the touched files were optional parameter defaults or test fixture defaults, not UI-rendered placeholder data.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 7's targeted quick-onboarding and auto-sourcing evidence is in place, and the full-suite gate is clean.

## Self-Check: PASSED

- Found summary file: `.planning/phases/07-quick-onboarding-and-auto-sourcing/07-08-SUMMARY.md`
- Found task commit: `db9839f`
- Found task commit: `53f634c`
- Found task commit: `cc49d37`
- Found task commit: `021fd76`

---
*Phase: 07-quick-onboarding-and-auto-sourcing*
*Completed: 2026-07-05*
