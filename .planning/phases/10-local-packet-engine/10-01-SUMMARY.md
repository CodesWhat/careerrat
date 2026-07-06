---
phase: 10-local-packet-engine
plan: 01
subsystem: testing
tags: [packet, local-api, bounded-ai, node-test, sqlite, pdf, docx]

requires: []
provides:
  - Wave 0 RED contracts for local packet route and runtime-boundary behavior
  - Wave 0 RED contracts for packet generation, evidence grounding, answer capture, and EEO exclusion
  - Wave 0 RED contracts for packet export defaults, conditional DOCX, and DB-owned artifact stamping
affects: [10-local-packet-engine, packet, apply-flow, dashboard-runtime]

tech-stack:
  added: []
  patterns:
    - node:test RED contracts using temp SQLite fixtures
    - Static byte-boundary assertions for packet and answer page runtime defaults
    - Dependency-injected packet export contract around existing document export helpers

key-files:
  created:
    - tests/packet-generate-route.test.mjs
    - tests/packet-runtime-boundary.test.mjs
    - tests/packet-engine.test.mjs
    - tests/packet-answers.test.mjs
    - tests/packet-export.test.mjs
  modified:
    - tests/packet-page.test.mjs
    - tests/answer-page.test.mjs

key-decisions:
  - "Plan 10-01 intentionally ships RED contracts only; wrappers pass by proving Phase 10 packet owners are still missing."
  - "Ordinary packet and answer UI defaults are treated as local packet API calls, while explicit retained skill runtime remains allowed outside that path."
  - "Packet export contracts require PDF by default and DOCX only for explicit selection or captured upload requirements."

patterns-established:
  - "RED wrappers use `node --test ...; test $? -ne 0` so future implementation waves can flip the underlying tests green."
  - "Packet tests seed temp SQLite directly and assert generated tracker exports are not source-of-truth inputs."
  - "Outbound packet contracts use private/current-comp sentinels and unsupported-claim checks to prevent upload-ready leakage."

requirements-completed: [PKT-01, PKT-02, PKT-03, PKT-04]

coverage:
  - id: D1
    description: "RED local route and runtime-boundary contracts cover packet gate/generate APIs, DB-missing and malformed-body behavior, local UI defaults, and retained-runtime separation."
    requirement: PKT-01
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/packet-generate-route.test.mjs tests/packet-runtime-boundary.test.mjs tests/packet-page.test.mjs tests/answer-page.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D2
    description: "RED packet engine contracts cover evidence-linked cover-letter prose, forbidden unsupported claims, NEEDS YOU gaps, upload-ready blocking, and captured questions in the packet manifest."
    requirement: PKT-02
    verification:
      - kind: unit
        ref: "bash -lc 'node --test tests/packet-engine.test.mjs tests/packet-answers.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D3
    description: "RED answer contracts cover provider-normalized and manual-paste question capture, durable question metadata, non-EEO answer drafting, and demographic/self-ID exclusion."
    requirement: PKT-03
    verification:
      - kind: unit
        ref: "bash -lc 'node --test tests/packet-engine.test.mjs tests/packet-answers.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D4
    description: "RED export contracts cover ATS-safe PDF defaults, conditional DOCX, internal source markdown separation, existing export-helper delegation, and DB-owned packet artifact stamping."
    requirement: PKT-04
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/packet-export.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-07-06
status: complete
---

# Phase 10 Plan 01: Local Packet Engine RED Contracts Summary

**Wave 0 RED packet contracts for local APIs, evidence-grounded packet content, non-EEO answer drafting, and PDF-first exports**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-06T14:58:40Z
- **Completed:** 2026-07-06T15:04:26Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- Added RED local packet route and runtime-boundary tests for `POST /api/packet/gate`, `POST /api/packet/generate`, local packet/answer UI defaults, retained-runtime separation, and DB-backed artifact stamping expectations.
- Added RED packet engine and answer tests for evidence-linked cover-letter prose, captured question persistence, non-EEO answer drafting, private/current-comp leakage prevention, unsupported-claim gaps, and upload-ready blocking.
- Added RED packet export tests for ATS-safe PDF defaults, DOCX only when selected or required, internal source markdown separation, existing export-helper reuse, and DB-owned packet artifact stamping.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add RED local route and runtime-boundary contracts** - `9e3a2e9` (test)
2. **Task 2: Add RED packet engine and answer contracts** - `e3538aa` (test)
3. **Task 3: Add RED export contracts** - `05d1c87` (test)

## Files Created/Modified

- `tests/packet-generate-route.test.mjs` - RED route contracts for local gate/generate POST behavior and DB artifact stamping.
- `tests/packet-runtime-boundary.test.mjs` - Static guard that ordinary packet and answer flows do not default to `/api/skill/run`.
- `tests/packet-engine.test.mjs` - RED packet-generation contracts for evidence-backed prose, manifest questions, gaps, and forbidden private claims.
- `tests/packet-answers.test.mjs` - RED question capture and answer-drafting contracts with provider/manual fixtures and EEO exclusion.
- `tests/packet-export.test.mjs` - RED packet-export contracts for PDF defaults, conditional DOCX, internal markdown sources, and DB-owned stamping.
- `tests/packet-page.test.mjs` - Updated byte-static packet page expectations for local packet generate defaults.
- `tests/answer-page.test.mjs` - Updated byte-static answer page expectations for local packet answer defaults.

## Decisions Made

- Wave 0 remains test-only and intentionally RED; the verification wrappers pass because the underlying tests fail against missing Phase 10 implementation.
- Packet and answer page ordinary actions now have tests requiring local packet APIs by default, with the retained skill runtime preserved only as an explicit outside path.
- Export contracts require PDF as the standard user-facing format and keep DOCX conditional on explicit user selection or captured board requirements.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes; implementation remains deferred to later Phase 10 plans.

## Issues Encountered

- After the Task 3 amend, HEAD had been switched externally to `gsd/phase-11-runtime-lockdown-and-desktop-release`. The working tree was clean, the three Task 10-01 commits existed on `gsd/phase-10-local-packet-engine`, and execution resumed after switching back to the Phase 10 branch.

## Known Stubs

None. Stub scan found only test helper defaults and negative assertions against existing "coming soon" text, not product stubs or UI placeholders introduced by this plan.

## User Setup Required

None - no external service configuration required.

## Verification

- `bash -lc 'node --test tests/packet-generate-route.test.mjs tests/packet-runtime-boundary.test.mjs tests/packet-page.test.mjs tests/answer-page.test.mjs; test $? -ne 0'` - passed; 7 intended RED failures.
- `bash -lc 'node --test tests/packet-engine.test.mjs tests/packet-answers.test.mjs; test $? -ne 0'` - passed; 7 intended RED failures for missing `src/core/packet/*` modules.
- `bash -lc 'node --test tests/packet-export.test.mjs; test $? -ne 0'` - passed; 4 intended RED failures for missing `src/core/packet/exports.mjs`.

## Self-Check: PASSED

- Created files exist: `tests/packet-generate-route.test.mjs`, `tests/packet-runtime-boundary.test.mjs`, `tests/packet-engine.test.mjs`, `tests/packet-answers.test.mjs`, `tests/packet-export.test.mjs`.
- Task commits found: `9e3a2e9`, `e3538aa`, `05d1c87`.
- Plan verification wrappers passed with intended RED failures against missing Phase 10 implementation.

## Next Phase Readiness

Phase 10 implementation plans can now use these RED contracts as the starting gate for local packet route owners, packet core modules, question/answer capture, and export/stamping behavior.

---
*Phase: 10-local-packet-engine*
*Completed: 2026-07-06*
