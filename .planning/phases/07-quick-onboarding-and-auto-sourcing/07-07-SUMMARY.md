---
phase: 07-quick-onboarding-and-auto-sourcing
plan: 07
subsystem: onboarding-ui
tags: [react, onboarding, sourcing-runs, cadence, sqlite, vitest]

requires:
  - phase: 07-03
    provides: "RED first-search UI, cadence, and readiness contracts"
  - phase: 07-06
    provides: "Durable /api/sourcing run status and start routes"
provides:
  - "Cadence search preference schema/defaults and React sourcing run API wrappers"
  - "First-search onboarding setup task with cadence selection, route-backed start/retry, and durable status copy"
  - "Home setup readiness first-search status context"
affects: [onboarding, home, sourcing, candidate-setup]

tech-stack:
  added: []
  patterns:
    - "First-search UI uses local /api/sourcing/* wrappers and treats chat/discovery as outside the first-search task."
    - "Cadence persistence preserves existing targeting.search_preferences and stamps saved_at metadata."
    - "Setup readiness cards render first-search status as compact checklist context, not a modal or nag."

key-files:
  created: []
  modified:
    - config/targeting.schema.json
    - src/core/db/verbs/candidate.mjs
    - apps/web/src/lib/api.js
    - apps/web/src/onboarding/steps/FinishStep.jsx
    - apps/web/src/onboarding/steps/FinishStep.test.jsx
    - apps/web/src/pages/SetupReadinessCard.jsx
    - tests/candidate-setup.test.mjs

key-decisions:
  - "Cadence is stored under targeting.search_preferences.cadence with a daily/default baseline and does not affect search_ready."
  - "First-search start/retry uses startFirstSearchRun() and /api/sourcing/first-run/start; no discovery/chat/skill route is used by the first-search task."
  - "The explicit deeper interview link remains separate from the first-search task."

patterns-established:
  - "Route-backed retry pattern: failed-state UI calls startFirstSearchRun({ retry: true }) and renders the returned running retry run."
  - "First-search summary rendering tolerates both route-facing and test fixture count names."

requirements-completed:
  - ONB-01
  - RUN-02

coverage:
  - id: D1
    description: "Cadence preference schema/defaults and local sourcing API wrappers are available without widening search readiness."
    requirement: ONB-01
    verification:
      - kind: unit
        ref: "node --test tests/candidate-setup.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "FinishStep renders first-search cadence, Not started/Running/Completed/Failed states, zero-result copy, and route-backed retry."
    requirement: RUN-02
    verification:
      - kind: unit
        ref: "npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/pages/SetupReadinessCard.test.jsx"
        status: pass
    human_judgment: false
  - id: D3
    description: "Production first-search UI files contain no discovery/chat/skill first-search route references while keeping the separate deeper interview link."
    requirement: RUN-02
    verification:
      - kind: other
        ref: "rg -n \"startDiscoveryQuickStart|startDiscoveryNext|DiscoveryChatPanel|/api/discovery/quick-start|/api/discovery/next|/api/skill/run|research-boards|discover-companies|search-jobs\" apps/web/src/onboarding/steps/FinishStep.jsx apps/web/src/pages/SetupReadinessCard.jsx || true"
        status: pass
    human_judgment: false

duration: 8 min
completed: 2026-07-05
status: complete
---

# Phase 07 Plan 07: First-Search Onboarding UI Summary

**Cadence-backed first-search setup task using durable local sourcing routes and compact status context.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-05T22:49:41Z
- **Completed:** 2026-07-05T22:58:08Z
- **Tasks:** 2 completed
- **Files modified:** 7

## Accomplishments

- Added cadence validation/defaults under `targeting.search_preferences` and proved compensation remains outside `search_ready`.
- Added React wrappers for latest sourcing run reads, first-search start/retry, and manual search start.
- Replaced the onboarding quick-start discovery surface with a local first-search setup task, cadence controls, durable status labels, completed counts, zero-result copy, and failed retry action.
- Added compact first-search status context to the setup readiness card.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Add cadence preference schema/default and API wrapper tests** - `801cc5c` (test)
2. **Task 1 GREEN: Add cadence preference schema/default and API wrappers** - `a44eb81` (feat)
3. **Task 2 RED: Tighten first-search UI contracts** - `4fbb4bf` (test)
4. **Task 2 GREEN: Wire first-search onboarding task UI** - `a988159` (feat)
5. **Task 2 correction: Keep deep interview link separate** - `e2e0670` (fix)

