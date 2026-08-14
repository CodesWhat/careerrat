---
phase: 08-deep-ingest-lane
plan: 02
subsystem: database
tags: [sqlite, node-test, cli, deep-ingest, candidate-readiness]

requires:
  - phase: 08-deep-ingest-lane
    provides: Plan 08-01 RED contracts for SQLite Deep ingest migration, verbs, and terminal lane readiness.
provides:
  - SQLite migration 008 for Deep ingest source, chunk, proposal, lane, story, voice, honesty-boundary, and role-signal state.
  - Deep ingest DB verbs for sources, proposals, expected-version decisions, confirmations, lane states, and aggregate state reads.
  - `careerrat data deep-ingest` CLI commands for state, source, proposal, decision, confirmation, and lane operations.
  - Candidate readiness now derives `deep_ingest_complete` from terminal Deep ingest lane states.
affects: [08-03-source-scanner-routes, 08-04-bounded-proposals, 08-06-deep-ingest-ui, 08-08-readiness]

tech-stack:
  added: []
  patterns:
    - JSON table migrations with generated columns and indexes for queryable SQLite state.
    - Queue/proposal DB verbs use `requireDb` plus `withTransaction` without tracker export side effects.
    - Proposal decisions require expected versions and return conflict errors before mutation.

key-files:
  created:
    - src/core/db/migrations/008-deep-ingest.mjs
    - src/core/db/verbs/deep-ingest.mjs
  modified:
    - src/core/db/migrations.mjs
    - src/core/db/verbs/candidate.mjs
    - src/core/db/verbs/index.mjs
    - src/cli/data.mjs
    - tests/deep-ingest-db.test.mjs

key-decisions:
  - "Deep ingest source/proposal/lane writes are SQLite product workflow state and intentionally do not export tracker/activity compatibility files."
  - "Deep ingest completion is terminal-lane driven: completed, deferred, or not_available for every required lane."
  - "Confirmed proposal writes are explicit and narrow; unconfirmed/deferred/rejected proposals do not promote trusted candidate facts."

patterns-established:
  - "Deep ingest generated columns include status/lane/target/source/update fields for route and UI query paths."
  - "Deep ingest proposal decisions require `expectedVersion`; stale decisions throw `VERSION_CONFLICT` before mutation."
  - "Candidate readiness reads Deep ingest lane state from SQLite rather than candidate compatibility files."

requirements-completed: [ING-02, ING-04]

coverage:
  - id: D1
    description: "Migration 008 creates JSON-valid Deep ingest tables with generated query columns, enum guards, and indexes after sourcing-runs."
    requirement: ING-02
    verification:
      - kind: integration
        ref: "node --test tests/deep-ingest-db.test.mjs tests/db-migrations.test.mjs tests/db-verbs.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Deep ingest DB verbs persist sources, proposals, expected-version decisions, lane states, confirmed outputs, and aggregate state reads without tracker export side effects."
    requirement: ING-02
    verification:
      - kind: integration
        ref: "node --test tests/deep-ingest-db.test.mjs tests/db-migrations.test.mjs tests/db-verbs.test.mjs"
        status: pass
      - kind: other
        ref: "CLI smoke: data deep-ingest source/proposal/decide/lane/state"
        status: pass
    human_judgment: false
  - id: D3
    description: "Deep ingest terminal lane state drives candidate `deep_ingest_complete` readiness independently from search readiness and candidate compatibility files."
    requirement: ING-04
    verification:
      - kind: integration
        ref: "tests/deep-ingest-db.test.mjs#deep_ingest_complete is computed only from terminal lane states and stays independent from search readiness"
        status: pass
      - kind: integration
        ref: "tests/db-verbs.test.mjs#candidate setup computes deep_ingest_complete from terminal Deep ingest lanes, not candidate files"
        status: pass
    human_judgment: false

duration: 7 min
completed: 2026-07-06
status: complete
---

# Phase 08 Plan 02: SQLite Deep Ingest State Summary

**SQLite-native Deep ingest source, proposal, lane, and readiness state with DB verbs and CLI access**

## Performance

- **Duration:** 7 min
- **Started:** 2026-07-06T00:59:57Z
- **Completed:** 2026-07-06T01:06:57Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- Added migration 008 after `sourcing-runs`, creating Deep ingest source, chunk, proposal, lane-state, story-bank, writing-voice, honesty-boundary, and role-signal tables with JSON checks, generated columns, enum guards, and indexes.
- Implemented Deep ingest DB verbs for creating/listing/getting sources, putting proposals, expected-version decision conflicts, explicit confirmation, lane terminality, and full SQLite state reads.
- Added `careerrat data deep-ingest` CLI commands and wired candidate readiness so `deep_ingest_complete` is driven by terminal lane state rather than candidate files.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED contracts for SQLite Deep ingest state** - `4bfb92d` (test)
2. **Task 2: GREEN migration and DB verbs, then run the blocking schema gate** - `dd9623a` (feat)

