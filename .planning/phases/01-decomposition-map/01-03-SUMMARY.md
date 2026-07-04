---
phase: 01-decomposition-map
plan: "03"
subsystem: architecture
tags:
  - runtime-routing
  - local-api
  - db-verbs
  - bounded-ai
  - skill-runtime
dependency_graph:
  requires:
    - .planning/PROJECT.md
    - .planning/REQUIREMENTS.md
    - .planning/ROADMAP.md
    - .planning/phases/01-decomposition-map/01-CONTEXT.md
    - .planning/phases/01-decomposition-map/01-RESEARCH.md
    - .planning/architecture/skill-decomposition.yml
    - .planning/architecture/discover-companies-target-contract.md
  provides:
    - .planning/architecture/runtime-routing-policy.md
    - ARCH-03 runtime routing policy
    - UI, CLI, and agent caller route-selection rules
  affects:
    - .planning/phases/01-decomposition-map/01-04-PLAN.md
    - future bounded-ai-foundation phase
    - future company-discovery-api phase
    - future runtime-routing phase
tech_stack:
  added: []
  patterns:
    - cheapest-correct route policy
    - local API and DB verb first routing
    - bounded structured AI as schema-validated assist path
    - retained chat and full skill runtime fallback policy
key_files:
  created:
    - .planning/architecture/runtime-routing-policy.md
  modified:
    - .planning/phases/01-decomposition-map/01-03-SUMMARY.md
key_decisions:
  - Phase 1 remains planning-only; runtime source under src/ was not modified.
  - UI, CLI, and agents must choose local deterministic or DB-owned routes before retained skill runtime.
  - Bounded AI uses callAI() and runStructuredOneshot(); model output remains untrusted until schema and deterministic validation pass.
  - POST /api/skill/run is retained for allowlisted tool-heavy, long-running, or human-watched workflows only.
requirements-completed:
  - ARCH-03
requirements_completed:
  - ARCH-03
coverage:
  - id: D1
    description: Runtime routing policy covering local API, DB verb/CLI helper, bounded structured AI, conversational skill handoff, and full skill runtime route classes.
    requirement: ARCH-03
    verification:
      - kind: other
        ref: node --input-type=module -e "<plan automated routing policy check>"
        status: pass
      - kind: other
        ref: node --input-type=module -e "<acceptance criteria routing policy check>"
        status: pass
    human_judgment: false
  - id: D2
    description: Caller-specific UI, CLI, and agent rules that preserve local-first routing and reserve POST /api/skill/run for retained full skill workflows.
    requirement: ARCH-03
    verification:
      - kind: other
        ref: node --input-type=module -e "<acceptance criteria routing policy check>"
        status: pass
    human_judgment: false
metrics:
  duration: 2min
  completed: 2026-07-04
  tasks_completed: 1
  files_created: 1
  files_modified: 1
status: complete
---

# Phase 01 Plan 03: Runtime Routing Policy Summary

Planning-only runtime routing policy for UI, CLI, and agents that prefers local APIs, DB verbs, and bounded structured AI before retained chat or full skill runtime.

## Performance

- **Duration:** 2min
- **Started:** 2026-07-04T18:10:07Z
- **Completed:** 2026-07-04T18:12:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Created `.planning/architecture/runtime-routing-policy.md`.
- Defined the five route classes required by ARCH-03: deterministic local code, DB verb or CLI helper, bounded structured AI, conversational skill handoff, and full skill runtime.
- Added caller-specific rules for UI, CLI, and agents.
- Referenced the current route/runtime owners for `/api/search/scan`, `/api/discovery/quick-start`, `/api/discovery/next`, `/api/chat/*`, and `POST /api/skill/run`.
- Preserved the D-02 cheapest-correct-route order, D-03 bounded-AI posture, and D-12 skill-files-as-contracts boundary.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define runtime route selection policy** - `4af4848` (docs)

## Requirements Completed

| Requirement | Evidence |
| --- | --- |
| ARCH-03 | `.planning/architecture/runtime-routing-policy.md` defines when UI, CLI, and agents should use local APIs, DB verbs/CLI helpers, bounded structured AI, `/api/chat/*`, or `POST /api/skill/run`. |

