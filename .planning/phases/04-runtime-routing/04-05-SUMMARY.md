---
phase: 04-runtime-routing
plan: 05
subsystem: runtime-routing
tags: [react, onboarding, discovery, chat-runtime, skill-runtime, docs, tdd]

requires:
  - phase: 04-runtime-routing
    provides: Runtime capability propagation and local Companies step proposal routing from Plans 04-01 through 04-04
  - phase: 03-company-discovery-api
    provides: Company proposal create/read/decision routes and confirm-first write ownership
provides:
  - Runtime-capability-gated FinishStep discovery handoff controls
  - FinishStep regression coverage for explicit quick-start/next chat handoffs and non-discovery guidance filtering
  - Phase 4 routing docs naming local proposals, explicit chat handoffs, and retained POST /api/skill/run
  - Cross-surface runtime-routing regression gate results
affects: [04-runtime-routing, onboarding-finish-step, runtime-routing-docs, verification-and-docs]

tech-stack:
  added: []
  patterns:
    - RuntimeCapabilities.discoveryChatHandoffs controls discovery chat handoff visibility when present
    - Legacy aiEnabled fallback remains for direct FinishStep callers
    - Local proposal routes are documented as the default app company discovery path

key-files:
  created:
    - .planning/phases/04-runtime-routing/04-05-SUMMARY.md
  modified:
    - apps/web/src/onboarding/steps/FinishStep.jsx
    - apps/web/src/onboarding/steps/FinishStep.test.jsx
    - .planning/architecture/runtime-routing-policy.md
    - docs/ARCHITECTURE.md

key-decisions:
  - "FinishStep uses runtimeCapabilities.discoveryChatHandoffs as the authoritative discovery handoff gate when provided, with aiEnabled preserved as the legacy fallback."
  - "Discovery quick-start and next controls remain explicit user actions; no FinishStep render path starts chat without a button-triggered route call."
  - "Routing docs now treat local company proposal create/read/decision routes as the Phase 4 default app path."
  - "Discovery quick-start, discovery next, /api/chat/*, and POST /api/skill/run remain documented as explicit retained runtime paths."

patterns-established:
  - "FinishStep handoff gating: derive discovery chat availability from runtime capability metadata before showing quick-start or next chat CTAs."
  - "Documentation route split: local deterministic routes first, bounded AI for finite judgment, chat for explicit turn-by-turn workflows, retained full skill runtime for allowlisted tool loops."

requirements-completed: [RUNT-01, RUNT-02, RUNT-03]

coverage:
  - id: D1
    description: "FinishStep hides quick-start/next discovery chat CTAs when runtimeCapabilities.discoveryChatHandoffs is false while keeping write config and manual navigation visible."
    requirement: RUNT-03
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/FinishStep.test.jsx#hides discovery chat CTAs when runtime capability disables handoffs while keeping manual finish available"
        status: pass
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx"
        status: pass
    human_judgment: false
  - id: D2
    description: "FinishStep preserves explicit quick-start/next handoff helpers, ChatPanel rendering for returned chats, and non-discovery guidance filtering."
    requirement: RUNT-03
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/steps/FinishStep.test.jsx#runQuickStartHandoff, runNextDiscoveryHandoff, DiscoveryChatPanel, and non-discovery guidance tests"
        status: pass
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx"
        status: pass
    human_judgment: false
  - id: D3
    description: "Runtime routing docs identify local company proposals as the default app path, explicit chat handoffs as user-led workflows, and POST /api/skill/run as retained allowlisted full runtime."
    requirement: RUNT-01
    verification:
      - kind: other
        ref: "rg -n \"company-proposals|company-proposal-decisions|/api/discovery/quick-start|/api/discovery/next|/api/chat|/api/skill/run\" .planning/architecture/runtime-routing-policy.md docs/ARCHITECTURE.md"
        status: pass
      - kind: other
        ref: "rg -n \"future company discovery API|future behavior|later phases replace|Phase 1 is documentation|future-facing\" .planning/architecture/runtime-routing-policy.md docs/ARCHITECTURE.md || true"
        status: pass
    human_judgment: false
  - id: D4
    description: "Cross-surface runtime-routing regression gate covers discovery routes, company proposal routes, retained skill runtime, chat runtime, and onboarding surfaces together."
    requirement: RUNT-02
    verification:
      - kind: integration
        ref: "node --test tests/discovery-route.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs"
        status: pass
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx src/onboarding/steps/FinishStep.test.jsx src/onboarding/OnboardingPage.test.jsx"
        status: pass
      - kind: other
        ref: "rg -n \"/api/skill/run\" src/cli/skill-run-route.mjs"
        status: pass
      - kind: other
        ref: "rg -n \"company-proposals|company-proposal-decisions\" apps/web/src/lib/api.js apps/web/src/onboarding/steps/CompaniesStep.jsx"
        status: pass
    human_judgment: false

duration: 5 min
completed: 2026-07-05
status: complete
---

# Phase 04 Plan 05: Runtime Routing Handoff and Docs Summary

**FinishStep discovery chat handoffs are now capability-gated, while Phase 4 docs name local proposals as the default app route and retain explicit chat/full-runtime paths.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-05T02:43:46Z
- **Completed:** 2026-07-05T02:48:31Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Added TDD coverage proving `discoveryChatHandoffs:false` hides quick-start/next chat CTAs while the write/manual finish path remains visible.
- Updated `FinishStep` to use `runtimeCapabilities.discoveryChatHandoffs` when present and preserve `aiEnabled` fallback for direct/legacy callers.
- Preserved `runQuickStartHandoff`, `runNextDiscoveryHandoff`, `extractDiscoveryGuidance`, `/api/discovery/quick-start`, `/api/discovery/next`, and `ChatPanel` behavior.
- Updated routing docs to describe the Phase 4 split: local company proposal routes by default, explicit discovery chat handoffs, and retained allowlisted `POST /api/skill/run`.
- Ran the focused backend, frontend, static, and formatting gates.