## Files Created/Modified

- `config/targeting.schema.json` - Allows cadence mode, recommendation source, and saved timestamp under strict `search_preferences`.
- `src/core/db/verbs/candidate.mjs` - Defaults cadence to daily/default while leaving readiness computation unchanged.
- `apps/web/src/lib/api.js` - Adds `getSourcingRun`, `startFirstSearchRun`, and `startSearchRun` wrappers for `/api/sourcing/*`.
- `apps/web/src/onboarding/steps/FinishStep.jsx` - Renders the first-search setup task, persists cadence, starts/retries local sourcing, and keeps deeper interview separate.
- `apps/web/src/onboarding/steps/FinishStep.test.jsx` - Covers cadence persistence, all first-search states, zero-result copy, retry payload, and scoped no-runtime assertions.
- `apps/web/src/pages/SetupReadinessCard.jsx` - Shows first-search status as compact checklist context.
- `tests/candidate-setup.test.mjs` - Covers cadence schema/defaults, strict unknown-key rejection, and local sourcing wrapper endpoints.

## Decisions Made

- Cadence is a saved preference, not a scheduler. The UI labels default recommendation transparently and does not imply recurring automation.
- First search starts through `startFirstSearchRun()` and retries with `startFirstSearchRun({ retry: true })`; discovery/chat handoffs remain outside this setup task.
- The setup readiness card shows first-search progress only as contextual checklist state, avoiding a modal, nag, or second action surface.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Restored separate deeper interview handoff**
- **Found during:** Task 2 (Replace FinishStep discovery quick start with first-search task)
- **Issue:** The first GREEN implementation removed the explicit deeper interview link while satisfying the no-chat first-search test.
- **Fix:** Restored the `/chat` deeper interview link outside the first-search task and scoped the no-runtime assertion to the first-search card.
- **Files modified:** `apps/web/src/onboarding/steps/FinishStep.jsx`, `apps/web/src/onboarding/steps/FinishStep.test.jsx`
- **Verification:** `npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/pages/SetupReadinessCard.test.jsx`
- **Committed in:** `e2e0670`

---

**Total deviations:** 1 auto-fixed (Rule 2: 1)
**Impact on plan:** Preserved both requirements: no first-search runtime handoff and a separate deeper interview entry point.

## Issues Encountered

- Existing unrelated worktree changes remained in `.planning/config.json` and `.planning/research/`; they were not staged.

## Known Stubs

None. Stub-pattern scan matched only existing test placeholder cases and ordinary empty array/object initializers.

## Threat Mitigations

- First-search controls call `/api/sourcing/*` wrappers only; production UI scan found no discovery/chat/skill-route references in the first-search component path.
- Cadence validates through the targeting schema with `additionalProperties: false`, preserving strict search preference writes.
- Durable status labels render from run state, and retry renders the returned route-backed running run instead of mutating display copy only.

## Verification

- PASS: `node --test tests/candidate-setup.test.mjs`
- PASS: `npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/pages/SetupReadinessCard.test.jsx`
- PASS: `npm exec -- biome check apps/web/src/onboarding/steps/FinishStep.jsx apps/web/src/onboarding/steps/FinishStep.test.jsx apps/web/src/pages/SetupReadinessCard.jsx apps/web/src/pages/SetupReadinessCard.test.jsx config/targeting.schema.json src/core/db/verbs/candidate.mjs apps/web/src/lib/api.js tests/candidate-setup.test.mjs`
- PASS: `rg -n "startDiscoveryQuickStart|startDiscoveryNext|DiscoveryChatPanel|/api/discovery/quick-start|/api/discovery/next|/api/skill/run|research-boards|discover-companies|search-jobs" apps/web/src/onboarding/steps/FinishStep.jsx apps/web/src/pages/SetupReadinessCard.jsx || true`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for `07-08` to wire the Jobs-page manual search action and run the final Phase 7 regression rollup.

## Self-Check: PASSED

- Found all modified source/test files on disk.
- Found task commits `801cc5c`, `a44eb81`, `4fbb4bf`, `a988159`, and `e2e0670`.
- Confirmed no tracked files were deleted by task commits.
- Confirmed summary frontmatter includes `status: complete` and requirements `ONB-01`, `RUN-02`.

---
*Phase: 07-quick-onboarding-and-auto-sourcing*
*Completed: 2026-07-05*
