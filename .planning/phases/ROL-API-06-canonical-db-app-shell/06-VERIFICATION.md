---
phase: ROL-API-06-canonical-db-app-shell
verified: 2026-07-05T17:52:18Z
status: gaps_found
score: "5/7 must-haves verified"
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "APP-01: React /app is the canonical product surface and legacy compatibility surfaces are not normal UX."
    status: failed
    reason: "The sidebar nav and generated tracker routes are cleaned up, but the normal /app onboarding welcome step still advertises the legacy /onboard page as a user-facing fallback."
    artifacts:
      - path: "apps/web/src/onboarding/steps/WelcomeStep.jsx"
        issue: "Line 43 renders an href to /onboard with 'Prefer the classic step-by-step page?' inside the React /app onboarding flow."
      - path: "src/cli/tracker-dev.mjs"
        issue: "Help/route copy still lists /onboard, /search, /packet, /evaluate, and /answer as retained utility pages rather than debug/export compatibility surfaces."
    missing:
      - "Remove or demote the /onboard link from the React /app onboarding flow."
      - "Add a regression guard that scans normal React product pages for legacy static-page affordances, not only NavList."
  - truth: "APP-02: Source setup views read DB-derived state instead of compatibility source files."
    status: failed
    reason: "DB-mode onboarding state and FinishStep still use config/search-sources.yml presence and copy as source-setup readiness, so a normal /app source-setup path still depends on a compatibility file."
    artifacts:
      - path: "src/cli/onboard-route.mjs"
        issue: "Lines 480-500 and 551-557 set searchSourcesPresent from config/search-sources.yml even when DB exists; lines 359-366 and 888 expose write-config as a normal path that writes the compatibility file."
      - path: "apps/web/src/onboarding/steps/FinishStep.jsx"
        issue: "Lines 206-211 use searchSourcesPresent as configReady/readiness; lines 409-442 present compatibility-file export and config/search-sources.yml copy in the normal app flow."
    missing:
      - "In DB mode, derive source setup readiness from SQLite sourceConfigGet({ name: 'search-sources' }) rather than config/search-sources.yml."
      - "Reword /app onboarding finish copy so compatibility file export is explicit and not the product source setup state."
      - "Add route/component tests covering DB-mode onboarding source readiness without config/search-sources.yml."
---

# Phase 6: Canonical DB App Shell Verification Report

**Phase Goal:** Make the Electron/React app DB-source-of-truth and remove compatibility surfaces from product paths.
**Verified:** 2026-07-05T17:52:18Z
**Status:** gaps_found
**Re-verification:** No - initial verification

## Goal Achievement

Phase 6 is mostly implemented for the route families targeted by the final rollup, but the broader phase goal is not fully achieved. The migrated packet, boards, search, scanner, dashboard, data, and static-guard paths are backed by DB-derived state and have passing focused tests. However, normal `/app/onboarding` still exposes the legacy `/onboard` static page and uses `config/search-sources.yml` as source-setup readiness in DB mode.

MVP metadata note: ROADMAP marks Phase 6 as `mode: mvp`, but the roadmap goal is not in strict user-story format. The verification below follows the user-supplied phase goal plus APP-01 through APP-04 contract.

### Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | `/app` navigation and route copy expose React app as canonical product UX; legacy generated/static surfaces are debug/export compatibility only. | FAILED | `NavList.jsx` and `/tracker` debug/export classification pass, but `apps/web/src/onboarding/steps/WelcomeStep.jsx:43` still links from `/app/onboarding` to `/onboard`; `tracker-dev.mjs` still presents static utility pages separately from debug/export routes. |
| 2 | Packet, board/source setup, search results, scanner context, dashboard/tracker/activity snapshots, and DB data routes pass together as DB-derived app APIs. | FAILED | Packet/boards/search/dashboard/data routes are verified, but `src/cli/onboard-route.mjs:480` still derives DB-mode `searchSourcesPresent` from `config/search-sources.yml`, and `FinishStep.jsx:206` uses it as source-setup readiness. |
| 3 | Product routes do not depend on generated `workspace/tracker.json` or `workspace/activity.jsonl` as source of truth. | VERIFIED | `tests/db-app-shell-regression.test.mjs` scans product boundary files; focused backend command passed. `tracker-dev.mjs` skips debug/export render when tracker export is absent while `/app` and DB APIs still serve. |
| 4 | Static guards prevent product dependencies on generated tracker/activity files. | VERIFIED | Static guard defines product files and forbidden generated tracker/activity/raw-feed patterns; `node --test ... tests/db-app-shell-regression.test.mjs` passed. |
| 5 | Standalone explicit scanner config does not mutate DB product state. | VERIFIED | `scripts/scan-sourced.mjs` uses `standaloneConfigMode`; `tests/scan-sourced.test.mjs` asserts no sourced DB rows, no tracker export, and no DB watermark mutation in explicit config mode. |
| 6 | Binary packet artifacts are DB-referenced and safe. | VERIFIED | `/api/packet/artifact` requires `id` plus `kind`, reads application artifacts via `readPacketApplicationsFromDb()`, rejects raw path queries, and tests pass for PDF metadata/serve behavior and no-DB 409. |
| 7 | Search preflight failures return JSON. | VERIFIED | `src/cli/search-route.mjs` catches source-config preflight errors and returns JSON 500/409; `tests/search-route.test.mjs` includes invalid DB source-config JSON behavior. |

