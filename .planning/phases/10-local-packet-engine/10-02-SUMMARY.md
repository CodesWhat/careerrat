---
phase: 10-local-packet-engine
plan: 02
subsystem: api
tags: [packet, local-api, bounded-ai, sqlite, jd-capture]

requires:
  - phase: 10-01
    provides: Wave 0 RED packet route and gate contracts
provides:
  - Local POST /api/packet/gate route
  - DB-first packet context builder and JD/body capture
  - Bounded-AI packet gate service with manual/review fallbacks
affects: [10-local-packet-engine, packet, apply-flow]

tech-stack:
  added: []
  patterns:
    - Thin route over core packet service
    - DB-first context via requireDb and assembleTrackerObject
    - Bounded AI schema validation with safe review envelopes

key-files:
  created:
    - src/core/packet/schemas/packet-schemas.mjs
    - src/core/packet/context.mjs
    - src/core/packet/gate.mjs
  modified:
    - tests/packet-generate-route.test.mjs
    - src/cli/packet-route.mjs

key-decisions:
  - "JD/body capture happens before any packet gate AI call and stamps artifacts.jd through the DB artifact verb."
  - "Missing JD/body, no AI route, and invalid AI output all return review/manual metadata instead of fabricated KEEP/CUT."
  - "POST /api/packet/gate is a local packet API and never falls back to /api/skill/run or evaluate-job."

patterns-established:
  - "Packet route POST handlers use readJsonBodyCapped and delegate business logic to src/core/packet/*."
  - "Packet services expose test injection for bounded AI while production uses native-preferred bounded AI."

requirements-completed: [PKT-01]

coverage:
  - id: D1
    description: "POST /api/packet/gate handles missing DB, malformed JSON, supplied JD capture, saved JD reuse, missing body review, and no-AI review locally."
    requirement: PKT-01
    verification:
      - kind: integration
        ref: "node --test --test-name-pattern 'packet/gate' tests/packet-generate-route.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Packet context capture persists full JD text under workspace/jobs and stamps artifacts.jd through the DB-owned artifact write path."
    requirement: PKT-01
    verification:
      - kind: integration
        ref: "tests/packet-generate-route.test.mjs#captures supplied JD body and stamps artifacts.jd before AI"
        status: pass
    human_judgment: false
  - id: D3
    description: "Bounded packet gate AI validates schema output and maps unavailable/invalid model states to manual review envelopes."
    requirement: PKT-01
    verification:
      - kind: unit
        ref: "node --test tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs"
        status: pass
    human_judgment: false

duration: 14min
completed: 2026-07-06
status: complete
---

# Phase 10 Plan 02: Local Packet Gate Summary

**Local packet gate API with DB-first JD capture and bounded-AI review envelopes**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-06T14:59:00Z
- **Completed:** 2026-07-06T15:13:14Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Added focused gate route contracts for supplied JD capture, saved JD reuse, missing-body review, and no-AI manual review.
- Implemented `capturePacketJobBody()`, `buildPacketContext()`, and `evaluatePacketGate()` as DB-first packet owners that do not read generated tracker exports.
- Mounted `POST /api/packet/gate` with capped JSON parsing, 409/400/local error mapping, and no default retained skill-runtime handoff.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED packet gate route contract** - `7199c1c` (test)
2. **Task 2: GREEN packet context, schemas, and gate service** - `a4a3072` (feat)
3. **Task 3: GREEN mount POST /api/packet/gate** - `fc92e80` (feat)

## Files Created/Modified

- `tests/packet-generate-route.test.mjs` - adds D-02/D-03 gate contracts.
- `src/core/packet/schemas/packet-schemas.mjs` - packet gate request and AI verdict schemas.
- `src/core/packet/context.mjs` - DB-first packet context assembly and JD artifact capture.
- `src/core/packet/gate.mjs` - local packet gate service and bounded-AI/manual envelope handling.
- `src/cli/packet-route.mjs` - mounts the local gate route.

## Decisions Made

- Used `appRegisterArtifact({ kind: "jd" })` as the DB-owned write path for JD capture, matching the existing artifact-stamping convention.
- Kept model output out of artifact writes; AI can only produce a validated gate verdict or a review envelope.
- Preserved test injection for `packetGateInvoke` so route tests can prove AI is skipped or called without requiring a real provider.

## Deviations from Plan

Task 2 and Task 3 were initially implemented together, then split into separate commits so the history matches the planned task boundaries.

**Total deviations:** 1 auto-fixed process issue.
**Impact on plan:** No scope change. The final commits are task-scoped.

## Issues Encountered

- The full `tests/packet-generate-route.test.mjs` file still has one expected RED failure for `POST /api/packet/generate`. That endpoint is owned by later Phase 10 plans; 10-02 verified the gate subset with `--test-name-pattern 'packet/gate'`.
- The main checkout was being moved by parallel Phase 11 work, so execution continued in the dedicated `$HOME/code/careerrat-phase10-exec` worktree pinned to the Phase 10 branch.

## User Setup Required

None - no external service configuration required.

## Verification

- `node --test --test-name-pattern 'packet/gate' tests/packet-generate-route.test.mjs` - passed, 6/6.
- `node --test tests/packet-route.test.mjs tests/evaluate-gate.test.mjs tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs` - passed, 70/70.
- `bash -lc 'node --test tests/packet-generate-route.test.mjs; test $? -ne 0'` - passed as a RED wrapper; only the future `/api/packet/generate` contract remains red.

## Self-Check: PASSED

- Created files exist and parse.
- Task commits found: `7199c1c`, `a4a3072`, `fc92e80`.
- Gate contracts pass without generated tracker input, and missing JD/no-AI paths do not fabricate KEEP/CUT.

## Next Phase Readiness

Plan 10-03 can build question capture and non-EEO answer drafting on the new packet schema/context module. Plan 10-04 still owns `POST /api/packet/generate` and should flip the remaining route contract green.

---
*Phase: 10-local-packet-engine*
*Completed: 2026-07-06*