## Task Commits

Each implementation task was committed atomically:

1. **Task 1 RED: FinishStep handoff capability tests** - `8a2c8d2` (test)
2. **Task 1 GREEN: Runtime-capability-gated FinishStep handoffs** - `01b2872` (feat)
3. **Task 2: Runtime routing docs** - `44f88fa` (docs)
4. **Task 3: Cross-surface regression gate** - no commit; verification-only task with no file changes.

_Note: Task 1 was TDD and produced separate RED and GREEN commits._

## Files Created/Modified

- `apps/web/src/onboarding/steps/FinishStep.jsx` - Adds runtime capability handoff gating and extracts `DiscoveryChatPanel` for renderable returned-chat coverage.
- `apps/web/src/onboarding/steps/FinishStep.test.jsx` - Adds capability-gated CTA, runtime capability override, returned ChatPanel, and non-discovery guidance regressions.
- `.planning/architecture/runtime-routing-policy.md` - Updates the policy from future-facing language to Phase 4 local proposal default plus retained explicit runtime paths.
- `docs/ARCHITECTURE.md` - Adds public layer language for local API/DB, bounded AI, conversational chat handoff, retained full skill runtime, and skill contracts.
- `.planning/phases/04-runtime-routing/04-05-SUMMARY.md` - Plan completion record.

## Decisions Made

- `runtimeCapabilities.discoveryChatHandoffs` is authoritative for FinishStep when provided; `aiEnabled` remains only the fallback for direct tests and legacy callers.
- A runtime with AI available but discovery chat disabled gets a runtime-unavailable hint rather than showing chat CTAs.
- Returned chat rendering remains tied to explicit backend handoff responses; rendering a `ChatPanel` still requires `discoveryChat` from quick-start or next.
- Docs now forbid hidden fallback from local proposal errors to chat or `POST /api/skill/run`.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- The RED command failed as expected on missing runtime capability gating before implementation.
- Pre-commit Biome formatted the touched web files during the RED and GREEN commits.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub-pattern scan hits were local test accumulators, defensive arrays, and default helper parameters; no UI-rendered placeholder data or unwired behavior was introduced.

## Threat Flags

None. The changed browser-to-discovery handoff surface was planned in the threat model, and no new endpoints, auth paths, file access patterns, or schema changes were introduced.

## TDD Gate Compliance

- **RED:** `8a2c8d2 test(04-05): add failing FinishStep handoff capability tests`
- **GREEN:** `01b2872 feat(04-05): gate FinishStep discovery handoffs by runtime capability`
- **REFACTOR:** not needed

## Verification

- RED command: `npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx` - FAIL as expected before implementation on capability-gated CTA assertions.
- GREEN command: `npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx` - PASS (12 tests).
- Backend gate: `node --test tests/discovery-route.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs` - PASS (89 passed, 2 integration tests skipped without `ANTHROPIC_API_KEY`).
- Frontend gate: `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx src/onboarding/steps/FinishStep.test.jsx src/onboarding/OnboardingPage.test.jsx` - PASS (29 tests).
- Static retained runtime scan: `rg -n "/api/skill/run" src/cli/skill-run-route.mjs` - PASS; route comment and POST mount present.
- Static local proposal scan: `rg -n "company-proposals|company-proposal-decisions" apps/web/src/lib/api.js apps/web/src/onboarding/steps/CompaniesStep.jsx` - PASS; web API wrappers point at Phase 3 routes.
- Format gate: `npx biome check apps/web/src/onboarding/steps/FinishStep.jsx apps/web/src/onboarding/steps/FinishStep.test.jsx` - PASS.
- Stale docs scan: `rg -n "future company discovery API|future behavior|later phases replace|Phase 1 is documentation|future-facing" .planning/architecture/runtime-routing-policy.md docs/ARCHITECTURE.md || true` - PASS; no stale matches.

## Acceptance Criteria

- FinishStep handoffs remain explicit and capability-gated - PASS.
- Docs describe local proposals, explicit chat handoffs, and retained `POST /api/skill/run` - PASS.
- Focused Phase 04 runtime-routing regressions pass - PASS.
- No hidden fallback from local proposal errors to chat/full skill runtime was introduced - PASS.

## Next Phase Readiness

Phase 04 runtime routing is ready for Phase 05 verification/docs lock-in. The app now has runtime config, local proposal defaults, proposal decision routing, explicit discovery chat handoffs, and retained full skill runtime documented and covered by focused regressions.

## Self-Check: PASSED

- Verified `apps/web/src/onboarding/steps/FinishStep.jsx` exists.
- Verified `apps/web/src/onboarding/steps/FinishStep.test.jsx` exists.
- Verified `.planning/architecture/runtime-routing-policy.md` exists.
- Verified `docs/ARCHITECTURE.md` exists.
- Verified `.planning/phases/04-runtime-routing/04-05-SUMMARY.md` exists.
- Verified task commits `8a2c8d2`, `01b2872`, and `44f88fa` exist in git history.
- Verified final focused backend/frontend/static gates passed.
- Verified task commits did not delete tracked files.

---
*Phase: 04-runtime-routing*
*Completed: 2026-07-05*