**Score:** 5/7 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `apps/web/src/app-shell/NavList.jsx` | Product nav excludes Classic `/tracker`. | VERIFIED | Nav renders SPA routes only; `NavList.test.jsx` passed. |
| `apps/web/src/App.jsx` | `/app` route map is canonical React SPA. | VERIFIED | Route comments and route map identify `/app` as canonical. |
| `src/cli/tracker-dev.mjs` | Generated tracker/static routes are debug/export classified. | PARTIAL | `DEBUG_EXPORT_ROUTES` covers generated dashboard/raw feeds, but retained static utility pages remain normal route copy. |
| `src/cli/packet-route.mjs` | Packet list/detail/artifacts read DB-derived application rows. | VERIFIED | Uses `requireDb()` and `assembleTrackerObject(db)`; artifact endpoint reads by DB app id/kind. |
| `src/cli/boards-route.mjs` | Source setup add route writes SQLite source config. | VERIFIED | `readDbSearchSources()` and `writeDbSearchSources()` wrap `sourceConfigGet/Put`; tests assert no YAML write. |
| `src/cli/search-route.mjs` | Search scan/results/sources are DB-only. | VERIFIED | Uses `sourceConfigGet()` and `readDbScannerRows()`; tests assert legacy files are insufficient. |
| `scripts/scan-sourced.mjs` | Scanner seen sets use DB rows in DB mode and standalone config does not mutate DB state. | VERIFIED | `buildSeenSetsForRun()` uses `buildDbSeenSets()` when DB exists; explicit config mode bypasses DB mutation. |
| `src/core/db/scan-context.mjs` | DB-derived scanner duplicate/result helper. | VERIFIED | Reads `applications` and `sourced` tables; helper tests pass. |
| `src/cli/onboard-route.mjs` | Onboarding/source setup state should be DB-derived in DB mode. | FAILED | Still reports `searchSourcesPresent` by checking `config/search-sources.yml`. |
| `apps/web/src/onboarding/steps/WelcomeStep.jsx` and `FinishStep.jsx` | Normal `/app/onboarding` should not advertise/depend on compatibility surfaces. | FAILED | Welcome links to `/onboard`; FinishStep presents compatibility file export/readiness as the normal finish path. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `NavList.jsx` | `NavList.test.jsx` | render-to-static-markup assertions | VERIFIED | Test passed and blocks Classic `/tracker` nav. |
| `tracker-dev.mjs` | `db-app-shell-regression.test.mjs` | `DEBUG_EXPORT_ROUTES` and `isDebugExportRoute()` | VERIFIED | Static guard passed for generated tracker/activity compatibility routes. |
| `packet-route.mjs` | SQLite applications | `readPacketApplicationsFromDb()` | VERIFIED | Packet tests passed for list/detail/artifact paths and missing DB 409. |
| `boards-route.mjs` | SQLite source config | `sourceConfigGet/Put` | VERIFIED | Board tests passed and assert `config/search-sources.yml` is not written by `/api/boards/add`. |
| `search-route.mjs` | SQLite source config and sourced rows | `sourceConfigGet()` and `readDbScannerRows()` | VERIFIED | Search tests passed and assert legacy config/result files are ignored. |
| `scan-sourced.mjs` | DB scanner seen sets | `buildSeenSetsForRun()` -> `buildDbSeenSets()` | VERIFIED | Scanner seen-set and explicit-config tests passed. |
| `/app/onboarding` | Source setup state | `getOnboardState()` -> `/api/onboard/state` | FAILED | DB-mode route still reports source readiness from `config/search-sources.yml`, not DB source config. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `dashboard-route.mjs` | `trackerData`, `activityEvents` | `assembleTrackerObject(db)`, `assembleActivityEvents(db)` | Yes | FLOWING |
| `data-route.mjs` | applications/sourced/comms/activity rows | SQLite table queries via `requireDb()` | Yes | FLOWING |
| `packet-route.mjs` | packet application rows/artifacts | `readPacketApplicationsFromDb()` | Yes | FLOWING |
| `boards-route.mjs` | search source config | `sourceConfigGet/Put({ name: 'search-sources' })` | Yes | FLOWING |
| `search-route.mjs` | scan sources/results | `sourceConfigGet()` and `readDbScannerRows()` | Yes | FLOWING |
| `scan-sourced.mjs` | duplicate context | `buildDbSeenSets()` in DB mode | Yes | FLOWING |
| `onboard-route.mjs` + `FinishStep.jsx` | `searchSourcesPresent` / `configReady` | `existsSync(config/search-sources.yml)` in DB mode | No | HOLLOW/LEGACY FILE |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Final backend quick route/static guard | `node --test tests/dashboard-route.test.mjs tests/data-route.test.mjs tests/packet-route.test.mjs tests/search-route.test.mjs tests/boards-route.test.mjs tests/desktop-routing.test.mjs tests/db-app-shell-regression.test.mjs` | 62 pass, 0 fail | PASS |
| React nav canonical product surface | `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` | 2 pass, 0 fail | PASS |
| Review-fix regression set | `node --test tests/scan-sourced.test.mjs tests/packet-route.test.mjs tests/packet-page.test.mjs tests/search-route.test.mjs tests/db-app-shell-regression.test.mjs` | 50 pass, 0 fail | PASS |
| Syntax checks for migrated route/helper files | `node --check ...` for tracker-dev, packet, boards, search, scan-sourced, scan-context | no syntax errors | PASS |

