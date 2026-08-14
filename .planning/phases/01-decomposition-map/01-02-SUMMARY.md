---
phase: 01-decomposition-map
plan: "02"
subsystem: architecture
tags:
  - discover-companies
  - target-contract
  - sourcing-cascade
  - resolver-cache
  - jd-capture
dependency_graph:
  requires:
    - .planning/PROJECT.md
    - .planning/REQUIREMENTS.md
    - .planning/ROADMAP.md
    - .planning/phases/01-decomposition-map/01-CONTEXT.md
    - .planning/phases/01-decomposition-map/01-RESEARCH.md
    - .planning/architecture/skill-decomposition.yml
  provides:
    - .planning/architecture/discover-companies-target-contract.md
    - ARCH-02 discover-companies target owner contract
    - D-01 through D-14 decision traceability for company discovery
  affects:
    - .planning/phases/01-decomposition-map/01-03-PLAN.md
    - .planning/phases/01-decomposition-map/01-04-PLAN.md
    - future company-discovery-api phase
    - future verification-and-docs phase
tech_stack:
  added: []
  patterns:
    - planning-only target contract
    - schema-validated AI seed output as untrusted proposal data
    - resolver cache separated from supported ATS promotion
    - first-reachable full JD capture as a discovery invariant
key_files:
  created:
    - .planning/architecture/discover-companies-target-contract.md
  modified:
    - .planning/phases/01-decomposition-map/01-02-SUMMARY.md
key_decisions:
  - Phase 1 remains planning-only; runtime source under src/ was not modified.
  - companySeedSchema seed output is advisory and not write-ready.
  - companyBoardResolutionCache is the durable future resolver cache concept.
  - supported ATS promotion and unsupported public-page cache remain separate write paths.
requirements-completed:
  - ARCH-02
requirements_completed:
  - ARCH-02
coverage:
  - id: D1
    description: Discover-companies target contract with AI seed schema, resolver cache, sourcing cascade, confirmation, and write boundaries.
    requirement: ARCH-02
    verification:
      - kind: other
        ref: node --input-type=module -e "<plan automated contract check>"
        status: pass
      - kind: other
        ref: node --input-type=module -e "<acceptance criteria contract check>"
        status: pass
    human_judgment: false
  - id: D2
    description: D-08/D-09 posture requiring practical scraping priorities and first-reachable full JD capture.
    requirement: ARCH-02
    verification:
      - kind: other
        ref: node --input-type=module -e "<acceptance criteria contract check>"
        status: pass
    human_judgment: false
metrics:
  duration: 2min
  completed: 2026-07-04
  tasks_completed: 1
  files_created: 1
  files_modified: 1
status: complete
---

# Phase 01 Plan 02: Discover Companies Target Contract Summary

Planning-only `discover-companies` target contract covering company seed AI, durable board resolution cache, cheapest-first sourcing, proposal confirmation, and first-reachable JD capture.

## Performance

- **Duration:** 2min
- **Started:** 2026-07-04T18:02:55Z
- **Completed:** 2026-07-04T18:04:54Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Created `.planning/architecture/discover-companies-target-contract.md`.
- Defined `companySeedSchema` as untrusted seed output and `companyBoardResolutionCache` as the durable resolver cache concept.
- Preserved D-08/D-09 posture: optimize for freshness, cost, reliability, cacheability, disappearing postings, and immediate full JD capture.
- Separated `supported ATS promotion` from `unsupported public-page cache` per D-14.

## Tasks Completed

| Task | Name | Commit | Status |
| --- | --- | --- | --- |
| 1 | Specify company discovery pipeline contract | `678fda4` | Complete |

## Requirements Completed

| Requirement | Evidence |
| --- | --- |
| ARCH-02 | The contract maps future `discover-companies` work to existing or planned owners: AI helpers, resolver cache, scanner/extractor cascade, source-config writes, sourced persistence, and retained full skill runtime. |

