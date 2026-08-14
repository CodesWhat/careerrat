---
phase: 03-company-discovery-api
plan: "03"
subsystem: discovery
tags: [resolver, ats, url-safety, cache, tdd]

requires:
  - phase: 03-company-discovery-api
    provides: DB-owned resolver cache and proposal state from Plan 03-02
provides:
  - Deterministic company board resolver with safe URL validation, redirect/link caps, supported ATS inference, and cache persistence
  - Resolver refresh constants and reason enum for TTL, scan, zero-job, failure, and explicit refresh decisions
  - Hermetic resolver tests covering unsafe targets, supported ATS resolution, unsupported public cache-only records, and refresh logic
affects: [company-discovery-api, proposal-generation, discovery-decisions]

tech-stack:
  added: []
  patterns:
    - Injected fetchImpl and lookupHost seams for hermetic resolver tests
    - Pure URL safety and refresh helpers exported from the resolver module
    - DB cache writes performed after network resolution, outside DB transactions

key-files:
  created:
    - tests/company-board-resolver.test.mjs
  modified:
    - src/core/discovery/company-board-resolver.mjs

key-decisions:
  - "Seed URL hints remain untrusted until resolver checks scheme, host, DNS/lookup result, redirects, and supported provider identity."
  - "Supported ATS promotion uses sourced-scanner inferProvider(); unsupported public pages are persisted as cache-only and non-promotable."
  - "Resolver refresh policy exports the pinned Phase 03 constants and REFRESH_REASONS enum for downstream decision plans."

patterns-established:
  - "resolveCompanyBoard() returns camelCase route-facing resolution data while persisting D-15 snake_case cache records."
  - "resolutionNeedsRefresh() is the pure helper for explicit, TTL, scan-status, zero-job, failure-threshold, and stored-reason refresh checks."

requirements-completed: [DISC-02]

coverage:
  - id: D1
    description: "Resolver constants and REFRESH_REASONS match the resolved Phase 03 research decisions."
    requirement: DISC-02
    verification:
      - kind: unit
        ref: "tests/company-board-resolver.test.mjs#exports the pinned company discovery resolver constants and refresh reasons"
        status: pass
    human_judgment: false
  - id: D2
    description: "Unsafe schemes, localhost/private hosts, and unsafe redirect targets are rejected before cache promotion."
    requirement: DISC-02
    verification:
      - kind: unit
        ref: "tests/company-board-resolver.test.mjs#rejects unsafe scheme and local/private host hints before cache promotion"
        status: pass
      - kind: unit
        ref: "tests/company-board-resolver.test.mjs#rejects redirect targets that become local or private"
        status: pass
    human_judgment: false
  - id: D3
    description: "Supported ATS hints and homepage/careers links resolve through inferProvider() and persist provider/cache metadata."
    requirement: DISC-02
    verification:
      - kind: unit
        ref: "tests/company-board-resolver.test.mjs#resolves a supported ATS hint through provider inference and persists cache metadata"
        status: pass
      - kind: unit
        ref: "tests/company-board-resolver.test.mjs#discovers a supported ATS board from public homepage and careers links within the redirect cap"
        status: pass
    human_judgment: false
  - id: D4
    description: "Unsupported public pages persist as cache-only records and refresh decisions use pinned threshold logic."
    requirement: DISC-02
    verification:
      - kind: unit
        ref: "tests/company-board-resolver.test.mjs#persists unsupported public pages as cache-only and non-promotable"
        status: pass
      - kind: unit
        ref: "tests/company-board-resolver.test.mjs#resolutionNeedsRefresh covers explicit, stale, scan, threshold, and stored enum reasons"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-07-04
status: complete
---

# Phase 03 Plan 03: Deterministic Company Board Resolver Summary

