---
phase: 03-company-discovery-api
plan: "06"
subsystem: api
tags: [discovery, company-proposal-decisions, source-config, sourced-persistence, tdd]

requires:
  - phase: 03-company-discovery-api
    provides: pinned proposal contract, scanner-backed gate, and captured JD artifacts from Plan 03-05
provides:
  - Exact POST /api/discovery/company-proposal-decisions route for approve, reject, suppress, refresh, and escalate decisions
  - Core applyCompanyProposalDecision authority for confirmed supported ATS writes and proposal state transitions
  - Approval-time captured job promotion through sourcedRowsFromScanOffers() and sourcedUpsertBatch()
  - Real refresh behavior through force resolver refresh, supported ATS rescan, proposal regate, and versioned state patching
  - Focused route/DB tests for confirmed writes, no-write decisions, refresh, and conflict envelopes
affects: [company-discovery-api, runtime-routing, verification-and-docs]

tech-stack:
  added: []
  patterns:
    - Thin exact-match HTTP route over injected core decision authority
    - Proposal-version expectedVersion checks with DB batch-version patch protection
    - Confirmation-only source-config and sourced-row writes
    - Refresh-only resolver/scanner/gate flow with no confirmed writes

key-files:
  created:
    - src/core/discovery/company-proposal-decisions.mjs
    - tests/company-proposal-decisions.test.mjs
  modified:
    - src/cli/discovery-route.mjs

key-decisions:
  - "Only approve-supported-ats can call companyAtsUpsert() or sourcedUpsertBatch(); reject, suppress, escalate, and refresh patch proposal state only."
  - "Refresh calls resolveCompanyBoard() with forceRefresh:true and refreshReason:\"explicit-refresh\", rescans supported ATS boards, reruns the gate, and returns refreshed proposal or rejection metadata."
  - "Decision expectedVersion is checked against the proposal version; the DB patch still uses the current batch version to preserve conflict-safe writes."

patterns-established:
  - "Decision routes pass optional dependency seams into applyCompanyProposalDecision() so tests can prove no-write refresh and non-approval behavior."
  - "Approved capturedOffers are converted to sourced rows at decision time, preserving artifacts.jd paths created during proposal generation."
  - "Refreshed offers preserve existing JD artifact paths by URL before capturing newly seen offers."

requirements-completed: [DISC-05]

coverage:
  - id: D1
    description: "Approved high-confidence supported ATS proposals write through companyAtsUpsert() and source-config state, without direct legacy config edits."
    requirement: DISC-05
    verification:
      - kind: integration
        ref: "tests/company-proposal-decisions.test.mjs#POST /api/discovery/company-proposal-decisions approves a pending supported ATS proposal and promotes captured sourced rows"
        status: pass
    human_judgment: false
  - id: D2
    description: "Captured proposal jobs promote through sourced row persistence with JD artifact paths preserved and tracker compatibility export present."
    requirement: DISC-05
    verification:
      - kind: integration
        ref: "tests/company-proposal-decisions.test.mjs#POST /api/discovery/company-proposal-decisions approves a pending supported ATS proposal and promotes captured sourced rows"
        status: pass
    human_judgment: false
  - id: D3
    description: "Reject, suppress, escalate, and refresh decisions update proposal/cache state without source-config, sourced-row, or generated tracker writes."
    requirement: DISC-05
    verification:
      - kind: integration
        ref: "tests/company-proposal-decisions.test.mjs#reject, suppress, and escalate decisions update proposal state without confirmed writes"
        status: pass
      - kind: integration
        ref: "tests/company-proposal-decisions.test.mjs#refresh forces resolver refresh, rescans, reruns the gate, preserves captured JD artifacts, and performs no confirmed writes"
        status: pass
    human_judgment: false
  - id: D4
    description: "Refresh performs force re-resolution, supported ATS rescan, gate rerun, proposal version increment, JD artifact preservation, and refreshed/rejected response metadata."
    requirement: DISC-05
    verification:
      - kind: integration
        ref: "tests/company-proposal-decisions.test.mjs#refresh forces resolver refresh, rescans, reruns the gate, preserves captured JD artifacts, and performs no confirmed writes"
        status: pass
      - kind: integration
        ref: "tests/company-proposal-decisions.test.mjs#refresh returns rejected metadata when the refreshed gate rejects the proposal"
        status: pass
    human_judgment: false
  - id: D5
    description: "Missing records, stale versions, already-decided proposals, unsupported actions, and invalid approvals fail closed with stable 400, 409, or 422 envelopes."
    requirement: DISC-05
    verification:
      - kind: integration
        ref: "tests/company-proposal-decisions.test.mjs#decision endpoint fails closed for missing records, stale versions, decided proposals, unsupported actions, and invalid approvals"
        status: pass
    human_judgment: false

duration: 6 min
completed: 2026-07-05
status: complete
---

# Phase 03 Plan 06: Company Proposal Decisions Summary

