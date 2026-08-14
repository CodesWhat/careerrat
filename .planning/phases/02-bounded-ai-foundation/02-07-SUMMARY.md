---
phase: 02-bounded-ai-foundation
plan: "07"
subsystem: testing
tags: [bounded-ai, telemetry, privacy, usage-log, node-test]

requires:
  - phase: 02-bounded-ai-foundation
    provides: [bounded AI helper contract, assist route migration, intake migration, resume-AI migration]
provides:
  - Final AIR-04 regression coverage for BYOK usage rows
  - Final AIR-04 regression coverage for managed-proxy usage rows
  - Helper and route no-leak failure-envelope regressions
  - Missing-label pre-invocation regression coverage for fallback and native helper paths
affects: [bounded-ai-helper, call-ai, ai-proxy, assist-route, resume-ai, telemetry]

tech-stack:
  added: []
  patterns:
    - "Usage-row regression tests pin the exact metadata-only key set for BYOK and proxy metering."
    - "Failure-envelope regression tests scan concrete prompt, raw model, resume, JD, candidate, and page-body sentinels."
    - "Missing-label helper tests assert both fallback invoke callbacks and native call seams remain uncalled."

key-files:
  created:
    - .planning/phases/02-bounded-ai-foundation/02-07-SUMMARY.md
  modified:
    - tests/bounded-ai.test.mjs
    - tests/call-ai.test.mjs
    - tests/ai-proxy.test.mjs
    - tests/assist-route.test.mjs
    - tests/onboard-route.test.mjs

key-decisions:
  - "Plan 02-07 stayed test-only because the final regressions passed against production code from Plans 02-01 through 02-06."
  - "Allowed usage event keys are locked to id, at, source, skill, action, model, upstream, token/cache/search fields, shared_cache_hit, cost_usd, and priced."
  - "No production files were changed because no leakage or dropped-label regression was exposed."

patterns-established:
  - "Metadata-only usage assertion: compare sorted usage-row keys against the full allowed set, then scan for forbidden body/schema/raw fields and sentinel strings."
  - "Route envelope privacy assertion: serialize error envelopes and scan for forbidden field names plus concrete prompt/raw/resume/JD/candidate/page-body sentinels."

requirements-completed:
  - AIR-01
  - AIR-04

coverage:
  - id: D1
    description: "Bounded helper failures reject missing labels before fallback invoke or native call seams and omit sensitive failure content."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#requireBoundedAILabels rejects missing or blank labels before invocation"
        status: pass
      - kind: unit
        ref: "tests/bounded-ai.test.mjs#runBoundedAI failure envelopes omit raw prompts, model text, and sensitive source content"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs tests/assist-route.test.mjs tests/onboard-route.test.mjs tests/intake-classify.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "BYOK native bounded calls write non-null skill/action labels and allowed metadata-only usage keys."
    requirement: AIR-04
    verification:
      - kind: unit
        ref: "tests/call-ai.test.mjs#callAI (BYOK, native output): usage rows preserve labels and metadata-only keys"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs tests/assist-route.test.mjs tests/onboard-route.test.mjs tests/intake-classify.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Managed-proxy bounded calls meter non-null skill/action labels and allowed metadata-only usage keys."
    requirement: AIR-04
    verification:
      - kind: unit
        ref: "tests/ai-proxy.test.mjs#proxy (non-stream): metered bounded calls write labels and allowed usage keys only"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs tests/assist-route.test.mjs tests/onboard-route.test.mjs tests/intake-classify.test.mjs"
        status: pass
    human_judgment: false
  - id: D4
    description: "Assist schema and provider failure envelopes do not expose raw model output or source prompt content."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/assist-route.test.mjs#POST /api/assist/suggest: 422s when the model never produces valid output, even after the retry"
        status: pass
      - kind: unit
        ref: "tests/assist-route.test.mjs#POST /api/assist/suggest: provider failures return safe envelopes without raw content"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs tests/assist-route.test.mjs tests/onboard-route.test.mjs tests/intake-classify.test.mjs"
        status: pass
    human_judgment: false
  - id: D5
    description: "Resume-AI schema, no-route, and provider/runtime failure envelopes keep 501/502 classification and omit sensitive upload/source content."
    requirement: AIR-01
    verification:
      - kind: unit
        ref: "tests/onboard-route.test.mjs#POST /api/onboard/resume-ai 422/501/502 failure tests"
        status: pass
      - kind: other
        ref: "node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs tests/assist-route.test.mjs tests/onboard-route.test.mjs tests/intake-classify.test.mjs"
        status: pass
    human_judgment: false

