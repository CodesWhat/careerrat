---
phase: 03-company-discovery-api
plan: "04"
subsystem: api
tags: [bounded-ai, discover-companies, company-discovery, privacy, tdd]

requires:
  - phase: 02-bounded-ai-foundation
    provides: bounded AI envelopes, native-preferred structured output, and safe no-AI/manual fallback semantics
  - phase: 03-company-discovery-api
    provides: manual company proposal generation, resolver cache, and deterministic ATS resolution
provides:
  - Privacy-filtered candidate context for company seed generation
  - Schema-validated manual and bounded-AI company seed generation
  - Proposal route integration that feeds AI seeds through resolver/scanner/gate processing
affects: [03-company-discovery-api, discover-companies, dashboard-discovery]

tech-stack:
  added: []
  patterns:
    - runBoundedAI native-preferred structured generation with explicit labels
    - candidate-context sanitization before prompt construction
    - untrusted AI seed output feeding deterministic resolver/scanner gates

key-files:
  created:
    - src/core/discovery/company-context.mjs
    - src/core/discovery/company-seeds.mjs
    - tests/company-discovery-seeds.test.mjs
  modified:
    - src/core/discovery/company-proposals.mjs
    - src/cli/discovery-route.mjs
    - tests/company-proposals-route.test.mjs

key-decisions:
  - "Company seed output is advisory only: schema-validated seeds cannot carry final URLs, provider, API URL, approval, or write-state fields."
  - "Candidate prompt context includes minimum base and OE floor only; current compensation keys and values are never serialized into prompts, metadata, responses, or proposals."
  - "No manual seeds plus no AI route returns the shared bounded-AI 501 manual fallback envelope instead of launching chat or a full skill."

patterns-established:
  - "Seed context is assembled read-only from candidate config, source config, applications, and sourced rows, then privacy-filtered before prompt use."
  - "Manual seeds short-circuit AI and are normalized through the same trusted schema boundary used by AI seeds."
  - "HTTP discovery routes pass bounded-AI failure envelopes through unchanged, preserving shared error semantics."

requirements-completed: [DISC-01]

coverage:
  - id: D1
    description: "Privacy-safe candidate company seed context covering profile domain, role families, location posture, keep/cut signals, exclusions, tracked companies, applications, sourced companies, dedupe, and allowed comp floor fields."
    requirement: DISC-01
    verification:
      - kind: unit
        ref: "tests/company-discovery-seeds.test.mjs#buildCompanySeedContext includes candidate and dedupe inputs while omitting private current comp"
        status: pass
      - kind: other
        ref: "rg -n \"current_base|current_comp_shareable|145000\" src/core/discovery/company-context.mjs src/core/discovery/company-seeds.mjs src/core/discovery/company-proposals.mjs src/cli/discovery-route.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Bounded AI company seed generation with top-level companies[] schema, max 12 seeds, native-preferred output, exact discover-companies labels, and safe no-AI/manual fallback."
    requirement: DISC-01
    verification:
      - kind: unit
        ref: "tests/company-discovery-seeds.test.mjs"
        status: pass
      - kind: unit
        ref: "tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Company proposal route can use AI seeds while still requiring deterministic resolver, scanner, and proposal-gate processing before presentation."
    requirement: DISC-01
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals turns AI seeds into deterministic resolver/scanner proposals"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-07-05
status: complete
---

# Phase 03 Plan 04: Bounded AI Company Seed Generation Summary

**Bounded discover-companies seed generation with privacy-filtered candidate context and deterministic proposal routing**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-05T00:13:00Z
- **Completed:** 2026-07-05T00:25:25Z
- **Tasks:** 1
- **Files modified:** 6

## Accomplishments

