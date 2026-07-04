---
phase: 02-bounded-ai-foundation
plan: "03"
subsystem: ai-runtime
tags: [bounded-ai, structured-output, native-output, call-ai, node-test]

requires:
  - phase: 02-bounded-ai-foundation
    provides: [bounded AI helper contract, provider-native callAI request options]
provides:
  - Native-preferred structured output orchestration through runBoundedAI()
  - Local parse/schema validation for provider-native text before success envelopes
  - Fallback structured mode compatibility for custom invoke callbacks
  - extractAIText() for Anthropic-shaped content arrays
affects: [bounded-ai-helper, company-discovery-api, ai-routing, route-migration]

tech-stack:
  added: []
  patterns:
    - "Native-preferred bounded AI calls pass provider-neutral output options to callAI()."
    - "Provider-native text is parsed and schema-validated locally before route data is exposed."
    - "Fallback structured mode remains backed by runStructuredOneshot() and injected invoke callbacks."

key-files:
  created: []
  modified:
    - src/core/ai/bounded-ai.mjs
    - tests/bounded-ai.test.mjs

key-decisions:
  - "runBoundedAI() treats provider-native structured output as a reliability optimization, not a trust boundary; native responses still pass through parseStructuredJson()."
  - "Native-preferred mode calls callAI() or an injected call seam with outputMode:\"native\" and outputSchema while routes keep provider-specific request bodies out of their code."
  - "Fallback mode remains explicit via structuredMode:\"fallback\" so custom invoke routes continue to use runStructuredOneshot()."

patterns-established:
  - "Native helper mode: structuredMode:\"native-preferred\" maps to ai.mode:\"native\" after local validation."
  - "Corrective native retry: failed native parse/validation appends the same structured retry instruction used by fallback mode."
  - "Safe content extraction: extractAIText() reads text blocks without exposing raw provider replies in error envelopes."

requirements-completed:
  - AIR-01
  - AIR-02
  - AIR-04

coverage:
  - id: D1
    description: "Native-preferred bounded AI calls pass provider-neutral native output options and strict labels to callAI()."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#runBoundedAI native-preferred mode calls callAI with native output options and validates locally"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Native provider text is locally parsed and schema-validated before success, with one corrective retry."
    requirement: AIR-02
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#runBoundedAI native-preferred mode locally rejects invalid native text after one retry"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Fallback structured mode still uses injected invoke callbacks and does not call callAI()."
    requirement: AIR-02
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#runBoundedAI fallback structured mode uses invoke and does not call callAI"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs"
        status: pass
    human_judgment: false
  - id: D4
    description: "Native provider failures return safe AI_PROVIDER_FAILED envelopes without prompt or raw-output leakage."
    requirement: AIR-04
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#runBoundedAI native-preferred mode maps provider failures to a safe 502 manual envelope"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs"
        status: pass
    human_judgment: false
  - id: D5
    description: "extractAIText() exposes provider content extraction for Anthropic-shaped text blocks."
    requirement: AIR-02
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#extractAIText returns text from Anthropic-shaped content blocks"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs"
        status: pass
    human_judgment: false

duration: 3 min
completed: 2026-07-04
status: complete
---

# Phase 02 Plan 03: Native-Preferred Bounded AI Helper Summary

**Native-preferred bounded AI orchestration with local schema validation, safe envelopes, and fallback-mode compatibility**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-04T22:03:55Z
- **Completed:** 2026-07-04T22:07:06Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Added `structuredMode:"native-preferred"` to `runBoundedAI()` so the helper calls `callAI()` or an injected `call` with `outputMode:"native"`, `outputSchema`, `outputName`, strict labels, and workspace root.
- Added local native-response validation with `extractAIText()` plus `parseStructuredJson()` before success envelopes expose `body.data`.
- Preserved `structuredMode:"fallback"` behavior through `runStructuredOneshot()` and injected `invoke` callbacks.
- Added hermetic tests for native success, invalid native retry exhaustion, fallback mode, provider failure, and Anthropic-shaped content extraction.

## TDD Gate Compliance

- **RED:** `f84809a` - `test(02-03): add failing native bounded AI tests`
- **GREEN:** `7c26df9` - `feat(02-03): implement native bounded AI mode`
- **REFACTOR:** No refactor commit needed; post-green review kept the implementation scoped to the helper and all verification stayed green.

## Task Commits

1. **Task 1 RED: TDD native-preferred helper mode with local validation** - `f84809a` (test)
2. **Task 1 GREEN: TDD native-preferred helper mode with local validation** - `7c26df9` (feat)

**Plan metadata:** pending final docs commit.

## Files Created/Modified

- `src/core/ai/bounded-ai.mjs` - Adds native-preferred orchestration, local native output parsing/validation, corrective retry, native metadata, and `extractAIText()`.
- `tests/bounded-ai.test.mjs` - Adds RED/GREEN coverage for native call options, local validation failure, fallback compatibility, provider failure, and content extraction.

## Verification

- `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs` - PASS, 41 tests passing.
- RED verification: the same command failed before implementation with 37 passing and 4 failing bounded-helper tests for missing `extractAIText`, missing native call invocation, missing native retry, and fallback metadata on native provider failure.
- TDD gate check: `git log --oneline --grep="^test(02-03)" --grep="^feat(02-03)"` - PASS, RED and GREEN commits present in order.

## Decisions Made

- `runBoundedAI()` treats provider-native structured output as a reliability optimization, not a trust boundary; native responses still pass through `parseStructuredJson()`.
- Native-preferred mode calls `callAI()` or an injected `call` seam with `outputMode:"native"` and `outputSchema` while routes keep provider-specific request bodies out of their code.
- Fallback mode remains explicit via `structuredMode:"fallback"` so custom invoke routes continue to use `runStructuredOneshot()`.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- A local syntax check caught an implementation naming collision between the requested model option and fallback response model metadata before the GREEN verification run. It was corrected before commit, and the required test command passed afterward.

## Known Stubs

None. Stub-pattern scan matched only local test accumulators and nullable helper metadata defaults, not unfinished UI/data stubs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 02-04. The bounded helper can now be used by route migrations that prefer native structured output while preserving local validation, strict labels, safe envelopes, and fallback compatibility.

## Self-Check: PASSED

- Modified files exist: `src/core/ai/bounded-ai.mjs`, `tests/bounded-ai.test.mjs`.
- TDD commits exist: `f84809a`, `7c26df9`.
- Required verification passed: `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs`.
- No tracked files were deleted by task commits.
- Pre-existing dirty files `tests/release-safety.test.mjs` and `tmp-skill-conversion/` were not staged or modified by this plan.

---
*Phase: 02-bounded-ai-foundation*
*Completed: 2026-07-04*