**Safe deterministic company board resolution with supported ATS inference, cache-only unsupported pages, and pinned refresh policy.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-05T00:09:41Z
- **Completed:** 2026-07-05T00:15:04Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Added resolver constants, `REFRESH_REASONS`, pure company-key, host-safety, and refresh-decision helpers.
- Hardened `resolveCompanyBoard()` with scheme, local/private host, lookup, redirect, timeout, link-hop, provider identity, and cache freshness checks.
- Persisted supported ATS rows with provider/API/provenance metadata and unsupported public pages as non-promotable cache-only rows.
- Added hermetic node:test coverage with injected `fetchImpl` and `lookupHost` seams.

## Task Commits

1. **RED: failing company board resolver tests** - `53b9fff` (test)
2. **GREEN: hardened resolver implementation** - `0a689b3` (feat)

**Plan metadata:** recorded by the docs commit that adds this SUMMARY.

## Files Created/Modified

- `tests/company-board-resolver.test.mjs` - TDD coverage for constants, unsafe target rejection, supported ATS resolution, unsupported public cache-only behavior, and refresh triggers.
- `src/core/discovery/company-board-resolver.mjs` - Hardened deterministic resolver with safe URL handling, provider inference, cache reads/writes, and refresh helpers.

## Decisions Made

- Seed URL hints are treated only as discovery inputs; supported output requires resolver-owned URL safety checks and `inferProvider()` validation.
- Unsupported public careers pages remain useful cache/provenance records but return `proposedAction: "cache-only"` and `promotable: false`.
- The resolver writes cache records only after network/URL checks complete, keeping public HTTP calls outside DB transactions.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The first GREEN run exposed a test fixture key mismatch for normalized root URLs (`https://acme.example/` vs `https://acme.example`). The fixture was corrected and the focused command passed.
- The pre-commit Biome hook removed one unused implementation parameter during the GREEN commit. The focused command was rerun after commit and passed.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. The stub-pattern scan only found benign default parameters, local helper arrays, and test fixture defaults.

## Threat Flags

None. The new public fetch resolver surface is the planned T-03-03 trust boundary and includes the required scheme, host, DNS/lookup, redirect, timeout, and provider-identity mitigations.

## TDD Gate Compliance

- **RED:** `53b9fff test(03-03): add failing company board resolver tests`
- **GREEN:** `0a689b3 feat(03-03): harden company board resolver`
- **REFACTOR:** not needed

## Verification

- RED command: `node --test tests/company-board-resolver.test.mjs tests/sourced-scanner.test.mjs tests/company-discovery-cache-db.test.mjs tests/company-proposals-route.test.mjs` - FAIL as expected before implementation (`REFRESH_REASONS` export missing).
- GREEN command: `node --test tests/company-board-resolver.test.mjs tests/sourced-scanner.test.mjs tests/company-discovery-cache-db.test.mjs tests/company-proposals-route.test.mjs` - PASS (40 tests).
- Post-GREEN commit command: `node --test tests/company-board-resolver.test.mjs tests/sourced-scanner.test.mjs tests/company-discovery-cache-db.test.mjs tests/company-proposals-route.test.mjs` - PASS (40 tests).
- Boundary check: `rg -n "runBoundedAI|callAI|runStructuredOneshot|runSkill|skill-runtime|companyAtsUpsert|sourcedUpsert|writeTracker|tracker\\.json|activity\\.jsonl|sourceConfigPut" src/core/discovery/company-board-resolver.mjs` - PASS (no matches).

## Next Phase Readiness

Ready for Plan 03-04 to add bounded/manual company seed generation on top of the hardened resolver boundary.

## Self-Check: PASSED

- Verified `src/core/discovery/company-board-resolver.mjs` exists.
- Verified `tests/company-board-resolver.test.mjs` exists.
- Verified commits `53b9fff` and `0a689b3` exist in git history.
- Verified the plan automated command exits 0 after implementation.
- Verified task commits did not delete tracked files.

---
*Phase: 03-company-discovery-api*
*Completed: 2026-07-04*
