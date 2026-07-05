---
phase: 07-quick-onboarding-and-auto-sourcing
plan: 06
subsystem: onboarding
tags: [sqlite, sourcing-runs, onboarding, deterministic-search, node-test]

requires:
  - phase: 07-04
    provides: "DB-backed onboarding readiness and source-config generation patterns"
  - phase: 07-05
    provides: "sourcing_runs table and durable sourcing run verbs"
provides:
  - "First-search orchestration service that prepares DB search-sources without compatibility YAML"
  - "Durable /api/sourcing run status and start routes"
  - "Onboarding quick-start path that starts local deterministic sourcing instead of returning discovery handoff fields"
  - "Deterministic source counts exposed separately from total configured sources"
affects: [onboarding, search, tracker-dev, discovery]

tech-stack:
  added: []
  patterns:
    - "Route handlers translate DB/readiness errors into stable JSON envelopes"
    - "Background sourcing work records completion/failure through sourcing run verbs"
    - "First-search retry is driven from latest durable failed state"

key-files:
  created:
    - src/core/onboarding/first-search-run.mjs
    - src/cli/sourcing-route.mjs
    - tests/first-search-run.test.mjs
  modified:
    - src/cli/onboard-route.mjs
    - src/cli/search-route.mjs
    - src/cli/tracker-dev.mjs
    - tests/onboard-route.test.mjs
    - tests/search-route.test.mjs
    - tests/sourcing-route.test.mjs

key-decisions:
  - "Onboarding quick-start now calls a first-search-specific helper; the existing discovery prep helper remains for explicit /api/discovery/quick-start chat handoff."
  - "POST /api/sourcing/first-run/start inspects the latest durable first-search run and passes retryFailed:true only when the latest run failed."
  - "Deterministic first-search counts include enabled RSS/rssUrl entries and supported ATS companies, excluding browser/auth/url-query sources from automatic first-run work."

patterns-established:
  - "Durable sourcing route pattern: read latest run state, create or reuse run, start background scan only for new running work, return 202 for new work and 200 for reuse."
  - "Quick-start local-first pattern: DB setup readiness gates local deterministic work without compatibility file export or hidden runtime handoff."

requirements-completed: [RUN-01, RUN-02]

coverage:
  - id: D1
    description: "First-search orchestration prepares DB search-sources, counts deterministic sources, and records completed/failed runs."
    requirement: RUN-01
    verification:
      - kind: unit
        ref: "node --test tests/first-search-run.test.mjs#prepareFirstSearchSources/countDeterministicSources/retry/zero-result"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sourcing routes expose latest run state, first-run start/retry, and manual-search start without hidden runtime escalation."
    requirement: RUN-02
    verification:
      - kind: integration
        ref: "node --test tests/sourcing-route.test.mjs tests/search-route.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Onboarding quick-start starts durable local first-search work and omits discovery/chat handoff response fields."
    requirement: RUN-01
    verification:
      - kind: integration
        ref: "node --test tests/onboard-route.test.mjs#POST /api/onboard/quick-start"
        status: pass
    human_judgment: false

duration: 12 min
completed: 2026-07-05
status: complete
---

# Phase 07 Plan 06: First-Search Orchestration Summary

**DB-backed first-search orchestration with durable sourcing routes and local onboarding quick-start**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-05T22:34:44Z
- **Completed:** 2026-07-05T22:45:55Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Added `first-search-run.mjs`, which builds and merges DB `search-sources`, counts deterministic sources, starts/reuses/retries sourcing runs, and records scan completion/failure.
- Added `/api/sourcing/runs/latest`, `/api/sourcing/first-run/start`, and `/api/sourcing/search/start`, mounted in `tracker-dev`.
- Replaced `/api/onboard/quick-start` response behavior so search-ready onboarding starts durable local first-search work and no longer returns discovery skill guidance or compatibility YAML exports.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED:** `3377153` test(07-06): add failing first-search service tests
2. **Task 1 GREEN:** `8084d54` feat(07-06): create first-search orchestration service
3. **Task 2 RED:** `9176582` test(07-06): add failing durable sourcing route tests
4. **Task 2 GREEN:** `9a4b831` feat(07-06): mount durable sourcing routes

_Note: Both tasks followed TDD with separate RED and GREEN commits._

## Files Created/Modified

- `src/core/onboarding/first-search-run.mjs` - First-search source preparation, deterministic source counting, durable run start/retry, and background scan completion/failure.
- `src/cli/sourcing-route.mjs` - Local sourcing run APIs for latest status, first-run start/retry, and manual-search start.
- `src/cli/onboard-route.mjs` - Onboarding quick-start now starts local first-search work while preserving the explicit discovery prep helper for `/api/discovery/quick-start`.
- `src/cli/search-route.mjs` - `/api/search/sources` now includes deterministic source counts.
- `src/cli/tracker-dev.mjs` - Mounts sourcing routes and documents them in route help/not-found text.
- `tests/first-search-run.test.mjs` - Service-level coverage for DB-only prep, counts, retry, and zero-result completion.
- `tests/sourcing-route.test.mjs` - Route coverage for latest state, missing DB, not-ready, idempotence, retry, zero deterministic source failure, and manual search.
- `tests/onboard-route.test.mjs` - Quick-start coverage for local first-run behavior and no compatibility exports or discovery handoff fields.
- `tests/search-route.test.mjs` - Source-count response coverage adjusted for deterministic source counts.

