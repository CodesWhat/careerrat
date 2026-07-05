---
phase: 07-quick-onboarding-and-auto-sourcing
plan: 04
subsystem: onboarding
tags: [docx, mammoth, resume-intake, react, sqlite, form-defaults]

requires:
  - phase: 07-01
    provides: RED DOCX/backend and document-format contracts for ONB-02
  - phase: 07-03
    provides: RED ResumeStep/first-search UI contracts and document-format test context
provides:
  - Mammoth-backed deterministic DOCX resume parsing and onboarding route
  - ResumeStep DOCX upload flow that stays local and preserves PDF/image AI extraction
  - Schema-backed packet document-format preferences defaulting to PDF
affects: [10-local-packet-engine, onboarding, packet-generation]

tech-stack:
  added: [mammoth@1.12.0]
  patterns:
    - Raw browser file upload routes save original bytes before local parsing
    - Candidate source-resume readiness is set only after a parser quality gate passes
    - Packet output requirements live in form-defaults.document_formats

key-files:
  created:
    - src/core/onboarding/resume-docx.mjs
  modified:
    - package.json
    - package-lock.json
    - src/cli/onboard-route.mjs
    - tests/onboard-route.test.mjs
    - apps/web/src/lib/api.js
    - apps/web/src/onboarding/steps/ResumeStep.jsx
    - apps/web/src/onboarding/steps/ResumeStep.test.jsx
    - config/form-defaults.schema.json
    - src/core/db/verbs/candidate.mjs

key-decisions:
  - "Use mammoth.extractRawText({ buffer }) only; no DOCX HTML conversion or external file access."
  - "Save DOCX originals under workspace/intake/resume-uploads/ before parsing, but write source-resume only after usable text passes the quality gate."
  - "Keep PDF as default_packet_format and record DOCX only in required_export_formats when a board requires it."

patterns-established:
  - "DOCX intake mirrors raw resume-ai upload mechanics while returning the text-resume seed shape."
  - "Frontend upload mode selection is explicit by extension: DOCX/text local, PDF/image AI-gated, unsupported fallback."
  - "Form-defaults schema owns packet export choices for later packet generation."

requirements-completed: [ONB-02]

coverage:
  - id: D1
    description: "DOCX uploads are parsed locally with Mammoth, original bytes are retained, usable text unlocks source-resume readiness, and unusable text returns fallback guidance without readiness."
    requirement: ONB-02
    verification:
      - kind: integration
        ref: "node --test tests/onboard-route.test.mjs"
        status: pass
      - kind: other
        ref: "npx biome check src/core/onboarding/resume-docx.mjs src/cli/onboard-route.mjs tests/onboard-route.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "ResumeStep accepts DOCX with or without an AI key, routes DOCX to the deterministic API path, and shows UI-SPEC fallback copy on unusable DOCX."
    requirement: ONB-02
    verification:
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/ResumeStep.test.jsx"
        status: pass
      - kind: other
        ref: "npx biome check apps/web/src/lib/api.js apps/web/src/onboarding/steps/ResumeStep.jsx apps/web/src/onboarding/steps/ResumeStep.test.jsx"
        status: pass
    human_judgment: false
  - id: D3
    description: "Packet format preferences are schema-backed, default to PDF, accept DOCX as a board-required export, and reject unknown formats."
    requirement: ONB-02
    verification:
      - kind: integration
        ref: "node --test tests/candidate-setup.test.mjs"
        status: pass
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/ResumeStep.test.jsx"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-07-05
status: complete
---

# Phase 07 Plan 04: Deterministic DOCX Onboarding Summary

**Mammoth-backed DOCX resume intake with local parser gating, React upload routing, and PDF-default packet format preferences**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-05T22:13:58Z
- **Completed:** 2026-07-05T22:21:42Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Added `mammoth@1.12.0` and `src/core/onboarding/resume-docx.mjs` for deterministic DOCX raw-text extraction, normalization, and resume-likeness gating.
- Added `POST /api/onboard/resume-docx` with extension/size guards, original upload retention, stable JSON success/error bodies, and `source-resume` writes only after usable extraction.
- Updated `ResumeStep` to accept DOCX regardless of AI key state, keep TXT/Markdown local, keep PDF/image on the AI path, and show the exact DOCX fallback copy.
- Added `form-defaults.document_formats` with PDF default and optional DOCX board-required export tracking for later packet generation.

## Task Commits

1. **Task 1: Add Mammoth-backed DOCX parser and route** - `32a5424` (RED test), `9acfd83` (GREEN implementation)
2. **Task 2: Wire DOCX upload through React ResumeStep** - `bba0db3` (RED test), `d392066` (test contract alignment), `ae99f7d` (GREEN implementation)
3. **Task 3: Persist packet export format needs** - `411203b` (GREEN implementation using existing RED candidate contract)

## Files Created/Modified

