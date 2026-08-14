---
phase: 11-runtime-lockdown-and-desktop-release
plan: "01"
subsystem: runtime-lockdown
tags:
  - sec-01
  - runtime-guard
  - app-default
  - tdd
dependency_graph:
  requires:
    - "D-06 through D-09 runtime-routing decisions from Phase 11 context"
    - "Phase 6 DB app shell static-guard pattern"
    - "Phase 7 quick onboarding/source readiness regressions"
  provides:
    - "SEC-01 slice-aware static guard for app-default runtime seams"
  affects:
    - "React /app product files"
    - "Product HTTP route slices"
    - "Electron product wiring"
    - "Retained runtime classification tests"
tech_stack:
  added: []
  patterns:
    - "node:test source guard"
    - "comment-stripped JavaScript scanning"
    - "named route-slice classification"
    - "TDD red/green commits"
key_files:
  created:
    - tests/app-default-runtime-guard.test.mjs
  modified: []
key_decisions:
  - "SEC-01 is enforced by a slice-aware static guard: app-default files and local route slices are scanned, while explicit chat handoffs, retained runtime owners, legacy/static clients, and test files require named classifications."
requirements_completed:
  - SEC-01
metrics:
  duration: "6m 19s"
  completed_at: "2026-07-06T15:14:00Z"
  tasks_completed: 1
  files_changed: 1
status: complete
---

# Phase 11 Plan 01: App-Default Runtime Guard Summary

Slice-aware SEC-01 runtime guard for app-default product paths.

## What Changed

- Added `tests/app-default-runtime-guard.test.mjs` with the full comment-stripping state machine pattern from the DB app shell guard.
- Named the app/default product file set covering React `/app` surfaces, product HTTP routes, and Electron product wiring.
- Added mixed-route slice checks so local proposal/onboarding/intake slices fail if they acquire hidden retained full-runtime seams.
- Classified explicit chat handoffs, retained runtime owners, legacy/static clients, and retained-runtime tests by name instead of using a blanket repo-wide exception.

## Verification

Passed:

```bash
node --test tests/app-default-runtime-guard.test.mjs
node --test tests/app-default-runtime-guard.test.mjs tests/db-app-shell-regression.test.mjs tests/quick-onboarding-auto-sourcing-regression.test.mjs
rg -n "APP_DEFAULT_FILES|CLASSIFIED_RETAINED_RUNTIME_FILES|MIXED_ROUTE_SLICES" tests/app-default-runtime-guard.test.mjs
```

Commit hook verification also passed during the GREEN commit:

```bash
node --test tests/styles.test.mjs tests/client-script.test.mjs tests/config-yaml-parses.test.mjs
npx biome check --write --no-errors-on-unmatched tests/app-default-runtime-guard.test.mjs
```

## Task Commits

| Task | Name | Commit | Notes |
| ---- | ---- | ------ | ----- |
| RED | Add failing app-default runtime guard | d69d9c7 | Initial TDD guard failed against an unclassified app-default runtime seam. |
| GREEN | Implement app-default runtime guard | 9e4cc4c | Guard passes with named product/default files, route slices, and classifications. |

## TDD Gate Compliance

- RED gate commit exists: `d69d9c7`.
- GREEN gate commit exists after RED: `9e4cc4c`.
- Refactor gate was not needed.

## Deviations from Plan

None - plan executed exactly as written.

## Auto-Fixed Issues

None.

## Issues Encountered

- The shared main working tree moved back to the Phase 10 branch during the RED step. I preserved history instead of rewriting: cherry-picked the RED commit onto the Phase 11 branch as `d69d9c7`, then reverted the accidental Phase 10 RED commit with `237c9b4`.
- `requirements.mark-complete SEC-01` did not update this workspace's `Planned` traceability row format, so the `SEC-01` row was patched directly to `Complete` after the registered handler reported `not_found`.
- The state SDK updated session/body fields and calculated 71% progress, but could not patch nested frontmatter fields in this older STATE.md shape; `status` and `progress.percent` were patched directly to match the SDK result.

## Known Stubs

None. The stub scan only matched test-helper initialization values, not UI-visible placeholders or unwired data.

## Threat Flags

None. This plan added test-only static guard coverage and introduced no new network endpoint, auth path, file access path, or schema trust boundary.

## Next Steps

- Continue Phase 11 Wave 1 with `11-02-PLAN.md` and `11-04-PLAN.md`.

## Self-Check: PASSED

- Found `tests/app-default-runtime-guard.test.mjs`.
- Found `.planning/phases/11-runtime-lockdown-and-desktop-release/11-01-SUMMARY.md`.
- Found task commits `d69d9c7` and `9e4cc4c`.
- Re-ran the plan verification command successfully.