_Note: TDD gate compliance passed: RED commit `4bfb92d` precedes GREEN commit `dd9623a`; no refactor commit was needed._

## Files Created/Modified

- `src/core/db/migrations/008-deep-ingest.mjs` - Defines Deep ingest SQLite tables, generated columns, enum constraints, and indexes.
- `src/core/db/migrations.mjs` - Registers migration 008 after migration 007.
- `src/core/db/verbs/deep-ingest.mjs` - Adds Deep ingest source/proposal/lane/state DB verbs.
- `src/core/db/verbs/index.mjs` - Exports Deep ingest verbs from the DB verb barrel.
- `src/core/db/verbs/candidate.mjs` - Computes `deep_ingest_complete` from terminal Deep ingest lane state.
- `src/cli/data.mjs` - Adds `careerrat data deep-ingest` commands.
- `tests/deep-ingest-db.test.mjs` - Extends RED/GREEN schema, lane status, conflict, and readiness coverage.

## Verification

- `bash -lc 'node --test tests/deep-ingest-db.test.mjs tests/db-migrations.test.mjs; test $? -ne 0'` passed for RED. Underlying tests failed as intended on missing migration 008, missing Deep ingest tables, and missing `src/core/db/verbs/deep-ingest.mjs`.
- `node --test tests/deep-ingest-db.test.mjs tests/db-migrations.test.mjs tests/db-verbs.test.mjs` passed after implementation: 35 tests passed.
- CLI smoke passed for `data deep-ingest source create`, `proposal put`, `decide`, `lane`, and `state` against a temporary SQLite database.
- Biome check passed for all touched source/test files.

## Decisions Made

- Deep ingest source/proposal/lane writes are workflow state, not tracker-visible domain outcomes; they do not bump tracker meta or export generated tracker/activity files.
- Proposal confirmation is explicit and narrow. Evidence confirmation writes candidate evidence; deferred/rejected/unconfirmed proposals remain proposal state only.
- Terminal lane completion uses the Phase 8 decision set: every required lane must be `completed`, `deferred`, or `not_available`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added candidate readiness bridge**
- **Found during:** Task 2 (GREEN migration and DB verbs)
- **Issue:** The plan required lane terminality to be readable by candidate setup readiness, but `src/core/db/verbs/candidate.mjs` was not in the declared Task 2 file list.
- **Fix:** Updated candidate readiness to compute `deep_ingest_complete` from SQLite Deep ingest lane states.
- **Files modified:** `src/core/db/verbs/candidate.mjs`
- **Verification:** `node --test tests/deep-ingest-db.test.mjs tests/db-migrations.test.mjs tests/db-verbs.test.mjs`
- **Committed in:** `dd9623a`

**2. [Rule 1 - Bug] Fixed null-prototype SQLite row assertion**
- **Found during:** Task 2 (GREEN verification)
- **Issue:** Once migration 008 existed, a RED test compared a `node:sqlite` null-prototype row object with a plain object using `deepStrictEqual`.
- **Fix:** Changed the assertion to compare scalar `[id, name]` values.
- **Files modified:** `tests/deep-ingest-db.test.mjs`
- **Verification:** `node --test tests/deep-ingest-db.test.mjs tests/db-migrations.test.mjs tests/db-verbs.test.mjs`
- **Committed in:** `dd9623a`

---

**Total deviations:** 2 auto-fixed (1 Rule 2, 1 Rule 1)
**Impact on plan:** Both fixes were necessary to satisfy the planned SQLite-native readiness and verification contract. No unrelated runtime scope was added.

## Issues Encountered

- Initial GREEN verification failed on the SQLite row object assertion above; fixed and reran the full gate successfully.
- Unrelated workspace changes remained unstaged: `.planning/research/` and `.planning/phases/CAREERRAT-API-09-public-company-intelligence-and-scanner-cascade/09-UI-SPEC.md`.

## Known Stubs

None. Stub-pattern scan only matched expected empty accumulator/default patterns and the literal `not_available` lane terminal status.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 08-03. The SQLite schema and DB verb slice are green, so source scanner/routes can now persist Deep ingest sources and proposal outcomes against the new DB surface.

## Self-Check

PASSED.

- Found `src/core/db/migrations/008-deep-ingest.mjs`.
- Found `src/core/db/verbs/deep-ingest.mjs`.
- Found `src/core/db/migrations.mjs`.
- Found `src/core/db/verbs/index.mjs`.
- Found `src/core/db/verbs/candidate.mjs`.
- Found `src/cli/data.mjs`.
- Found `tests/deep-ingest-db.test.mjs`.
- Found task commits `4bfb92d` and `dd9623a`.
- No file deletions were introduced by task commits.

---
*Phase: 08-deep-ingest-lane*
*Completed: 2026-07-06*
