---
phase: 04-runtime-routing
plan: 02
subsystem: runtime-routing
tags: [onboarding, runtime-config, capability-gating, react, vitest]

requires:
  - phase: 04-runtime-routing
    provides: Expanded GET /api/runtime/config payload from plan 04-01
  - phase: 03-company-discovery-api
    provides: Local company proposal and manual seed routes for downstream onboarding controls
provides:
  - Runtime config API wrapper for the web app
  - Onboarding runtime capability derivation from server-provided config
  - Conservative no-config fallback that keeps local/manual discovery available
  - Runtime capability prop propagation to onboarding steps
affects: [04-runtime-routing, onboarding-runtime-capabilities, companies-step, finish-step]

tech-stack:
  added: []
  patterns:
    - Central OnboardingPage runtime capability loading before step rendering
    - Server-provided runtime config as the app AI/chat capability source
    - Conservative runtime-config failure fallback for local/manual discovery

key-files:
  created:
    - .planning/phases/04-runtime-routing/04-02-SUMMARY.md
  modified:
    - apps/web/src/lib/api.js
    - apps/web/src/onboarding/OnboardingPage.jsx
    - apps/web/src/onboarding/OnboardingPage.test.jsx

key-decisions:
  - "Onboarding AI controls now derive from runtimeConfig.ai.available instead of state.keyConfigured."
  - "Runtime config failures disable AI, full skill run, and discovery chat handoff capability while preserving local company proposals and manual company seeds."
  - "OnboardingPage remains the only runtime capability loader; individual onboarding steps receive runtimeCapabilities as props and do not call /api/runtime/config."
  - "Task 3 made no refactor commit because GREEN already centralized capability construction and loading."

patterns-established:
  - "Onboarding runtime capability propagation: load state plus runtime config through loadOnboardingRuntimeState(), derive booleans once, and pass runtimeCapabilities in the shared step prop bag."

requirements-completed: [RUNT-02, RUNT-03]

coverage:
  - id: D1
    description: "The web app exposes getRuntimeConfig() as a thin wrapper over GET /api/runtime/config."
    requirement: RUNT-02
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/OnboardingPage.test.jsx#getRuntimeConfig is exported as the runtime config API wrapper"
        status: pass
      - kind: other
        ref: "rg \"export function getRuntimeConfig\" apps/web/src/lib/api.js"
        status: pass
    human_judgment: false
  - id: D2
    description: "Onboarding derives AI and discovery capabilities from runtime config, including proxy AI and no-AI local/manual discovery behavior."
    requirement: RUNT-02
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/OnboardingPage.test.jsx#deriveRuntimeCapabilities"
        status: pass
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/OnboardingPage.test.jsx"
        status: pass
    human_judgment: false
  - id: D3
    description: "OnboardingPage loads state and runtime config once, keeps runtime-config failures non-fatal, and propagates runtimeCapabilities to steps."
    requirement: RUNT-03
    verification:
      - kind: unit
        ref: "apps/web/src/onboarding/OnboardingPage.test.jsx#loadOnboardingRuntimeState"
        status: pass
      - kind: other
        ref: "rg \"runtimeCapabilities=\\{runtimeCapabilities\\}\" apps/web/src/onboarding/OnboardingPage.jsx"
        status: pass
      - kind: other
        ref: "rg \"getRuntimeConfig|/api/runtime/config\" apps/web/src/onboarding/steps || true"
        status: pass
    human_judgment: false

duration: 3min
completed: 2026-07-05
status: complete
---

# Phase 04 Plan 02: Onboarding Runtime Capability Loading Summary

**Onboarding now loads server runtime capabilities and uses them to gate AI/chat controls while preserving local/manual discovery.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-05T02:00:32Z
- **Completed:** 2026-07-05T02:03:38Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Added RED Vitest coverage for runtime capability derivation, runtime config loading, proxy-enabled AI, no-AI local/manual discovery, and the new API wrapper export.
- Added `getRuntimeConfig()` as the app wrapper over `GET /api/runtime/config`.
- Implemented `deriveRuntimeCapabilities()` and `loadOnboardingRuntimeState()` so OnboardingPage loads runtime config centrally, degrades conservatively on config failure, and passes `runtimeCapabilities` to every step.
- Kept individual onboarding steps from making their own runtime config requests.

## Task Commits

Each implementation task was committed atomically:

1. **Task 1: RED onboarding runtime capability tests** - `bcb40cb` (test)
2. **Task 2: GREEN load and propagate runtime capabilities** - `904965d` (feat)
3. **Task 3: REFACTOR app capability loading** - no commit; no behavior-neutral cleanup was needed.

_Note: This TDD plan produced RED and GREEN commits. The REFACTOR gate was executed with no code changes._

## Files Created/Modified

- `apps/web/src/lib/api.js` - Adds the `getRuntimeConfig()` wrapper for `GET /api/runtime/config`.
- `apps/web/src/onboarding/OnboardingPage.jsx` - Centralizes runtime capability loading, derives `aiEnabled` from runtime config, and passes `runtimeCapabilities` to child steps.
- `apps/web/src/onboarding/OnboardingPage.test.jsx` - Covers runtime capability derivation, load helper behavior, conservative no-config fallback, and the wrapper export.
- `.planning/phases/04-runtime-routing/04-02-SUMMARY.md` - Plan completion record.

## Verification

- RED gate: `npm --workspace apps/web run test -- src/onboarding/OnboardingPage.test.jsx` failed as expected with missing `deriveRuntimeCapabilities`, `loadOnboardingRuntimeState`, and `getRuntimeConfig`.
- GREEN gate: `npm --workspace apps/web run test -- src/onboarding/OnboardingPage.test.jsx` passed with 6 tests.
- REFACTOR gate: `npm --workspace apps/web run test -- src/onboarding/OnboardingPage.test.jsx` passed again with 6 tests.
- Format gate: `npx biome check apps/web/src/lib/api.js apps/web/src/onboarding/OnboardingPage.jsx apps/web/src/onboarding/OnboardingPage.test.jsx` passed.
- Centralization check: `rg "getRuntimeConfig|/api/runtime/config" apps/web/src/onboarding/steps || true` returned no matches.

## Decisions Made

- Onboarding AI controls now derive from `runtimeConfig.ai.available` instead of the onboarding key flag so managed proxy AI can enable controls when `state.keyConfigured` is false.
- A runtime config read failure is non-fatal: AI/full-skill/chat booleans become false, while `companyProposals` and `manualCompanySeeds` remain true.
- Runtime capability loading stays in `OnboardingPage`; steps consume the shared prop bag rather than calling runtime config themselves.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

Biome requested formatting after the GREEN implementation; `npx biome check --write apps/web/src/onboarding/OnboardingPage.jsx` applied the formatter-only fix before the GREEN commit.

## Known Stubs

None. Stub-pattern scan hits were local test variables, request-body accumulators, or defensive null defaults, not UI-rendered placeholder data or unwired behavior.

## Threat Flags

None. The only new trust-boundary use is the planned read-only runtime config fetch; capability state stores booleans, route kind, and skill names only.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 04-03 can make the Companies step default to local proposal create/read routes using the propagated `runtimeCapabilities` without adding another runtime config fetch.

## Self-Check: PASSED

- Summary path created: `.planning/phases/04-runtime-routing/04-02-SUMMARY.md`
- Required source/test files exist.
- Task commits found: `bcb40cb`, `904965d`
- Final focused verification passed.

---
*Phase: 04-runtime-routing*
*Completed: 2026-07-05*
