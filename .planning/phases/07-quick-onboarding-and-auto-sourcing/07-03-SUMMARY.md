---
phase: 07-quick-onboarding-and-auto-sourcing
plan: 03
subsystem: testing
tags: [red-contracts, onboarding, sourcing, react, vitest, node-test]

requires:
  - phase: 07-quick-onboarding-and-auto-sourcing
    provides: "Phase 7 context, research, validation, and prior RED contracts for DOCX intake and sourcing run routes"
provides:
  - "RED candidate setup tests for staged search/gate/apply readiness and document format defaults"
  - "RED FinishStep tests for first-search task states, cadence persistence, and local first-run start behavior"
  - "RED JobsPage tests for DB-gated manual Search jobs action and local manual sourcing route"
affects:
  - "07-04 deterministic DOCX/default implementation"
  - "07-07 first-search onboarding UI implementation"
  - "07-08 Jobs page manual search implementation"

tech-stack:
  added: []
  patterns:
    - "RED contract tests use wrapper commands that pass only when targeted suites fail against current production."
    - "React component contracts continue to use Vitest with renderToStaticMarkup and explicit API wrapper checks."

key-files:
  created:
    - apps/web/src/jobs/JobsPage.test.jsx
  modified:
    - tests/candidate-setup.test.mjs
    - apps/web/src/onboarding/steps/FinishStep.test.jsx
    - apps/web/src/pages/SetupReadinessCard.test.jsx

key-decisions:
  - "Plan 07-03 remained test-only and intentionally RED; implementation is left to later Phase 7 plans."
  - "First-search UI contracts replace discovery-chat quick-start expectations with local sourcing-run expectations."
  - "Document format contracts use form-defaults.document_formats.default_packet_format and required_export_formats."

patterns-established:
  - "First-search route wrappers must target /api/sourcing/first-run/start and /api/sourcing/search/start, not chat or skill runtime routes."
  - "JobsPage manual rerun tests assert PageScaffold header actions are DB-source-setup gated."

requirements-completed:
  - ONB-02
  - ONB-01
  - RUN-02

coverage:
  - id: D1
    description: "Staged candidate readiness stays search-ready without compensation while document format defaults/schema expectations are RED."
    requirement: ONB-01
    verification:
      - kind: unit
        ref: "bash -lc 'node --test tests/candidate-setup.test.mjs; node_status=$?; npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/pages/SetupReadinessCard.test.jsx; web_status=$?; test $node_status -ne 0 -o $web_status -ne 0'"
        status: pass
    human_judgment: false
  - id: D2
    description: "FinishStep first-search task contracts cover cadence choices, default search-now behavior, durable statuses, no hidden runtime handoff tokens, and retry behavior."
    requirement: RUN-02
    verification:
      - kind: unit
        ref: "bash -lc 'node --test tests/candidate-setup.test.mjs; node_status=$?; npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/pages/SetupReadinessCard.test.jsx; web_status=$?; test $node_status -ne 0 -o $web_status -ne 0'"
        status: pass
    human_judgment: false
  - id: D3
    description: "JobsPage manual Search jobs action contracts cover DB-source gating, active-running label, and local manual sourcing wrapper behavior."
    requirement: RUN-02
    verification:
      - kind: unit
        ref: "bash -lc 'npm --workspace apps/web run test -- src/jobs/JobsPage.test.jsx; test $? -ne 0'"
        status: pass
    human_judgment: false

duration: 4 min
completed: 2026-07-05
status: complete
---

# Phase 07 Plan 03: RED First-Search UI and Readiness Contracts Summary

**RED contracts for staged onboarding readiness, first-search task state, cadence persistence, and DB-gated Jobs-page reruns.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-05T22:02:17Z
- **Completed:** 2026-07-05T22:06:33Z
- **Tasks:** 2 completed
- **Files modified:** 4

## Accomplishments

- Added candidate setup RED coverage proving `search_ready` can be true without compensation while stricter gates remain locked.
- Replaced old FinishStep discovery-chat expectations with first-search task, cadence, durable status, retry, and no-runtime-handoff RED contracts.
- Added JobsPage RED coverage for a DB-source-gated `Search jobs` header action backed by `/api/sourcing/search/start`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add staged readiness and first-search onboarding UI tests** - `dc815f6` (test)
2. **Task 2: Add RED JobsPage search action tests** - `331bb72` (test)

## Files Created/Modified

- `tests/candidate-setup.test.mjs` - Adds DB readiness and form-defaults document-format RED expectations.
- `apps/web/src/onboarding/steps/FinishStep.test.jsx` - Defines first-search task/cadence/status/retry contracts and removes old discovery-chat quick-start expectations.
- `apps/web/src/pages/SetupReadinessCard.test.jsx` - Adds first-search checklist-context status coverage.
- `apps/web/src/jobs/JobsPage.test.jsx` - New RED tests for Jobs page manual search action and local sourcing wrapper behavior.

## Decisions Made

- Plan 07-03 is intentionally test-only; no production code was changed.
- First-search onboarding UI is specified as local deterministic sourcing state, not discovery chat or retained skill runtime.
- JobsPage repeat search is specified as a header action gated by DB source setup.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope change; all changes are RED contract tests for later implementation plans.

## Issues Encountered

- `state.advance-plan` could not parse this project's STATE plan counters; `state.update-progress`, session, metric, and roadmap helpers were still applied.
- `requirements.mark-complete` found no checkbox rows for `ONB-02`, `ONB-01`, or `RUN-02`, so `REQUIREMENTS.md` stayed unchanged.
- `roadmap.update-plan-progress` and `state.update-progress` left two metadata formatting/count issues, which were corrected before the final metadata commit.

## Known Stubs

None. Stub-pattern scan only matched existing placeholder-lint test names/comments in `tests/candidate-setup.test.mjs`.

## Authentication Gates

None.

## Verification

- PASS: `bash -lc 'node --test tests/candidate-setup.test.mjs; node_status=$?; npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/pages/SetupReadinessCard.test.jsx; web_status=$?; test $node_status -ne 0 -o $web_status -ne 0'`
- PASS: `bash -lc 'npm --workspace apps/web run test -- src/jobs/JobsPage.test.jsx; test $? -ne 0'`

Both commands passed the RED wrapper contract by confirming the new tests fail against current production.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Phase 7 implementation plans to make these RED contracts green, especially form-defaults document-format defaults, first-search onboarding UI, and JobsPage manual sourcing reruns.

## Self-Check: PASSED

- Found summary file and all created/modified test files.
- Found task commits `dc815f6` and `331bb72`.
- Coverage metadata classified successfully with all three deliverables auto-covered by RED-wrapper verification commands.

---
*Phase: 07-quick-onboarding-and-auto-sourcing*
*Completed: 2026-07-05*
