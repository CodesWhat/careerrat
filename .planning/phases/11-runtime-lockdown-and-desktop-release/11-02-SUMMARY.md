---
phase: 11-runtime-lockdown-and-desktop-release
plan: "02"
subsystem: ai-runtime
tags: [runtime-tools, agent-sdk, security, tdd]

requires:
  - phase: 11-runtime-lockdown-and-desktop-release
    provides: [SEC-01 app-default runtime guard from 11-01]
provides:
  - App-safe one-shot runtime tool profile
  - Explicit tool-heavy runtime tool profile
  - runSkillStream toolProfile support with copied explicit tool arrays
affects: [runtime-routing, chat-runtime, skill-run-route, desktop-release]

tech-stack:
  added: []
  patterns:
    - Named runtime tool profiles
    - App-safe default tool surface under bypassPermissions

key-files:
  created:
    - src/core/ai/runtime-tools.mjs
  modified:
    - src/core/ai/skill-runtime.mjs
    - tests/skill-runtime.test.mjs

key-decisions:
  - "The one-shot runtime's backward-compatible RUNTIME_TOOLS export now aliases the app-safe profile."
  - "Explicit tools arrays remain the narrowest authority and are copied before SDK use."
  - "Tool-heavy execution requires toolProfile: \"tool-heavy\" or an equivalent resolver call."

patterns-established:
  - "Runtime tool profiles live in src/core/ai/runtime-tools.mjs and resolve to copied arrays before SDK invocation."

requirements-completed: [SEC-02]

coverage:
  - id: D1
    description: "Default one-shot runtime tools exclude Write, Edit, and Bash while keeping Read, Glob, Grep, WebFetch, and Skill."
    requirement: SEC-02
    verification:
      - kind: unit
        ref: "node --test tests/skill-runtime.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Explicit caller tools and explicit tool-heavy profiles are resolved through public runtime profile helpers."
    requirement: SEC-02
    verification:
      - kind: unit
        ref: "node --test tests/skill-runtime.test.mjs"
        status: pass
    human_judgment: false

duration: 2 min
completed: 2026-07-06
status: complete
---

# Phase 11 Plan 02: App-Safe One-Shot Runtime Tool Profiles Summary

**One-shot Agent SDK runs now default to an app-safe tool profile, with explicit opt-in for Write/Edit/Bash.**

## Performance

- **Duration:** 2 min
- **Started:** 2026-07-06T15:19:20Z
- **Completed:** 2026-07-06T15:21:58Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added `src/core/ai/runtime-tools.mjs` with immutable app-safe, tool-heavy, and chat profile exports.
- Changed `runSkillStream()` so default SDK calls receive app-safe tools and `permissionMode: "bypassPermissions"` is bounded by that resolved list.
- Preserved explicit per-call `tools` overrides and added `toolProfile: "tool-heavy"` support for intentionally broad runtime lanes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Pin app-safe one-shot runtime behavior in tests** - `4112092` (test)
2. **Task 2: Implement app-safe runtime profiles** - `ef16e0f` (feat)

**Plan metadata:** committed after this SUMMARY is written.

## Files Created/Modified

- `src/core/ai/runtime-tools.mjs` - Defines app-safe, tool-heavy, and chat runtime tool profiles plus resolver helpers.
- `src/core/ai/skill-runtime.mjs` - Imports the resolver, exposes app-safe `RUNTIME_TOOLS`, and resolves SDK `options.tools` from explicit tools or `toolProfile`.
- `tests/skill-runtime.test.mjs` - Covers RED/GREEN behavior for app-safe defaults, copied explicit tools, invalid profiles, and tool-heavy opt-in.

## Verification

- PASS: `node --test tests/skill-runtime.test.mjs`
- PASS: `node --test tests/chat-runtime.test.mjs`

## Decisions Made

- `RUNTIME_TOOLS` remains exported for backward compatibility, but now represents the app-safe profile.
- `resolveRuntimeTools()` copies all returned arrays so callers cannot mutate shared profile constants or leak a mutable override into SDK options.
- The profile resolver rejects unclassified profile names before SDK invocation with `RUNTIME_TOOL_PROFILE_INVALID`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Authentication Gates

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None.

## TDD Gate Compliance

- RED gate: `4112092` added failing runtime profile tests. The focused suite failed against broad `RUNTIME_TOOLS` and the missing profile module.
- GREEN gate: `ef16e0f` implemented the profile helper and runtime integration. The focused suite passed.

## Next Phase Readiness

SEC-02 is complete for the one-shot runtime. Plan 11-03 can build on `runtime-tools.mjs` to make retained runtime and chat tool-heavy execution explicit.

## Self-Check: PASSED

- FOUND: `.planning/phases/11-runtime-lockdown-and-desktop-release/11-02-SUMMARY.md`
- FOUND: `src/core/ai/runtime-tools.mjs`
- FOUND commits: `4112092`, `ef16e0f`
- Coverage metadata classified successfully with `all_auto_covered: true`.

---
*Phase: 11-runtime-lockdown-and-desktop-release*
*Completed: 2026-07-06*
