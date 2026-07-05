---
phase: 03-company-discovery-api
plan: "05"
subsystem: discovery
tags: [company-proposals, scanner-gate, comp-plausibility, jd-capture, tdd]

requires:
  - phase: 03-company-discovery-api
    provides: bounded/manual company seeds, deterministic resolver, scanner proof, and pending proposal state from Plans 03-01 through 03-04
provides:
  - Pinned camelCase company proposal contract for high-confidence, borderline, unsupported-cache, and rejected states
  - Scanner-backed proposal gate with dedupe, exclusion, in-play, comp plausibility, current-role, and JD-capture checks
  - Proposal generation that captures JD artifacts via offersWithCapturedJobs() without persisting sourced rows before approval
affects: [company-discovery-api, discovery-decisions, runtime-routing, verification-and-docs]

tech-stack:
  added: []
  patterns:
    - Pure proposal gate over resolver output, scanner flags, candidate context, and captured-offer metadata
    - TDD RED/GREEN/REFACTOR with node:test route coverage and hermetic injected scanner/resolver seams
    - Capture-only proposal generation using sourced-persistence artifact helpers while keeping sourced DB writes confirmation-only

key-files:
  created: []
  modified:
    - src/core/discovery/company-proposal-gate.mjs
    - src/core/discovery/company-proposals.mjs
    - tests/company-proposals-route.test.mjs

key-decisions:
  - "High-confidence proposals require supported ATS proof, a current viable role, JD capture, clean dedupe/exclusion/in-play checks, and comp clearing the configured minimum_base."
  - "Unposted, uncertain, or top-of-band-only compensation remains borderline/review-only; below-floor posted compensation rejects with comp-below-floor."
  - "Proposal generation captures JD artifacts with offersWithCapturedJobs() but does not call sourced persistence or confirmed source-config write paths before approval."

patterns-established:
  - "All returned proposal records use the pinned camelCase contract fields; rejected rows carry reason codes for downstream decision routes."
  - "Raw scanner offers without gate metadata are scored/deduped through filterAndDedupeOffers(); injected scanner flags remain authoritative."
  - "Comp checks use minimum_base from sanitized candidate context and never read or return current_base."

requirements-completed: [DISC-03, DISC-04]

coverage:
  - id: D1
    description: "High-confidence supported-ATS proposals return the pinned contract with current role proof, comp-plausible status, approval action, and captured JD artifact paths."
    requirement: DISC-03
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals returns the pinned high-confidence proposal contract with captured JD artifacts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Below-floor, unposted, uncertain, and top-of-band-only compensation signals drive rejected or borderline proposal states without leaking current compensation."
    requirement: DISC-04
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals applies comp-plausibility flags to confidence and reject states"
        status: pass
      - kind: other
        ref: "rg -n \"current_base|current_comp_shareable|145000\" src/core/discovery/company-proposal-gate.mjs src/core/discovery/company-proposals.mjs src/cli/discovery-route.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Borderline supported/unsupported review states return concrete review reasons and never use approve-supported-ats."
    requirement: DISC-04
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals returns review-only non-comp borderline states"
        status: pass
    human_judgment: false
  - id: D4
    description: "Tracked, excluded, already-in-play, unreachable, unsupported-without-cache, no-current-role, and comp-below-floor cases reject with reason codes."
    requirement: DISC-04
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals hard-rejects tracked, excluded, in-play, unreachable, unsupported, and no-role companies"
        status: pass
    human_judgment: false
  - id: D5
    description: "Proposal generation captures reachable JD bodies but does not persist sourced rows or confirmed source-config writes before user approval."
    requirement: DISC-03
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals returns the pinned high-confidence proposal contract with captured JD artifacts"
        status: pass
      - kind: other
        ref: "rg -n \"captureAndPersistOffersIfDb|sourcedUpsertBatch|companyAtsUpsert|sourceConfigPut|writeTracker|tracker\\.json|activity\\.jsonl\" src/core/discovery/company-proposal-gate.mjs src/core/discovery/company-proposals.mjs"
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-07-05
status: complete
---

# Phase 03 Plan 05: Scanner-Backed Proposal Gate Summary

**Scanner-backed company proposal screening with comp plausibility, pinned proposal fields, and capture-only JD evidence.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-07-05T00:29:07Z
- **Completed:** 2026-07-05T00:35:34Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments

