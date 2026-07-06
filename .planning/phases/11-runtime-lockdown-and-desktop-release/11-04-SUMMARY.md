---
phase: 11-runtime-lockdown-and-desktop-release
plan: "04"
subsystem: desktop-runtime
tags: [desktop, electron, sqlite, byok, runtime-hardening, tdd]

requires:
  - phase: 11-runtime-lockdown-and-desktop-release
    provides: [SEC-01 app-default runtime guard, SEC-02 app-safe runtime tools]
provides:
  - Pure desktop runtime path and external URL safety helpers
  - Packaged ROLESTER_HOME coverage for SQLite migration and BYOK storage
  - Desktop smoke route and built-asset reporting
affects: [desktop-release, packaged-runtime, byok-storage, sqlite-migrations]

tech-stack:
  added: []
  patterns:
    - Pure Electron-free helpers for desktop runtime decisions
    - Packaged data-root tests using real SQLite open/init paths
    - Safe external-open protocol allowlist

key-files:
  created:
    - apps/desktop/desktop-runtime.mjs
    - tests/desktop-runtime.test.mjs
  modified:
    - apps/desktop/main.mjs
    - apps/desktop/desktop-smoke.mjs
    - src/core/ai/ai-env.mjs
    - tests/desktop-smoke.test.mjs
    - tests/ai-env.test.mjs

key-decisions:
  - "Desktop packaged path resolution is centralized in apps/desktop/desktop-runtime.mjs so ROLESTER_HOME is set before dynamic engine imports."
  - "Electron external opens are allowed only for https: and mailto: targets; same-origin navigation stays inside the app and unsafe targets are denied recoverably."
  - "BYOK path resolution now passes the active env into userPath(), so injected packaged ROLESTER_HOME controls both load and write paths."

patterns-established:
  - "Desktop helpers avoid Electron imports so node:test can verify packaged path and external URL policy directly."
  - "Smoke helpers return route and asset evidence after checking health, SPA root, and built assets."

requirements-completed: [DESK-01]

coverage:
  - id: D1
    description: "Packaged desktop runtime resolves ROLESTER_HOME under Electron userData/data and repoRoot under resources/rolester."
    requirement: DESK-01
    verification:
      - kind: unit
        ref: "node --test tests/desktop-runtime.test.mjs tests/desktop-smoke.test.mjs tests/desktop-routing.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Packaged SQLite initialization and BYOK storage land under ROLESTER_HOME, not staged resources or the checkout."
    requirement: DESK-01
    verification:
      - kind: unit
        ref: "tests/desktop-runtime.test.mjs#desktop packaged ROLESTER_HOME storage"
        status: pass
      - kind: unit
        ref: "tests/ai-env.test.mjs#writeLocalAiKey uses ROLESTER_HOME/internal/ai.env when packaged home is set"
        status: pass
    human_judgment: false
  - id: D3
    description: "Electron external-open decisions deny unsafe protocols and desktop smoke reports selected route plus built assets."
    requirement: DESK-01
    verification:
      - kind: unit
        ref: "tests/desktop-runtime.test.mjs#desktop external URL decisions"
        status: pass
      - kind: unit
        ref: "tests/desktop-smoke.test.mjs#desktop smoke HTTP surface verification"
        status: pass
    human_judgment: false

duration: 4m 13s
completed: 2026-07-06
status: complete
---

# Phase 11 Plan 04: Desktop Runtime Paths, Smoke, and External-Link Hardening Summary

**Electron desktop startup now has testable packaged data-root, SQLite migration, BYOK storage, smoke, and safe external-open behavior.**

## Performance

- **Duration:** 4m 13s
- **Started:** 2026-07-06T15:51:56Z
- **Completed:** 2026-07-06T15:56:09Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- Added pure desktop runtime helpers for packaged/dev path resolution and safe external URL decisions.
- Wired Electron main startup to set packaged `ROLESTER_HOME` before dynamic engine imports and to gate every `shell.openExternal()` call.
- Added desktop runtime coverage proving packaged SQLite migrations and BYOK key storage use `<ROLESTER_HOME>` and smoke checks report the selected route and built assets.

## Task Commits

Each task was committed atomically:

1. **Task 1: Pin desktop runtime, DB, BYOK, and external-link safety** - `9f4109a` (test)
2. **Task 2: Wire desktop runtime helpers into Electron main** - `093a5d5` (feat)

