---
phase: 10-local-packet-engine
plan: 03
subsystem: api
tags: [packet, questions, answers, bounded-ai, sqlite]

requires:
  - phase: 10-02
    provides: Local packet gate API, packet context, JD capture, and shared packet schemas
provides:
  - Local POST /api/packet/questions route
  - Local POST /api/packet/answers route
  - Packet question capture, EEO exclusion, and durable question metadata
  - Bounded-AI answer drafting with grounded answers or NEEDS YOU gaps
affects: [10-local-packet-engine, packet, apply-flow]

tech-stack:
  added: []
  patterns:
    - DB verb owns packet question artifact registration
    - Packet answer drafting validates bounded AI output through document helpers
    - EEO and self-identification prompts are filtered before any answer-generation call

key-files:
  created:
    - src/core/packet/questions.mjs
    - src/core/packet/answers.mjs
  modified:
    - tests/packet-answers.test.mjs
    - src/core/packet/schemas/packet-schemas.mjs
    - src/core/db/verbs/app.mjs
    - src/core/db/verbs/index.mjs
    - src/cli/packet-route.mjs

key-decisions:
  - "Question capture writes artifacts.packetQuestionsSource plus packetManifest.questions before answer drafting or generation can consume the questions."
  - "Manual-paste self-identification prompts are conservatively excluded and returned as metadata, not sent to bounded AI."
  - "Packet answers use the local bounded-AI helper with packet-engine labels and never invoke the answer-question skill runtime by default."

patterns-established:
  - "Packet routes remain thin adapters over src/core/packet services with capped JSON parsing."
  - "Answer proposals must either carry evidence-backed text that passes buildShortAnswer() or an explicit NEEDS YOU gap."

requirements-completed: [PKT-02, PKT-03]

coverage:
  - id: D1
    description: "Provider and manual packet question capture filters self-identification prompts before answer drafting."
    requirement: PKT-03
    verification:
      - kind: unit
        ref: "tests/packet-answers.test.mjs#filterAnswerableQuestions excludes provider demographic metadata and manual self-ID prompts"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST /api/packet/questions persists normalized question capture and manifest metadata through the DB artifact path."
    requirement: PKT-03
    verification:
      - kind: integration
        ref: "tests/packet-answers.test.mjs#POST /api/packet/questions persists capture before local answer drafting"
        status: pass
    human_judgment: false
  - id: D3
    description: "POST /api/packet/answers drafts only persisted non-EEO questions through local bounded AI and preserves NEEDS YOU gaps."
    requirement: PKT-02
    verification:
      - kind: integration
        ref: "tests/packet-answers.test.mjs#POST /api/packet/answers drafts only persisted non-EEO questions through local bounded AI"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-06
status: complete
---

# Phase 10 Plan 03: Question Capture and Answer Drafting Summary

**Local packet question capture and bounded answer drafting with EEO exclusion**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-06T14:59:00Z
- **Completed:** 2026-07-06T15:19:45Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- Added route-level RED contracts for durable packet question capture and answer drafting from persisted non-EEO questions.
- Implemented `capturePacketQuestions()`, `filterAnswerableQuestions()`, capture schemas, and `appRegisterPacketQuestionCapture()`.
- Added `draftPacketAnswers()` and mounted local `POST /api/packet/questions` and `POST /api/packet/answers` without default retained skill-runtime escalation.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED question and answer contracts** - `1914d9b` (test)
2. **Task 2: GREEN packet question capture and exclusion** - `dbdd744` (feat)
3. **Task 3: GREEN answer drafting service and routes** - `8a04588` (feat)

## Files Created/Modified

- `tests/packet-answers.test.mjs` - adds packet question and answer route contracts.
- `src/core/packet/schemas/packet-schemas.mjs` - adds question capture and answer proposal schemas.
- `src/core/packet/questions.mjs` - captures provider/manual questions and excludes self-identification prompts.
- `src/core/packet/answers.mjs` - drafts grounded answers or explicit gaps through bounded AI.
- `src/core/db/verbs/app.mjs` - registers durable packet question artifacts and manifest metadata.
- `src/core/db/verbs/index.mjs` - exports the packet question capture DB verb.
- `src/cli/packet-route.mjs` - mounts local question and answer packet routes.

## Decisions Made

- Persisted question capture before answer drafting so later packet generation can consume `artifacts.packetQuestionsSource` and `packetManifest.questions`.
- Kept excluded EEO/self-identification prompts visible as metadata with reason codes instead of silently dropping them.
- Routed answer drafting through `runBoundedAI()` with `skill:"packet-engine"`, `action:"draft-answers"`, and `operation:"packet:answers"` labels.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope change.

## Issues Encountered

- The full `tests/packet-generate-route.test.mjs` file still has one expected RED failure for `POST /api/packet/generate`. That endpoint is owned by Plan 10-04.

## User Setup Required

None - no external service configuration required.

## Verification

- `node --test tests/packet-answers.test.mjs tests/form-questions.test.mjs tests/documents-tailor.test.mjs tests/bounded-ai.test.mjs` - passed, 100/100.
- `node --check src/core/packet/answers.mjs && node --check src/cli/packet-route.mjs` - passed.
- `bash -lc 'node --test tests/packet-generate-route.test.mjs; test $? -ne 0'` - passed as a RED wrapper; only the future `/api/packet/generate` contract remains red.

## Self-Check: PASSED

- Created files exist and parse.
- Task commits found: `1914d9b`, `dbdd744`, `8a04588`.
- Question capture survives route boundaries through packet artifacts, and answer drafting consumes only non-EEO questions.

## Next Phase Readiness

Plan 10-04 can build `generatePacket()` on the persisted question capture and answer proposal sources, then flip the remaining `/api/packet/generate` route contract green.

---
*Phase: 10-local-packet-engine*
*Completed: 2026-07-06*
