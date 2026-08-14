---
phase: 07-quick-onboarding-and-auto-sourcing
plan: 02
subsystem: testing
tags: [node-test, sqlite, sourcing-runs, search-route, first-search]

requires:
  - phase: 06-canonical-db-app-shell
    provides: React `/app` and SQLite DB-derived state are canonical product paths.
provides:
  - RED migration and DB verb contracts for durable sourcing run state.
  - RED route contracts for first-search start/latest state and manual search start.
  - RED deterministic source-count coverage for RSS and supported ATS sources.
affects: [07-05-sourcing-run-state, 07-06-first-search-service, 07-08-manual-search]

tech-stack:
  added: []
  patterns:
    - Temp DB workspace tests for sourcing run state verbs.
    - Minimal addRoute HTTP harness for sourcing route contracts.
    - RED wrapper commands that pass only when the underlying contracts fail.

key-files:
  created:
    - tests/sourcing-runs.test.mjs
    - tests/sourcing-route.test.mjs
  modified:
    - tests/db-migrations.test.mjs
    - tests/search-route.test.mjs

key-decisions:
  - "Plan 07-02 is intentionally RED and test-only; implementation remains in later Phase 7 plans."
  - "The sourcing_runs contract requires generated JSON columns and explicit latest-purpose/running-status indexes."
  - "First-search route responses are forbidden from carrying chat, skill-runtime, or discovery-skill handoff tokens."
  - "Deterministic source counts distinguish fetchable RSS and supported ATS companies from browser/auth/url-query-only sources."

patterns-established:
  - "Durable first-search run contracts use purpose/status JSON rows with latest/start/complete/fail verbs."
  - "First-search route tests seed SQLite source config and candidate readiness directly, never compatibility YAML."
  - "Route no-runtime assertions scan response envelopes for chat, skill, and discovery handoff tokens."

requirements-completed: [RUN-01, RUN-02]

coverage:
  - id: D1
    description: "RED migration and DB verb contracts for sourcing_runs durable state, status transitions, summary/error JSON, and first-search idempotency"
    requirement: RUN-01
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/db-migrations.test.mjs tests/sourcing-runs.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D2
    description: "RED route contracts for latest first-search state, first-run start/reuse/failure, manual search start, and no hidden chat/skill runtime handoffs"
    requirement: RUN-01
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/sourcing-route.test.mjs tests/search-route.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D3
    description: "RED deterministic source-count contract for RSS and supported ATS sources excluding browser/auth/url-query-only sources"
    requirement: RUN-02
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/sourcing-route.test.mjs tests/search-route.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false

duration: 5 min
completed: 2026-07-05
status: complete
---

# Phase 07 Plan 02: Add RED Durable Sourcing Run and First-Search Route Contracts Summary

**RED SQLite run-state and first-search route contracts for deterministic, no-runtime sourcing starts**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-05T21:40:23Z
- **Completed:** 2026-07-05T21:43:36Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Extended migration coverage to require migration `007` named `sourcing-runs`, a `sourcing_runs` table with JSON `data`, generated state columns, and latest/running lookup indexes.
- Added `tests/sourcing-runs.test.mjs` with RED contracts for `sourcingRunLatest`, `sourcingRunStart`, `sourcingRunComplete`, `sourcingRunFail`, persisted summary/error JSON, and duplicate first-search idempotency.
- Added `tests/sourcing-route.test.mjs` for `GET /api/sourcing/runs/latest`, `POST /api/sourcing/first-run/start`, and `POST /api/sourcing/search/start`, including search-ready gating, zero deterministic source failure, and no chat/skill handoff tokens.
- Extended `tests/search-route.test.mjs` to require deterministic attempted source counts where enabled RSS and supported ATS companies count, while browser/auth/url-query-only sources do not.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add RED migration and run-state verb tests** - `180d9b0` (test)
2. **Task 2: Add RED first-search route tests** - `1d73f59` (test)

## Files Created/Modified

- `tests/db-migrations.test.mjs` - Requires migration 007 registration plus `sourcing_runs` schema/index details.
- `tests/sourcing-runs.test.mjs` - New RED DB verb contract coverage for durable sourcing run state.
- `tests/sourcing-route.test.mjs` - New RED addRoute-based route coverage for first-search and manual search starts.
- `tests/search-route.test.mjs` - Adds deterministic source-count expectations for DB source setup.

## Verification

- `bash -lc 'node --test tests/db-migrations.test.mjs tests/sourcing-runs.test.mjs; test $? -ne 0'` passed as a RED wrapper. Underlying result: 9 tests, 6 pass, 3 fail. Expected failures: latest migration is still `6`, `sourcing_runs` does not exist, and `src/core/db/verbs/sourcing-runs.mjs` is missing.
- `bash -lc 'node --test tests/sourcing-route.test.mjs tests/search-route.test.mjs; test $? -ne 0'` passed as a RED wrapper. Underlying result: 14 tests, 12 pass, 2 fail. Expected failures: `/api/search/sources` lacks `deterministicSources`, and `src/cli/sourcing-route.mjs` is missing.

## Decisions Made

- Kept this plan test-only and intentionally RED; no migration, DB verb, route, or scanner implementation was added.
- Defined the durable run-state contract around a JSON row with generated query columns instead of separate scalar mutation fields, matching existing DB cache/proposal patterns.
- Made first-search route tests seed SQLite source config and candidate readiness directly so compatibility files cannot satisfy product readiness.
- Required route response envelopes to omit chat, skill-runtime, and discovery-skill handoff tokens to lock the first search to deterministic local code.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. The failing underlying tests are the expected RED evidence for this plan.

## Known Stubs

None. Empty arrays/objects and `null` values introduced here are test fixtures and assertions only; they do not introduce runtime UI stubs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 07-03. Plans 07-05 and 07-06 can implement the migration, sourcing-run verbs, first-search service, and route behavior against these contracts.

## Self-Check

PASSED.

- Found `tests/db-migrations.test.mjs`.
- Found `tests/sourcing-runs.test.mjs`.
- Found `tests/sourcing-route.test.mjs`.
- Found `tests/search-route.test.mjs`.
- Found `.planning/phases/07-quick-onboarding-and-auto-sourcing/07-02-SUMMARY.md`.
- Found task commits `180d9b0` and `1d73f59`.
- Plan-level RED wrapper verification commands passed.

---
*Phase: 07-quick-onboarding-and-auto-sourcing*
*Completed: 2026-07-05*
