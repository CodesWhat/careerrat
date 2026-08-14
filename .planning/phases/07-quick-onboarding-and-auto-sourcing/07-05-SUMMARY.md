---
phase: 07-quick-onboarding-and-auto-sourcing
plan: 05
subsystem: database
tags: [sqlite, migrations, db-verbs, sourcing-runs, node-test]

requires:
  - phase: 07-quick-onboarding-and-auto-sourcing
    provides: RED durable sourcing run contracts from Plan 07-02.
provides:
  - SQLite migration 007 for durable sourcing run state.
  - DB verb state machine for first-search and manual-search sourcing runs.
  - Failed first-search retry semantics with retryOf metadata.
affects: [07-06-first-search-service, 07-07-first-search-ui, 07-08-manual-search]

tech-stack:
  added: []
  patterns:
    - JSON-backed SQLite state table with generated lookup columns.
    - Transaction-wrapped DB verbs with prepared statements and stable error codes.
    - Idempotent run start behavior for first-search duplicate starts and failed-run retry work.

key-files:
  created:
    - src/core/db/migrations/007-sourcing-runs.mjs
    - src/core/db/verbs/sourcing-runs.mjs
  modified:
    - src/core/db/migrations.mjs
    - src/core/db/verbs/index.mjs
    - tests/sourcing-runs.test.mjs

key-decisions:
  - "Store sourcing run payloads as JSON while exposing generated purpose/status/timestamp columns for reload-safe lookups."
  - "Return existing first-search rows for running, completed, and failed display states unless retryFailed:true is explicitly requested."
  - "Create failed first-search retry work as a fresh running row with metadata.retryOf pointing at the failed run."
  - "Keep stored run timestamps snake_case and return camelCase aliases for route consumers."

patterns-established:
  - "Run-state verbs read through requireDb(), mutate inside withTransaction(), and use prepared statements for every SQL operation."
  - "Run timestamps are monotonic relative to the prior row so latest-purpose reads remain deterministic inside same-millisecond tests and route calls."

requirements-completed: [RUN-01, RUN-02]

coverage:
  - id: D1
    description: "Migration 007 registers sourcing-runs after migration 006 and creates sourcing_runs with JSON data, generated lookup columns, and latest/running indexes."
    requirement: RUN-01
    verification:
      - kind: integration
        ref: "node --test tests/db-migrations.test.mjs"
        status: pass
      - kind: integration
        ref: "node --test tests/db-migrations.test.mjs tests/sourcing-runs.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sourcing run verbs provide latest/start/complete/fail behavior, duplicate first-search reuse, failed-run retry work, and persisted summary/error JSON."
    requirement: RUN-02
    verification:
      - kind: integration
        ref: "node --test tests/sourcing-runs.test.mjs"
        status: pass
      - kind: integration
        ref: "node --test tests/db-migrations.test.mjs tests/sourcing-runs.test.mjs"
        status: pass
    human_judgment: false

duration: 3 min
completed: 2026-07-05
status: complete
---

# Phase 07 Plan 05: Durable SQLite Sourcing Run State Summary

**SQLite sourcing run state with idempotent first-search starts, failed-run retry work, and persisted terminal summaries/errors**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-05T22:26:20Z
- **Completed:** 2026-07-05T22:29:54Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added migration `007` named `sourcing-runs`, registered after migration `006`, with a JSON-backed `sourcing_runs` table, generated lookup columns, and exact latest/running index names required by the Wave 0 contracts.
- Added `sourcingRunLatest`, `sourcingRunStart`, `sourcingRunComplete`, and `sourcingRunFail` DB verbs with controlled purposes/statuses, transaction-wrapped writes, prepared statements, and stable `BAD_REQUEST`, `NOT_FOUND`, and `CONFLICT` errors.
- Implemented revised failed first-search retry behavior: a failed row remains displayable by default, while `retryFailed:true` creates a new running row with `metadata.retryOf` linked to the failed run.
- Re-exported sourcing run verbs through the DB verb barrel for later route/service plans.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add sourcing_runs migration** - `f227367` (feat)
2. **Task 2: Add sourcing run verbs** - `d046af7` (feat)

## Files Created/Modified

