---
phase: 03-company-discovery-api
plan: "02"
subsystem: database
tags: [sqlite, company-discovery, resolver-cache, proposal-state, tdd]

requires:
  - phase: 03-company-discovery-api
    provides: callable company proposal route and initial pending proposal persistence from Plan 03-01
provides:
  - DB-owned company board resolution cache with generated lookup and due-refresh columns
  - Versioned company discovery proposal batch reads and state patches
  - Focused node:test coverage for migration 006, resolver cache fields, due-refresh thresholds, latest pending lookup, and stale-version conflicts
affects: [company-discovery-api, discovery-decisions, runtime-routing]

tech-stack:
  added: []
  patterns:
    - SQLite JSON tables with generated query columns and explicit indexes
    - DB-only verbs using requireDb() and withTransaction() with no tracker/source exports
    - TDD RED/GREEN coverage for durable discovery cache state

key-files:
  created:
    - tests/company-discovery-cache-db.test.mjs
  modified:
    - src/core/db/migrations/006-company-discovery-cache.mjs
    - src/core/db/verbs/company-discovery.mjs
    - src/core/db/verbs/index.mjs

key-decisions:
  - "Resolver cache and proposal state remain DB-owned app state; source-config, sourced rows, activity, and generated tracker/dashboard files are not written by these verbs."
  - "Due-refresh logic uses the pinned Phase 03 constants: 14-day TTL, failure threshold 2, and zero-job threshold 2."
  - "Proposal state patches require expectedVersion and return code CONFLICT without mutating stored JSON on stale attempts."

patterns-established:
  - "company_board_resolutions stores D-15 resolver fields as JSON with generated lookup columns for cache reads and refresh scans."
  - "company_discovery_proposals stores batch JSON with generated status/version/created_at columns for latest-pending and conflict-safe decisions."

requirements-completed: [DISC-02, DISC-04, DISC-05]

coverage:
  - id: D1
    description: "Migration 006 creates company_board_resolutions and company_discovery_proposals with JSON constraints, generated columns, and query indexes."
    requirement: DISC-02
    verification:
      - kind: integration
        ref: "node --test tests/company-discovery-cache-db.test.mjs tests/company-proposals-route.test.mjs tests/db-source-config.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Resolver cache upsert/get preserves D-15 fields and due-refresh reads use pinned TTL, failure, zero-job, status, provider-change, extraction, and stored-reason triggers."
    requirement: DISC-02
    verification:
      - kind: integration
        ref: "tests/company-discovery-cache-db.test.mjs#company board resolution tests"
        status: pass
    human_judgment: false
  - id: D3
    description: "Proposal batches can be put, read by id, read as latest pending, and patched with expectedVersion conflict protection."
    requirement: DISC-04
    verification:
      - kind: integration
        ref: "tests/company-discovery-cache-db.test.mjs#proposal batches support get/latest pending reads and version-conflict patches"
        status: pass
    human_judgment: false
  - id: D4
    description: "DB cache/proposal verbs do not create tracker, activity, or legacy sourced-scan compatibility files."
    requirement: DISC-05
    verification:
      - kind: integration
        ref: "tests/company-discovery-cache-db.test.mjs#generated-file absence assertions"
        status: pass
    human_judgment: false

duration: 4min
completed: 2026-07-04
status: complete
---

# Phase 03 Plan 02: DB-Owned Resolver Cache and Proposal State Summary

**SQLite resolver cache and versioned proposal state for company discovery, with due-refresh and stale-decision protection.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-05T00:02:16Z
- **Completed:** 2026-07-05T00:06:25Z
- **Tasks:** 1
- **Files modified:** 4

## Accomplishments

- Added `company_board_resolutions` to migration 006 with JSON validity, generated lookup columns, and indexes for company key, provider, status, verification time, and due-refresh scans.
- Expanded `company_discovery_proposals` with generated `version` and `created_at` columns plus latest-pending indexing.
- Added DB-only verbs for resolver cache upsert/get/due-list and proposal batch get/latest/patch-state with `CONFLICT` stale-version protection.
- Added focused DB tests for migration shape, D-15 cache field round-trips, pinned refresh triggers, latest pending reads, stale conflicts, and no generated-file writes.

## Task Commits

1. **RED: failing DB cache tests** - `7a4f4e7` (test)
2. **GREEN: DB cache/proposal implementation** - `1acccd3` (feat)

**Plan metadata:** recorded by the docs commit that adds this SUMMARY.

## Files Created/Modified

- `tests/company-discovery-cache-db.test.mjs` - TDD coverage for migration 006, resolver cache verbs, proposal state verbs, conflict behavior, and generated-file absence.
- `src/core/db/migrations/006-company-discovery-cache.mjs` - Adds resolver cache table and hardens proposal table generated columns/indexes.
- `src/core/db/verbs/company-discovery.mjs` - Implements DB-only cache/proposal verbs and pinned due-refresh logic.
- `src/core/db/verbs/index.mjs` - Re-exports the new company discovery DB verb surface.

## Decisions Made

- Resolver cache rows use `company_key` as the DB row id and generated lookup column, matching the cache lookup path.
- Generated columns guard `json_extract()` behind `json_valid(data)` so malformed payloads are rejected by the table JSON constraint instead of surfacing low-level extraction errors.
- Latest pending proposal lookup orders by generated `created_at` first and `updated_at` second, while accepting both existing `createdAt` route batches and new `created_at` test fixtures.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The first GREEN run showed SQLite evaluates generated `json_extract()` expressions before the `json_valid(data)` check reports cleanly on malformed JSON. The migration now wraps generated expressions with `CASE WHEN json_valid(data)`; the focused test command then passed.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. The stub-pattern scan only found benign empty test arrays and optional parameter defaults.

## Threat Flags

None. The new DB tables, generated indexes, expected-version conflict handling, and generated-file non-write assertions match the plan threat model.

## TDD Gate Compliance

- **RED:** `7a4f4e7 test(03-02): add failing DB cache tests`
- **GREEN:** `1acccd3 feat(03-02): harden company discovery DB state`
- **REFACTOR:** not needed

## Verification

- RED command: `node --test tests/company-discovery-cache-db.test.mjs tests/company-proposals-route.test.mjs tests/db-source-config.test.mjs` - FAIL as expected before implementation (`companyBoardResolutionGet` export missing).
- GREEN command: `node --test tests/company-discovery-cache-db.test.mjs tests/company-proposals-route.test.mjs tests/db-source-config.test.mjs` - PASS (8 tests).
- Pre-commit hooks on both commits: PASS (`structure-guards`; `biome check --write` on staged files).

## Next Phase Readiness

Ready for Plan 03-03 to build deterministic resolver behavior on top of the durable cache surface. The DB state now preserves proposal versions and resolver refresh state without writing confirmed source config or generated dashboard artifacts.

## Self-Check: PASSED

- Verified all created/modified key files exist.
- Verified commits `7a4f4e7` and `1acccd3` exist in git history.
- Verified the plan automated command exits 0 after implementation.
- Verified task commits did not delete tracked files.

---
*Phase: 03-company-discovery-api*
*Completed: 2026-07-04*