**Plan metadata:** committed after this SUMMARY is written.

## Files Created/Modified

- `apps/desktop/desktop-runtime.mjs` - Pure packaged/dev path resolution and external URL decision helpers.
- `apps/desktop/main.mjs` - Uses runtime helpers before engine imports and before external opens.
- `apps/desktop/desktop-smoke.mjs` - Returns selected route and built app asset paths after smoke verification.
- `src/core/ai/ai-env.mjs` - Honors caller-provided `env.ROLESTER_HOME` when resolving BYOK load/write paths.
- `tests/desktop-runtime.test.mjs` - Covers packaged data root, SQLite migration state, BYOK storage, and URL safety helpers.
- `tests/desktop-smoke.test.mjs` - Covers smoke route/asset reporting for first-run and existing workspace routes.
- `tests/ai-env.test.mjs` - Covers packaged BYOK path resolution.

## Verification

- PASS: `node --test tests/desktop-runtime.test.mjs tests/desktop-smoke.test.mjs tests/desktop-routing.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs`
- PASS: pre-commit structure guards and Biome checks on both task commits.
- PASS: TDD gate commits exist in order: `9f4109a` then `093a5d5`.

## Decisions Made

- Desktop runtime decisions live in a pure helper module so behavior is testable without importing Electron.
- External URL handling is protocol allowlist based: `https:` and `mailto:` may leave the app, same-origin URLs remain internal, and malformed or unsafe protocols are denied.
- BYOK load/write functions now pass their injected env through to `userPath()` so packaged tests and Electron startup share the same data-root contract.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Honored injected ROLESTER_HOME in BYOK path resolution**
- **Found during:** Task 2 (Wire desktop runtime helpers into Electron main)
- **Issue:** `loadLocalAiEnv()` and `writeLocalAiKey()` accepted an `env` object but did not pass it to `userPath()`, so tests that simulated packaged `ROLESTER_HOME` wrote under the staged repo's `.rolester` root.
- **Fix:** Passed `{ repoRoot, env }` into `userPath()` for both load and write paths.
- **Files modified:** `src/core/ai/ai-env.mjs`
- **Verification:** `node --test tests/desktop-runtime.test.mjs tests/desktop-smoke.test.mjs tests/desktop-routing.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs`
- **Committed in:** `093a5d5`

---

**Total deviations:** 1 auto-fixed (Rule 2).
**Impact on plan:** The fix was required for the plan's packaged BYOK correctness requirement and stayed within DESK-01.

## Issues Encountered

- `state.advance-plan` could not parse this workspace's older STATE.md current-plan shape, but `state.update-progress`, `state.record-metric`, and `state.record-session` succeeded. The frontmatter progress percent was corrected to match the SDK's reported 48/65 plan count.
- `requirements.mark-complete DESK-01` reported `not_found` against the older traceability-table format, so the `DESK-01` traceability row was patched to `Complete` after the registered handler was attempted.

## Authentication Gates

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub-pattern matches were limited to normal helper defaults, test fixtures, empty arrays, and existing nullable runtime state; no UI-visible placeholder or unwired data source was introduced.

## Threat Flags

None. The new external-open and packaged data-root surfaces were already covered by the plan threat model (`T-11-09`, `T-11-10`, `T-11-11`).

## TDD Gate Compliance

- RED gate: `9f4109a` added failing desktop runtime coverage. The suite failed on missing `desktop-runtime.mjs`, missing smoke report output, and packaged BYOK path behavior.
- GREEN gate: `093a5d5` implemented the helper, Electron wiring, smoke reporting, and BYOK env path fix. The focused suite passed.
- Refactor gate was not needed.

## Next Phase Readiness

DESK-01 runtime path, data-root, BYOK, smoke, and external-link behavior are covered. Phase 11 can continue with retained runtime/chat tool-heavy classification and signed/notarized packaging plans.

## Self-Check: PASSED

- Found `.planning/phases/11-runtime-lockdown-and-desktop-release/11-04-SUMMARY.md`.
- Found `apps/desktop/desktop-runtime.mjs`.
- Found `tests/desktop-runtime.test.mjs`.
- Found task commits `9f4109a` and `093a5d5`.
- Re-ran the plan verification command successfully after both task commits.

---
*Phase: 11-runtime-lockdown-and-desktop-release*
*Completed: 2026-07-06*
