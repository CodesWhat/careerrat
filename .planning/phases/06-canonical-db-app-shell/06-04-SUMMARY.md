---
phase: 06-canonical-db-app-shell
plan: "04"
subsystem: app-shell
tags: [react-nav, tracker-dev, debug-export-routes, db-app-shell]

requires:
  - phase: 06-canonical-db-app-shell
    provides: Phase 6 decisions D-01 through D-05 and RED guards from 06-01
  - phase: 06-canonical-db-app-shell
    provides: Wave 0 NavList and tracker-dev compatibility route regressions
provides:
  - React /app navigation without the legacy Classic tracker affordance
  - Named DEBUG_EXPORT_ROUTES and isDebugExportRoute classification for generated tracker-dev compatibility surfaces
  - tracker-dev startup that serves /app and DB APIs without requiring workspace/tracker.json
affects: [canonical-db-app-shell, app-shell-navigation, tracker-dev, generated-export-boundary]

tech-stack:
  added: []
  patterns:
    - Debug/export compatibility routes are listed in DEBUG_EXPORT_ROUTES and dispatched through isDebugExportRoute(url)
    - Generated dashboard export rendering is best-effort and cannot block /app server startup

key-files:
  created:
    - .planning/phases/06-canonical-db-app-shell/06-04-SUMMARY.md
  modified:
    - apps/web/src/app-shell/NavList.jsx
    - apps/web/src/App.jsx
    - src/cli/tracker-dev.mjs

key-decisions:
  - "Normal React app navigation now contains only /app SPA product routes; legacy /tracker remains outside the nav."
  - "tracker-dev keeps generated dashboard, raw tracker/activity, and storage-adapter feed routes only as named debug/export compatibility routes."
  - "Missing generated tracker exports skip only the debug/export render path; /app and DB APIs still boot."

patterns-established:
  - "Compatibility routes should be added to DEBUG_EXPORT_ROUTES before being served from tracker-dev."
  - "Help and 404 route copy should lead with /app as the product entry and label generated-file paths as debug/export utilities."

requirements-completed:
  - APP-01
  - APP-03
  - APP-04

coverage:
  - id: D1
    description: "React app navigation renders canonical SPA routes and no Classic /tracker link."
    requirement: APP-01
    verification:
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx"
        status: pass
    human_judgment: false
  - id: D2
    description: "tracker-dev debug/export route classification exists and the compatibility route regression subtest is green."
    requirement: APP-04
    verification:
      - kind: other
        ref: "node --check src/cli/tracker-dev.mjs plus token scan for DEBUG_EXPORT_ROUTES/isDebugExportRoute"
        status: pass
      - kind: other
        ref: "node --test --test-name-pattern 'compatibility routes' tests/db-app-shell-regression.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "tracker-dev serves /app and health routes from an empty CAREERRAT_HOME without workspace/tracker.json."
    requirement: APP-03
    verification:
      - kind: integration
        ref: "temporary CAREERRAT_HOME tracker-dev boot with /app, /api/health, and 404 copy checks"
        status: pass
    human_judgment: false

duration: 5 min
completed: 2026-07-05
status: complete
---

# Phase 06 Plan 04: Legacy Nav Retirement and Debug Export Route Summary

**The React app shell now presents /app-only product navigation while tracker-dev keeps generated dashboard feeds behind explicit debug/export route metadata.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-05T16:56:00Z
- **Completed:** 2026-07-05T17:01:09Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Removed the `Classic` external `/tracker` item from `NavList.jsx` while preserving Home, Settings, Onboarding, Inbox, Jobs, Calendar, Network, Library, and the Inbox badge behavior.
- Updated React route comments in `NavList.jsx` and `App.jsx` so `/app` is described as the canonical product shell, not a compatibility path beside legacy tracker.
- Added `DEBUG_EXPORT_ROUTES` and `isDebugExportRoute(url)` to `tracker-dev.mjs`, routing generated dashboard HTML, raw workspace feed files, and raw storage-adapter feeds through a named debug/export classifier.
- Changed tracker-dev startup so missing `workspace/tracker.json` skips only debug/export rendering; `/app`, `/api/health`, DB APIs, and 404 route copy still serve.

## Task Commits

1. **Task 1: Remove Classic from normal React app navigation** - `24c1d5a` (feat)
2. **Task 2: Classify tracker-dev compatibility routes as debug/export-only** - `266b6b8` (feat)

