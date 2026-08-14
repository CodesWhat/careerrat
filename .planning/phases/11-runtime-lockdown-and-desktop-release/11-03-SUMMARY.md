---
phase: 11-runtime-lockdown-and-desktop-release
plan: "03"
subsystem: runtime-lockdown
tags: [sec-02, runtime-tools, skill-runtime, chat-runtime, tdd]

requires:
  - phase: 11-runtime-lockdown-and-desktop-release
    provides: [SEC-01 app-default runtime guard, SEC-02 app-safe one-shot runtime profiles]
provides:
  - Runtime config metadata for app-safe default tools and classified retained tool-heavy skills
  - Pre-stream validation for `toolProfile: "tool-heavy"` requests to `/api/skill/run`
  - Explicit chat runtime tool profile wiring for visible chat handoffs
affects: [runtime-routing, retained-skill-runtime, chat-runtime, desktop-release]

tech-stack:
  added: []
  patterns:
    - Route-level retained runtime classification
    - Pre-SSE request validation for broad tool profile selection
    - Explicit chat runtime tool profile import

key-files:
  created:
    - .planning/phases/11-runtime-lockdown-and-desktop-release/11-03-SUMMARY.md
  modified:
    - src/cli/skill-run-route.mjs
    - src/core/ai/chat-runtime.mjs
    - tests/skill-run-route.test.mjs
    - tests/chat-runtime.test.mjs

key-decisions:
  - "Runtime config exposes only non-secret app-safe tool profile metadata and the allowed tool-heavy skill names."
  - "Tool-heavy POST requests are rejected before SSE starts unless the requested skill is explicitly classified as a retained tool-heavy workflow."
  - "Chat runtime imports CHAT_RUNTIME_TOOLS directly from runtime-tools.mjs instead of deriving from the one-shot RUNTIME_TOOLS export."

patterns-established:
  - "Route-level toolProfile validation happens before runSkillStream() and before event-stream headers are written."
  - "Visible chat handoffs use the named chat runtime profile as their own boundary."

requirements-completed: [SEC-02]

coverage:
  - id: D1
    description: "GET /api/runtime/config exposes app-safe default tool metadata and classified retained tool-heavy skills without secret values."
    requirement: SEC-02
    verification:
      - kind: integration
        ref: "node --test tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST /api/skill/run rejects unclassified tool-heavy requests before SSE and passes validated toolProfile values for classified retained workflows."
    requirement: SEC-02
    verification:
      - kind: integration
        ref: "node --test tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "createChatRuntime().startSession() uses the explicit chat runtime profile for visible chat handoffs."
    requirement: SEC-02
    verification:
      - kind: unit
        ref: "tests/chat-runtime.test.mjs#query() gets CHAT_RUNTIME_TOOLS from the explicit chat profile"
        status: pass
    human_judgment: false

duration: 5 min
completed: 2026-07-06
status: complete
---

# Phase 11 Plan 03: Retained Runtime and Chat Tool Classification Summary

**Retained full-runtime calls now require explicit tool-heavy classification, while chat handoffs use their own named runtime profile.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-06T16:34:16Z
- **Completed:** 2026-07-06T16:38:56Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added runtime config coverage and implementation for non-secret app-safe tool metadata plus classified tool-heavy retained workflows.
- Added pre-SSE validation so unclassified `toolProfile: "tool-heavy"` POST requests fail as JSON before `runSkillStream()` starts.
- Changed chat runtime to use `CHAT_RUNTIME_TOOLS` directly, keeping visible chat handoffs separate from one-shot runtime defaults.

## Task Commits

Each task was committed atomically:

1. **Task 1: Pin route and chat profile behavior in tests** - `b5804d1` (test)
2. **Task 2: Implement explicit retained runtime classification** - `5e8d4be` (feat)

**Plan metadata:** committed after this SUMMARY is written.

## Files Created/Modified

