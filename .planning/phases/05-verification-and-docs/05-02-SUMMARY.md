---
phase: 05-verification-and-docs
plan: "02"
subsystem: testing
tags: [company-discovery, bounded-ai, structured-output, no-ai, route-regression, tdd]

requires:
  - phase: 02-bounded-ai-foundation
    provides: bounded AI envelopes, native-preferred structured output, corrective retry, and no-AI/manual fallback semantics
  - phase: 03-company-discovery-api
    provides: company seed generation and local company proposal create route
  - phase: 05-verification-and-docs
    provides: VER-01 deterministic discovery cost-boundary regression lock
provides:
  - VER-02 helper-level malformed JSON retry, schema rejection, and safe manual envelope coverage for company seeds
  - VER-02 route-level AI_SCHEMA_INVALID coverage for company proposal creation
  - VER-03 route-level NO_AI_ROUTE/manual fallback coverage proving no chat, no full runtime, no batch, and no generated tracker/activity writes
affects: [company-discovery-api, bounded-ai-helper, runtime-routing, verification-and-docs]

tech-stack:
  added: []
  patterns:
    - Hermetic native-preferred AI tests using injected call seams and fixture responses
    - Route failure side-effect assertions that check unchanged source config, absent proposal batches, and absent generated workspace exports

key-files:
  created:
    - .planning/phases/05-verification-and-docs/05-02-SUMMARY.md
  modified:
    - tests/company-discovery-seeds.test.mjs
    - tests/company-proposals-route.test.mjs

key-decisions:
  - "Structured-output negative coverage stayed test-only because existing production code already returns safe bounded-AI envelopes for malformed, schema-invalid, and no-AI paths."
  - "Route failure side-effect assertions compare source config to the fixture's pre-failure state instead of assuming an empty source config."

patterns-established:
  - "Company seed negative tests assert retry metadata, manual fallback metadata, trusted-field schema rejection, and no prompt/model/candidate/private-comp leakage."
  - "Company proposal route negative tests assert failure responses plus no chat start, no full runtime seam, no resolver/scanner/write seam, no proposal batch, and no tracker/activity export."

requirements-completed: [VER-02, VER-03]

coverage:
  - id: D1
    description: "Company seed generation covers malformed JSON corrective retry, schema rejection of trusted URL/provider/write fields, and safe exhausted malformed-output envelopes."
    requirement: VER-02
    verification:
      - kind: unit
        ref: "tests/company-discovery-seeds.test.mjs#malformed company seed JSON gets exactly one corrective retry before succeeding"
        status: pass
      - kind: unit
        ref: "tests/company-discovery-seeds.test.mjs#schema-invalid company seed trusted fields return AI_SCHEMA_INVALID manual envelopes"
        status: pass
      - kind: unit
        ref: "tests/company-discovery-seeds.test.mjs#exhausted malformed company seed output returns safe manual metadata without prompt or model leakage"
        status: pass
      - kind: other
        ref: "node --test tests/company-discovery-seeds.test.mjs tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Company proposal route no-AI and AI_SCHEMA_INVALID failures remain manual, write-free, batch-free, and do not start chat or retained full skill runtime."
    requirement: VER-03
    verification:
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals returns no-AI manual fallback without chat, full runtime, or writes"
        status: pass
      - kind: integration
        ref: "tests/company-proposals-route.test.mjs#POST /api/discovery/company-proposals returns AI_SCHEMA_INVALID without proposal batches or writes"
        status: pass
      - kind: other
        ref: "node --test tests/company-proposals-route.test.mjs tests/company-discovery-seeds.test.mjs tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs"
        status: pass
    human_judgment: false

duration: 3 min
completed: 2026-07-05
status: complete
---

# Phase 05 Plan 02: Structured-Output and No-AI Route Negative Coverage Summary

**Company discovery seed and proposal route failures now have hermetic regression coverage for retry, schema rejection, manual fallback, and write-free no-AI behavior.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-05T12:45:26Z
- **Completed:** 2026-07-05T12:49:21Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added helper-level company seed tests for malformed JSON retrying exactly once, schema-invalid trusted fields returning `AI_SCHEMA_INVALID`, and exhausted malformed output omitting raw prompt/model/candidate/private-comp leakage.
- Added route-level proposal creation tests for `NO_AI_ROUTE` and `AI_SCHEMA_INVALID` failures with manual metadata, no chat starts, no retained runtime seam calls, no proposal batches, and no generated tracker/activity files.
- Preserved the Phase 05 test-only scope: no production source, package dependencies, real AI/network calls, tracker data writes, or unrelated `tests/release-safety.test.mjs` edits were introduced.

## Task Commits

1. **Task 1 RED: failing company seed negative regression scaffold** - `36360fb` (test)
2. **Task 1 GREEN: helper-level structured-output negative coverage** - `846a1f9` (feat)
3. **Task 2 RED: failing proposal route negative scaffold** - `8ececb4` (test)
4. **Task 2 GREEN: route-level no-AI and schema-invalid coverage** - `736a966` (feat)