duration: 3 min
completed: 2026-07-04
status: complete
---

# Phase 02 Plan 07: Telemetry and Privacy Regression Summary

**Bounded AI telemetry and route failures are now regression-tested for strict labels, metadata-only usage rows, and no raw content leakage**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-04T22:32:21Z
- **Completed:** 2026-07-04T22:35:32Z
- **Tasks:** 1
- **Files modified:** 5

## Accomplishments

- Added helper-level regressions proving missing `skill`, `action`, or `operation` labels stop before both fallback invocation and native call seams.
- Added exact allowed-key assertions for BYOK and managed-proxy usage rows, including non-null bounded `skill` and `action` labels.
- Added concrete forbidden-content scans across helper, assist, and resume-AI failure envelopes for prompt, raw model, resume, JD, candidate-fact, and page-body sentinels.
- Preserved the final bounded-AI verification subset with no live AI credentials.

## Regression Gate Compliance

- **Regression commit:** `12225d3` - `test(02-07): add telemetry privacy regressions`
- **Production fix:** Not applicable. The new regressions passed against existing production code from Plans 02-01 through 02-06, so this plan remained test-only as instructed.
- **Test cleanup:** No separate refactor commit needed; Biome formatted the staged test changes during the test commit hook.

## Task Commits

1. **Task 1: TDD telemetry label and no-leak regressions** - `12225d3` (test)

**Plan metadata:** pending final docs/state commit.

## Files Created/Modified

- `tests/bounded-ai.test.mjs` - Adds native-path missing-label pre-call assertions and forbidden-content scans for schema/no-AI/provider helper failures.
- `tests/call-ai.test.mjs` - Adds BYOK native usage-row metadata-only assertions and raw model response sentinels.
- `tests/ai-proxy.test.mjs` - Adds managed-proxy usage-row metadata-only assertions for bounded labeled calls.
- `tests/assist-route.test.mjs` - Adds assist schema/provider failure no-leak route-envelope checks.
- `tests/onboard-route.test.mjs` - Adds resume-AI schema/no-route/provider failure no-leak route-envelope checks.

## Verification

- Baseline before edits: `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs tests/assist-route.test.mjs tests/onboard-route.test.mjs tests/intake-classify.test.mjs` passed with 106 passing and 1 skipped integration test.
- Post-edit verification before commit: same command passed with 110 passing and 1 skipped integration test.
- Final verification after commit: same command passed with 110 passing and 1 skipped integration test.
- Pre-commit hooks ran normally; `structure-guards` passed and Biome checked the five staged files.

## Decisions Made

- Plan 02-07 stayed test-only because the final regressions passed against production code from Plans 02-01 through 02-06.
- The allowed usage row key set is now asserted exactly in both BYOK and proxy tests.
- Route failure privacy checks use concrete sentinel strings rather than only checking for legacy field names.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes. No production leakage or dropped-label regression was exposed, so no production patch was made.

## Issues Encountered

- The regression baseline already passed before edits because the behavior existed from prior plans. This was investigated by the baseline run and the post-edit regression run; no production fix was needed or allowed by the plan.
- `state.advance-plan` could not parse this project's compact `STATE.md` layout, matching prior Phase 02 close-out behavior. Other SDK handlers updated progress, metrics, decisions, session continuity, requirements, and roadmap state.
- `roadmap.update-plan-progress 02` rewrote the five-column overview row as a four-column progress row. The row was repaired to preserve the existing ROADMAP shape while updating Phase 2 to `Complete (7/7, 2026-07-04)`.

## Known Stubs

None. Stub-pattern scan matched only test fixture sentinel strings and existing nullable/default handling, not unfinished UI/data stubs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 2 is complete. The bounded AI foundation now has helper, route, BYOK, proxy, and final privacy/telemetry regression coverage ready for Phase 3 company discovery work.

## Self-Check: PASSED

- Modified files exist: `tests/bounded-ai.test.mjs`, `tests/call-ai.test.mjs`, `tests/ai-proxy.test.mjs`, `tests/assist-route.test.mjs`, `tests/onboard-route.test.mjs`.
- Summary file exists: `.planning/phases/02-bounded-ai-foundation/02-07-SUMMARY.md`.
- Task commit exists: `12225d3`.
- Required verification passed: `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs tests/assist-route.test.mjs tests/onboard-route.test.mjs tests/intake-classify.test.mjs`.
- No tracked files were deleted by the task commit.
- Pre-existing dirty files `tests/release-safety.test.mjs` and `tmp-skill-conversion/` were not staged or modified by this plan.

---
*Phase: 02-bounded-ai-foundation*
*Completed: 2026-07-04*
