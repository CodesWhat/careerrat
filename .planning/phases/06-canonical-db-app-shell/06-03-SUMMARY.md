---
phase: 06-canonical-db-app-shell
plan: "03"
subsystem: testing
tags: [source-setup, scanner, db-source-of-truth, red-coverage, app-shell]

requires:
  - phase: 06-canonical-db-app-shell
    provides: Phase 6 context decisions D-04 through D-08 and validation map entries 06-W0-04 through 06-W0-06
  - phase: 06-01
    provides: Wave 0 RED coverage convention for DB app shell regressions
  - phase: 06-02
    provides: DB-only product route RED pattern with fail-closed missing database behavior
provides:
  - RED source setup route coverage requiring `/api/boards/add` to use SQLite source config and never write legacy `config/search-sources.yml`
  - RED scanner route coverage requiring scan, sources, and results product APIs to fail closed without SQLite and ignore legacy source/result files
  - RED scanner seen-set coverage requiring DB-mode dedupe to derive seen URLs from DB application/sourced rows instead of generated tracker exports
affects: [canonical-db-app-shell, source-setup, scanner-context, generated-export-boundary, phase-06-wave-1]

tech-stack:
  added: []
  patterns:
    - Source setup RED tests initialize SQLite with `openDb` and assert `sourceConfigGet({ name: "search-sources" })`
    - Scanner route RED tests seed source config and sourced rows through DB verbs while writing contradictory legacy files
    - Scanner seen-set RED tests overwrite generated tracker exports after DB seeding to prove DB rows must be authoritative

key-files:
  created:
    - tests/scanner-seen-set-db.test.mjs
    - .planning/phases/06-canonical-db-app-shell/06-03-SUMMARY.md
  modified:
    - tests/boards-route.test.mjs
    - tests/search-route.test.mjs

key-decisions:
  - "Wave 0 source setup and scanner coverage stays test-only and RED against current file-backed product route behavior."
  - "Source setup and scanner product routes are specified as fail-closed HTTP 409 when SQLite is absent; legacy config and scan-result files are not sufficient product state."
  - "DB-mode scanner seen sets must come from SQLite application and sourced rows, not from generated workspace/tracker.json exports."

patterns-established:
  - "DB-only route RED tests may write contradictory legacy files to prove product routes ignore compatibility artifacts."
  - "Scanner DB-mode dedupe regressions can seed canonical DB rows, then overwrite generated exports to expose fallback leaks."

requirements-completed:
  - APP-02
  - APP-03

coverage:
  - id: D1
    description: "Source setup add-route tests require initialized SQLite, DB `search-sources` writes, unchanged preview behavior, and absence of legacy YAML writes."
    requirement: APP-02
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/boards-route.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D2
    description: "Search scan, sources, and results route tests require DB-only product context and reject legacy config or scan-result files without SQLite."
    requirement: APP-02
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/search-route.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D3
    description: "Scanner seen-set tests require DB-mode dedupe to filter DB application/sourced rows while keeping tracker-export-only URLs eligible."
    requirement: APP-03
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/scanner-seen-set-db.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false

duration: 5 min
completed: 2026-07-05
status: complete
---

# Phase 06 Plan 03: Source Setup and Scanner DB RED Coverage Summary

**Source setup and scanner RED tests now require DB-backed product state for source config, scanner results, and seen-set dedupe before Wave 1 migration begins.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-05T16:46:21Z
- **Completed:** 2026-07-05T16:51:33Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Updated `tests/boards-route.test.mjs` so `POST /api/boards/add` requires SQLite, persists `search-sources` through DB source config, and asserts the legacy YAML file is not written.
- Updated `tests/search-route.test.mjs` so scan, sources, and results product routes reject missing DB state and read DB source/sourced rows instead of legacy config or scan-result JSON files.
- Added `tests/scanner-seen-set-db.test.mjs` proving DB-mode scanner dedupe must use DB application/sourced rows while ignoring contradictory generated tracker exports.

## Task Commits

1. **Task 1: Add RED DB source setup route tests** - `859545d` (test)
2. **Task 2: Add RED DB scanner context and results tests** - `b82f06f` (test)
3. **Task 3: Add RED scanner seen-set DB tests** - `79db932` (test)

**Plan metadata:** recorded in this summary commit.

## Files Created/Modified

- `tests/boards-route.test.mjs` - DB source-config RED route contract for `/api/boards/add`.
- `tests/search-route.test.mjs` - DB-only scanner route RED contract for scan, sources, and results.
- `tests/scanner-seen-set-db.test.mjs` - New DB-mode scanner seen-set RED integration test.
- `.planning/phases/06-canonical-db-app-shell/06-03-SUMMARY.md` - Plan execution summary and coverage metadata.

## Decisions Made

- Kept this Wave 0 plan test-only; no production route or scanner implementation files were changed.
- Treated missing SQLite as product setup failure (`409`) for source setup and scanner routes, even when legacy config or scan-result files exist.
- Used contradictory legacy artifacts in tests to make future DB-first behavior mechanically verifiable.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

None. The RED contracts failed for the intended current-source reasons: `boards-route.mjs` still writes YAML, `search-route.mjs` still accepts/reads legacy files, and `runSourcedScan()` still builds seen sets from generated tracker exports.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. This plan added and updated regression tests only; it introduced no UI-rendered placeholder data or incomplete runtime behavior.

## Threat Flags

None. This plan added test-only fixtures and assertions; it introduced no new endpoint, auth path, production file-access behavior, or runtime trust boundary.

## Verification

- Source setup route RED command: PASS - `node --test tests/boards-route.test.mjs` failed against current YAML-backed add behavior, so `test $? -ne 0` passed.
- Search route RED command: PASS - `node --test tests/search-route.test.mjs` failed against current legacy config/result behavior, so `test $? -ne 0` passed.
- Scanner seen-set RED command: PASS - `node --test tests/scanner-seen-set-db.test.mjs` failed against current tracker-export seen-set behavior, so `test $? -ne 0` passed.
- Pre-commit hooks: PASS - lefthook structure guards passed and Biome checked or formatted the changed test files.

## Acceptance Criteria

- Existing preview tests still expect 200 without DB because preview is pure URL construction - PASS.
- Add-route tests initialize DB before successful writes and expect 409 when DB is missing - PASS.
- Successful add-route tests assert `sourceConfigGet({ name: "search-sources" })` contains the new search and the legacy YAML file is absent - PASS.
- Search route tests no longer treat legacy source config files as sufficient for product routes - PASS.
- Search route tests seed DB source config and sourced rows through DB helpers for successful cases - PASS.
- Search result tests write contradictory scan-result JSON and assert DB rows win - PASS.
- Scanner seen-set test seeds DB source config plus existing DB rows and proves tracker-export-only rows are not seen in DB mode - PASS.

## Next Phase Readiness

Plan 06-03 is complete. Phase 6 Wave 0 RED coverage is now complete, so Wave 1 can migrate the app shell, packet, source setup, and scanner implementation paths against these failing contracts.

## Self-Check: PASSED

- Verified `tests/boards-route.test.mjs` exists.
- Verified `tests/search-route.test.mjs` exists.
- Verified `tests/scanner-seen-set-db.test.mjs` exists.
- Verified task commit `859545d` exists in git history.
- Verified task commit `b82f06f` exists in git history.
- Verified task commit `79db932` exists in git history.
- Verified all three plan-level RED wrapper commands pass.

---
*Phase: 06-canonical-db-app-shell*
*Completed: 2026-07-05*
