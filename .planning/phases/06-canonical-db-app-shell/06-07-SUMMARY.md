---
phase: 06-canonical-db-app-shell
plan: "07"
subsystem: api
tags: [scanner, search-route, sqlite, db-source-of-truth, app-shell]

requires:
  - phase: 06-canonical-db-app-shell
    provides: Phase 6 decisions D-04 through D-08 and validation map entries 06-W1-05 through 06-W1-07
  - phase: 06-03
    provides: RED scanner route and DB seen-set coverage for DB-only product search behavior
  - phase: 06-06
    provides: DB source config writes for board/source setup
provides:
  - DB scanner context helper for application and sourced row duplicate context
  - DB-mode scanner seen-set selection while preserving legacy CLI compatibility when SQLite is absent
  - Search product routes that fail closed without SQLite and read DB source/results state only
affects: [canonical-db-app-shell, scanner-context, search-route, generated-export-boundary, phase-06-wave-2]

tech-stack:
  added: []
  patterns:
    - DB scanner helpers read JSON blobs from `applications` and `sourced` tables in rowid order.
    - Product search routes translate missing SQLite into HTTP 409 instead of falling back to generated files.
    - Scanner orchestration chooses DB seen sets only when SQLite exists, preserving legacy CLI behavior otherwise.

key-files:
  created:
    - tests/db-scan-context.test.mjs
    - src/core/db/scan-context.mjs
    - .planning/phases/06-canonical-db-app-shell/06-07-SUMMARY.md
  modified:
    - scripts/scan-sourced.mjs
    - src/cli/search-route.mjs

key-decisions:
  - "DB scanner context reads only SQLite application and sourced rows; generated tracker exports are not part of DB-mode duplicate context."
  - "Legacy tracker-export seen sets remain available only when no SQLite database exists, preserving compatibility CLI mode outside product routes."
  - "Search product routes now require SQLite for scan, sources, and results; legacy config and scan-result files are ignored as product state."

patterns-established:
  - "Use `readDbScannerRows()` for product result routes that need stable sourced row order."
  - "Use a route-local `sendDbError()` translation to map `NO_DATABASE` to HTTP 409 without hiding other failures."

requirements-completed:
  - APP-02
  - APP-03
  - APP-04

coverage:
  - id: D1
    description: "DB scanner context helper builds seen URL, request-id, company-role, and tracker-shaped app context from SQLite rows."
    requirement: APP-02
    verification:
      - kind: integration
        ref: "node --test tests/db-scan-context.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "`runSourcedScan()` uses DB application/sourced seen sets when SQLite exists and ignores tracker-export-only duplicates."
    requirement: APP-03
    verification:
      - kind: integration
        ref: "node --test tests/scanner-seen-set-db.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Search scan, sources, and results product routes require SQLite and ignore legacy config or scan-result files."
    requirement: APP-03
    verification:
      - kind: integration
        ref: "node --test tests/search-route.test.mjs"
        status: pass
      - kind: other
        ref: "rg file-backed search-route tokens in src/cli/search-route.mjs"
        status: pass
    human_judgment: false

duration: 4 min
completed: 2026-07-05
status: complete
---

# Phase 06 Plan 07: Scanner DB Context and Search Route Migration Summary

**Scanner duplicate context and search product routes now read SQLite source, application, and sourced rows instead of generated tracker or scan-result files.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-05T17:16:25Z
- **Completed:** 2026-07-05T17:20:19Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Added `src/core/db/scan-context.mjs` with DB-only `buildDbSeenSets()` and `readDbScannerRows()` helpers.
- Switched `runSourcedScan()` to use DB-derived seen sets when SQLite exists while keeping legacy tracker-export seen sets for non-DB CLI compatibility.
- Migrated `/api/search/scan`, `/api/search/results`, and `/api/search/sources` to fail closed on missing DB and ignore legacy source config or scan-result files as product state.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Add DB scan context helper contract** - `e5add7d` (test)
2. **Task 1 GREEN: Add DB scanner context helper** - `55b6543` (feat)
3. **Task 2: Use DB seen sets in scanner runs** - `3f8655a` (feat)
4. **Task 3: Make search routes DB-only** - `ea8a622` (feat)

**Plan metadata:** recorded in this summary commit.

## Files Created/Modified

- `tests/db-scan-context.test.mjs` - Focused helper coverage for DB-derived seen sets, stable sourced row order, and `NO_DATABASE` propagation.
- `src/core/db/scan-context.mjs` - New DB scanner context helper that reads SQLite JSON rows directly.
- `scripts/scan-sourced.mjs` - Chooses DB seen sets in DB mode and legacy seen sets only when no DB exists.
- `src/cli/search-route.mjs` - Product search routes now require DB source config and return DB sourced rows for results.
- `.planning/phases/06-canonical-db-app-shell/06-07-SUMMARY.md` - Plan execution summary and coverage metadata.