**Plan metadata:** recorded in this summary commit.

## Files Created/Modified

- `apps/web/src/app-shell/NavList.jsx` - Removed the Classic external nav item, unused ListIcon import, and legacy link helper.
- `apps/web/src/App.jsx` - Updated route-map comments to present `/app` as the canonical product route map.
- `src/cli/tracker-dev.mjs` - Added debug/export route metadata, classified compatibility dispatch, non-blocking generated-export render startup, and product-first help/404 copy.
- `.planning/phases/06-canonical-db-app-shell/06-04-SUMMARY.md` - Execution summary and coverage metadata.

## Decisions Made

- Kept legacy generated tracker/dashboard endpoints available for compatibility, but moved them behind `DEBUG_EXPORT_ROUTES` and debug/export wording instead of normal product route prose.
- Treated missing generated tracker exports as a debug/export concern only; the server can now listen and serve `/app` without a generated tracker file.
- Left broader product-file generated-export dependency failures to their owning Wave 1 plans instead of editing 06-05 through 06-07 files from this plan.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- A first no-tracker startup verification script omitted the port environment variable in its fetch helper. The server itself had already started; rerunning the check with `PORT` wired correctly passed.
- The full `node --test tests/db-app-shell-regression.test.mjs` still fails on `src/cli/packet-route.mjs` using `defaultAdapter`, which is expected 06-05 ownership. The tracker-dev compatibility subtest from that guard passes after this plan.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. This plan introduced no UI placeholder data, mock data source, TODO, or incomplete rendered control.

## Threat Flags

None. No new network endpoint, auth path, file trust boundary, or schema surface was introduced; existing compatibility endpoints were narrowed behind debug/export classification.

## Verification

- NavList RED check before implementation: PASS - `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` failed on `Classic` as expected.
- Tracker-dev RED check before implementation: PASS - local token scan failed because `DEBUG_EXPORT_ROUTES` was missing as expected.
- Plan verification: PASS - `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx`.
- Plan verification: PASS - `node --check src/cli/tracker-dev.mjs` plus token scan for `DEBUG_EXPORT_ROUTES` and `isDebugExportRoute`.
- Focused static guard: PASS - `node --test --test-name-pattern 'compatibility routes' tests/db-app-shell-regression.test.mjs`.
- Startup verification: PASS - with temporary empty `CAREERRAT_HOME`, tracker-dev logged the missing tracker export skip, served `/app` 200, `/api/health` 200, and 404 copy naming `/app` plus debug/export routes.
- Pre-commit hooks: PASS for both task commits; lefthook structure guards passed and Biome checked/fixed staged files as needed.

## Acceptance Criteria

- `apps/web/src/app-shell/NavList.jsx` no longer imports `ListIcon` - PASS.
- `NavList` renders no `Classic` label and no external nav item to `/tracker` - PASS.
- `apps/web/src/App.jsx` no longer describes legacy tracker as reachable through normal nav - PASS.
- `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` passes - PASS.
- `src/cli/tracker-dev.mjs` defines `DEBUG_EXPORT_ROUTES` and uses `isDebugExportRoute(url)` for compatibility route classification - PASS.
- Missing `workspace/tracker.json` no longer prevents tracker-dev from listening and serving `/app` - PASS.
- Raw generated tracker/activity feed routes are labeled debug/export in help and 404 copy - PASS.

## TDD Gate Compliance

The RED guards for this implementation were created in Plan 06-01 (`20a9af6` for NavList and `8d49dd1` for the static tracker-dev guard). Plan 06-04 intentionally produced GREEN implementation commits only after confirming those guards were RED. No separate `test(06-04)` commit was created because this plan consumes the Wave 0 RED contracts.

## Next Phase Readiness

Plan 06-04 is complete. Wave 1 can continue with 06-05 to migrate packet product APIs off generated tracker exports, which is the remaining failure in the full 06-01 static guard sample.

## Self-Check: PASSED

- Verified `apps/web/src/app-shell/NavList.jsx` exists.
- Verified `apps/web/src/App.jsx` exists.
- Verified `src/cli/tracker-dev.mjs` exists.
- Verified task commits `24c1d5a` and `266b6b8` exist in git history.
- Verified the two plan-level commands pass.
- Verified the focused tracker-dev compatibility subtest passes.

---
*Phase: 06-canonical-db-app-shell*
*Completed: 2026-07-05*
