---
phase: 04-runtime-routing
plan: 01
subsystem: runtime-routing
tags: [runtime-config, skill-runtime, chat-runtime, ai-route, tdd]

requires:
  - phase: 02-bounded-ai-foundation
    provides: AI route detection through resolveAIRoute()
  - phase: 03-company-discovery-api
    provides: Local company proposal and manual seed capabilities for discovery routing
provides:
  - Backward-compatible GET /api/runtime/config payload with one-shot skills, chat skills, AI route state, and discovery capability flags
  - Focused TDD coverage proving config reads do not start retained skill runtime sessions
  - Existing evaluate and answer page runtime-config consumers preserved through body.skills compatibility
affects: [04-runtime-routing, onboarding-runtime-capabilities, discovery-routing]

tech-stack:
  added: []
  patterns:
    - Runtime-owned capability config from existing allowlist and AI-route helpers
    - Read-only route extension that preserves retained POST /api/skill/run behavior

key-files:
  created:
    - .planning/phases/04-runtime-routing/04-01-SUMMARY.md
  modified:
    - src/cli/skill-run-route.mjs
    - tests/skill-run-route.test.mjs
    - tests/evaluate-page.test.mjs
    - tests/answer-page.test.mjs

key-decisions:
  - "GET /api/runtime/config exposes only skill names, route type, and booleans; secrets and raw env values remain unreported."
  - "Discovery chat handoff availability is derived from chat runtime allowlist membership for research-boards, discover-companies, or search-jobs."
  - "Task 3 made no refactor commit because GREEN did not introduce avoidable duplication."

patterns-established:
  - "Runtime capability config: resolve skills from runtime helpers, compute booleans in the route, and keep the response read-only."

requirements-completed: [RUNT-01, RUNT-03]

coverage:
  - id: D1
    description: "GET /api/runtime/config returns skills, chatSkills, ai, and discovery capability fields without starting runSkillStream."
    requirement: RUNT-01
    verification:
      - kind: unit
        ref: "tests/skill-run-route.test.mjs#GET /api/runtime/config: returns one-shot, chat, AI-route, and discovery capabilities without starting a skill run"
        status: pass
    human_judgment: false
  - id: D2
    description: "Existing evaluate and answer pages remain compatible by reading body.skills after capability payload expansion."
    requirement: RUNT-01
    verification:
      - kind: unit
        ref: "tests/evaluate-page.test.mjs and tests/answer-page.test.mjs runtime config assertions"
        status: pass
    human_judgment: false
  - id: D3
    description: "Discovery chat handoff capability is explicit and derived from chat allowlist state."
    requirement: RUNT-03
    verification:
      - kind: unit
        ref: "tests/skill-run-route.test.mjs#GET /api/runtime/config: reports no AI route and no discovery chat handoff when discovery chat skills are unavailable"
        status: pass
    human_judgment: false

duration: 3min
completed: 2026-07-05
status: complete
---

# Phase 04 Plan 01: Runtime Capability Config Summary

**Read-only runtime capability metadata now reports one-shot skills, chat skills, AI route state, and discovery handoff support while preserving the retained SSE skill runtime.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-05T01:54:15Z
- **Completed:** 2026-07-05T01:56:33Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Added TDD coverage for the expanded `GET /api/runtime/config` payload and proved config reads do not call `runSkillStream`.
- Implemented runtime-owned capability metadata using `resolveAllowedSkills()`, `resolveAllowedChatSkills()`, and `resolveAIRoute()`.
- Preserved existing page consumers by asserting `body.skills` compatibility instead of whole-response equality.
- Re-ran focused runtime/page tests with retained `POST /api/skill/run` coverage passing.

## Task Commits

Each implementation task was committed atomically:

1. **Task 1: RED runtime capability config route tests** - `0b74df4` (test)
2. **Task 2: GREEN implement runtime capability config** - `9bea941` (feat)
3. **Task 3: REFACTOR runtime config closeout** - no commit; no behavior-neutral cleanup was needed.

_Note: This TDD plan produced RED and GREEN commits. The REFACTOR gate was executed with no code changes._

## Files Created/Modified

- `src/cli/skill-run-route.mjs` - Expands `GET /api/runtime/config` with `chatSkills`, `ai`, and `discovery` while leaving `POST /api/skill/run` unchanged.
- `tests/skill-run-route.test.mjs` - Adds failing-then-passing config capability tests and keeps POST route regressions intact.
- `tests/evaluate-page.test.mjs` - Keeps evaluate page assertions focused on `body.skills`.
- `tests/answer-page.test.mjs` - Keeps answer page assertions focused on `body.skills`.
- `.planning/phases/04-runtime-routing/04-01-SUMMARY.md` - Plan completion record.

## Verification

- RED gate: `node --test tests/skill-run-route.test.mjs tests/evaluate-page.test.mjs tests/answer-page.test.mjs` failed as expected on the two new missing capability-field assertions; existing POST tests passed.
- GREEN gate: `node --test tests/skill-run-route.test.mjs tests/evaluate-page.test.mjs tests/answer-page.test.mjs tests/skill-runtime.test.mjs tests/chat-runtime.test.mjs` passed with 82 passing and 2 skipped integration tests.
- REFACTOR gate: same focused command passed again with 82 passing and 2 skipped integration tests.
- Package manifest check: no package or lockfile changes.

## Decisions Made

- `GET /api/runtime/config` exposes only route kind, booleans, and skill names; API keys, proxy tokens, errors, prompts, and raw env values are not serialized.
- Local discovery proposal and manual seed capability flags are always true because Phase 3 local routes own those capabilities.
- Discovery chat handoffs are true only when `research-boards`, `discover-companies`, or `search-jobs` is present in `chatSkills`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None. Stub-pattern scan hits were local test/helper initializers and request-body accumulators, not UI-rendered placeholder data or unwired behavior.

## Threat Flags

None. The changed surface is the planned `GET /api/runtime/config` trust boundary, and the response avoids secret/env serialization.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 04-02 can load runtime capabilities into the onboarding app and pass them to steps. The backend config payload is stable for UI gating and still keeps retained full-skill execution behind the existing allowlisted POST route.

## Self-Check: PASSED

- Summary path created: `.planning/phases/04-runtime-routing/04-01-SUMMARY.md`
- Required source/test files exist.
- Task commits found: `0b74df4`, `9bea941`
- Final focused verification passed.

---
*Phase: 04-runtime-routing*
*Completed: 2026-07-05*