### Probe Execution

| Probe | Command | Result | Status |
|---|---|---|---|
| None | Probe discovery found no declared or conventional `probe-*.sh` files for this phase. | skipped | SKIP |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| APP-01 | 06-01, 06-04, 06-08 | `/app` is canonical product surface; compatibility surfaces are not normal UX. | BLOCKED | Nav and generated tracker/feed route copy are verified, but `/app/onboarding` still links to `/onboard`. |
| APP-02 | 06-02, 06-03, 06-05, 06-06, 06-07, 06-08 | Dashboard, packet, tracker/activity, scanner context, and source setup views read DB-derived snapshots. | BLOCKED | Most route families are DB-derived, but DB-mode onboarding source setup still reads compatibility YAML presence. |
| APP-03 | 06-01, 06-02, 06-03, 06-05, 06-06, 06-07, 06-08 | `workspace/tracker.json` and `workspace/activity.jsonl` are compatibility/export artifacts only. | SATISFIED | Product static guard passed; packet/search/data/dashboard paths do not read generated tracker/activity as source of truth. |
| APP-04 | 06-01, 06-04, 06-07, 06-08 | Static regression guards prevent product routes or React app code from depending on generated tracker/activity files. | SATISFIED | `tests/db-app-shell-regression.test.mjs` passed and scans the planned product boundary. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| None | - | Debt markers/stubs | - | No `TBD`, `FIXME`, `XXX`, `TODO`, placeholder, or console-only implementation markers found in the scanned Phase 6 files. |

### Human Verification Required

None. The unresolved items are code/route dependency gaps, not visual or external-service uncertainty.

### Gaps Summary

The phase should not proceed as fully verified. The passing final rollup proves the planned migrated route surface, but the actual React product path still has an unverified/unmigrated onboarding source-setup seam:

1. `/app/onboarding` still advertises the legacy `/onboard` static page.
2. DB-mode onboarding source readiness still depends on `config/search-sources.yml`.

Structured gaps are in the YAML frontmatter for `$gsd-plan-phase --gaps`.

---

_Verified: 2026-07-05T17:52:18Z_
_Verifier: the agent (gsd-verifier)_