- `src/core/db/migrations/007-sourcing-runs.mjs` - Adds the durable sourcing run table and lookup indexes.
- `src/core/db/migrations.mjs` - Registers migration 007 after migration 006.
- `src/core/db/verbs/sourcing-runs.mjs` - Implements latest/start/complete/fail sourcing run state verbs.
- `src/core/db/verbs/index.mjs` - Re-exports the new sourcing run verb surface.
- `tests/sourcing-runs.test.mjs` - Aligns the RED contract with the revised running reuse and failed retry requirements.

## Verification

- `node --test tests/db-migrations.test.mjs` - passed after Task 1.
- `node --test tests/sourcing-runs.test.mjs` - passed after Task 2.
- `node --test tests/db-migrations.test.mjs tests/sourcing-runs.test.mjs` - passed as final plan verification: 13 tests passed.
- Pre-commit hooks ran normally for both task commits; structure guards and Biome passed.

## Decisions Made

- Used a JSON payload plus generated SQLite columns so later route/UI plans can evolve run metadata without schema churn while still querying latest purpose/status efficiently.
- Returned both stored snake_case timestamps and camelCase aliases from DB verbs so existing tests and route consumers can use the same verb surface.
- Reused first-search rows for running, completed, and failed display states by default; explicit `retryFailed:true` is the only path that creates new retry work after a failed first search.
- Added monotonic timestamp generation relative to the current row to avoid same-millisecond latest-row ambiguity.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Updated stale Wave 0 first-search idempotency tests**
- **Found during:** Task 2 (Add sourcing run verbs)
- **Issue:** `tests/sourcing-runs.test.mjs` still expected a duplicate running first-search start to throw `CONFLICT`, but the plan and checkpoint require `sourcingRunStart()` to return the running row with `reused:true`.
- **Fix:** Updated the duplicate-start assertion and added failed-run retry coverage for `retryFailed:true` and `metadata.retryOf`.
- **Files modified:** `tests/sourcing-runs.test.mjs`
- **Verification:** `node --test tests/sourcing-runs.test.mjs`
- **Committed in:** `d046af7`

**2. [Rule 1 - Bug] Made latest-run ordering deterministic for same-millisecond transitions**
- **Found during:** Task 2 (Add sourcing run verbs)
- **Issue:** The failed-run retry test exposed a same-millisecond timestamp tie where latest-purpose lookup could return the failed row instead of the newly-created retry row.
- **Fix:** Added monotonic timestamp generation relative to the prior row's `updated_at` before insert/terminal updates.
- **Files modified:** `src/core/db/verbs/sourcing-runs.mjs`
- **Verification:** `node --test tests/sourcing-runs.test.mjs`
- **Committed in:** `d046af7`

---

**Total deviations:** 2 auto-fixed (1 Rule 2, 1 Rule 1)
**Impact on plan:** Both deviations preserved the revised RUN-01/RUN-02 contract. No architectural scope changed.

## Issues Encountered

The initial Task 2 RED run failed because `src/core/db/verbs/sourcing-runs.mjs` did not exist, which was the expected pre-implementation failure. The same-millisecond latest-row ambiguity was fixed before Task 2 commit.

During metadata closeout, `state.advance-plan` could not parse this project's STATE shape, `roadmap.update-plan-progress` malformed the Phase 7 overview row, and `state.update-progress` wrote `percent: 45` despite reporting 92% from 33/36 completed plans. The applicable metadata was corrected before the final docs commit.

## Known Stubs

None. The `null` values in `sourcing_runs` are meaningful run-state fields (`completed_at`, `summary`, and `error`) and do not represent UI placeholder data.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 07-06. Durable run records and DB verbs are available for first-search service/routes and React status display.

## Self-Check

PASSED.

- Found `.planning/phases/07-quick-onboarding-and-auto-sourcing/07-05-SUMMARY.md`.
- Found `src/core/db/migrations/007-sourcing-runs.mjs`.
- Found `src/core/db/verbs/sourcing-runs.mjs`.
- Found task commits `f227367` and `d046af7`.
- Re-ran `node --test tests/db-migrations.test.mjs tests/sourcing-runs.test.mjs`: 13 tests passed.

---
*Phase: 07-quick-onboarding-and-auto-sourcing*
*Completed: 2026-07-05*
