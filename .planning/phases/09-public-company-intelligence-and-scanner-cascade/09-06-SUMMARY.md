---
phase: 09-public-company-intelligence-and-scanner-cascade
plan: 06
subsystem: public-intel-verification
tags: [privacy, runtime-routing, docs, verification]

requires:
  - phase: 09-public-company-intelligence-and-scanner-cascade
    plan: 02
    provides: Public-intel storage and scrub validation
  - phase: 09-public-company-intelligence-and-scanner-cascade
    plan: 03
    provides: Deterministic scanner cascade
  - phase: 09-public-company-intelligence-and-scanner-cascade
    plan: 04
    provides: Bounded scanner AI fallback
  - phase: 09-public-company-intelligence-and-scanner-cascade
    plan: 05
    provides: Public-intel review queue and UI
provides:
  - Static runtime guards for public-intel route and scanner modules
  - Sync-preview contamination guards for private source config, sourced rows, postings, and page bodies
  - Architecture/source documentation for the public metadata lane
  - Final Phase 09 verification rollup
affects: [public-intel, discovery, scanner-cascade, docs]

tech-stack:
  added: []
  patterns: [static route slice guard, public scrub fail-closed validation, docs-aligned runtime boundary]

key-files:
  modified:
    - docs/ARCHITECTURE.md
    - docs/SOURCES.md
    - src/core/discovery/public-intel-scrub.mjs
    - tests/deep-ingest-db.test.mjs
    - tests/public-intel-db.test.mjs
    - tests/public-intel-route.test.mjs
    - tests/public-intel-scrub.test.mjs

key-decisions:
  - "Public-intel route and scanner modules are statically guarded against chat, retained skill runtime, and /api/skill/run seams."
  - "Sync-preview-shaped payloads fail closed when they include private source config, search sources, sourced rows, job postings, page text, raw AI, local paths, or candidate-private fields."
  - "Docs now define the public metadata lane, scanner cascade order, no-AI no-result branches, and explicit supported-ATS review approval boundary."

requirements-completed: [PUB-01, PUB-02, PUB-03, DSC-01, DSC-02, DSC-03]

coverage:
  - id: D1
    description: "Public-intel route slice and scanner modules do not contain hidden chat, retained skill runtime, or skill-run calls."
    requirement: DSC-03
    verification:
      - kind: static
        ref: "node --test tests/public-intel-route.test.mjs tests/public-intel-scrub.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Public scrub blocks private sync-preview contamination and individual posting/page-body data."
    requirement: PUB-02
    verification:
      - kind: unit
        ref: "node --test tests/public-intel-db.test.mjs tests/public-intel-scrub.test.mjs tests/public-scanner-cascade.test.mjs tests/public-scanner-ai.test.mjs tests/public-intel-route.test.mjs tests/onboard-public-sync.test.mjs tests/public-intel-review.test.mjs tests/discovery-route.test.mjs tests/company-discovery-regression.test.mjs tests/bounded-ai.test.mjs tests/onboard-page.test.mjs tests/search-page.test.mjs tests/deep-ingest-db.test.mjs tests/release-safety.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Architecture and source docs match the shipped public-only scanner contract."
    requirement: PUB-01
    verification:
      - kind: docs
        ref: "npm run lint:placeholders"
        status: pass
    human_judgment: false
  - id: D4
    description: "Repo-wide test sweep has no Phase 09 failures; remaining failures are pre-existing Phase 08 Deep ingest AI module/schema gaps."
    requirement: DSC-03
    verification:
      - kind: regression
        ref: "npm test"
        status: blocked-unrelated
    human_judgment: true

duration: 5 min
completed: 2026-07-06
status: complete
---

# Phase 09 Plan 06: Final Guards and Verification Summary

**Lock the public/private boundary and scanner runtime contract**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-06T13:50:52Z
- **Completed:** 2026-07-06T13:55:44Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- Added static public-intel route and scanner module guards that fail if hidden chat, retained skill runtime, `runSkillStream`, `/api/chat`, or `/api/skill/run` seams enter the local public scanner path.
- Tightened public-intel scrub validation for sync-preview-shaped private contamination: source config, search sources, sourced rows, job postings, and page text are rejected.
- Updated architecture and source documentation with public metadata scope, forbidden private data, scanner branch order, bounded AI eligibility, and review queue semantics.
- Fixed direct Phase 09 sweep fallout: migration 008 tests now tolerate later migrations, and public-intel test literals no longer trip release-safety sentinels.

## Task Commits

1. **Tasks 1-3: Privacy guards, docs, and verification fixes** - `ecb4118` (test)

## Verification

- `node --test tests/public-intel-route.test.mjs tests/public-intel-scrub.test.mjs` - pass
- `node --test tests/public-intel-db.test.mjs tests/public-intel-scrub.test.mjs tests/public-scanner-cascade.test.mjs tests/public-scanner-ai.test.mjs tests/public-intel-route.test.mjs tests/onboard-public-sync.test.mjs tests/public-intel-review.test.mjs tests/discovery-route.test.mjs tests/company-discovery-regression.test.mjs tests/bounded-ai.test.mjs tests/onboard-page.test.mjs tests/search-page.test.mjs tests/deep-ingest-db.test.mjs tests/release-safety.test.mjs` - pass
- `npm run lint:placeholders` - pass
- `npm test` - blocked by unrelated Phase 08 Deep ingest AI gaps: missing `config/deep-ingest-proposal.schema.json`, `src/core/deep-ingest/proposals/*`, and `src/core/deep-ingest/validators/{grounding,privacy}.mjs`.

## Deviations from Plan

- The final sweep included `tests/deep-ingest-db.test.mjs` and `tests/release-safety.test.mjs` because migration 009 and new public-intel fixtures directly affected those global guards.

## Issues Encountered

- Full `npm test` still fails only in `tests/deep-ingest-ai.test.mjs` because prior Phase 08 proposal schema/modules are absent. No Phase 09 regression remains in the focused or related regression suite.

## User Setup Required

None.

## Next Phase Readiness

Phase 09 is complete. The next clean handoff is Phase 10 Local Packet Engine planning, with the repo-wide test baseline caveat above.

---
*Phase: 09-public-company-intelligence-and-scanner-cascade*
*Completed: 2026-07-06*
