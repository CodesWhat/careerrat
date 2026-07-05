---
phase: ROL-API-06-canonical-db-app-shell
plan: 09
subsystem: app-shell
tags:
  - react
  - tracker-dev
  - static-guards
  - tdd

requires:
  - phase: ROL-API-06-canonical-db-app-shell
    provides: Phase 6 DB app shell migrations and 06-08 verification gaps
provides:
  - APP-01 onboarding no longer advertises the legacy static /onboard page as normal UX
  - APP-01 tracker-dev labels retained static pages as compatibility/debug/export surfaces
  - APP-04 static guard coverage includes normal React onboarding product pages
affects:
  - Phase 6 verification
  - Phase 7 onboarding
  - tracker-dev compatibility routes

tech-stack:
  added: []
  patterns:
    - renderToStaticMarkup component regression for React onboarding
    - explicit STATIC_COMPATIBILITY_ROUTES metadata for retained byte-static pages
    - source-text static guard over normal React product pages

key-files:
  created:
    - apps/web/src/onboarding/steps/WelcomeStep.test.jsx
    - .planning/phases/ROL-API-06-canonical-db-app-shell/06-09-SUMMARY.md
  modified:
    - tests/db-app-shell-regression.test.mjs
    - apps/web/src/onboarding/steps/WelcomeStep.jsx
    - src/cli/tracker-dev.mjs

key-decisions:
  - "React /app onboarding keeps only the canonical Get started action; the legacy /onboard page is not presented as a user fallback."
  - "Retained byte-static pages remain mounted, but tracker-dev route discovery now classifies them as compatibility/debug/export surfaces."
  - "The static guard now scans normal React onboarding product pages, not only the app shell nav."

patterns-established:
  - "Retained static pages must be declared in STATIC_COMPATIBILITY_ROUTES before tracker-dev can mount them."
  - "Normal React product pages are scanned for direct legacy static anchors and legacy/static/classic affordance copy."

requirements-completed:
  - APP-01
  - APP-04

coverage:
  - id: D1
    description: "React onboarding welcome step no longer links to legacy /onboard."
    requirement: APP-01
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/WelcomeStep.test.jsx#keeps onboarding inside the canonical React app flow"
        status: pass
      - kind: other
        ref: "node --test tests/db-app-shell-regression.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "tracker-dev route/help copy classifies /evaluate, /answer, /onboard, /search, and /packet as compatibility/debug/export surfaces."
    requirement: APP-01
    verification:
      - kind: other
        ref: "tests/db-app-shell-regression.test.mjs#tracker-dev static byte pages are explicit compatibility/debug/export surfaces"
        status: pass
    human_judgment: false
  - id: D3
    description: "Static guard coverage includes normal React onboarding product pages."
    requirement: APP-04
    verification:
      - kind: other
        ref: "tests/db-app-shell-regression.test.mjs#static affordance guard scans normal React product pages"
        status: pass
    human_judgment: false

duration: 3min
completed: 2026-07-05
status: complete
---

# Phase 06 Plan 09: Onboarding Compatibility Gap Summary

**React onboarding now stays in /app while tracker-dev names retained static pages as compatibility/debug/export surfaces.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-05T19:04:35Z
- **Completed:** 2026-07-05T19:07:28Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added RED coverage proving `WelcomeStep` must keep users inside the canonical React onboarding flow.
- Expanded `tests/db-app-shell-regression.test.mjs` so normal React onboarding pages are scanned for legacy static-page affordances.
- Removed the `/onboard` fallback link from `WelcomeStep.jsx`.
- Added `STATIC_COMPATIBILITY_ROUTES` in `tracker-dev.mjs` and used it for retained byte-static route mounting and 404/help copy.

## TDD Evidence

- **RED:** `4670ed0` added failing tests. Verification required both `node --test tests/db-app-shell-regression.test.mjs` and `npm --workspace apps/web run test -- src/onboarding/steps/WelcomeStep.test.jsx` to fail. They failed on `href="/onboard"` and the missing static compatibility route table.
- **GREEN:** `f2d0daa` removed the normal React `/onboard` fallback and introduced explicit static compatibility route metadata. Focused and broad verification passed.
- **REFACTOR:** No separate refactor commit was needed; the GREEN change was already limited to route classification and copy.

## Task Commits

1. **Task 1 RED: Expand legacy-affordance regression coverage** - `4670ed0` (test)
2. **Task 2 GREEN/REFACTOR: Remove onboarding fallback link and reframe static pages** - `f2d0daa` (feat)

## Files Created/Modified

- `apps/web/src/onboarding/steps/WelcomeStep.test.jsx` - Component regression for canonical React onboarding.
- `tests/db-app-shell-regression.test.mjs` - Static source guard for normal React product pages and tracker-dev static compatibility copy.
- `apps/web/src/onboarding/steps/WelcomeStep.jsx` - Removed the legacy `/onboard` fallback anchor.
- `src/cli/tracker-dev.mjs` - Added static compatibility route metadata and reframed help/404 route copy.
- `.planning/phases/ROL-API-06-canonical-db-app-shell/06-09-SUMMARY.md` - This execution summary.

## Decisions Made

- Kept `/evaluate`, `/answer`, `/onboard`, `/search`, and `/packet` mounted for compatibility, but made their retained status explicit through `STATIC_COMPATIBILITY_ROUTES`.
- Kept `/chat` out of the static compatibility list because it remains an explicit user-selected chat handoff, not a generated-file debug/export route.
- Added source-level React page scanning to catch legacy static-page affordances outside `NavList.jsx`.

## Verification

- `node --test tests/db-app-shell-regression.test.mjs && npm --workspace apps/web run test -- src/onboarding/steps/WelcomeStep.test.jsx` - passed.
- `node --test tests/dashboard-route.test.mjs tests/data-route.test.mjs tests/packet-route.test.mjs tests/search-route.test.mjs tests/boards-route.test.mjs tests/desktop-routing.test.mjs tests/db-app-shell-regression.test.mjs && npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx src/onboarding/steps/WelcomeStep.test.jsx` - passed.
- Task acceptance greps confirmed `WelcomeStep.jsx` has no `href="/onboard"` or classic-page copy, tracker-dev no longer groups static pages under "utility pages", and existing app/API/static compatibility route mounts remain present.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The GREEN commit hook reported an existing Biome warning for `process.env.ROLESTER_TRACKER_HOST` in `src/cli/tracker-dev.mjs`. The hook passed and no unrelated file was changed.

## User Setup Required

None - no external service configuration required.

## Stub And Threat Review

- **Known stubs:** None. Stub-pattern scan hits were existing parser/helper locals such as `output = ""`, `watchers = []`, and `placeholderPage`, not unwired UI data or placeholders that block the plan goal.
- **Threat flags:** None. The plan reframed existing retained static routes and removed a React fallback link; it did not add new network endpoints or trust-boundary behavior beyond the planned threat register.

## Next Phase Readiness

APP-01 is closed for the onboarding legacy-affordance gap, and APP-04 now guards normal React product pages against legacy static links and labels. Plan 06-10 remains responsible for the separate DB-mode onboarding source-readiness and compatibility export-copy gap.

## Self-Check: PASSED

- Confirmed summary and key files exist on disk.
- Confirmed task commits `4670ed0` and `f2d0daa` exist in git history.
- Re-ran `node --test tests/db-app-shell-regression.test.mjs`.
- Re-ran `npm --workspace apps/web run test -- src/onboarding/steps/WelcomeStep.test.jsx`.

---
*Phase: ROL-API-06-canonical-db-app-shell*
*Completed: 2026-07-05*