- `src/core/onboarding/resume-docx.mjs` - Mammoth raw-text extraction, normalization, and usable-resume heuristics.
- `src/cli/onboard-route.mjs` - DOCX upload route with capped raw body reads, upload retention, parser quality gate, and source-resume readiness write.
- `package.json` / `package-lock.json` - Runtime `mammoth@1.12.0` dependency.
- `tests/onboard-route.test.mjs` - DOCX route coverage for success, unusable text, oversized body, and non-DOCX rejection.
- `apps/web/src/lib/api.js` - Raw DOCX upload wrapper preserving `ApiError` behavior.
- `apps/web/src/onboarding/steps/ResumeStep.jsx` - DOCX/text/AI upload mode routing, fallback copy, and packet format preference controls.
- `apps/web/src/onboarding/steps/ResumeStep.test.jsx` - Component contracts for DOCX intake, fallback copy, and packet preference payload/display.
- `config/form-defaults.schema.json` - `document_formats` schema with `pdf`/`docx` enums and no nested extra properties.
- `src/core/db/verbs/candidate.mjs` - PDF default packet format and empty board-required export defaults.

## Decisions Made

- DOCX parsing uses `mammoth.extractRawText({ buffer })` only, so uploaded DOCX bytes are not rendered to HTML and no external file access is enabled.
- The original DOCX is retained even when extraction is unusable, but readiness is not advanced until `looksLikeUsableResumeText()` passes.
- Packet generation remains PDF-first; DOCX is modeled as an additional board-required export need rather than an extraction or AI requirement.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test contract drift] Aligned stale ResumeStep document-format expectations**
- **Found during:** Task 2
- **Issue:** The frontend test contract still referenced the older `standard` / `board_required` shape while the plan and backend contract use `default_packet_format` / `required_export_formats`.
- **Fix:** Updated the ResumeStep test expectations to the plan-backed `document_formats` schema shape.
- **Files modified:** `apps/web/src/onboarding/steps/ResumeStep.test.jsx`
- **Verification:** `npm --workspace apps/web run test -- src/onboarding/steps/ResumeStep.test.jsx`
- **Committed in:** `d392066`

**Total deviations:** 1 auto-fixed Rule 1 issue
**Impact on plan:** No scope expansion; this kept the tests aligned with the planned storage contract.

## Threat Mitigations

- **T-07-01:** DOCX filenames are sanitized and stored only below `workspace/intake/resume-uploads/`.
- **T-07-02:** DOCX request bodies are capped before Mammoth extraction.
- **T-07-03:** The parser uses raw-text extraction only, with no HTML conversion or external file access.
- **T-07-04:** `source-resume` is written only after the local quality gate passes.
- **T-07-05:** Packet export formats are restricted to `pdf` and `docx` by schema and tests.
- **T-07-SC:** Installed exactly the researched package/version, `mammoth@1.12.0`.

## Issues Encountered

- `state.advance-plan` could not parse this `STATE.md` plan-counter format, so other GSD helpers were used and the helper-produced roadmap/progress artifacts were corrected manually.
- Biome caught a control-character regex in the initial DOCX normalizer draft; the implementation was changed to character-code filtering before the Task 1 GREEN commit.
- A ResumeStep assertion used an invalid Chai property chain after the RED commit; the assertion was corrected in the Task 2 GREEN commit.

## Verification

- `node --test tests/onboard-route.test.mjs` — passed, 54 tests.
- `node --test tests/candidate-setup.test.mjs` — passed, 13 tests.
- `npm --workspace apps/web run test -- src/onboarding/steps/ResumeStep.test.jsx` — passed, 8 tests.
- `npx biome check src/core/onboarding/resume-docx.mjs src/cli/onboard-route.mjs tests/onboard-route.test.mjs apps/web/src/lib/api.js apps/web/src/onboarding/steps/ResumeStep.jsx apps/web/src/onboarding/steps/ResumeStep.test.jsx config/form-defaults.schema.json src/core/db/verbs/candidate.mjs tests/candidate-setup.test.mjs package.json package-lock.json` — passed.
- `npm ls mammoth --depth=0` — passed, `mammoth@1.12.0`.
- `npm audit --omit=dev --json` — no high or critical findings; two existing moderate Next/PostCSS findings remain out of scope.

## Known Stubs

None. Stub scan hits were intentional UI placeholders, default accumulator values, or existing placeholder-lint tests.

## Deferred Issues

- `npm audit --omit=dev --json` reports two existing moderate findings in the `next` / bundled `postcss` chain. They were not introduced by DOCX intake and require a separate framework dependency decision.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 10 can consume `form-defaults.document_formats` for packet generation and DOCX export decisions. Quick onboarding can now accept DOCX locally while preserving the existing PDF/image AI extraction route.

## Self-Check: PASSED

- Verified `07-04-SUMMARY.md`, `src/core/onboarding/resume-docx.mjs`, and all key modified source/config files exist.
- Verified task commits `32a5424`, `9acfd83`, `bba0db3`, `d392066`, `ae99f7d`, and `411203b` exist in git history.
- Verified the plan commit range contains no tracked file deletions.

---
*Phase: 07-quick-onboarding-and-auto-sourcing*
*Completed: 2026-07-05*
