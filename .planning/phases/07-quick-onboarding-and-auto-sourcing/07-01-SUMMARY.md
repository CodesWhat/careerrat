---
phase: 07-quick-onboarding-and-auto-sourcing
plan: 01
subsystem: testing
tags: [node-test, vitest, onboarding, docx, resume-intake]

requires:
  - phase: 06-canonical-db-app-shell
    provides: React `/app` and SQLite-backed onboarding state are canonical product paths.
provides:
  - RED backend route contracts for deterministic DOCX resume upload.
  - RED React ResumeStep contracts for PDF-standard and DOCX board-required packet preferences.
  - RED React ResumeStep contracts for DOCX upload routing, review reuse, and paste fallback copy.
affects: [07-04-docx-implementation, 10-local-packet-engine]

tech-stack:
  added: []
  patterns:
    - In-test minimal DOCX ZIP fixture generation for backend upload contracts.
    - Vitest `renderToStaticMarkup` plus exported helper contracts for ResumeStep behavior.

key-files:
  created:
    - apps/web/src/onboarding/steps/ResumeStep.test.jsx
  modified:
    - tests/onboard-route.test.mjs

key-decisions:
  - "Plan 07-01 is intentionally RED and test-only; implementation remains in later Phase 7 plans."
  - "Backend DOCX route tests generate a minimal valid DOCX fixture in test code instead of committing a binary fixture."
  - "ResumeStep tests separate resume input parsing from packet output-format preferences."

patterns-established:
  - "DOCX intake tests assert original upload preservation before source-resume readiness is granted."
  - "Frontend tests keep packet format preferences under form-defaults.document_formats, separate from extractResumeDocx/extractResumeAi parsing paths."

requirements-completed: [ONB-02]

coverage:
  - id: D1
    description: "Backend RED contracts for /api/onboard/resume-docx valid, empty, oversized, and no-AI behavior"
    requirement: ONB-02
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/onboard-route.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D2
    description: "ResumeStep RED contracts for PDF-standard/DOCX-board-required packet format preferences"
    requirement: ONB-02
    verification:
      - kind: unit
        ref: "bash -lc 'npm --workspace apps/web run test -- src/onboarding/steps/ResumeStep.test.jsx; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D3
    description: "ResumeStep RED contracts for DOCX accept list, deterministic wrapper routing, review reuse, and 422 paste fallback copy"
    requirement: ONB-02
    verification:
      - kind: unit
        ref: "bash -lc 'npm --workspace apps/web run test -- src/onboarding/steps/ResumeStep.test.jsx; test $? -ne 0'"
        status: pass
    human_judgment: false

duration: 6 min
completed: 2026-07-05
status: complete
---

# Phase 07 Plan 01: Add RED DOCX Resume Intake Contracts Summary

**RED backend and React contracts for deterministic DOCX resume intake plus PDF-standard/DOCX-board-required format preferences**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-05T21:28:56Z
- **Completed:** 2026-07-05T21:35:41Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

- Added backend RED tests for `POST /api/onboard/resume-docx?name=<filename>` covering valid DOCX parsing, saved originals, source-resume readiness, empty extraction fallback, oversized input, and no-AI behavior.
- Created `ResumeStep.test.jsx` with RED packet-format preference contracts: PDF remains standard, DOCX can be marked board-required, and persistence goes through `saveCandidateFile("form-defaults", { document_formats: ... })`.
- Extended `ResumeStep.test.jsx` with RED DOCX intake contracts for `.docx` accept-list support, deterministic `extractResumeDocx` routing, existing Review & edit reuse, and the exact UI-SPEC 422 fallback copy.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add RED backend DOCX intake tests** - `01503d8` (test)
2. **Task 2: Add RED ResumeStep document format preference tests** - `b637367` (test)
3. **Task 3: Add RED ResumeStep DOCX intake tests** - `adc8190` (test)

## Files Created/Modified

- `tests/onboard-route.test.mjs` - Adds in-test DOCX fixture generation and RED route tests for deterministic DOCX intake.
- `apps/web/src/onboarding/steps/ResumeStep.test.jsx` - New Vitest coverage for packet-format preferences and DOCX upload UI/helper contracts.

## Verification

- `bash -lc 'node --test tests/onboard-route.test.mjs; test $? -ne 0'` passed as a RED wrapper. Underlying result: 53 tests, 50 pass, 3 fail. The three failures are the new DOCX route tests, currently receiving `404` instead of expected `200`, `422`, and `413`.
- `bash -lc 'npm --workspace apps/web run test -- src/onboarding/steps/ResumeStep.test.jsx; test $? -ne 0'` passed as a RED wrapper. Underlying result: 7 tests, 7 fail because packet-format UI, `.docx` accept support, and ResumeStep DOCX helper contracts are not implemented yet.

## Decisions Made

- Kept this plan test-only and intentionally RED; no production route, parser, dependency, API wrapper, or React implementation was added.
- Used a generated minimal DOCX ZIP fixture in `tests/onboard-route.test.mjs` so implementation must parse real DOCX bytes without adding a binary fixture to the repo.
- Defined output packet preferences as `form-defaults.document_formats`, explicitly separate from input parsing through `extractResumeDocx`, `extractResumeAi`, and `parseResumeText`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. The failing underlying backend and frontend tests are the expected RED evidence for this plan.

## Known Stubs

None. New mocks and empty objects/arrays are test fixtures only and do not introduce runtime UI stubs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 07-02. Plan 07-04 will use these RED contracts when implementing deterministic DOCX upload through onboarding.

## Self-Check

PASSED.

- Found `tests/onboard-route.test.mjs`.
- Found `apps/web/src/onboarding/steps/ResumeStep.test.jsx`.
- Found `.planning/phases/07-quick-onboarding-and-auto-sourcing/07-01-SUMMARY.md`.
- Found task commits `01503d8`, `b637367`, and `adc8190`.
- Coverage metadata validated with `gsd-tools.cjs uat classify-coverage`.

---
*Phase: 07-quick-onboarding-and-auto-sourcing*
*Completed: 2026-07-05*