- Added `buildCompanySeedContext()` to assemble candidate/domain/source/dedupe context while excluding current compensation data.
- Added `companySeedSchema`, `normalizeManualCompanySeeds()`, and `generateCompanySeeds()` with native-preferred bounded AI labels and shared no-AI/manual envelopes.
- Integrated seed generation into `createCompanyProposalBatch()` and the route seam so AI seeds still pass through resolver, scanner, and proposal gate logic.
- Added TDD coverage for schema rejection of trusted write-ready fields, manual seed short-circuiting, no-AI fallback, privacy, and route integration.

## Task Commits

1. **Task 1 RED: bounded company seed generation tests** - `bcb2bfc` (test)
2. **Task 1 GREEN: bounded company seed generation implementation** - `6c8dfa7` (feat)

_Note: This was a TDD task, so RED and GREEN were committed separately._

## Files Created/Modified

- `src/core/discovery/company-context.mjs` - Builds read-only, privacy-filtered candidate seed context from DB or legacy workspace files.
- `src/core/discovery/company-seeds.mjs` - Defines seed schema, manual seed normalization, bounded prompt construction, and AI/no-AI envelope handling.
- `src/core/discovery/company-proposals.mjs` - Requests manual or AI seeds before resolving/scanning companies and preserves seed metadata.
- `src/cli/discovery-route.mjs` - Passes the injected seed AI call seam and returns bounded-AI failure envelopes unchanged.
- `tests/company-discovery-seeds.test.mjs` - Covers schema, privacy, context, manual fallback, no-AI fallback, and native-preferred AI call labels.
- `tests/company-proposals-route.test.mjs` - Covers AI-seeded proposal route processing through resolver/scanner/gate without chat/full-skill launch.

## Decisions Made

- AI output remains untrusted advisory seed input; final URL, provider, API URL, and approval fields are excluded from the seed schema and stripped from manual normalization.
- Seed prompt context includes allowed floor fields (`minimum_base`, `oe_min_base`) but excludes current compensation keys and values entirely.
- Manual seed input is the first path through `generateCompanySeeds()`, so deterministic/manual discovery remains available without invoking AI.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The RED gate failed as expected because `company-context.mjs` did not exist and the proposal route still used the old manual-only 501 path.
- No blocking implementation issues remained after adding the seed modules and route wiring.

## Known Stubs

None - the default empty arrays/objects in the touched code are normal optional-input defaults and do not flow as placeholder UI data.

## Threat Flags

None - the AI prompt, seed schema, compensation privacy, count cap, and route error envelope surfaces were already covered by the plan threat model.

## TDD Gate Compliance

- RED commit present: `bcb2bfc` (`test(03-04): add failing company seed generation tests`)
- GREEN commit present: `6c8dfa7` (`feat(03-04): implement bounded company seed generation`)
- Refactor commit: not needed

## Verification

- `node --test tests/company-discovery-seeds.test.mjs tests/company-proposals-route.test.mjs tests/bounded-ai.test.mjs` - passed, 20/20 tests.
- `git diff --check -- src/cli/discovery-route.mjs src/core/discovery/company-proposals.mjs src/core/discovery/company-context.mjs src/core/discovery/company-seeds.mjs tests/company-discovery-seeds.test.mjs tests/company-proposals-route.test.mjs` - passed.
- `rg -n "current_base|current_comp_shareable|145000" src/core/discovery/company-context.mjs src/core/discovery/company-seeds.mjs src/core/discovery/company-proposals.mjs src/cli/discovery-route.mjs` - passed with no production matches.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 03-05 can consume AI/manual company seeds as proposal inputs while relying on deterministic resolver/scanner/gate behavior. The route now exposes bounded-AI failure envelopes consistently for UI handling.

## Self-Check: PASSED

- Found `src/core/discovery/company-context.mjs`
- Found `src/core/discovery/company-seeds.mjs`
- Found `tests/company-discovery-seeds.test.mjs`
- Found commit `bcb2bfc`
- Found commit `6c8dfa7`

---
*Phase: 03-company-discovery-api*
*Completed: 2026-07-05*