- `src/cli/skill-run-route.mjs` - Adds runtime profile metadata, tool-heavy skill classification, pre-stream `toolProfile` validation, and profile pass-through.
- `src/core/ai/chat-runtime.mjs` - Imports and uses `CHAT_RUNTIME_TOOLS` directly for chat sessions.
- `tests/skill-run-route.test.mjs` - Covers runtime config metadata, secret non-disclosure, unclassified rejection, and classified profile pass-through.
- `tests/chat-runtime.test.mjs` - Covers explicit chat profile source wiring and SDK query tool selection.
- `.planning/phases/11-runtime-lockdown-and-desktop-release/11-03-SUMMARY.md` - Records plan completion evidence.

## Verification

- PASS: RED run failed before source changes with missing runtime metadata, missing tool-heavy pre-stream validation, missing profile pass-through, and chat source deriving from `RUNTIME_TOOLS`.
- PASS: `node --test tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs`
- PASS: Pre-commit structure guards and Biome checks on both task commits. Biome reported the existing `ANTHROPIC_API_KEY` integration-skip warning in `tests/chat-runtime.test.mjs`; it remained a warning and did not block.
- PASS: No tracked-file deletions in task commits `b5804d1` or `5e8d4be`.

## Decisions Made

- Tool-heavy runtime classification lives at the route boundary as a named retained-workflow allowlist; the route rejects broad profile selection before SSE headers can commit.
- Runtime config reports profile names/tool names/booleans only; it does not expose AI keys, Apple credentials, or credential paths.
- Chat remains a visible handoff surface and uses the named `chat` profile from `runtime-tools.mjs` instead of inheriting the one-shot default.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Narrowed chat source test to avoid self-matching the target symbol**
- **Found during:** Task 2 (Implement explicit retained runtime classification)
- **Issue:** The RED static assertion checked `/RUNTIME_TOOLS/`, which also matches the intended `CHAT_RUNTIME_TOOLS` symbol and would fail after the correct implementation.
- **Fix:** Narrowed the assertion to `/\bRUNTIME_TOOLS\b/`, preserving the check for the old bare one-shot export while allowing `CHAT_RUNTIME_TOOLS`.
- **Files modified:** `tests/chat-runtime.test.mjs`
- **Verification:** `node --test tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs`
- **Committed in:** `5e8d4be`

---

**Total deviations:** 1 auto-fixed (Rule 1).
**Impact on plan:** The fix corrected the RED guard without weakening the intended chat runtime boundary.

## Issues Encountered

- The first RED run was interrupted after a new negative route test left the current implementation's response open. The test stub was corrected before the RED commit so subsequent RED/GREEN runs complete deterministically.
- Biome continues to warn about a pre-existing integration-test `process.env.ANTHROPIC_API_KEY` skip in `tests/chat-runtime.test.mjs`; hooks and focused verification pass.

## Authentication Gates

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub-pattern matches were limited to normal helper initializers, nullable session state, and test fixture defaults; no UI-visible placeholder or unwired data source was introduced.

## Threat Flags

None. The changed route/session surfaces are the planned SEC-02 mitigations for T-11-06, T-11-07, and T-11-08.

## TDD Gate Compliance

- RED gate: `b5804d1` added failing route/chat profile tests. The focused suite failed before source changes for the intended missing metadata, validation, pass-through, and chat-profile wiring.
- GREEN gate: `5e8d4be` implemented route/session profile classification and the focused suite passed.
- Refactor gate was not needed.

## Next Phase Readiness

SEC-02 is now covered at both the core runtime-tool layer and the retained route/chat boundaries. Phase 11 can continue with desktop signing/notarization, release docs, and final rollup plans.

## Self-Check: PASSED

- Found `.planning/phases/11-runtime-lockdown-and-desktop-release/11-03-SUMMARY.md`.
- Found `src/cli/skill-run-route.mjs` and `src/core/ai/chat-runtime.mjs`.
- Found task commits `b5804d1` and `5e8d4be`.
- Re-ran the plan verification command successfully after both task commits.

---
*Phase: 11-runtime-lockdown-and-desktop-release*
*Completed: 2026-07-06*