## Decisions Made

- Kept the DB scanner helper independent from tracker storage adapters and generated-file loaders.
- Mirrored the legacy URL/request/company-role normalization locally so the helper can stay DB-only.
- Preserved scanner debug output writes from `runSourcedScan()`; this plan only removed generated-file reads from product route context.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

None. The Task 1 RED test failed on the missing helper module as expected, and the Task 2/3 RED contracts from 06-03 failed for the intended old tracker/file-backed behavior before implementation.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub scan found only normal default parameters, temporary local arrays, and nullable internal variables; no UI-rendered placeholder data or incomplete production behavior was introduced.

## Threat Flags

None. This plan mitigated the existing scanner/search trust boundary threats in the plan and introduced no new endpoint, auth path, schema migration, or file-access trust boundary.

## Verification

- Task 1 RED: PASS - `node --test tests/db-scan-context.test.mjs` failed before implementation with `ERR_MODULE_NOT_FOUND` for `src/core/db/scan-context.mjs`.
- Task 1 GREEN: PASS - `node --test tests/db-scan-context.test.mjs`.
- Task 2 RED: PASS - `node --test tests/scanner-seen-set-db.test.mjs` initially kept the DB application duplicate.
- Task 2 GREEN: PASS - `node --test tests/scanner-seen-set-db.test.mjs`.
- Task 3 RED: PASS - `node --test tests/search-route.test.mjs` initially passed through legacy configs and scan-result files.
- Task 3 GREEN: PASS - `node --test tests/search-route.test.mjs`.
- Plan verification: PASS - `node --test tests/db-scan-context.test.mjs tests/scanner-seen-set-db.test.mjs tests/search-route.test.mjs`.
- Prior-plan regression: PASS - `node --test tests/boards-route.test.mjs`.
- Syntax verification: PASS - `node --check src/core/db/scan-context.mjs && node --check scripts/scan-sourced.mjs && node --check src/cli/search-route.mjs`.
- Static route scan: PASS - no `node:fs`, `node:path`, `userPath`, `parseYaml`, legacy config, or scan-result read tokens remain in `src/cli/search-route.mjs`.
- Helper boundary scan: PASS - no `tracker-data`, storage adapter, generated tracker, or scan-result imports in `src/core/db/scan-context.mjs`.
- Pre-commit hooks: PASS - lefthook structure guards passed and Biome checked or formatted each committed file.

## Acceptance Criteria

- New helper file exports `buildDbSeenSets` and `readDbScannerRows` - PASS.
- `tests/db-scan-context.test.mjs` covers helper behavior without importing `scripts/scan-sourced.mjs` or `src/cli/search-route.mjs` - PASS.
- Helper reads only DB tables and does not import tracker-data or storage adapter modules - PASS.
- Helper returns a `tracker` object with an `apps` array for `computeFamilyOutcomes` call sites - PASS.
- `scripts/scan-sourced.mjs` no longer calls the legacy seen-set helper directly inside `runSourcedScan()` - PASS.
- DB-mode scanner seen-set tests pass and prove tracker-export-only duplicates are ignored - PASS.
- Existing scanner seen-set tests pass with stub fetches and no Task 3 dependency - PASS.
- `src/cli/search-route.mjs` no longer imports file-system helpers for scan-result reads or legacy source config reads - PASS.
- Missing DB tests for scan/results/sources expect 409 - PASS.
- DB source counts and scan run tests pass with DB fixtures and stub fetch - PASS.
- DB results tests prove generated scan-result JSON files are ignored by the product result route - PASS.

## TDD Gate Compliance

Task 1 followed a local RED/GREEN cycle with `e5add7d` then `55b6543`. Tasks 2 and 3 consumed the Wave 0 RED contracts committed in Plan 06-03, re-ran them to confirm the expected failures, then produced GREEN implementation commits `3f8655a` and `ea8a622`.

## Next Phase Readiness

Plan 06-07 is complete. Phase 6 Wave 2 can run the final backend, frontend, and global static-guard rollup in Plan 06-08.

## Self-Check: PASSED

- Verified `tests/db-scan-context.test.mjs` exists.
- Verified `src/core/db/scan-context.mjs` exists.
- Verified `scripts/scan-sourced.mjs` exists.
- Verified `src/cli/search-route.mjs` exists.
- Verified task commit `e5add7d` exists in git history.
- Verified task commit `55b6543` exists in git history.
- Verified task commit `3f8655a` exists in git history.
- Verified task commit `ea8a622` exists in git history.
- Verified all three plan-level verification commands pass.
- Verified prior-plan `tests/boards-route.test.mjs` still passes.

---
*Phase: 06-canonical-db-app-shell*
*Completed: 2026-07-05*
