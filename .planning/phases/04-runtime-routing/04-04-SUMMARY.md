---
phase: 04-runtime-routing
plan: 04
subsystem: runtime-routing
tags: [react, onboarding, company-discovery, proposal-decisions, tdd, vitest]

requires:
  - phase: 04-runtime-routing
    provides: Companies step local proposal create/read UI from Plan 04-03
  - phase: 03-company-discovery-api
    provides: POST /api/discovery/company-proposal-decisions route with expectedVersion conflict handling
provides:
  - Exported runCompanyProposalDecision helper for local proposal decisions
  - Companies step approve-supported-ats, reject, suppress, escalate, and refresh actions
  - Expected-version decision payloads and local 409 conflict refresh handling
  - Returned decision/proposal/refreshedProposal/rejected metadata preservation and display
affects: [04-runtime-routing, companies-step, company-discovery-api, verification-and-docs]

tech-stack:
  added: []
  patterns:
    - Injectable onboarding helper functions around thin API wrappers
    - Local proposal action rendering with API-owned writes and conflict refresh
    - Conflict and route/manual errors stay in the local proposal panel

key-files:
  created:
    - .planning/phases/04-runtime-routing/04-04-SUMMARY.md
  modified:
    - apps/web/src/onboarding/steps/CompaniesStep.jsx
    - apps/web/src/onboarding/steps/CompaniesStep.test.jsx

key-decisions:
  - "Proposal decisions are routed only through decideCompanyProposal() and include batchId, proposalId, action, and expectedVersion from the rendered proposal."
  - "approve-supported-ats is enabled only when the proposal itself has proposedAction:\"approve-supported-ats\"; the API remains the final write authority."
  - "409/CONFLICT responses reload pending proposals and show a local refresh-needed alert instead of starting chat or retained skill runtime."

patterns-established:
  - "runCompanyProposalDecision() returns normalized decision metadata plus the refreshed pending read result for component state updates."
  - "CompaniesStep keeps local proposal failures visible in the proposal panel, including server manual metadata when present."

requirements-completed: [RUNT-02]

coverage:
  - id: D1
    description: "runCompanyProposalDecision sends the Phase 3 decision payload with batchId, proposalId, action, and expectedVersion, then reloads latest pending proposals."
    requirement: RUNT-02
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/CompaniesStep.test.jsx#runCompanyProposalDecision sends the proposal decision contract and refreshes pending proposals after success"
        status: pass
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx"
        status: pass
    human_judgment: false
  - id: D2
    description: "CompaniesStep renders approve-supported-ats, reject, suppress, escalate, and refresh actions, with approval disabled for non-approve proposals."
    requirement: RUNT-02
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/CompaniesStep.test.jsx#CompaniesStep renders all local proposal decision actions and gates approval to supported ATS proposals"
        status: pass
    human_judgment: false
  - id: D3
    description: "Stale proposal decisions return a local refresh-needed conflict state, reload proposals, and do not start chat."
    requirement: RUNT-02
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/CompaniesStep.test.jsx#runCompanyProposalDecision treats stale-version conflicts as a local refresh-needed state without starting chat"
        status: pass
    human_judgment: false
  - id: D4
    description: "Returned decision/proposal/refreshedProposal/rejected metadata is preserved for display after successful decisions."
    requirement: RUNT-02
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/CompaniesStep.test.jsx#runCompanyProposalDecision preserves refresh and rejected metadata returned by the decision route"
        status: pass
    human_judgment: false
  - id: D5
    description: "No-AI/manual route failures remain local to the proposal panel and display server manual metadata when present."
    requirement: RUNT-02
    verification:
      - kind: other
        ref: "rg -n \"proposalRouteErrorMessage|manual\\?\\.action|ChatPanel|runCompanyProposalDecision\" apps/web/src/onboarding/steps/CompaniesStep.jsx"
        status: pass
    human_judgment: true
    rationale: "The existing frontend test harness is static-render focused; full interactive create-error display needs browser-level UAT in Phase 5."

duration: 6 min
completed: 2026-07-05
status: complete
---

# Phase 04 Plan 04: Companies Step Proposal Decisions Summary

**Companies onboarding can now decide local company proposals through the Phase 3 decision route with expected-version conflict handling.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-05T02:34:54Z
- **Completed:** 2026-07-05T02:41:02Z
- **Tasks:** 3 planned, 2 committed; optional refactor not needed
- **Files modified:** 3

## Accomplishments

