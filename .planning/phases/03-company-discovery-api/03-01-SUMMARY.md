---
phase: 03-company-discovery-api
plan: "01"
subsystem: api
tags: [discovery, company-proposals, sqlite, node-http, tdd]

requires:
  - phase: 01-decomposition-map
    provides: discover-companies target contract and routing boundaries
  - phase: 02-bounded-ai-foundation
    provides: bounded AI/no-AI envelope conventions used by later discovery plans
provides:
  - Exact POST /api/discovery/company-proposals route for manual supported-ATS proposal batches
  - DB-owned pending company proposal persistence through company_discovery_proposals
  - Deterministic resolver seam and confirm-first proposal gate for the first vertical slice
  - Route tests proving no full skill/chat runtime, source-config writes, sourced writes, or tracker/dashboard writes during proposal generation
affects: [company-discovery-api, runtime-routing, verification-and-docs]

tech-stack:
  added: []
  patterns:
    - Thin exact-match HTTP route over injected core orchestration
    - DB-owned pending proposal state with confirmation-only source/sourced writes
    - TDD RED/GREEN route slice using node:test and temp SQLite workspaces

key-files:
  created:
    - src/core/discovery/company-board-resolver.mjs
    - src/core/discovery/company-proposal-gate.mjs
    - src/core/discovery/company-proposals.mjs
    - src/core/db/migrations/006-company-discovery-cache.mjs
    - src/core/db/verbs/company-discovery.mjs
    - tests/company-proposals-route.test.mjs
  modified:
    - src/cli/discovery-route.mjs
    - src/core/db/migrations.mjs
    - src/core/db/verbs/index.mjs

key-decisions:
  - "Proposal generation persists pending review state only; source-config, sourced rows, and generated tracker/dashboard files remain confirmation-only."
  - "The Phase 03 batch maximum is pinned at COMPANY_DISCOVERY_BATCH_MAX = 12."
  - "The route is an exact thin adapter that delegates resolver, scanner, and persistence behavior to core seams."

patterns-established:
  - "Manual company seeds flow through capped JSON -> injected resolver -> injected scanner -> proposal gate -> DB proposal batch."
  - "company_discovery_proposals stores versioned pending proposal batches without bumping tracker metadata or exporting dashboard files."

requirements-completed: [DISC-01, DISC-02, DISC-03, DISC-04]

coverage:
  - id: D1
    description: "POST /api/discovery/company-proposals creates a manual supported-ATS proposal batch."
    requirement: DISC-01
    verification:
      - kind: integration
        ref: "node --test tests/company-proposals-route.test.mjs tests/discovery-route.test.mjs tests/db-source-config.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Proposal generation resolves and scans through deterministic injected seams and returns confirm-first proposal metadata."
    requirement: DISC-02
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals creates a persisted manual-seed proposal batch without confirmed writes"
        status: pass
    human_judgment: false
  - id: D3
    description: "Current-role scanner proof produces high-confidence approve-supported-ats metadata without confirmed writes."
    requirement: DISC-03
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals creates a persisted manual-seed proposal batch without confirmed writes"
        status: pass
    human_judgment: false
  - id: D4
    description: "Malformed JSON maps to 400, over-12 seed batches map to 422, and generation avoids chat/runtime/source/sourced/tracker writes."
    requirement: DISC-04
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#malformed JSON and over-12 seed batch tests"
        status: pass
    human_judgment: false

duration: 4min
completed: 2026-07-04
status: complete
---

# Phase 03 Plan 01: Callable Manual-Seed Company Proposal Slice Summary

**Manual supported-ATS company proposal route with pending SQLite proposal batches and no confirmed discovery writes.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-04T23:53:18Z
- **Completed:** 2026-07-04T23:57:30Z
- **Tasks:** 1
- **Files modified:** 9

## Accomplishments

- Added exact `POST /api/discovery/company-proposals` route using capped JSON parsing and stable success/error envelopes.
- Added core proposal orchestration, deterministic resolver seam, confirm-first gate, and DB-owned proposal batch persistence.
- Added TDD route coverage for manual seed success, malformed JSON, batch max 12, persisted batch readback, and no chat/full-skill/source/sourced/tracker writes.

## Task Commits

1. **RED: failing company proposal route test** - `f56b203` (test)
2. **GREEN: company proposal route slice** - `8e935ce` (feat)

**Plan metadata:** recorded by the docs commit that adds this SUMMARY.

## Files Created/Modified

- `src/cli/discovery-route.mjs` - Registers the exact company proposal route and maps parse/core errors to JSON envelopes.
- `src/core/discovery/company-board-resolver.mjs` - Exposes `COMPANY_DISCOVERY_BATCH_MAX = 12` and the minimal supported-ATS resolver seam.
- `src/core/discovery/company-proposal-gate.mjs` - Builds high-confidence confirm-first proposal metadata from resolution and scan results.
- `src/core/discovery/company-proposals.mjs` - Normalizes manual seeds, invokes resolver/scanner seams, persists pending batches, and returns route data.
- `src/core/db/migrations/006-company-discovery-cache.mjs` - Adds `company_discovery_proposals`.
- `src/core/db/migrations.mjs` - Registers migration 006.
- `src/core/db/verbs/company-discovery.mjs` - Adds `companyProposalBatchPut()` and `companyProposalBatchLatest()`.
- `src/core/db/verbs/index.mjs` - Re-exports company discovery proposal verbs.
- `tests/company-proposals-route.test.mjs` - Covers the TDD route slice and no-confirmed-write invariants.

## Decisions Made

- Proposal creation is limited to pending DB proposal state; tracked company source config and sourced rows are left for explicit decision routes.
- The first resolver implementation only accepts supported ATS URL hints by provider inference; tests inject a deterministic resolver for plain manual domain hints.
- No refactor commit was created because the GREEN implementation did not need behavior-neutral cleanup.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The first GREEN run exposed a route-test harness issue: the shared capped body reader expects Buffer chunks from HTTP requests. The test harness was corrected to use `Buffer.from(rawBody)`, then the focused command passed.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. The stub-pattern scan only found benign local defaults, empty test arrays, and existing optional-argument defaults.

## Threat Flags

None. The new route, capped body parsing, DB proposal state, version field, and no-confirmed-write assertions match the plan threat model.

## TDD Gate Compliance

- **RED:** `f56b203 test(03-01): add failing company proposal route test`
- **GREEN:** `8e935ce feat(03-01): implement company proposal route slice`
- **REFACTOR:** not needed

## Verification

- `node --test tests/company-proposals-route.test.mjs tests/discovery-route.test.mjs tests/db-source-config.test.mjs` - PASS (12 tests)

## Next Phase Readiness

Ready for Plan 03-02 to expand resolver/cache/proposal fields. The callable vertical slice now exists and preserves the confirmation boundary for later decision/write plans.

## Self-Check: PASSED

- Verified all created/modified key files exist.
- Verified commits `f56b203` and `8e935ce` exist in git history.
- Verified the plan automated command exits 0.

---
*Phase: 03-company-discovery-api*
*Completed: 2026-07-04*
