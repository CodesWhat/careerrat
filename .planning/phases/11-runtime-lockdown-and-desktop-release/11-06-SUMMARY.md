---
phase: 11-runtime-lockdown-and-desktop-release
plan: "06"
subsystem: desktop-release-docs
tags: [desktop, release-docs, notarization, app-first, runtime-lockdown, tdd]

requires:
  - phase: 11-runtime-lockdown-and-desktop-release
    provides: [SEC-01 app-default runtime guard, SEC-02 app-safe runtime profiles, DESK-01 signed/notarized packaging readiness]
provides:
  - Desktop docs truthfulness guard for pilot-facing release docs
  - App-first desktop README with signed/notarized pilot package guidance
  - Release checklist evidence requirements for signed/notarized desktop pilots
  - Architecture wording for app-safe default tools and explicit retained tool-heavy runtime
affects: [desktop-release, pilot-docs, release-verification, runtime-routing, DESK-02]

tech-stack:
  added: []
  patterns:
    - node:test static documentation guard
    - Phrase-based docs assertions instead of snapshots
    - Release-critical docs updates only

key-files:
  created:
    - tests/desktop-docs-release.test.mjs
    - .planning/phases/11-runtime-lockdown-and-desktop-release/11-06-SUMMARY.md
  modified:
    - apps/desktop/README.md
    - docs/RELEASE.md
    - docs/ARCHITECTURE.md

key-decisions:
  - "DESK-02 docs truthfulness is scoped to the desktop README, release checklist, and architecture runtime boundary rather than a broad documentation rewrite."
  - "The desktop pilot docs name Electron `/app` and `/app/onboarding` as the normal product path; generated tracker/static pages are compatibility/debug/export support only."
  - "Auto-update wording is readiness-only: the package is signed/notarized for future updater work, but the desktop app does not install updates itself."

patterns-established:
  - "Desktop pilot docs are guarded by focused node:test assertions over only pilot-facing docs."
  - "Release docs describe credential mechanisms without storing Apple account, team, password, or keychain-profile values."

requirements-completed: [DESK-02, SEC-01, SEC-02]

coverage:
  - id: D1
    description: "Desktop docs release guard pins app-first, notarization, update-readiness, and runtime-boundary truthfulness across pilot-facing docs."
    requirement: DESK-02
    verification:
      - kind: unit
        ref: "node --test tests/desktop-docs-release.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Desktop README documents `/app`, `/app/onboarding`, packaged `ROLESTER_HOME`, BYOK storage, signed/notarized DMG verification, and compatibility-surface boundaries."
    requirement: DESK-02
    verification:
      - kind: unit
        ref: "node --test tests/desktop-docs-release.test.mjs tests/release-safety.test.mjs && npm run lint:placeholders"
        status: pass
    human_judgment: false
  - id: D3
    description: "Release and architecture docs require signed/notarized pilot evidence and state app-safe default tools plus explicit tool-heavy retained runtime."
    requirement: DESK-02
    verification:
      - kind: unit
        ref: "node --test tests/desktop-docs-release.test.mjs tests/release-safety.test.mjs && npm run lint:placeholders"
        status: pass
    human_judgment: false

duration: 4 min
completed: 2026-07-06
status: complete
---

# Phase 11 Plan 06: Desktop Docs Truthfulness Summary

**Pilot-facing docs now teach the Electron `/app` desktop path, signed/notarized release evidence, and explicit retained-runtime boundaries.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-06T17:05:04Z
- **Completed:** 2026-07-06T17:08:59Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added `tests/desktop-docs-release.test.mjs`, a focused guard for only the desktop README, release checklist, and architecture runtime boundary.
- Replaced stale desktop README wording that treated notarization as deferred with signed/notarized DMG guidance, packaged data-root/BYOK docs, and app-first `/app` routing.
- Added release checklist evidence for stapling, Gatekeeper assessment, fresh/existing workspace smoke, checkout independence, and Apple credential exclusion.
- Updated architecture docs to name the app-safe default tools and explicit tool-heavy retained runtime, while keeping compatibility/static tracker pages out of normal product UX.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the desktop docs release guard** - `3138da8` (test)
2. **Task 2: Update pilot-facing app-first docs** - `0a64eb8` (docs)

