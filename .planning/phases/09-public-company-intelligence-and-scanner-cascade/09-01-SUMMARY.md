---
phase: 09-public-company-intelligence-and-scanner-cascade
plan: 01
subsystem: testing
tags: [public-intel, sqlite, scanner, bounded-ai, onboarding, review]

requires:
  - phase: 09-public-company-intelligence-and-scanner-cascade
    provides: Phase 09 context, research, UI, AI, and validation contracts
provides:
  - Wave 0 RED tests for public-intel DB, scrub, scanner, AI, routes, onboarding, and review decisions
  - Public/private separation contracts before implementation code
  - Route and UI hooks for later public-intel implementation plans
affects: [public-intel, discovery, onboarding, scanner, bounded-ai]

tech-stack:
  added: []
  patterns: [node:test RED contracts, temp DB fixtures, dependency-injected route tests]

key-files:
  created:
    - tests/public-intel-db.test.mjs
    - tests/public-intel-scrub.test.mjs
    - tests/public-scanner-cascade.test.mjs
    - tests/public-scanner-ai.test.mjs
    - tests/public-intel-route.test.mjs
    - tests/onboard-public-sync.test.mjs
    - tests/public-intel-review.test.mjs
  modified: []

key-decisions:
  - "Public-intel implementation will expose verbs from src/core/db/verbs/public-intel.mjs."
  - "Scanner cascade tests use injected resolver, fetch, AI, and source-config seams."
  - "Onboarding consent tests require default-on local preference plus explicit no-private-data copy."

patterns-established:
  - "RED wrappers pass only when underlying Phase 09 contract tests fail against missing implementation."
  - "Public sync preview tests serialize outputs and assert no candidate, tracker, comp, fit, local path, or job-posting leakage."

requirements-completed: [PUB-01, PUB-02, PUB-03, DSC-01, DSC-02, DSC-03]

coverage:
  - id: D1
    description: "RED public DB and scrub contracts cover public tables, preview scope, and fail-closed privacy denial."
    requirement: PUB-02
    verification:
      - kind: unit
        ref: "bash -lc 'node --test tests/public-intel-db.test.mjs tests/public-intel-scrub.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D2
    description: "RED scanner and bounded-AI contracts cover deterministic branch order, no-result silence, and AI eligibility."
    requirement: DSC-03
    verification:
      - kind: unit
        ref: "bash -lc 'node --test tests/public-scanner-cascade.test.mjs tests/public-scanner-ai.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D3
    description: "RED local route, onboarding, and review contracts cover public-intel APIs, consent UI, and versioned decisions."
    requirement: PUB-03
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/public-intel-route.test.mjs tests/onboard-public-sync.test.mjs tests/public-intel-review.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false

duration: 10 min
completed: 2026-07-06
status: complete
---

# Phase 09 Plan 01: Wave 0 Validation Foundation Summary

**RED contracts for public company intelligence, scanner cascade, bounded AI, onboarding consent, and review decisions**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-06T13:23:00Z
- **Completed:** 2026-07-06T13:33:04Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- Added seven failing contract suites for the Phase 09 public-intel data, API, scanner, AI, UI, and review surfaces.
- Verified every Wave 0 wrapper passes because the underlying tests fail against the intentionally missing implementation.
- Captured privacy boundaries for private candidate data, compensation, fit state, local paths, raw AI data, page bodies, and individual job postings.

## Task Commits

1. **Task 1-3: Add RED public intelligence contracts** - `55f4198` (test)

**Plan metadata:** pending in this summary commit.

## Files Created/Modified

- `tests/public-intel-db.test.mjs` - Migration, public-table, verb, sync-preview, and default preference contracts.
- `tests/public-intel-scrub.test.mjs` - Fail-closed public payload scrub contracts.
- `tests/public-scanner-cascade.test.mjs` - Deterministic scanner branch and no-AI/no-review contracts.
- `tests/public-scanner-ai.test.mjs` - Bounded AI eligibility, retry, schema, and deterministic-validation contracts.
- `tests/public-intel-route.test.mjs` - Local public-intel route and no runtime fallback contracts.
- `tests/onboard-public-sync.test.mjs` - Onboarding public sync preference route/UI contracts.
- `tests/public-intel-review.test.mjs` - Review queue, decision, conflict, and action-label contracts.

## Decisions Made

- Public-intel DB work will add a dedicated public verbs module rather than overloading candidate/source-config verbs.
- Scanner and route implementations must remain dependency-injected so tests can prove no hidden chat or skill-runtime fallback.
- The onboarding UI contract requires stable public-sync hooks and explicit no-private-data copy on the page itself.

## Deviations from Plan

None - plan executed exactly as written.

---

**Total deviations:** 0 auto-fixed.
**Impact on plan:** None.

## Issues Encountered

The initial onboarding RED fixture failed on incomplete temp-root templates; the fixture was corrected so it now fails on the intended missing public-sync preference fields and route.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 09-02 to implement migration 009, public-intel verbs, scrub validation, and onboarding preference wiring against the RED contracts.

---
*Phase: 09-public-company-intelligence-and-scanner-cascade*
*Completed: 2026-07-06*
