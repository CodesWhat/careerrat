---
phase: 05-verification-and-docs
plan: "04"
subsystem: documentation
tags: [runtime-routing, docs, company-discovery, drift-guard, tdd]

requires:
  - phase: 04-runtime-routing
    provides: local company proposal routes, explicit chat handoffs, retained full skill runtime, and runtime routing docs
  - phase: 05-verification-and-docs
    provides: VER-01 through VER-04 regression locks for cost, no-AI, structured-output, and confirm-first write boundaries
provides:
  - VER-05 aligned agent, public architecture, and routing-policy documentation
  - Static drift guard tying docs to app local proposal route wrappers and explicit runtime handoffs
  - No-hidden-fallback assertions for local proposal failures
affects: [runtime-routing, company-discovery-api, verification-and-docs, architecture-docs]

tech-stack:
  added: []
  patterns:
    - Section and phrase-based docs drift assertions instead of line-number or whole-file snapshots
    - App route-wrapper checks that separate local proposal APIs from explicit chat/full-runtime surfaces

key-files:
  created:
    - .planning/phases/05-verification-and-docs/05-04-SUMMARY.md
  modified:
    - AGENTS.md
    - docs/ARCHITECTURE.md
    - .planning/architecture/runtime-routing-policy.md
    - tests/decomposition-map.test.mjs

key-decisions:
  - "App company discovery docs name local proposal create/read/decision APIs as the default path; chat and full skill runtime remain explicit user-selected paths."
  - "Bounded AI is documented as advisory company seed judgment only, with deterministic validation and confirm-first source-config/DB owners controlling writes."
  - "The VER-05 drift guard checks route-class phrases and app wrapper slices rather than brittle snapshots."

patterns-established:
  - "Docs for runtime routing should update AGENTS.md, docs/ARCHITECTURE.md, and runtime-routing-policy.md together."
  - "Tests should guard both documentation language and app route wrappers when a docs truth depends on route behavior."

requirements-completed: [VER-05]

coverage:
  - id: D1
    description: "AGENTS.md, docs/ARCHITECTURE.md, and runtime-routing-policy.md describe the same local/default, bounded-AI, explicit-chat, and retained-runtime split."
    requirement: VER-05
    verification:
      - kind: other
        ref: 'rg -n "company-proposals|company-proposal-decisions|/api/discovery/quick-start|/api/discovery/next|/api/chat|/api/skill/run" AGENTS.md docs/ARCHITECTURE.md .planning/architecture/runtime-routing-policy.md'
        status: pass
      - kind: unit
        ref: "tests/decomposition-map.test.mjs#VER-05 docs and app wrappers keep discovery routing split aligned"
        status: pass
    human_judgment: false
  - id: D2
    description: "Static guard fails when required route-class language or app local proposal route names disappear, while allowing retained runtime documentation."
    requirement: VER-05
    verification:
      - kind: unit
        ref: "node --test tests/decomposition-map.test.mjs"
        status: pass
      - kind: other
        ref: "npx biome check tests/decomposition-map.test.mjs"
        status: pass
    human_judgment: false

duration: 4 min
completed: 2026-07-05
status: complete
---

# Phase 05 Plan 04: Docs Alignment and Docs Drift Guard Summary

**VER-05 now locks company discovery routing docs and app wrapper names to the same local-default, bounded-AI, explicit-chat, and retained-runtime contract.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-05T13:02:02Z
- **Completed:** 2026-07-05T13:06:18Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added agent-facing company discovery runtime-routing language to `AGENTS.md`, including the default local proposal APIs, seed-only bounded AI, explicit chat handoffs, retained allowlisted full runtime, and no hidden fallback from local errors.
- Tightened `docs/ARCHITECTURE.md` and `.planning/architecture/runtime-routing-policy.md` so public and detailed docs both name advisory seed judgment, deterministic validation, confirm-first source-config/DB writes, and retained explicit runtime paths.
- Extended `tests/decomposition-map.test.mjs` with a focused VER-05 guard that checks all three docs plus `apps/web/src/lib/api.js` and `CompaniesStep.jsx` local proposal helper slices.

## Task Commits

1. **Task 2 RED: failing VER-05 docs drift guard** - `61653fc` (test)
2. **Task 1 + Task 2 GREEN: aligned routing docs and passing guard** - `214a65c` (docs)
3. **Task 2 REFACTOR: lint-clean assertion cleanup** - `8eb0477` (refactor)

