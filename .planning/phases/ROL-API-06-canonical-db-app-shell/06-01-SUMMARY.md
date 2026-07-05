---
phase: ROL-API-06-canonical-db-app-shell
plan: "01"
subsystem: testing
tags: [db-app-shell, static-guard, react-nav, red-coverage]

requires:
  - phase: ROL-API-06-canonical-db-app-shell
    provides: Phase 6 context decisions D-01 through D-10 and validation plan
  - phase: 05-verification-and-docs
    provides: focused verification, docs alignment, and static scan patterns
provides:
  - RED static guard for product dependencies on generated tracker/activity exports and legacy source/scanner files
  - RED NavList regression for removing Classic and normal /tracker navigation from the React app shell
  - Wave 0 failing coverage for APP-01, APP-03, and APP-04 before implementation plans run
affects: [canonical-db-app-shell, app-shell-navigation, generated-export-boundary, phase-06-wave-1]

tech-stack:
  added: []
  patterns:
    - Node built-in static guard scans comment-stripped product source without new dependencies
    - React app shell tests render NavList to static markup under MemoryRouter with Vitest module mocking

key-files:
  created:
    - tests/db-app-shell-regression.test.mjs
    - apps/web/src/app-shell/NavList.test.jsx
    - .planning/phases/ROL-API-06-canonical-db-app-shell/06-01-SUMMARY.md
  modified: []

key-decisions:
  - "Wave 0 remains intentionally test-only: both new tests are RED against current source and are verified through commands that require nonzero underlying test exits."
  - "The static guard strips JavaScript comments before token scans so comments cannot create false positives for generated-export dependencies."
  - "The tracker-dev compatibility route check requires named debug/export classification symbols rather than allowing ad hoc legacy route branches."

patterns-established:
  - "RED guard verification commands wrap the failing test with `test $? -ne 0` so the plan-level command passes only while the regression contract is still red."
  - "NavList regression coverage keeps the normal SPA labels and Inbox badge under test while failing only the legacy Classic /tracker affordance."

requirements-completed:
  - APP-01
  - APP-03
  - APP-04

coverage:
  - id: D1
    description: "Static DB app shell guard fails current product files that still read generated tracker/activity exports, legacy source setup files, scan-result files, or tracker-derived seen sets."
    requirement: APP-03
    verification:
      - kind: other
        ref: "bash -lc 'node --test tests/db-app-shell-regression.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D2
    description: "Static tracker-dev guard requires remaining compatibility route references to be classified behind named debug/export allowlists."
    requirement: APP-04
    verification:
      - kind: other
        ref: "bash -lc 'node --test tests/db-app-shell-regression.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D3
    description: "React NavList regression keeps canonical app labels and Inbox badge while failing current Classic /tracker navigation."
    requirement: APP-01
    verification:
      - kind: unit
        ref: "bash -lc 'npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx; test $? -ne 0'"
        status: pass
    human_judgment: false

duration: 3 min
completed: 2026-07-05
status: complete
---

# Phase 06 Plan 01: Static and Nav RED Guards Summary

**RED regression tests now lock the DB-only app shell boundary and Classic nav retirement before Phase 6 implementation begins.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-05T16:32:11Z
- **Completed:** 2026-07-05T16:35:08Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added `tests/db-app-shell-regression.test.mjs`, a Node built-in static guard that scans the Phase 6 product boundary for generated tracker/activity, legacy source setup, scan-result, and tracker-derived seen-set dependencies.
- Added tracker-dev debug/export classification assertions that fail until compatibility routes are moved behind named allowlist symbols.
- Added `apps/web/src/app-shell/NavList.test.jsx`, a Vitest regression that preserves canonical SPA labels and the Inbox badge while failing the current Classic `/tracker` link.

## Task Commits

1. **Task 1: Add RED static guard for DB-only product dependencies** - `8d49dd1` (test)
2. **Task 2: Add RED NavList product-nav retirement test** - `20a9af6` (test)

**Plan metadata:** recorded in this summary commit.

## Files Created/Modified

- `tests/db-app-shell-regression.test.mjs` - Static RED guard for APP-03/APP-04 and D-09/D-10.
- `apps/web/src/app-shell/NavList.test.jsx` - React NavList RED regression for APP-01 and D-01 through D-03.
- `.planning/phases/ROL-API-06-canonical-db-app-shell/06-01-SUMMARY.md` - Plan execution summary and coverage metadata.

## Decisions Made

- Kept Wave 0 test-only; no product source files were changed.
- Used comment stripping before static scans so comments cannot trigger or mask dependency violations.
- Verified RED state with wrapper commands that pass only when the underlying regression tests fail against current source.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

None. Both RED contracts failed for the intended current-source reasons and the wrapper verification commands passed.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. The new files are regression tests only and introduce no UI-rendered placeholder data or incomplete runtime behavior.

## Threat Flags

None. This plan added test-only file reads and no new endpoint, auth path, schema, or production trust-boundary behavior.

## Verification

- Static guard RED command: PASS - `node --test tests/db-app-shell-regression.test.mjs` failed on current product dependencies and unclassified tracker-dev compatibility routes, so `test $? -ne 0` passed.
- NavList RED command: PASS - `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` failed on current `Classic` `/tracker` navigation, so `test $? -ne 0` passed.
- Pre-commit hooks: PASS for both task commits; lefthook structure guards passed and Biome formatted/checked staged test files.

## Acceptance Criteria

- `tests/db-app-shell-regression.test.mjs` exists and imports only Node built-ins - PASS.
- Static guard scans the required product files and has narrow tracker-dev debug/export assertions - PASS.
- Static guard is intentionally RED against current source - PASS.
- `apps/web/src/app-shell/NavList.test.jsx` imports Vitest APIs, renders under `MemoryRouter`, preserves normal labels and badge, and rejects Classic `/tracker` navigation - PASS.
- NavList test is intentionally RED against current source through the existing web `vitest run` script - PASS.
- No product source files were modified - PASS.

## Next Phase Readiness

Plan 06-01 is complete. Phase 6 Wave 0 can continue with 06-02 and 06-03 RED route/scanner coverage before Wave 1 implementation.

## Self-Check: PASSED

- Verified `tests/db-app-shell-regression.test.mjs` exists.
- Verified `apps/web/src/app-shell/NavList.test.jsx` exists.
- Verified `.planning/phases/ROL-API-06-canonical-db-app-shell/06-01-SUMMARY.md` exists.
- Verified task commits `8d49dd1` and `20a9af6` exist in git history.
- Verified both plan-level RED wrapper commands pass.

---
*Phase: ROL-API-06-canonical-db-app-shell*
*Completed: 2026-07-05*
