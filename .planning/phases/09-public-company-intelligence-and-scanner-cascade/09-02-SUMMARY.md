---
phase: 09-public-company-intelligence-and-scanner-cascade
plan: 02
subsystem: public-intel-storage
tags: [public-intel, sqlite, scrub, onboarding, sync-preference]

requires:
  - phase: 09-public-company-intelligence-and-scanner-cascade
    plan: 01
    provides: Wave 0 RED public-intel contracts
provides:
  - Migration 009 public-intel schema
  - Scrubbed public-intel DB verbs and sync preview
  - Onboarding public sync preference route and UI controls
affects: [public-intel, onboarding, sqlite]

tech-stack:
  added: []
  patterns: [SQLite JSON payload tables, generated columns, DB verbs, fail-closed scrub traversal]

key-files:
  created:
    - src/core/db/migrations/009-public-intel.mjs
    - src/core/db/verbs/public-intel.mjs
    - src/core/discovery/public-intel-scrub.mjs
  modified:
    - src/core/db/migrations.mjs
    - src/core/db/verbs/index.mjs
    - src/cli/onboard-route.mjs
    - src/core/onboarding/onboard-page.mjs
    - tests/public-intel-db.test.mjs
    - tests/db-migrations.test.mjs

key-decisions:
  - "Public company, board, careers-page, review, and sync-preference state lives in dedicated public_* SQLite tables."
  - "Public sync preference is default-on, local, and exposed through onboarding state plus POST /api/onboard/public-sync-preference."
  - "Public-intel writes and sync previews run scrub validation that blocks candidate, tracker, comp, fit, private notes, local paths, prompts, raw page bodies, and job postings."

requirements-completed: [PUB-01, PUB-02, PUB-03]

coverage:
  - id: D1
    description: "Migration 009 creates public-intel tables with JSON constraints, generated columns, indexes, and migration sequencing."
    requirement: PUB-01
    verification:
      - kind: unit
        ref: "node --test tests/public-intel-db.test.mjs tests/db-migrations.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Public-intel verbs and sync preview round-trip public metadata without leaking private workspace state."
    requirement: PUB-02
    verification:
      - kind: unit
        ref: "node --test tests/public-intel-db.test.mjs tests/public-intel-scrub.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Onboarding exposes and persists the default-on public sync preference with no-private-data copy."
    requirement: PUB-03
    verification:
      - kind: integration
        ref: "node --test tests/onboard-public-sync.test.mjs tests/onboard-page.test.mjs"
        status: pass
    human_judgment: false

duration: 16 min
completed: 2026-07-06
status: complete
---

# Phase 09 Plan 02: Public Intelligence Storage Summary

**Public/private storage boundary, scrub validator, sync preview, and onboarding preference**

## Performance

- **Duration:** 16 min
- **Started:** 2026-07-06T13:24:00Z
- **Completed:** 2026-07-06T13:40:50Z
- **Tasks:** 4
- **Files modified:** 9

## Accomplishments

- Added migration 009 with separate `public_*` tables for company intel, board intel, careers pages, review items, and sync preferences.
- Implemented public-intel DB verbs for scrubbed upserts, state reads, sync preview, preferences, and review decisions.
- Added a fail-closed scrub validator that rejects private candidate/tracker/comp/fit/note/path/prompt/page-body/job-posting payloads before public writes or previews.
- Added onboarding API and byte-static UI controls for the default-on public metadata sharing preference.

## Task Commits

1. **Task 1: Tighten RED storage/preference contracts** - `9bf1518` (test)
2. **Task 2: Public-intel DB tables, verbs, and scrub validator** - `9721526` (feat)
3. **Task 3-4: Onboarding preference and migration verification** - `6923f87` (feat)

## Verification

- `node --test tests/public-intel-db.test.mjs tests/public-intel-scrub.test.mjs tests/onboard-public-sync.test.mjs tests/onboard-page.test.mjs tests/db-migrations.test.mjs` - pass
- Pre-commit structure guards and Biome - pass

## Deviations from Plan

None - plan executed in scope.

## Issues Encountered

- The migration regression test still pinned migration 008 as the latest. Updated it to preserve the 007 -> 008 -> 009 ordering contract.
- The public preference row keeps an internal DB id, but public API responses strip that id and return only `enabled`, `source`, and `updatedAt`.

## User Setup Required

None.

## Next Phase Readiness

Ready for Plan 09-03: deterministic scanner cascade and local public-intel scan routes, with no AI calls in that slice.

---
*Phase: 09-public-company-intelligence-and-scanner-cascade*
*Completed: 2026-07-06*