## Coverage

| Area | Status | Evidence |
| --- | --- | --- |
| Required headings | Complete | Contract includes Phase Boundary, Inputs, AI Seed Schema, Resolver Cache Contract, Cheapest-First Sourcing Cascade, Scanner And Extractor Cascade, Proposal Gate, Confirmation Contract, Write Path, Bakeoff Metrics, Existing Code Owners, and Non-Goals. |
| AI seed schema | Complete | `companySeedSchema` includes `companies[].name`, `companies[].domain_hint`, `companies[].why`, `companies[].role_family_hint`, `companies[].confidence`, and `companies[].source_hint`; output is explicitly not write-ready. |
| Resolver cache | Complete | `companyBoardResolutionCache` includes all D-04/D-05/D-06 fields and refresh triggers. |
| Sourcing cascade | Complete | Cheapest-first lanes are listed in exact order from existing DB/source config through full skill runtime. |
| Scraping and JD capture posture | Complete | D-08 and D-09 language is explicit; authenticated browser automation is outside Phase 1. |

## Verification Results

| Command | Result |
| --- | --- |
| Plan automated `node --input-type=module -e ...` contract check | PASS |
| Additional acceptance criteria `node --input-type=module` check for headings, schema fields, cache fields, lanes, and supported/unsupported separation | PASS |
| `test -f tests/decomposition-map.test.mjs && node --test tests/decomposition-map.test.mjs || printf ...` | SKIP: `tests/decomposition-map.test.mjs` is created by Plan 01-04, so this later-phase verification is not available yet. |
| Commit hook structure guards | PASS |

## Files Created/Modified

- `.planning/architecture/discover-companies-target-contract.md` - Target contract for the future decomposed company discovery pipeline.
- `.planning/phases/01-decomposition-map/01-02-SUMMARY.md` - Execution summary and verification evidence for this plan.

## Decisions Made

- Kept this plan inside `.planning/` only; no runtime files under `src/` were changed.
- Documented model output as seed/proposal data only; deterministic resolver and confirmation paths own final URLs and writes.
- Preserved the supported ATS scanner path while adding a separate future cache for unsupported/custom public pages.
- Deferred authenticated browser automation and vendor commitment outside Phase 1.

## Deviations from Plan

None - plan executed exactly as written.

The plan-level `node --test tests/decomposition-map.test.mjs` command is documented as a later verification step after Plan 01-04 creates that test.

## Auth Gates

None.

## Known Stubs

None. Stub scan found no TODO, FIXME, placeholder, coming soon, not available, or hardcoded empty UI-flow values in the created artifact.

## Threat Flags

None. This plan added a planning Markdown contract only. The planned AI seed, resolver URL validation, public fetch/cache, and source write boundaries are already covered by the plan threat model.

## Issues Encountered

- GSD metadata handlers partially mismatched this project's existing Markdown templates: `state.advance-plan` could not parse a Current Plan field, `state.update-progress` updated completed plan counts but not the frontmatter percent, and `roadmap.update-plan-progress` assumed a different Phase Overview table shape. I repaired only the affected GSD tracking lines after rerunning the supported metric, decision, session, roadmap, and requirements handlers.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 01-03 to define the runtime routing policy. The new contract gives later company-discovery implementation plans concrete owner boundaries for AI seed generation, resolver cache, scanner/extractor lanes, confirmation, write paths, and full JD capture.

## Self-Check: PASSED

- Found `.planning/architecture/discover-companies-target-contract.md`.
- Found `.planning/phases/01-decomposition-map/01-02-SUMMARY.md`.
- Found task commit `678fda4`.
- Re-ran the plan automated verification command successfully.
- Unrelated pre-existing dirty paths were not edited, staged, or committed: `tests/release-safety.test.mjs` and `tmp-skill-conversion/`.

---
*Phase: 01-decomposition-map*
*Completed: 2026-07-04*