_Note: Both tasks were TDD-marked regression tasks, so each produced RED and GREEN commits. No refactor commits were needed._

## Files Created/Modified

- `tests/company-discovery-seeds.test.mjs` - Adds VER-02 helper-level malformed retry, schema rejection, and safe manual envelope assertions.
- `tests/company-proposals-route.test.mjs` - Adds VER-02/VER-03 route-level no-AI and schema-invalid failure assertions with no-write side-effect checks.
- `.planning/phases/05-verification-and-docs/05-02-SUMMARY.md` - Records plan outcome and verification evidence.

## Decisions Made

- Kept this plan test-only because the existing bounded-AI and company proposal implementation already satisfied the failure contracts once covered.
- Checked source config unchanged after failure rather than requiring it to be empty, because the schema-invalid route fixture intentionally seeds tracked-company context before exercising the failure.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Task 2's first GREEN run failed because the new side-effect helper assumed an empty source config while the fixture intentionally had one tracked company for prompt/dedupe context. The assertion was corrected to compare against the pre-failure source config state, and the full Task 2 command passed.
- During close-out, `state.advance-plan` could not parse this project's compact `STATE.md` layout and `roadmap.update-plan-progress` rewrote the Phase 5 overview row into a malformed compact row. I preserved the SDK-updated `2/5` plan progress and corrected only the malformed overview row plus the STATE percent.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub-pattern scanning found only normal test helper defaults, local accumulator arrays, and response defaults.

## Threat Flags

None. This plan added test-only verification and introduced no new network endpoint, auth path, file-access boundary, schema, or production write surface.

## TDD Gate Compliance

- **Task 1 RED:** `36360fb test(05-02): add failing company seed negative regression scaffold` - `node --test tests/company-discovery-seeds.test.mjs tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs` failed only on the new scaffold.
- **Task 1 GREEN:** `846a1f9 feat(05-02): lock company seed structured-output negatives` - the Task 1 command passed with 35 tests.
- **Task 2 RED:** `8ececb4 test(05-02): add failing proposal route negative scaffold` - the Task 2 command failed only on the new scaffold.
- **Task 2 GREEN:** `736a966 feat(05-02): lock proposal route negative behavior` - the Task 2 command passed with 45 tests.
- **REFACTOR:** not needed.

## Verification

- Baseline Task 1 command: `node --test tests/company-discovery-seeds.test.mjs tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs` - PASS (32 tests).
- Task 1 RED command: same command - FAIL as expected on `VER-02 company seed structured-output negative regressions are implemented`.
- Task 1 GREEN command: same command - PASS (35 tests).
- Baseline Task 2 command: `node --test tests/company-proposals-route.test.mjs tests/company-discovery-seeds.test.mjs tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs` - PASS (43 tests).
- Task 2 RED command: same command - FAIL as expected on `VER-02/VER-03 company proposal route negative regressions are implemented`.
- Final plan command: `node --test tests/company-discovery-seeds.test.mjs tests/company-proposals-route.test.mjs tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs` - PASS (45 tests).
- Acceptance scan: `rg -n "malformed company seed JSON|corrective retry|AI_SCHEMA_INVALID|assertNoFailureLeak|careers_url|provider|approved|manual.available" tests/company-discovery-seeds.test.mjs` - PASS.
- Acceptance scan: `rg -n "NO_AI_ROUTE|AI_SCHEMA_INVALID|assertNoProposalFailureSideEffects|chatRuntime\\.starts|companyProposalBatchLatest|workspace/tracker\\.json|workspace/activity\\.jsonl|runSkillStream|companyAtsUpsert|sourcedUpsertBatch" tests/company-proposals-route.test.mjs` - PASS.

## Acceptance Criteria

- Helper-level tests explicitly prove malformed parse failure, corrective retry, schema rejection, and safe manual envelope behavior for VER-02 - PASS.
- Route-level structured-output and no-AI failures are explicit, manual, write-free, and do not escalate to chat/full skill runtime for VER-02 and VER-03 - PASS.
- No real AI/network calls, package dependencies, tracker data writes, or unrelated release-safety edits were introduced - PASS.

## Next Phase Readiness

Plan 05-02 is complete. Plan 05-03 can build on this negative coverage to lock confirm-first write safety behavior.

## Self-Check: PASSED

- Verified `tests/company-discovery-seeds.test.mjs` exists.
- Verified `tests/company-proposals-route.test.mjs` exists.
- Verified `.planning/phases/05-verification-and-docs/05-02-SUMMARY.md` exists.
- Verified commits `36360fb`, `846a1f9`, `8ececb4`, and `736a966` exist in git history.
- Verified the final plan command exits 0 with 45 passing tests.
- Verified task commits did not delete tracked files.
- Verified pre-existing dirty paths `tests/release-safety.test.mjs`, `.planning/research/`, and `tmp-skill-conversion/` remain unstaged and outside this plan.

---
*Phase: 05-verification-and-docs*
*Completed: 2026-07-05*