## Coverage

| Area | Status | Evidence |
| --- | --- | --- |
| Required headings | Complete | Policy includes Phase Boundary, Principles, Decision Matrix, Caller Rules, Existing Route Owners, No-AI Degradation, Examples, and Drift Checks. |
| Route classes | Complete | Decision Matrix contains deterministic local code, DB verb or CLI helper, bounded structured AI, conversational skill handoff, and full skill runtime rows. |
| Caller rules | Complete | UI, CLI, and Agents each have dedicated subsections. |
| Route owner references | Complete | Policy references `/api/search/scan`, `/api/discovery/quick-start`, `/api/discovery/next`, `/api/chat/*`, `POST /api/skill/run`, `callAI()`, `runStructuredOneshot()`, `runSkillStream`, and `src/cli/skill-run-route.mjs`. |
| Local-first guard | Complete | Policy states deterministic scans, DB writes, validation, dedupe, and confirmed source writes must not start full skill runtime when local owners exist. |

## Verification Results

| Command | Result |
| --- | --- |
| Plan automated `node --input-type=module -e ...` routing policy check | PASS |
| Additional acceptance criteria `node --input-type=module -e ...` check for headings, rows, routes, AI owners, and local-first guard | PASS |
| `git diff --check -- .planning/architecture/runtime-routing-policy.md` | PASS |
| `test -f tests/decomposition-map.test.mjs && node --test tests/decomposition-map.test.mjs || printf ...` | SKIP: `tests/decomposition-map.test.mjs` is created by Plan 01-04, so this later-phase verification is not available yet. |
| Stub scan for TODO/FIXME/placeholder/empty UI-flow values | PASS: no matches in the created artifact. |
| Commit hook structure guards | PASS |

## Files Created/Modified

- `.planning/architecture/runtime-routing-policy.md` - ARCH-03 route selection policy for UI, CLI, and agents.
- `.planning/phases/01-decomposition-map/01-03-SUMMARY.md` - Execution summary and verification evidence for this plan.

## Decisions Made

- Kept this plan inside `.planning/` only; no runtime files under `src/` were changed.
- Documented `/api/search/scan` and `/api/data/*` as local API/DB-owned paths for deterministic and mutation work.
- Documented `callAI()` and `runStructuredOneshot()` as bounded AI owners for schema-validated finite assists.
- Documented `/api/chat/*` as the conversational user-led handoff path and `POST /api/skill/run` as the retained full skill runtime path.

## Deviations from Plan

None - plan executed exactly as written.

## Auth Gates

None.

## Known Stubs

None. Stub scan found no TODO, FIXME, placeholder, coming soon, not available, or hardcoded empty UI-flow values in the created artifact.

## Threat Flags

None. This plan added a planning Markdown policy only and introduced no runtime network endpoint, auth path, file-access trust boundary, package install, or schema mutation.

## Issues Encountered

- An extra acceptance-proof command initially expected the local-first guard as one contiguous sentence. I adjusted the uncommitted policy wording before the task commit and reran all acceptance checks successfully.
- GSD metadata handlers had the same project-template mismatch seen in Plan 01-02: `state.advance-plan` could not parse a Current Plan field, `roadmap.update-plan-progress` briefly rewrote the Phase Overview row shape, and `state.update-progress` set the frontmatter percent to `0`. I kept the valid SDK updates and manually repaired only the STATE percent and ROADMAP Phase 1 row before the metadata commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 01-04 to create the decomposition-map validation test. The policy gives that test concrete route classes and owner paths to assert for ARCH-03.

## Self-Check: PASSED

- Found `.planning/architecture/runtime-routing-policy.md`.
- Found `.planning/phases/01-decomposition-map/01-03-SUMMARY.md`.
- Found task commit `4af4848`.
- Re-ran the plan automated verification command successfully.
- Confirmed no runtime files under `src/` were modified by this plan.
- Unrelated pre-existing dirty paths were not edited, staged, or committed: `tests/release-safety.test.mjs` and `tmp-skill-conversion/`.

---
*Phase: 01-decomposition-map*
*Completed: 2026-07-04*
