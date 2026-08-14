---
phase: 10-local-packet-engine
plan: 06
subsystem: ui
tags: [packet, static-ui, runtime-boundary, answers, questions]

requires:
  - phase: 10-05
    provides: Local packet gate, question, answer, generation, and export APIs
provides:
  - Packet page default generation through POST /api/packet/generate
  - Packet page question capture through POST /api/packet/questions before generation
  - Answer page default drafting through POST /api/packet/answers
  - Source-slice runtime-boundary guard for ordinary packet and answer UI actions
affects: [10-local-packet-engine, packet-ui, answer-ui, runtime-routing]

tech-stack:
  added: []
  patterns:
    - Byte-static pages call local packet JSON APIs for ordinary packet work
    - Retained POST /api/skill/run remains mounted but is excluded from default packet/answer UI scripts
    - Excluded self-identification questions render as skipped metadata, not drafted answer text

key-files:
  created: []
  modified:
    - tests/packet-page.test.mjs
    - tests/answer-page.test.mjs
    - src/core/onboarding/packet-page.mjs
    - src/core/ai/answer-page.mjs

key-decisions:
  - "Packet page generation sends freshly captured questionCapture state when present and otherwise relies on application-id persisted capture fallback in the local service."
  - "The answer page uses the packet question capture route to filter pasted questions before drafting answerable prompts through the local answers route."
  - "The default packet and answer page scripts contain no retained skill-runtime calls or skill names; runtime config remains tested separately as retained capability."

patterns-established:
  - "Static page tests assert literal local API fetches plus absence of /api/skill/run in ordinary packet/answer scripts."
  - "One-off answer drafting maps local packet answer metadata into the existing answer/source/durable/persisted hooks."
  - "Question capture UI displays answerable/skipped counts and excluded question ids without rendering excluded answers."

requirements-completed: [PKT-01, PKT-03, PKT-04]

coverage:
  - id: D1
    description: "Packet page defaults to local packet question capture and generation without launching retained skill runtime."
    requirement: PKT-01
    verification:
      - kind: automated_ui
        ref: "tests/packet-page.test.mjs#the Generate packet run POSTs the local packet generate API by default"
        status: pass
      - kind: integration
        ref: "tests/packet-runtime-boundary.test.mjs#ordinary packet page generation calls the local packet API, not the retained skill runtime"
        status: pass
    human_judgment: false
  - id: D2
    description: "Packet page captures application questions, stores page-state capture metadata, and exposes skipped self-identification counts."
    requirement: PKT-03
    verification:
      - kind: automated_ui
        ref: "tests/packet-page.test.mjs#packet page captures application questions before local generation"
        status: pass
    human_judgment: false
  - id: D3
    description: "Answer page drafts through local packet answers and displays excluded question metadata."
    requirement: PKT-03
    verification:
      - kind: automated_ui
        ref: "tests/answer-page.test.mjs#answer page drafts through the local packet answers API by default"
        status: pass
      - kind: integration
        ref: "tests/packet-runtime-boundary.test.mjs#ordinary answer page drafting calls the local answers API, not answer-question through runtime"
        status: pass
    human_judgment: false
  - id: D4
    description: "Retained POST /api/skill/run remains mounted outside ordinary packet and answer default actions."
    requirement: PKT-01
    verification:
      - kind: integration
        ref: "tests/packet-runtime-boundary.test.mjs#retained POST /api/skill/run remains mounted outside the ordinary packet path"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-07-06
status: complete
---

# Phase 10 Plan 06: Packet UI Runtime Boundary Summary

**Packet and answer pages now use local packet APIs by default while retained skill runtime stays explicit**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-06T15:31:00Z
- **Completed:** 2026-07-06T15:38:17Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Added RED static/page contracts requiring local packet API calls, persisted question capture state, excluded metadata, and no ordinary retained-runtime launch.
- Updated `/packet` to capture application questions through `/api/packet/questions`, show answerable/skipped metadata, and generate through `/api/packet/generate`.
- Updated `/answer` to filter pasted questions through local question capture and draft only answerable prompts through `/api/packet/answers`.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED page and runtime-boundary contracts** - `75847e0` (test)
2. **Task 2: GREEN packet page local generate flow** - `8d735c2` (feat)
3. **Task 3: GREEN answer page local draft flow** - `a9d9f04` (feat)

## Files Created/Modified

- `tests/packet-page.test.mjs` - adds local packet route, question capture, and excluded metadata assertions.
- `tests/answer-page.test.mjs` - adds local answers route and excluded metadata assertions.
- `src/core/onboarding/packet-page.mjs` - replaces runtime generation with local question capture and packet generation calls.
- `src/core/ai/answer-page.mjs` - replaces streamed skill-runtime answer drafting with local packet question/answer calls.

## Decisions Made

- Kept the existing byte-static page architecture and hook names, adding only the controls needed for local packet capture.
- Reused the local question capture route on the answer page so EEO/self-ID filtering stays server-owned instead of duplicating classifier logic in browser JavaScript.
- Preserved `/api/runtime/config` tests for retained capability while excluding runtime config from ordinary packet/answer scripts.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope change.

## Issues Encountered

- The isolated execution worktree did not have `node_modules`; tests were run with a temporary symlink to the repo's existing install, and that symlink was not committed.
- A packet runtime-boundary guard caught a leftover skill name in an empty-state string. The copy now avoids retained-runtime references in the ordinary packet script.

## User Setup Required

None - no external service configuration required.

## Verification

- `node --test tests/packet-page.test.mjs tests/answer-page.test.mjs tests/packet-runtime-boundary.test.mjs tests/packet-answers.test.mjs` - passed, 27/27.

## Self-Check: PASSED

- Task commits found: `75847e0`, `8d735c2`, `a9d9f04`.
- Packet page, answer page, runtime-boundary, and packet answer tests all pass.
- Ordinary UI scripts no longer contain `/api/skill/run`, `tailor-application`, or `answer-question`.

## Next Phase Readiness

Plan 10-07 can run final integration/regression coverage across the packet pipeline and retained runtime boundary now that the app-default pages use local packet APIs.

---
*Phase: 10-local-packet-engine*
*Completed: 2026-07-06*