- Added failing RED coverage for proposal decision payloads, success metadata, 409 conflict refresh behavior, local action rendering, and approval gating.
- Exported `runCompanyProposalDecision()` from `CompaniesStep.jsx`, sending `{ batchId, proposalId, action, expectedVersion }` to `decideCompanyProposal()`.
- Added local proposal action buttons for `approve-supported-ats`, `reject`, `suppress`, `escalate`, and `refresh`.
- Added local conflict handling that reloads pending proposals and shows a refresh-needed `InlineAlert` without starting chat or retained skill runtime.
- Preserved route-returned `decision`, `proposal`, `refreshedProposal`, and `rejected` metadata for display while refreshing pending proposal state after each decision.

## Task Commits

Each implementation task was committed atomically:

1. **Task 1: RED proposal decision tests** - `546f774` (test)
2. **Task 2: GREEN implement proposal decisions** - `4629ead` (feat)
3. **Task 3: REFACTOR proposal decision state** - no separate commit; helpers were already clean after GREEN and focused verification stayed green

_Note: This was a TDD plan, so RED and GREEN were committed separately._

## Files Created/Modified

- `apps/web/src/onboarding/steps/CompaniesStep.jsx` - Exports the decision helper, renders proposal action controls, handles success/conflict state, and keeps local route/manual errors in the proposal panel.
- `apps/web/src/onboarding/steps/CompaniesStep.test.jsx` - Adds TDD coverage for exact decision payloads, pending refreshes, returned metadata, stale conflicts, no hidden chat, and action button gating.
- `.planning/phases/04-runtime-routing/04-04-SUMMARY.md` - Plan completion record.

## Decisions Made

- Proposal decisions use the current card's `proposal.version` as `expectedVersion`; stale proposal responses reload state and ask the user to review the refreshed data.
- The browser never directly writes company/source state. It delegates every action to the Phase 3 decision route and displays returned metadata.
- Approval is a UI affordance only for `proposedAction: "approve-supported-ats"` proposals; API validation remains the final enforcement boundary.
- Hidden escalation stays forbidden: decision and error paths do not start `ChatPanel`, `/api/chat/*`, or `/api/skill/run`.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- The RED command failed as expected on the absent `runCompanyProposalDecision` export and missing action UI.
- Biome requested formatting in `CompaniesStep.jsx`; formatting was applied to owned files only.
- Generic GSD state/roadmap updates were not written because this executor's user-provided owned write set was limited to `CompaniesStep.jsx`, `CompaniesStep.test.jsx`, and this SUMMARY file.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub-pattern scan matches were defensive default parameters, local test accumulators, an optional `initialProposalBatch` render seam for static tests, and the existing `TextField` placeholder example.

## Threat Flags

None. The browser-to-decision-route boundary, expected-version contract, approval gating, returned metadata rendering, and local conflict handling were all included in the plan threat model.

## TDD Gate Compliance

- **RED:** `546f774 test(04-04): add failing company proposal decision tests`
- **GREEN:** `4629ead feat(04-04): implement company proposal decisions`
- **REFACTOR:** not needed

## Verification

- RED command: `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` - FAIL as expected before implementation (missing `runCompanyProposalDecision` and missing action UI).
- GREEN command: `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` - PASS (11 tests).
- Format command: `npx biome check apps/web/src/onboarding/steps/CompaniesStep.jsx apps/web/src/onboarding/steps/CompaniesStep.test.jsx` - PASS.
- Final focused command: `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` - PASS (11 tests).
- Static route check: `rg -n "runCompanyProposalDecision|decideCompanyProposal|startChat|ChatPanel|/api/skill/run|data-action|expectedVersion|CONFLICT" apps/web/src/onboarding/steps/CompaniesStep.jsx apps/web/src/onboarding/steps/CompaniesStep.test.jsx` - PASS; production decisions call `decideCompanyProposal` with `expectedVersion`, and `ChatPanel` remains only the explicit secondary section.

## Acceptance Criteria

- Approve/reject/suppress/escalate/refresh actions POST through `decideCompanyProposal()` to `/api/discovery/company-proposal-decisions` - PASS.
- Every proposal decision includes `expectedVersion` from the current proposal card - PASS.
- `approve-supported-ats` is enabled only for proposals whose `proposedAction` is `approve-supported-ats` - PASS.
- 409/CONFLICT responses show a local refresh-needed alert and reload pending proposals - PASS.
- No proposal decision path starts chat or retained full skill runtime - PASS.

## Next Phase Readiness

Ready for Plan 04-05 to preserve explicit discovery chat handoffs and close routing docs. The Companies step now routes create/read/decision proposal work through local APIs by default.

## Self-Check: PASSED

- Verified `.planning/phases/04-runtime-routing/04-04-SUMMARY.md` exists.
- Verified task commits `546f774` and `4629ead` exist in git history.
- Verified coverage metadata parses with `gsd-tools.cjs uat classify-coverage`.
- Verified final focused command exits 0 after all task commits.
- Verified task commits did not delete tracked files.

---
*Phase: 04-runtime-routing*
*Completed: 2026-07-05*
