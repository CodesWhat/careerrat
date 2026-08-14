---
phase: 02-bounded-ai-foundation
plan: "02"
subsystem: ai-runtime
tags: [call-ai, structured-output, anthropic, telemetry-labels, node-test]

requires:
  - phase: 02-bounded-ai-foundation
    provides: [bounded AI helper contract, strict AI labels, safe route envelopes]
provides:
  - Provider-native structured output request options through callAI()
  - Hermetic BYOK and proxy request-shape tests for native structured output
  - Regression coverage that non-schema calls omit provider-native output_config
affects: [bounded-ai-helper, company-discovery-api, ai-proxy, route-migration]

tech-stack:
  added: []
  patterns:
    - "Provider-native Anthropic structured output is adapted inside callAI() from provider-neutral options."
    - "Native structured-output requests preserve existing BYOK usage rows and proxy skill/action headers."

key-files:
  created: []
  modified:
    - src/core/ai/call-ai.mjs
    - tests/call-ai.test.mjs

key-decisions:
  - "callAI() exposes provider-neutral outputSchema, outputName, and outputMode options while keeping Anthropic output_config construction inside callAI()."
  - "output_config.format is emitted only for outputMode:\"native\" calls that provide outputSchema; ordinary calls keep the existing request body."
  - "Proxy native structured-output calls still forward x-careerrat-skill and x-careerrat-action, leaving proxy usage metering server-side."

patterns-established:
  - "Native output adapter: translate CareerRat output options to Anthropic output_config.format inside buildRequest()."
  - "Request-shape tests: mock upstreams capture headers and JSON bodies without live AI credentials."

requirements-completed:
  - AIR-01
  - AIR-02
  - AIR-04

coverage:
  - id: D1
    description: "callAI() accepts native structured-output options and emits Anthropic json_schema output_config for BYOK requests."
    requirement: AIR-02
    verification:
      - kind: unit
        ref: "tests/call-ai.test.mjs#callAI (BYOK, native output): sends Anthropic json_schema output_config"
        status: pass
      - kind: other
        ref: "node --test tests/call-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Proxy native structured-output requests preserve authorization and CareerRat skill/action labels."
    requirement: AIR-04
    verification:
      - kind: unit
        ref: "tests/call-ai.test.mjs#callAI (proxy path, native output): forwards json_schema body plus auth and labels"
        status: pass
      - kind: other
        ref: "node --test tests/call-ai.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Non-schema calls keep the existing request shape and route modules do not encode provider output_config."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/call-ai.test.mjs#callAI (BYOK, non-native): omits output_config when no outputSchema is provided"
        status: pass
      - kind: other
        ref: "rg -n \"output_config|json_schema\" src --glob '!src/core/ai/call-ai.mjs' (no matches)"
        status: pass
    human_judgment: false

duration: 2 min
completed: 2026-07-04
status: complete
---

# Phase 02 Plan 02: Native Structured Output Request Options Summary

**Provider-native structured output request options in callAI() with hermetic BYOK/proxy request-shape coverage**

## Performance

- **Duration:** 2 min
- **Started:** 2026-07-04T21:12:06Z
- **Completed:** 2026-07-04T21:14:03Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Added `outputSchema`, `outputName`, and `outputMode` options to `callAI()`.
- Converted native structured-output options into Anthropic `output_config.format` only inside `src/core/ai/call-ai.mjs`.
- Added hermetic BYOK/proxy tests proving native request shape, proxy label headers, usage-row preservation, and non-native request-shape behavior.

## TDD Gate Compliance

- **RED:** `e1fc0ed` - `test(02-02): add failing native output callAI tests`
- **GREEN:** `af09e0a` - `feat(02-02): implement native output request options`
- **REFACTOR:** No refactor commit needed; the implementation remains a small `buildRequest()` adapter and all tests stayed green after hook formatting.

## Task Commits

1. **Task 1 RED: TDD native structured-output options through callAI** - `e1fc0ed` (test)
2. **Task 1 GREEN: TDD native structured-output options through callAI** - `af09e0a` (feat)

**Plan metadata:** pending final docs commit.

## Files Created/Modified

- `src/core/ai/call-ai.mjs` - Adds provider-neutral output options and Anthropic native `output_config.format` request construction.
- `tests/call-ai.test.mjs` - Adds mock-upstream assertions for BYOK native output, proxy native output with labels, and non-schema request bodies.

## Verification

- `node --test tests/call-ai.test.mjs` - PASS, 15 tests passing.
- RED verification: `node --test tests/call-ai.test.mjs` failed before implementation with 13 passing and 2 failing native-output tests due missing `output_config`.
- `rg -n "output_config|json_schema" src --glob '!src/core/ai/call-ai.mjs'` - PASS, no route-layer matches.
- `git log --oneline --grep="^test(02-02)" --grep="^feat(02-02)"` - PASS, RED and GREEN commits present.

## Decisions Made

- `callAI()` exposes provider-neutral `outputSchema`, `outputName`, and `outputMode` options while keeping Anthropic `output_config` construction inside `callAI()`.
- `output_config.format` is emitted only for `outputMode:"native"` calls that provide `outputSchema`; ordinary calls keep the existing request body.
- Proxy native structured-output calls still forward `x-careerrat-skill` and `x-careerrat-action`, leaving proxy usage metering server-side.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- GSD metadata sync handlers partially mismatched this roadmap/state template during close-out: `roadmap.update-plan-progress 02` rewrote the Phase 2 overview row as if it used a plan-count table shape, and `state.update-progress` left the frontmatter percent stale. The generated metric/session/decision updates were preserved, and the affected metadata fields were repaired before the docs commit.

## Known Stubs

None. Stub-pattern scan matched only internal parser/request accumulators and nullable option defaults, not unfinished UI/data stubs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 02-03. The lower-level `callAI()` seam can now carry native structured-output schema options for bounded helpers and later route migrations without provider-specific route code.

## Self-Check: PASSED

- Modified files exist: `src/core/ai/call-ai.mjs`, `tests/call-ai.test.mjs`.
- TDD commits exist: `e1fc0ed`, `af09e0a`.
- Required verification passed: `node --test tests/call-ai.test.mjs`.
- Route-layer isolation check passed: no `output_config` or `json_schema` matches under `src/` outside `src/core/ai/call-ai.mjs`.
- No tracked files were deleted by task commits.
- GSD metadata close-out files were repaired and staged after the update handler row-shape mismatch.
- Pre-existing dirty files `tests/release-safety.test.mjs` and `tmp-skill-conversion/` were not staged or modified by this plan.

---
*Phase: 02-bounded-ai-foundation*
*Completed: 2026-07-04*