- Hardened `buildCompanyProposal()` to emit deterministic high-confidence, borderline, unsupported-cache, and rejected states using the exact camelCase proposal contract.
- Added comp gates for `comp-below-floor`, `comp-unposted`, `comp-uncertain`, and `top-of-band-only`, using `minimum_base` only.
- Wired proposal generation to capture reachable JD artifacts with `offersWithCapturedJobs()` while avoiding confirmed source-config writes and sourced-row persistence.
- Added route coverage for pinned fields, comp states, current-comp privacy, non-comp borderline reasons, hard rejects, and capture-only side effects.

## Task Commits

1. **Task 1 RED: failing proposal gate tests** - `eae4996` (test)
2. **Task 1 GREEN: hardened proposal gate** - `ac063c3` (feat)
3. **Task 1 REFACTOR: comp-state lookup cleanup** - `284abe7` (refactor)

**Plan metadata:** recorded by the docs commit that adds this SUMMARY.

## Files Created/Modified

- `src/core/discovery/company-proposal-gate.mjs` - Adds proposal contract output, dedupe/exclusion/in-play rejects, comp plausibility, unsupported-cache review state, and JD-capture-aware confidence tiers.
- `src/core/discovery/company-proposals.mjs` - Routes scanner output through scoring/dedupe when needed, captures JD artifacts with `offersWithCapturedJobs()`, and passes candidate context/captured offers into the gate.
- `tests/company-proposals-route.test.mjs` - Pins high/borderline/rejected behavior, privacy, JD artifact capture, and no pre-approval persistence.

## Decisions Made

- High confidence is intentionally narrow: supported ATS, viable current role, clear comp, no review-only scanner flags, and captured JD evidence.
- Unsupported public cache records remain review/cache-only and cannot receive `approve-supported-ats`.
- Proposal creation can write local JD artifacts for evidence, but confirmation-only DB/source/sourced writes remain reserved for Plan 03-06.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Existing high-confidence fixtures lacked posted comp after this plan made comp plausibility mandatory. The fixtures were updated to include ranges clearing the configured floor.
- The GREEN commit left one Biome warning for an unused callback parameter. A behavior-neutral refactor commit removed it and the focused command stayed green.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. The stub-pattern scan found only benign optional-argument defaults, local empty accumulator arrays, and test harness defaults.

## Threat Flags

None. The filesystem JD capture, scanner-output trust boundary, comp privacy boundary, and no-persistence boundary were all covered by the plan threat model and tested.

## TDD Gate Compliance

- **RED:** `eae4996 test(03-05): add failing company proposal gate tests`
- **GREEN:** `ac063c3 feat(03-05): harden company proposal gate`
- **REFACTOR:** `284abe7 refactor(03-05): clean up proposal comp state lookup`

## Verification

- RED command: `node --test tests/company-proposals-route.test.mjs tests/search-route.test.mjs tests/scan-sourced.test.mjs tests/sourced-scanner.test.mjs tests/company-discovery-seeds.test.mjs` - FAIL as expected before implementation (new proposal contract, comp, review, and reject expectations failed).
- GREEN/refactor command: `node --test tests/company-proposals-route.test.mjs tests/search-route.test.mjs tests/scan-sourced.test.mjs tests/sourced-scanner.test.mjs tests/company-discovery-seeds.test.mjs` - PASS (61 tests).
- Privacy check: `rg -n "current_base|current_comp_shareable|145000" src/core/discovery/company-proposal-gate.mjs src/core/discovery/company-proposals.mjs src/cli/discovery-route.mjs` - PASS (no matches).
- No pre-approval persistence check: `rg -n "captureAndPersistOffersIfDb|sourcedUpsertBatch|companyAtsUpsert|sourceConfigPut|writeTracker|tracker\\.json|activity\\.jsonl" src/core/discovery/company-proposal-gate.mjs src/core/discovery/company-proposals.mjs` - PASS (no matches).

## Next Phase Readiness

Ready for Plan 03-06 to consume the pinned proposal contract and apply explicit approval/reject/suppress/refresh decisions. Captured offers now carry JD artifact paths for approval-time sourced-row promotion.

## Self-Check: PASSED

- Verified `src/core/discovery/company-proposal-gate.mjs`, `src/core/discovery/company-proposals.mjs`, and `tests/company-proposals-route.test.mjs` exist.
- Verified commits `eae4996`, `ac063c3`, and `284abe7` exist in git history.
- Verified the plan automated command exits 0 after implementation and refactor.
- Verified privacy and no-persistence boundary checks pass.
- Verified task commits did not delete tracked files.

---
*Phase: 03-company-discovery-api*
*Completed: 2026-07-05*