**Plan metadata:** committed after this SUMMARY is written.

## Files Created/Modified

- `tests/desktop-docs-release.test.mjs` - Static docs truthfulness guard for DESK-02 pilot-facing docs.
- `apps/desktop/README.md` - Documents Electron `/app` as the pilot product path, packaged `ROLESTER_HOME`, BYOK storage, signed/notarized DMG verification, compatibility-surface boundaries, and update-readiness truth.
- `docs/RELEASE.md` - Adds desktop pilot release checks for signed/notarized DMG evidence, stapling, Gatekeeper assessment, fresh/existing workspace smoke, no checkout dependency, and credential exclusion.
- `docs/ARCHITECTURE.md` - Adds app-safe default tool profile and explicit tool-heavy retained runtime wording.

## Verification

- PASS: RED run failed before docs updates, including the intended stale README failure on `Notarization (deferred)`.
- PASS: `node --test tests/desktop-docs-release.test.mjs`
- PASS: `node --test tests/desktop-docs-release.test.mjs tests/release-safety.test.mjs && npm run lint:placeholders`
- PASS: Static scan found no stale deferred-notarization wording, placeholder brackets, local absolute paths, Apple credential placeholders, or automatic-update claims in the touched pilot docs.
- PASS: Pre-commit structure guards and Biome checks passed for both task commits.

## Decisions Made

- Kept DESK-02 scoped to release-critical pilot docs instead of rewriting broader open-core or agent documentation.
- Treated signed/notarized DMG output as the pilot release target while keeping unsigned checkout runs as development-only.
- Documented auto-update readiness without claiming the desktop app currently installs updates.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- During Task 2, the architecture tool-list phrase wrapped across a Markdown line and missed the exact guard assertion. The docs wording was adjusted before commit so the guard proves the intended phrase directly.
- During close-out, `state.advance-plan` could not parse this workspace's older STATE.md current-plan shape; `state.update-progress`, `state.record-metric`, `state.record-session`, and `roadmap.update-plan-progress` succeeded, and the stale frontmatter percent was patched to the handler's computed 78%.
- `requirements.mark-complete` reported DESK-02 as `not_found` in this workspace's traceability shape, so the DESK-02 traceability row was patched directly to `Complete`.

## Authentication Gates

None.

## User Setup Required

None - no external service configuration required for this docs plan.

## Known Stubs

None. Stub-pattern scanning found only the existing release checklist line that says the placeholder linter must be clean; no TODO, FIXME, placeholder text, empty UI data source, or unfinished runtime value was introduced.

## Threat Flags

None. This plan added documentation and test-only guard coverage. It introduced no new network endpoint, auth path, schema, or file-access trust boundary beyond the planned docs-to-pilot and docs-to-release-credentials boundaries.

## TDD Gate Compliance

- RED gate: `3138da8` added the failing desktop docs release guard and verified it failed on current stale docs.
- GREEN gate: `0a64eb8` updated the pilot-facing docs so the focused guard and release-safety checks passed.
- Refactor gate was not needed.

## Next Phase Readiness

DESK-02 is complete and guarded. Phase 11 can proceed to Plan 11-07 for the final focused verification rollup and signed/notarized artifact evidence.

## Self-Check: PASSED

- Found `tests/desktop-docs-release.test.mjs`.
- Found `.planning/phases/11-runtime-lockdown-and-desktop-release/11-06-SUMMARY.md`.
- Found task commits `3138da8` and `0a64eb8`.
- Re-ran `node --test tests/desktop-docs-release.test.mjs tests/release-safety.test.mjs && npm run lint:placeholders` successfully after both task commits.

---
*Phase: 11-runtime-lockdown-and-desktop-release*
*Completed: 2026-07-06*