## Decisions Made

- Kept `prepareQuickStartSourcing` unchanged for the explicit `/api/discovery/quick-start` chat handoff and added `prepareQuickStartFirstSearch` for `/api/onboard/quick-start`.
- Made first-run retry state server-derived: the route inspects latest durable `first-search` state and passes `retryFailed:true` only after a failed latest run.
- Counted automatic deterministic work narrowly: RSS/rssUrl entries plus supported public ATS companies only.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Preserved explicit discovery quick-start compatibility**
- **Found during:** Task 2
- **Issue:** Replacing the exported `prepareQuickStartSourcing` helper directly would have broken `/api/discovery/quick-start`, which is the explicit user-selected chat handoff path.
- **Fix:** Added `prepareQuickStartFirstSearch` for onboarding quick-start and left `prepareQuickStartSourcing` available for discovery.
- **Files modified:** `src/cli/onboard-route.mjs`
- **Verification:** `node --test tests/discovery-route.test.mjs tests/decomposition-map.test.mjs`
- **Committed in:** `9a4b831`

**2. [Rule 1 - Bug] Latest-run UI mapping returned a wrapper object for missing runs**
- **Found during:** Task 2
- **Issue:** `latestSourcingRunForUi()` mapped `null` through `mapSourcingRunForUi()`, producing a nested not-started object instead of `run: null`.
- **Fix:** Return `run: null` when no durable run exists.
- **Files modified:** `src/core/onboarding/first-search-run.mjs`
- **Verification:** `node --test tests/sourcing-route.test.mjs`
- **Committed in:** `9a4b831`

---

**Total deviations:** 2 auto-fixed (Rule 1: 1, Rule 2: 1)
**Impact on plan:** Both fixes were required to preserve existing explicit discovery behavior and deliver the route envelope React expects.

## Issues Encountered

- Biome reported an existing warning for `ROLESTER_TRACKER_HOST` missing from `turbo.json` env configuration while checking `src/cli/tracker-dev.mjs`. This predates 07-06 and was not changed.
- The worktree had unrelated pre-existing `.planning` changes and `.planning/research/` untracked files. They were not staged in task commits.

## Known Stubs

None. Stub scan found only existing tracker-dev fallback placeholder text, legitimate empty initializers, and test fixtures; no 07-06 behavior relies on mock data or placeholders.

## Threat Mitigations

- `/api/sourcing/*` delegates run lifecycle to DB verbs and returns stable status envelopes.
- First-search start/retry is idempotent for running/completed work and records failed retry lineage in durable metadata.
- New first-search service imports no chat, skill runtime, browser/session, discovery route, or compatibility YAML write helpers.
- Source setup writes through `sourceConfigPut`; compatibility YAML remains outside the product-state readiness path.

## Verification

- `node --test tests/first-search-run.test.mjs tests/sourcing-route.test.mjs tests/search-route.test.mjs tests/onboard-route.test.mjs`
- `node --test tests/discovery-route.test.mjs tests/decomposition-map.test.mjs`
- `node --test tests/first-search-run.test.mjs tests/sourcing-route.test.mjs tests/search-route.test.mjs tests/onboard-route.test.mjs tests/discovery-route.test.mjs tests/decomposition-map.test.mjs`
- `npm exec biome check -- src/cli/sourcing-route.mjs src/core/onboarding/first-search-run.mjs src/cli/onboard-route.mjs src/cli/tracker-dev.mjs tests/sourcing-route.test.mjs tests/onboard-route.test.mjs tests/search-route.test.mjs tests/first-search-run.test.mjs`
- `rg -n "chat|/api/skill/run|skill-runtime|browser|auth|runSkill|mountSkill|startSession|findBySkill" src/cli/sourcing-route.mjs src/core/onboarding/first-search-run.mjs || true`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

React can now read durable sourcing status and start/retry local deterministic sourcing through `/api/sourcing/*` and `/api/onboard/quick-start`. Follow-on UI work can render `Not started`, `Running`, `Completed`, and `Failed` states from DB-backed run envelopes.

## Self-Check: PASSED

- Verified all 10 claimed created/modified files exist.
- Verified task commits exist: `3377153`, `8084d54`, `9176582`, `9a4b831`.
- Verified summary frontmatter contains `status: complete` and `requirements-completed: [RUN-01, RUN-02]`.

---
*Phase: 07-quick-onboarding-and-auto-sourcing*
*Completed: 2026-07-05*
