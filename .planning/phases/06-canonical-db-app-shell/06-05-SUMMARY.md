---
phase: 06-canonical-db-app-shell
plan: "05"
subsystem: api
tags: [packet-route, sqlite, db-source-of-truth, app-shell]

requires:
  - phase: 06-canonical-db-app-shell
    provides: Phase 6 decisions D-04 through D-06 and packet RED coverage from 06-02
  - phase: 06-04
    provides: Static DB app shell guard requiring packet route to stop using generated tracker exports
provides:
  - Packet list and detail APIs backed by DB-derived application rows
  - Fail-closed HTTP 409 missing-database responses for packet list and detail routes
  - Preserved packet artifact resolution for path-safe files, inline markdown, traversal collapse-to-null, and NEEDS YOU findings
affects: [canonical-db-app-shell, packet-route, generated-export-boundary, app-packet-review]

tech-stack:
  added: []
  patterns:
    - Packet routes call requireDb and assembleTrackerObject directly instead of reading generated tracker exports.
    - Missing DB on product packet routes returns a 409 setup envelope with ok:false.

key-files:
  created:
    - .planning/phases/06-canonical-db-app-shell/06-05-SUMMARY.md
    - .planning/phases/06-canonical-db-app-shell/deferred-items.md
  modified:
    - src/cli/packet-route.mjs

key-decisions:
  - "Packet routes reuse assembleTrackerObject(db) for the existing application/stage shape instead of inventing packet-specific DB row mapping."
  - "Missing SQLite state is a product setup error returned as HTTP 409 with ok:false, not a fallback to generated tracker.json."
  - "Artifact path safety, inline markdown handling, and NEEDS YOU extraction remain local packet-route behavior."

patterns-established:
  - "Product routes that need legacy tracker-shaped rows should assemble that shape in memory from DB, never through workspace/tracker.json."
  - "Packet route DB setup failures use the same NoDatabaseError-to-409 boundary as other DB-backed app routes."

requirements-completed:
  - APP-02
  - APP-03

coverage:
  - id: D1
    description: "Packet list and detail routes read DB-seeded applications while preserving gated row selection, terminal rows with artifacts, inline artifacts, traversal-to-null behavior, and NEEDS YOU counts."
    requirement: APP-02
    verification:
      - kind: integration
        ref: "node --test tests/packet-route.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Packet list and detail routes return HTTP 409 setup failures when SQLite is absent."
    requirement: APP-03
    verification:
      - kind: integration
        ref: "node --test tests/packet-route.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Packet route source has no storage-adapter tracker read dependency."
    requirement: APP-03
    verification:
      - kind: other
        ref: "rg 'from \"../core/storage/storage-adapter\\.mjs\"|\\.readTracker\\s*\\(|\\breadTracker\\b|\\bdefaultAdapter\\b|\\breadTrackerOrRespondError\\b|storage-adapter\\.mjs' src/cli/packet-route.mjs"
        status: pass
    human_judgment: false

duration: 1 min
completed: 2026-07-05
status: complete
---

# Phase 06 Plan 05: Packet Route DB Migration Summary

**Packet product APIs now build list and detail responses from SQLite-derived application rows instead of generated tracker exports.**

## Performance

- **Duration:** 1 min
- **Started:** 2026-07-05T17:05:22Z
- **Completed:** 2026-07-05T17:07:12Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments

- Replaced packet-route storage-adapter tracker reads with `requireDb({ repoRoot, env })` plus in-memory `assembleTrackerObject(db)` rows.
- Added `readPacketApplicationsFromDb()` as the packet route's DB-derived application/stage reader.
- Converted missing DB for `GET /api/packet/list` and `GET /api/packet?id=...` to HTTP 409 `{ ok:false, error }`.
- Preserved gated-row filtering, artifact path safety, inline artifact markdown, generated HTML, and `NEEDS YOU` findings behavior.

## Task Commits

