---
phase: 04-runtime-routing
plan: 03
subsystem: runtime-routing
tags: [react, onboarding, company-discovery, api-routing, tdd, vitest]

requires:
  - phase: 04-runtime-routing
    provides: Runtime capability propagation to onboarding steps from Plan 04-02
  - phase: 03-company-discovery-api
    provides: Local company proposal create/read/decision routes
provides:
  - Web API wrappers for Phase 3 company proposal create/read/decision routes
  - Companies step local proposal create/read controls as the default discovery path
  - Runtime-gated secondary discover-companies ChatPanel handoff
  - Focused Vitest coverage for local routing, manual seeds, no hidden skill runtime, and chat gating
affects: [04-runtime-routing, companies-step, company-discovery-api, verification-and-docs]

tech-stack:
  added: []
  patterns:
    - Thin app API wrappers over existing Phase 3 discovery routes
    - Onboarding step helpers with injectable route functions for focused tests
    - Runtime-capability gated chat handoff rendered separately from local controls

key-files:
  created:
    - apps/web/src/onboarding/steps/CompaniesStep.test.jsx
    - .planning/phases/04-runtime-routing/04-03-SUMMARY.md
  modified:
    - apps/web/src/lib/api.js
    - apps/web/src/onboarding/steps/CompaniesStep.jsx

key-decisions:
  - "CompaniesStep now uses local company proposal create/read controls as the primary discovery action."
  - "discover-companies ChatPanel remains available only when runtimeCapabilities.discoveryChatHandoffs is true."
  - "Local proposal create/read errors render in the Companies step and do not fall through to chat or POST /api/skill/run."
  - "Proposal creation refreshes the latest pending proposal batch after the create call."

patterns-established:
  - "Company proposal UI helpers convert shortlist entries to manual seeds, call Phase 3 wrappers, and refresh pending proposal state."
  - "Local proposal display keeps proposal and rejected counts visible while deferring decision actions to Plan 04-04."

requirements-completed: [RUNT-02, RUNT-03]

coverage:
  - id: D1
    description: "Web API wrappers route company proposal create/read/decision calls to Phase 3 discovery endpoints, not retained skill runtime."
    requirement: RUNT-02
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/CompaniesStep.test.jsx#company proposal API wrappers"
        status: pass
      - kind: other
        ref: "rg -n '/api/discovery/company-proposals|/api/discovery/company-proposal-decisions|/api/skill/run' apps/web/src/lib/api.js apps/web/src/onboarding/steps/CompaniesStep.jsx apps/web/src/onboarding/steps/CompaniesStep.test.jsx"
        status: pass
    human_judgment: false
  - id: D2
    description: "CompaniesStep converts shortlist companies into manual seeds and creates local proposals before refreshing latest pending proposal state."
    requirement: RUNT-02
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/CompaniesStep.test.jsx#proposalSeedsFromCompanies, runCompanyProposalRead, runCompanyProposalCreate"
        status: pass
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx"
        status: pass
    human_judgment: false
  - id: D3
    description: "The local company proposal control renders before the secondary chat handoff, and manual/no-AI mode keeps local controls visible without ChatPanel."
    requirement: RUNT-03
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/CompaniesStep.test.jsx#CompaniesStep"
        status: pass
      - kind: other
        ref: "npx biome check apps/web/src/lib/api.js apps/web/src/onboarding/steps/CompaniesStep.jsx apps/web/src/onboarding/steps/CompaniesStep.test.jsx"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-07-05
status: complete
---

# Phase 04 Plan 03: Companies Step Local Proposal Routing Summary

**Companies onboarding now uses Phase 3 local proposal APIs by default while keeping discover-companies chat as an explicit secondary path.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-05T02:26:15Z
- **Completed:** 2026-07-05T02:31:52Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Added `createCompanyProposals`, `getCompanyProposals`, and `decideCompanyProposal` web wrappers for the Phase 3 proposal routes.
- Added Companies step helpers for manual seed conversion, latest-pending reads, and create-then-refresh proposal flow.
- Replaced the chat-first Companies discovery block with local proposal controls that render proposal/rejected counts and company confidence labels.
- Kept `ChatPanel skill="discover-companies"` as a visibly separate secondary handoff only when runtime capabilities allow discovery chat.
- Added focused Vitest coverage proving local routes do not call `/api/skill/run` and local failures do not start chat.

## Task Commits

Each implementation task was committed atomically:

1. **Task 1: RED CompaniesStep local proposal tests** - `0fd35fb` (test)
2. **Task 2: GREEN add local proposal wrappers and default UI** - `643c588` (feat)
3. **Task 3: REFACTOR local proposal display** - `6367a3c` (refactor)

## Files Created/Modified

- `apps/web/src/lib/api.js` - Adds thin wrappers for company proposal create/read/decision routes.
- `apps/web/src/onboarding/steps/CompaniesStep.jsx` - Adds local proposal helpers, local create/read UI, route error rendering, proposal display, and runtime-gated secondary chat handoff.
- `apps/web/src/onboarding/steps/CompaniesStep.test.jsx` - Adds focused RED/GREEN coverage for helpers, wrappers, static render ordering, manual/no-AI visibility, and no hidden chat/runtime escalation.
- `.planning/phases/04-runtime-routing/04-03-SUMMARY.md` - Plan completion record.

## Decisions Made

- Local proposal create/read is now the primary Companies discovery path; the browser delegates discovery work to Phase 3 routes instead of running resolver/scanner logic itself.
- `discoveryChatHandoffs` is the only gate for the secondary `discover-companies` ChatPanel; `aiEnabled` alone no longer makes chat appear in this step.
- Proposal creation refreshes pending proposal state immediately so the UI reads the DB-owned proposal batch after create.
- Proposal decision UI is intentionally deferred to Plan 04-04; this plan only exports `decideCompanyProposal` for the next wave.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- The RED suite failed as expected on missing proposal helpers, missing API wrappers, and missing local proposal panel.
- Biome requested formatting before the GREEN commit; formatting was applied to owned web files only.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub-pattern scan hits were existing wrapper defaults, local test accumulators, and defensive empty values; no UI-rendered placeholder data or unwired proposal behavior was introduced.

## Threat Flags

None. The new browser-to-proposal-route calls are the planned trust boundary from the plan, and tests assert the local route path does not call `/api/skill/run` or render chat as a fallback.

## TDD Gate Compliance

- **RED:** `0fd35fb test(04-03): add failing company proposal UI tests`
- **GREEN:** `643c588 feat(04-03): route companies discovery to local proposals`
- **REFACTOR:** `6367a3c refactor(04-03): dedupe company proposal chips`

## Verification

- RED command: `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` - FAIL as expected before implementation (7 failing assertions for missing helpers/wrappers/local panel).
- GREEN command: `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` - PASS (7 tests).
- REFACTOR command: `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` - PASS (7 tests).
- Final focused command: `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` - PASS (7 tests).
- Format gate: `npx biome check apps/web/src/lib/api.js apps/web/src/onboarding/steps/CompaniesStep.jsx apps/web/src/onboarding/steps/CompaniesStep.test.jsx` - PASS.
- Static route check: `rg -n "/api/discovery/company-proposals|/api/discovery/company-proposal-decisions|/api/skill/run" apps/web/src/lib/api.js apps/web/src/onboarding/steps/CompaniesStep.jsx apps/web/src/onboarding/steps/CompaniesStep.test.jsx` - PASS; production wrappers point at discovery routes only, and `/api/skill/run` appears only in the negative test assertion.

## Acceptance Criteria

- CompaniesStep primary discovery control calls `createCompanyProposals` / `getCompanyProposals` - PASS.
- Manual company seeds create local proposals through the app wrappers - PASS.
- ChatPanel is retained only as an explicit secondary path gated by `runtimeCapabilities.discoveryChatHandoffs` - PASS.
- Local proposal route failure remains local and does not start chat or POST `/api/skill/run` - PASS.
- Manual/no-AI local proposal controls remain visible - PASS.

## Next Phase Readiness

Plan 04-04 can wire proposal decision controls directly to the already-exported `decideCompanyProposal()` wrapper and the existing Phase 3 decision route, using the local proposal batch UI added here.

## Self-Check: PASSED

- Verified `apps/web/src/lib/api.js` exists.
- Verified `apps/web/src/onboarding/steps/CompaniesStep.jsx` exists.
- Verified `apps/web/src/onboarding/steps/CompaniesStep.test.jsx` exists.
- Verified `.planning/phases/04-runtime-routing/04-03-SUMMARY.md` exists.
- Verified task commits `0fd35fb`, `643c588`, and `6367a3c` exist in git history.
- Verified final focused command exits 0 after all task commits.
- Verified task commits did not delete tracked files.

---
*Phase: 04-runtime-routing*
*Completed: 2026-07-05*
