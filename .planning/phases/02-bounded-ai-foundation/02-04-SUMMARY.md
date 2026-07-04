---
phase: 02-bounded-ai-foundation
plan: "04"
subsystem: ai-runtime
tags: [bounded-ai, assist-route, shared-envelope, node-test, onboarding]

requires:
  - phase: 02-bounded-ai-foundation
    provides: [bounded AI helper contract, native-preferred helper mode]
provides:
  - Assist route migration to runBoundedAI()
  - Shared assist success, schema-failure, and no-AI envelopes
  - Strict assist skill/action/operation labels
  - Client-side assist envelope normalization for onboarding
affects: [assist-route, onboarding-targeting, bounded-ai-helper, route-migration]

tech-stack:
  added: []
  patterns:
    - "Migrated bounded routes call runBoundedAI() and send the helper's {status, body} envelope."
    - "Route-specific prompt builders stay local while shared helpers own schema retry, no-AI, and metadata envelopes."
    - "Client wrappers unwrap body.data for existing UI callers while preserving ai/manual metadata."

key-files:
  created: []
  modified:
    - src/cli/assist-route.mjs
    - tests/assist-route.test.mjs
    - apps/web/src/lib/api.js

key-decisions:
  - "POST /api/assist/suggest now uses runBoundedAI() fallback mode around the existing tool-less runBareOneshot() path."
  - "Assist labels are skill:\"assist\", action:\"suggest-titles\"/\"suggest-keywords\", and operation:\"assist.suggest.titles\"/\"assist.suggest.keywords\"."
  - "suggestAssist() unwraps body.data into the existing UI contract so TargetingStep.jsx stays unchanged."
  - "SDK_NOT_INSTALLED remains a no-AI assist degradation by mapping it into the shared NO_AI_ROUTE envelope."

patterns-established:
  - "Route migration pattern: validate route input, build labels/manual metadata, call runBoundedAI(), then sendJson(result.status, result.body)."
  - "Onboarding API wrapper pattern: return route-specific data at the wrapper boundary and preserve shared envelope metadata for callers that need it."

requirements-completed:
  - AIR-01
  - AIR-02
  - AIR-03

coverage:
  - id: D1
    description: "Assist suggestions use runBoundedAI() with exact skill/action/operation labels and shared success envelopes."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/assist-route.test.mjs#POST /api/assist/suggest: happy path"
        status: pass
      - kind: other
        ref: "node --test tests/assist-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Assist model schema exhaustion returns AI_SCHEMA_INVALID with manual fallback metadata and no legacy top-level suggestion fields."
    requirement: AIR-02
    verification:
      - kind: unit
        ref: "tests/assist-route.test.mjs#POST /api/assist/suggest: 422s when the model never produces valid output"
        status: pass
      - kind: other
        ref: "node --test tests/assist-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Assist no-AI degradation returns NO_AI_ROUTE with ai.used:false and manual fallback metadata."
    requirement: AIR-03
    verification:
      - kind: unit
        ref: "tests/assist-route.test.mjs#POST /api/assist/suggest: 501s when no AI route is configured"
        status: pass
      - kind: other
        ref: "node --test tests/assist-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D4
    description: "suggestAssist() unwraps body.data.suggestions/body.data.rationale while preserving ai/manual metadata for onboarding callers."
    requirement: AIR-03
    verification:
      - kind: unit
        ref: "tests/assist-route.test.mjs#suggestAssist unwraps shared envelope data and preserves AI/manual metadata"
        status: pass
      - kind: other
        ref: "node --test tests/assist-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D5
    description: "Assist prompt behavior, kind validation, request body cap, and tool-less Agent SDK posture remain intact."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/assist-route.test.mjs#buildAssistPrompt tests and happy-path tool assertions"
        status: pass
      - kind: other
        ref: "node --test tests/assist-route.test.mjs tests/bounded-ai.test.mjs"
        status: pass
    human_judgment: false

duration: 3 min
completed: 2026-07-04
status: complete
---

# Phase 02 Plan 04: Assist Route Bounded Helper Migration Summary

**Assist suggestions now use the shared bounded AI envelope with strict labels and onboarding-safe client normalization**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-04T22:10:34Z
- **Completed:** 2026-07-04T22:13:36Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments

- Migrated `POST /api/assist/suggest` from route-local `runStructuredOneshot()` outcome mapping to `runBoundedAI()`.
- Added exact assist route labels: `skill:"assist"`, `action:"suggest-titles"` / `action:"suggest-keywords"`, and matching `assist.suggest.*` operations.
- Updated route tests for shared success, schema-failure, no-AI, retry, label, manual fallback, and tool-less SDK posture contracts.
- Updated `suggestAssist()` to return `{ suggestions, rationale, ai, manual }` from the shared envelope so `TargetingStep.jsx` remains unchanged.

## TDD Gate Compliance

- **RED:** `81c35c8` - `test(02-04): add failing assist envelope tests`
- **GREEN:** `71a34d6` - `feat(02-04): route assist suggestions through bounded AI`
- **REFACTOR:** No refactor commit needed; post-green review found the implementation already scoped to the planned route migration and wrapper normalization.

## Task Commits

1. **Task 1 RED: TDD assist route migration to bounded helper envelope** - `81c35c8` (test)
2. **Task 1 GREEN: TDD assist route migration to bounded helper envelope** - `71a34d6` (feat)

**Plan metadata:** pending final docs commit.

## Files Created/Modified

- `src/cli/assist-route.mjs` - Calls `runBoundedAI()` with the assist schema, strict labels, manual fallback metadata, and the existing tool-less one-shot invocation.
- `tests/assist-route.test.mjs` - Asserts shared envelopes, exact labels, retry/schema/no-AI behavior, client wrapper normalization, and unchanged prompt/tool-less behavior.
- `apps/web/src/lib/api.js` - Unwraps `body.data.suggestions` and `body.data.rationale` for existing onboarding callers while preserving `ai` and `manual` metadata.

## Verification

- RED verification: `node --test tests/assist-route.test.mjs tests/bounded-ai.test.mjs` failed before implementation with 14 passing and 6 failing tests for legacy top-level assist fields and raw client-wrapper envelope return.
- GREEN verification: `node --test tests/assist-route.test.mjs tests/bounded-ai.test.mjs` passed with 20/20 tests.
- Final verification: `node --test tests/assist-route.test.mjs tests/bounded-ai.test.mjs` passed with 20/20 tests after commits.
- TDD gate check: `git log --oneline --grep="^test(02-04)" --grep="^feat(02-04)" --grep="^refactor(02-04)" --all` found RED and GREEN commits in order.

## Decisions Made

- `POST /api/assist/suggest` now uses `runBoundedAI()` fallback mode around the existing `runBareOneshot()` Agent SDK path, preserving the route's no-tool, max-turns-1 posture.
- Assist label metadata is route-specific and strict: `assist:suggest-titles:assist.suggest.titles` or `assist:suggest-keywords:assist.suggest.keywords`.
- The web API wrapper, not `TargetingStep.jsx`, adapts the shared envelope back to the existing UI-facing `{ suggestions, rationale }` shape and keeps `ai`/`manual` available.
- `SDK_NOT_INSTALLED` remains a normal assist degradation by mapping to the shared `NO_AI_ROUTE` envelope.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- `state.advance-plan` could not parse this project's compact `STATE.md` layout, matching the issue documented during Plan 02-03 close-out. Other SDK handlers updated progress, metrics, decisions, and session continuity.
- `roadmap.update-plan-progress 02` rewrote the five-column overview row as a four-column progress table row. The row was repaired to preserve the existing ROADMAP shape while updating Phase 2 to `In Progress (4/7)`.

## Known Stubs

None. Stub-pattern scan matched only ordinary initializer/default parameter syntax in existing helper and test code, not unfinished UI/data stubs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 02-05. The first migrated bounded app route now proves the shared helper/envelope path from API route through the onboarding client wrapper without live AI credentials.

## Self-Check: PASSED

- Modified files exist: `src/cli/assist-route.mjs`, `tests/assist-route.test.mjs`, `apps/web/src/lib/api.js`.
- TDD commits exist: `81c35c8`, `71a34d6`.
- Required verification passed: `node --test tests/assist-route.test.mjs tests/bounded-ai.test.mjs`.
- No tracked files were deleted by task commits.
- Pre-existing dirty files `tests/release-safety.test.mjs` and `tmp-skill-conversion/` were not staged or modified by this plan.

---
*Phase: 02-bounded-ai-foundation*
*Completed: 2026-07-04*
