---
phase: 09-public-company-intelligence-and-scanner-cascade
plan: 04
subsystem: public-scanner-ai
tags: [bounded-ai, public-intel, scanner, privacy]

requires:
  - phase: 09-public-company-intelligence-and-scanner-cascade
    plan: 03
    provides: Deterministic scanner cascade and local public-intel routes
provides:
  - Bounded AI public careers-page extraction helper
  - AI eligibility and retry behavior for ambiguous public pages
  - Cascade integration that keeps model output advisory until deterministic validation
affects: [bounded-ai, public-intel, scanner]

tech-stack:
  added: []
  patterns: [runBoundedAI native-preferred mode, JSON Schema extraction, deterministic post-validation]

key-files:
  created:
    - src/core/discovery/public-scanner-ai.mjs
  modified:
    - src/core/discovery/public-page-extractor.mjs
    - src/core/discovery/scanner-cascade.mjs

key-decisions:
  - "AI fallback runs only for ambiguous usable public text after deterministic extraction."
  - "Model output is never source-config authority; candidate URLs/providers remain advisory until deterministic validation passes."
  - "AI failure/manual envelopes, review metadata, and scanner responses omit raw prompts, model text, page text, and private keys."

requirements-completed: [PUB-02, PUB-03, DSC-03]

coverage:
  - id: D1
    description: "Bounded public scanner AI helper uses native-preferred structured output, one retry, safe failure envelopes, and no raw prompt/model/page text leakage."
    requirement: PUB-02
    verification:
      - kind: unit
        ref: "node --test tests/public-scanner-ai.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Scanner cascade calls AI only after ambiguous reachable public text and keeps AI candidates advisory until deterministic validation."
    requirement: DSC-03
    verification:
      - kind: integration
        ref: "node --test tests/public-scanner-cascade.test.mjs tests/public-scanner-ai.test.mjs tests/public-intel-scrub.test.mjs"
        status: pass
    human_judgment: false

duration: 4 min
completed: 2026-07-06
status: complete
---

# Phase 09 Plan 04: Bounded Public Scanner AI Summary

**Last-resort structured extraction for ambiguous public careers pages**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-06T13:45:02Z
- **Completed:** 2026-07-06T13:48:25Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Added `extractAmbiguousPublicCareersPage()` using `runBoundedAI()` in native-preferred mode with labels `discover-companies/scanner-cascade/public-careers-extract`.
- Added a strict public careers extraction schema, one corrective retry, safe manual fallback, public text sanitization, and input hashing.
- Wired scanner ambiguity through the AI helper while stripping internal page text from returned and persisted scanner data.
- Kept AI candidates advisory: deterministic validation must pass before any future public write approval, and source-config writes remain untouched.

## Task Commits

1. **Tasks 1-3: Bounded AI helper and cascade integration** - `d2b5913` (feat)

## Verification

- `node --test tests/public-scanner-ai.test.mjs tests/public-scanner-cascade.test.mjs tests/public-intel-scrub.test.mjs tests/bounded-ai.test.mjs` - pass
- Pre-commit structure guards and Biome - pass

## Deviations from Plan

None - AI remains a last-resort scanner fallback and does not approve writes.

## Issues Encountered

None blocking.

## User Setup Required

None.

## Next Phase Readiness

Ready for Plan 09-05: public-intel review queue, decisions, and review UI affordances.

---
*Phase: 09-public-company-intelligence-and-scanner-cascade*
*Completed: 2026-07-06*