**Confirmation decision API for company discovery with supported ATS approval writes, sourced job promotion, real refresh regating, and conflict-safe proposal state.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-05T00:38:33Z
- **Completed:** 2026-07-05T00:45:07Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments

- Added `applyCompanyProposalDecision()` to validate current pending proposal state, enforce `expectedVersion`, and apply approve/reject/suppress/refresh/escalate decisions.
- Added exact `POST /api/discovery/company-proposal-decisions` route with capped JSON parsing and stable error envelopes.
- Implemented confirmation-only writes: approval calls `companyAtsUpsert()`, converts captured offers with `sourcedRowsFromScanOffers()`, and persists rows through `sourcedUpsertBatch()`.
- Implemented real refresh behavior: force resolver refresh, supported ATS rescan, gate rerun, versioned proposal state update, and refreshed proposal or rejection metadata without confirmed writes.
- Added TDD route/DB coverage for approvals, sourced promotion, no-write decisions, refresh, and conflict/validation failure cases.

## Task Commits

1. **Task 1 RED: failing company proposal decision tests** - `e0e785a` (test)
2. **Task 1 GREEN: company proposal decisions implementation** - `8b8e5e8` (feat)

_Note: This was a TDD task, so RED and GREEN were committed separately. No refactor commit was needed._

## Files Created/Modified

- `src/core/discovery/company-proposal-decisions.mjs` - Core decision authority for approval, reject, suppress, refresh, escalate, sourced promotion, and state patching.
- `src/cli/discovery-route.mjs` - Registers the exact decision route and passes injected seams into the core module.
- `tests/company-proposal-decisions.test.mjs` - Covers decision endpoint success, no-write paths, refresh behavior, and fail-closed conflicts.

## Decisions Made

- Only `approve-supported-ats` is allowed to write confirmed source config or sourced rows.
- Refresh remains a behavior path, not a write path: it refreshes resolver/scanner/gate state and patches proposal state only.
- Approval promotes already captured proposal offers to sourced rows without recapturing them, preserving `artifacts.jd`.
- The route layer stays thin; decision authority and validation live in `company-proposal-decisions.mjs`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The first GREEN run classified `expectedVersion: 0` as malformed input. That was corrected to treat integer mismatches as stale-version conflicts (`409 CONFLICT`) before the GREEN commit.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. The stub-pattern scan found only normal optional-argument defaults and local test accumulator arrays.

## Threat Flags

None. The new decision endpoint, source-config write path, sourced-row promotion, refresh path, and conflict checks are all covered by the plan threat model.

## TDD Gate Compliance

- **RED:** `e0e785a test(03-06): add failing company proposal decision tests`
- **GREEN:** `8b8e5e8 feat(03-06): implement company proposal decisions`
- **REFACTOR:** not needed

## Verification

- RED command: `node --test tests/company-proposal-decisions.test.mjs tests/db-source-config.test.mjs tests/companies-cli.test.mjs tests/scan-sourced.test.mjs tests/company-proposals-route.test.mjs tests/company-board-resolver.test.mjs` - FAIL as expected before implementation (missing decision route).
- GREEN command: `node --test tests/company-proposal-decisions.test.mjs tests/db-source-config.test.mjs tests/companies-cli.test.mjs tests/scan-sourced.test.mjs tests/company-proposals-route.test.mjs tests/company-board-resolver.test.mjs` - PASS (34 tests).
- Post-GREEN commit command: `node --test tests/company-proposal-decisions.test.mjs tests/db-source-config.test.mjs tests/companies-cli.test.mjs tests/scan-sourced.test.mjs tests/company-proposals-route.test.mjs tests/company-board-resolver.test.mjs` - PASS (34 tests).
- Anti-pattern scan: `rg -n "config/sourced-scan|workspace/tracker|activity\\.jsonl|writeTracker|captureAndPersistOffersIfDb|sourceConfigPut" src/core/discovery/company-proposal-decisions.mjs src/cli/discovery-route.mjs tests/company-proposal-decisions.test.mjs` - PASS for production code; matches were only test assertions/injected no-write seams.

## Acceptance Criteria

- Approval writes supported ATS config through `companyAtsUpsert()` - PASS.
- Captured jobs promote through sourced verbs with JD artifacts preserved - PASS.
- Refresh performs force re-resolution, optional rescan, regate, and versioned state update without confirmed writes - PASS.
- Non-approval decisions mutate proposal/cache state only - PASS.
- Stale/conflicting decisions fail closed with stable envelopes - PASS.

## Next Phase Readiness

Ready for Plan 03-07 to close the company discovery API phase. The decision/write boundary is now implemented and tested against the proposal contract from Plan 03-05.

## Self-Check: PASSED

- Verified `src/core/discovery/company-proposal-decisions.mjs`, `src/cli/discovery-route.mjs`, and `tests/company-proposal-decisions.test.mjs` exist.
- Verified commits `e0e785a` and `8b8e5e8` exist in git history.
- Verified the plan automated command exits 0 after implementation.
- Verified task commits did not delete tracked files.

---
*Phase: 03-company-discovery-api*
*Completed: 2026-07-05*