_Note: The failing guard was committed before the docs update so the docs alignment could satisfy the TDD RED/GREEN path._

## Files Created/Modified

- `AGENTS.md` - Adds the app company discovery runtime routing contract while preserving the skill-led discovery order and confirm-first writes.
- `docs/ARCHITECTURE.md` - Clarifies local proposal APIs, source-config/DB write ownership, seed-only bounded AI, and deterministic validation.
- `.planning/architecture/runtime-routing-policy.md` - Adds detailed policy language for advisory company seed judgment before deterministic validation and confirm-first writes.
- `tests/decomposition-map.test.mjs` - Adds the VER-05 docs and app-wrapper drift guard.
- `.planning/phases/05-verification-and-docs/05-04-SUMMARY.md` - Records plan outcome and verification evidence.

## Decisions Made

- Kept the drift guard in `tests/decomposition-map.test.mjs` because the existing file already owns architecture-policy static checks.
- Used phrase and route-wrapper assertions rather than whole-file snapshots or line-number checks.
- Left `STATE.md`, `ROADMAP.md`, and `REQUIREMENTS.md` untouched because this execution is part of an orchestrated wave and the prompt assigned wave progress to the orchestrator.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope changes.

## Issues Encountered

- The RED command failed as expected because `AGENTS.md` did not yet name `/api/discovery/company-proposals`.
- The first GREEN run exposed a whitespace-sensitive regex in the new drift helper; normalizing whitespace fixed the guard without weakening the assertion.
- Pre-commit Biome reported a non-failing warning for a literal `${query}` substring in the route assertion. A refactor commit replaced it with a route-prefix check and `npx biome check tests/decomposition-map.test.mjs` passed.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Stub-pattern scanning found only existing AGENTS.md policy text about placeholder linting and benign form placeholders; no UI-rendered stub, mock-only data path, or placeholder implementation was introduced.

## Threat Flags

None. This plan changed docs and static tests only; it introduced no new endpoint, auth path, file-access boundary, schema, or runtime write surface.

## TDD Gate Compliance

- **RED:** `61653fc test(05-04): add failing VER-05 docs drift guard` - `node --test tests/decomposition-map.test.mjs` failed only on the new VER-05 assertion for missing AGENTS route language.
- **GREEN:** `214a65c docs(05-04): align discovery routing docs and guard drift` - `node --test tests/decomposition-map.test.mjs` passed after docs alignment and whitespace normalization.
- **REFACTOR:** `8eb0477 refactor(05-04): clean up docs drift guard assertion` - Node test and Biome check both passed.

## Verification

- RED command: `node --test tests/decomposition-map.test.mjs` - FAIL as expected on `AGENTS.md should contain /api/discovery/company-proposals`.
- Required static scan: `rg -n "company-proposals|company-proposal-decisions|/api/discovery/quick-start|/api/discovery/next|/api/chat|/api/skill/run" AGENTS.md docs/ARCHITECTURE.md .planning/architecture/runtime-routing-policy.md` - PASS; all three docs contain the required route classes.
- Required test command: `node --test tests/decomposition-map.test.mjs` - PASS (7 tests).
- Lint sanity check: `npx biome check tests/decomposition-map.test.mjs` - PASS.

## Acceptance Criteria

- The three docs describe the same local/default, bounded-AI, explicit-chat, and retained-runtime split without implying hidden fallback from local proposal errors to chat or full skill runtime - PASS.
- The docs drift guard fails if required route-class language or app route names disappear while still allowing legitimate retained runtime documentation - PASS.
- No source schema files, package dependencies, production tracker/candidate data, or unrelated release-safety tests were touched - PASS.

## Next Phase Readiness

Plan 05-04 is complete. Plan 05-05 can use the VER-05 docs and drift guard as part of the final focused verification rollup.

## Self-Check: PASSED

- Verified `.planning/phases/05-verification-and-docs/05-04-SUMMARY.md` exists.
- Verified commits `61653fc`, `214a65c`, and `8eb0477` exist in git history.
- Verified final required commands exit 0.
- Verified summary frontmatter parses as YAML.
- Verified pre-existing dirty paths `tests/release-safety.test.mjs`, `.planning/research/`, and `tmp-skill-conversion/` remain unstaged and outside this plan.

---
*Phase: 05-verification-and-docs*
*Completed: 2026-07-05*