1. **Task 1: Replace packet tracker adapter reads with DB-derived application rows** - `fc138dc` (feat)

**Plan metadata:** recorded in this summary commit.

## Files Created/Modified

- `src/cli/packet-route.mjs` - Packet routes now read DB-derived application rows, fail closed without SQLite, and keep existing artifact rendering behavior.
- `.planning/phases/06-canonical-db-app-shell/deferred-items.md` - Records the out-of-scope 06-06 static guard finding for `boards-route.mjs`.
- `.planning/phases/06-canonical-db-app-shell/06-05-SUMMARY.md` - Plan execution summary and coverage metadata.

## Decisions Made

- Reused `assembleTrackerObject(db)` rather than mapping raw SQLite JSON rows in the route. This keeps custom stage classification behavior identical to the existing tracker-shaped callers without a filesystem round-trip.
- Treated `NoDatabaseError` as the only special packet route error case; it maps to 409 while unexpected read failures remain 500.
- Left the artifact resolver local to `packet-route.mjs` because it handles stamped artifact values, inline text, traversal collapse, and `NEEDS YOU` linting independently from the data-source migration.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- The packet route RED suite failed for the expected reason before implementation: DB-seeded tests received old generated tracker-file 404 responses.
- A broader `tests/db-app-shell-regression.test.mjs` product-boundary subtest still fails on `src/cli/boards-route.mjs` reading legacy source setup files. That is expected 06-06 ownership and is recorded in `deferred-items.md`; the packet-route-specific forbidden-token scan passes.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub scan hits in `src/cli/packet-route.mjs` are comments or intentional function defaults, not UI-rendered placeholder data or unwired mock state.

## Threat Flags

None. This plan changed an existing route's data source and preserved the existing artifact path traversal collapse behavior; it introduced no new endpoint, auth path, schema change, or new file trust boundary.

## Verification

- RED check before implementation: PASS - `node --test tests/packet-route.test.mjs` failed with old 404 tracker export behavior.
- Plan verification: PASS - `node --test tests/packet-route.test.mjs`.
- Syntax verification: PASS - `node --check src/cli/packet-route.mjs`.
- Packet dependency scan: PASS - no `defaultAdapter`, `readTracker`, `readTrackerOrRespondError`, or storage-adapter import remains in `src/cli/packet-route.mjs`.
- Pre-commit hooks: PASS - lefthook structure guards passed and Biome checked `src/cli/packet-route.mjs`.

## Acceptance Criteria

- `src/cli/packet-route.mjs` has no import from `../core/storage/storage-adapter.mjs` - PASS.
- `src/cli/packet-route.mjs` does not call `readTracker` - PASS.
- `GET /api/packet/list` and `GET /api/packet?id=...` return 409 when DB is missing - PASS.
- Packet route happy-path artifact tests pass from DB-seeded rows without `workspace/tracker.json` - PASS.

## TDD Gate Compliance

The RED packet route tests were created and committed in Plan 06-02 (`e29fdf7`) as the Wave 0 contract. Plan 06-05 confirmed those tests were RED before implementation and then produced the GREEN implementation commit `fc138dc`. No separate `test(06-05)` commit was created because this plan consumes the prior Wave 0 RED contract.

## Next Phase Readiness

Plan 06-05 is complete. Wave 1 can continue with 06-06 to migrate board/source setup product writes off legacy source config files.

## Self-Check: PASSED

- Verified `src/cli/packet-route.mjs` exists.
- Verified `.planning/phases/06-canonical-db-app-shell/06-05-SUMMARY.md` exists.
- Verified `.planning/phases/06-canonical-db-app-shell/deferred-items.md` exists.
- Verified task commit `fc138dc` exists in git history.
- Verified `node --test tests/packet-route.test.mjs` passes.
- Verified the packet forbidden-token scan returns no matches.

---
*Phase: 06-canonical-db-app-shell*
*Completed: 2026-07-05*
