---
phase: ROL-API-06-canonical-db-app-shell
plan: "02"
subsystem: testing
tags: [packet-route, db-source-of-truth, red-coverage, app-shell]

requires:
  - phase: ROL-API-06-canonical-db-app-shell
    provides: Phase 6 context decisions D-04 through D-06 and validation map entry 06-W0-03
  - phase: 06-01
    provides: Wave 0 RED coverage convention for DB app shell regressions
provides:
  - RED packet route coverage requiring packet list and detail rows to come from SQLite-seeded applications
  - RED fail-closed coverage requiring packet list/detail routes to return 409 when the database is absent
  - Preserved artifact behavior coverage for path-safe files, inline text, terminal rows with artifacts, and NEEDS YOU counts
affects: [canonical-db-app-shell, packet-route, generated-export-boundary, phase-06-wave-1]

tech-stack:
  added: []
  patterns:
    - Packet route fixtures seed SQLite with importFromTracker from fixture-source/tracker.json
    - RED route verification wraps the failing packet test with `test $? -ne 0`

key-files:
  created:
    - .planning/phases/ROL-API-06-canonical-db-app-shell/06-02-SUMMARY.md
  modified:
    - tests/packet-route.test.mjs

key-decisions:
  - "Wave 0 packet route coverage stays test-only and RED against the current tracker-export-backed implementation."
  - "Packet fixtures seed SQLite through importFromTracker while asserting workspace/tracker.json is absent from the temp runtime workspace."

patterns-established:
  - "DB-only route RED fixtures may use a separate fixture-source/tracker.json as import input while keeping generated workspace/tracker.json absent."
  - "Packet route no-database behavior is specified as fail-closed HTTP 409 with database setup guidance."

requirements-completed:
  - APP-02
  - APP-03

coverage:
  - id: D1
    description: "Packet list and detail tests require DB-seeded application rows while preserving gated-row, terminal-artifact, inline-artifact, traversal-null, and NEEDS YOU behavior."
    requirement: APP-02
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/packet-route.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D2
    description: "Packet list and detail missing-state tests require HTTP 409 database setup failures instead of tracker-file 404 fallback."
    requirement: APP-03
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/packet-route.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false

duration: 1 min
completed: 2026-07-05
status: complete
---

# Phase 06 Plan 02: Packet Route DB RED Coverage Summary

**Packet route RED tests now require DB-derived application rows and fail-closed database setup behavior before packet route migration begins.**

## Performance

- **Duration:** 1 min
- **Started:** 2026-07-05T16:41:21Z
- **Completed:** 2026-07-05T16:42:16Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Updated `tests/packet-route.test.mjs` so standard packet fixtures import application rows into SQLite through `importFromTracker({ repoRoot, sourceDir })` from a separate `fixture-source/tracker.json`.
- Added an assertion that the temp runtime workspace has no generated `workspace/tracker.json`, ensuring the test cannot pass through the old storage-adapter export path.
- Changed packet list/detail missing-state expectations from tracker-file 404 behavior to fail-closed HTTP 409 database setup behavior.

## Task Commits

1. **Task 1: Rewrite packet tests for DB-derived application rows** - `e29fdf7` (test)

**Plan metadata:** recorded in this summary commit.

## Files Created/Modified

- `tests/packet-route.test.mjs` - DB-seeded RED route contract for packet list/detail behavior.
- `.planning/phases/ROL-API-06-canonical-db-app-shell/06-02-SUMMARY.md` - Plan execution summary and coverage metadata.

## Decisions Made

- Kept this Wave 0 plan test-only; no production route files were changed.
- Seeded route fixtures through the existing DB import path instead of inventing a packet-specific DB fixture writer.
- Preserved the existing artifact path safety, inline artifact, terminal status, and `needsYouCount` assertions while changing only the application-row source contract.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

None. The RED contract failed for the intended current-source reason: `src/cli/packet-route.mjs` still reads the storage adapter tracker export.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. This plan updated route regression tests only and introduced no UI-rendered placeholder data or incomplete runtime behavior.

## Threat Flags

None. This plan added test-only DB seeding and assertions; it introduced no new endpoint, auth path, schema, file-access production behavior, or runtime trust boundary.

## Verification

- Packet route RED command: PASS - `node --test tests/packet-route.test.mjs` failed against current tracker-export route behavior, so `test $? -ne 0` passed.
- Acceptance scan: PASS - the old helper that wrote `workspace/tracker.json` as the packet route data source is gone, the test imports with `importFromTracker`, and the missing DB assertions expect 409.
- Pre-commit hooks: PASS - lefthook structure guards passed and Biome formatted/checked `tests/packet-route.test.mjs`.

## Acceptance Criteria

- Tests no longer write `workspace/tracker.json` into the temp repo as the packet route's data source - PASS.
- DB-seeded packet list still asserts gated applications, terminal applications with artifacts, inline artifacts, traversal-to-null behavior, and `needsYouCount` - PASS.
- Missing DB assertions expect HTTP 409 and database setup guidance - PASS.
- RED tests fail against current `src/cli/packet-route.mjs` because it reads the storage adapter tracker export - PASS.

## Next Phase Readiness

Plan 06-02 is complete. Phase 6 Wave 0 can continue with 06-03 source setup, scanner context, and scanner seen-set RED coverage before Wave 1 implementation.

## Self-Check: PASSED

- Verified `tests/packet-route.test.mjs` exists.
- Verified `.planning/phases/ROL-API-06-canonical-db-app-shell/06-02-SUMMARY.md` exists.
- Verified task commit `e29fdf7` exists in git history.
- Verified the plan-level RED wrapper command passes.

---
*Phase: ROL-API-06-canonical-db-app-shell*
*Completed: 2026-07-05*
