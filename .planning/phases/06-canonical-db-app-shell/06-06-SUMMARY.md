---
phase: 06-canonical-db-app-shell
plan: "06"
subsystem: api
tags: [source-setup, sqlite, db-source-of-truth, app-shell]

requires:
  - phase: 06-canonical-db-app-shell
    provides: Phase 6 decisions D-04 through D-08 and source setup RED coverage from 06-03
  - phase: 06-03
    provides: RED boards route tests requiring DB source config writes and no legacy YAML writes
provides:
  - Board/source setup product writes backed by DB `search-sources` source config
  - Fail-closed HTTP 409 behavior for `/api/boards/add` when SQLite is absent
  - Preserved deterministic `/api/boards/preview` behavior without DB setup
affects: [canonical-db-app-shell, source-setup, db-source-of-truth, phase-06-wave-1]

tech-stack:
  added: []
  patterns:
    - Product source setup routes call `sourceConfigGet` and `sourceConfigPut` instead of writing legacy YAML.
    - Missing DB state on `/api/boards/add` maps to HTTP 409 while malformed request input remains HTTP 400.

key-files:
  created:
    - .planning/phases/06-canonical-db-app-shell/06-06-SUMMARY.md
  modified:
    - src/cli/boards-route.mjs

key-decisions:
  - "Board additions now read and write DB `search-sources` config through source-config verbs instead of `config/search-sources.yml`."
  - "Malformed board URLs are validated before DB access so bad input remains HTTP 400 while missing DB remains HTTP 409."
  - "Board preview remains deterministic and DB-free."

patterns-established:
  - "Source setup product writes use small route-local DB helpers around shared source-config verbs."
  - "Product setup routes preserve cheap input validation before fail-closed DB setup gates."

requirements-completed:
  - APP-02
  - APP-03

coverage:
  - id: D1
    description: "`POST /api/boards/add` persists board additions through DB `search-sources` source config and returns the existing searches list shape."
    requirement: APP-02
    verification:
      - kind: integration
        ref: "node --test tests/boards-route.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "`POST /api/boards/add` fails closed with HTTP 409 when SQLite is absent while preserving HTTP 400 for malformed URL input."
    requirement: APP-03
    verification:
      - kind: integration
        ref: "node --test tests/boards-route.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "`src/cli/boards-route.mjs` no longer imports or calls legacy YAML write helpers for product source setup."
    requirement: APP-03
    verification:
      - kind: other
        ref: "rg 'atomicWriteFile|mkdirSync|dirname|userPath|serializeConfig|parseConfig|emptyConfig|config/search-sources.yml' src/cli/boards-route.mjs"
        status: pass
    human_judgment: false

duration: 4 min
completed: 2026-07-05
status: complete
---

# Phase 06 Plan 06: Source Setup DB Write Migration Summary

**Board/source setup product writes now use SQLite source config rows instead of legacy search-sources YAML files.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-05T17:08:45Z
- **Completed:** 2026-07-05T17:12:48Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Replaced `/api/boards/add` legacy YAML reads and writes with `sourceConfigGet` and `sourceConfigPut` around the DB `search-sources` config row.
- Added `readDbSearchSources()` and `writeDbSearchSources()` route helpers for source setup persistence.
- Preserved URL parsing, schema validation, `listSearches()` response shape, and deterministic `/api/boards/preview` behavior.
- Converted missing SQLite setup to HTTP 409 `{ ok:false, error }` while malformed URL input remains HTTP 400.

## Task Commits

1. **Task 1: Persist board additions through DB source config verbs** - `88fedce` (feat)

**Plan metadata:** recorded in this summary commit.

## Files Created/Modified

- `src/cli/boards-route.mjs` - Source setup add route now reads/writes DB source config and no longer writes `config/search-sources.yml`.
- `.planning/phases/06-canonical-db-app-shell/06-06-SUMMARY.md` - Plan execution summary and coverage metadata.

## Decisions Made

- Used the existing `sourceConfigGet`/`sourceConfigPut` verbs directly from the route instead of creating a new source setup service layer.
- Kept malformed URL validation ahead of DB access so user input errors keep their existing 400 behavior even in an uninitialized workspace.
- Returned searches from the persisted DB config after write, preserving the existing response contract while proving DB state is authoritative.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserved malformed URL 400 behavior before DB setup gate**
- **Found during:** Task 1 (Persist board additions through DB source config verbs)
- **Issue:** The first DB-backed implementation read DB config before URL parsing, so an unparseable URL in a workspace with no DB returned 409 instead of the planned 400.
- **Fix:** Added a cheap `new URL(url)` validation step before `readDbSearchSources()`, matching `addSearchFromUrl()` parse semantics while keeping DB access fail-closed for valid source setup requests.
- **Files modified:** `src/cli/boards-route.mjs`
- **Verification:** `node --test tests/boards-route.test.mjs`
- **Committed in:** `88fedce`

**Total deviations:** 1 auto-fixed (Rule 1).
**Impact on plan:** The fix was required to satisfy the plan's existing malformed-input contract; no scope was added.

## Issues Encountered

- Initial RED verification failed exactly as expected: the old route returned 200 without DB and wrote legacy YAML instead of DB source config.
- The first GREEN attempt exposed the malformed URL ordering issue documented above; it was fixed before the task commit.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub scan found no placeholder/TODO/FIXME or UI-rendered hardcoded empty values in `src/cli/boards-route.mjs`.

## Threat Flags

None. This plan changed an existing route's persistence boundary already covered by T-06-06 and T-06-10; it introduced no new endpoint, auth path, schema change, or new trust boundary.

## Verification

- RED check before implementation: PASS - `node --test tests/boards-route.test.mjs` failed on the expected file-backed add-route behavior.
- Plan verification: PASS - `node --test tests/boards-route.test.mjs`.
- Syntax verification: PASS - `node --check src/cli/boards-route.mjs`.
- Legacy write scan: PASS - no `atomicWriteFile`, `mkdirSync`, `dirname`, `userPath`, `serializeConfig`, `parseConfig`, `emptyConfig`, or `config/search-sources.yml` references remain in `src/cli/boards-route.mjs`.
- Pre-commit hooks: PASS - lefthook structure guards passed and Biome checked `src/cli/boards-route.mjs`.

## Acceptance Criteria

- `src/cli/boards-route.mjs` no longer imports `atomicWriteFile`, `mkdirSync`, `dirname`, or `userPath` for product source setup writes - PASS.
- `POST /api/boards/add` writes DB source config and returns the same `searches` list shape - PASS.
- Successful tests prove the legacy search-sources file remains absent - PASS.
- `POST /api/boards/preview` tests still pass unchanged - PASS.

## TDD Gate Compliance

The RED boards route tests were created and committed in Plan 06-03 as the Wave 0 contract. Plan 06-06 confirmed those tests were RED before implementation and then produced the GREEN implementation commit `88fedce`. No separate `test(06-06)` commit was created because this plan consumes the prior Wave 0 RED contract.

## Next Phase Readiness

Plan 06-06 is complete. Phase 6 Wave 1 can continue with 06-07 to migrate scanner context, results, and seen sets to DB-derived state.

## Self-Check: PASSED

- Verified `src/cli/boards-route.mjs` exists.
- Verified `.planning/phases/06-canonical-db-app-shell/06-06-SUMMARY.md` exists.
- Verified task commit `88fedce` exists in git history.
- Verified `node --test tests/boards-route.test.mjs` passes.
- Verified the boards-route legacy write scan returns no matches.

---
*Phase: 06-canonical-db-app-shell*
*Completed: 2026-07-05*
