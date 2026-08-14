---
phase: 01-decomposition-map
plan: "01"
subsystem: architecture
tags:
  - skill-decomposition
  - architecture
  - planning
  - bounded-ai
  - deterministic-runtime
dependency_graph:
  requires:
    - .planning/PROJECT.md
    - .planning/phases/01-decomposition-map/01-CONTEXT.md
    - .planning/phases/01-decomposition-map/01-RESEARCH.md
    - .planning/phases/01-decomposition-map/01-01-PLAN.md
  provides:
    - .planning/architecture/skill-decomposition.yml
    - ARCH-01 skill decomposition inventory
    - ARCH-02 runtime owner map
  affects:
    - .planning/phases/01-decomposition-map/01-02-PLAN.md
    - .planning/phases/01-decomposition-map/01-03-PLAN.md
    - .planning/phases/01-decomposition-map/01-04-PLAN.md
    - future bounded-ai-foundation phase
    - future company-discovery-api phase
tech_stack:
  added: []
  patterns:
    - machine-readable YAML planning inventory
    - deterministic, bounded-AI, full-skill-runtime, prompt-spec, and deferred decomposition buckets
    - planned owner references for runtime modules created by later phases
key_files:
  created:
    - .planning/architecture/skill-decomposition.yml
  modified:
    - .planning/phases/01-decomposition-map/01-01-SUMMARY.md
decisions:
  - Phase 1 remains planning-only; runtime source under src/ was not modified.
  - AI outputs are classified as advisory or seed material unless deterministic verification owns final persistence.
  - Supported ATS promotion and unsupported/discovery cache remain separate runtime surfaces.
requirements_completed:
  - ARCH-01
  - ARCH-02
coverage:
  - deliverable: High-priority skill decomposition inventory
    requirement: ARCH-01
    evidence: .planning/architecture/skill-decomposition.yml maps setup-searches, research-boards, discover-companies, search-jobs, evaluate-job, apply-job, email-comms, interview-prep, and track-outcomes.
    verification: Plan YAML parse and required-skill bucket check passed.
    status: complete
    human_judgment: false
  - deliverable: Runtime owner classification map
    requirement: ARCH-02
    evidence: Each skill bucket contains source, owner_type, owner_refs, target_owner, and action fields where work is assigned.
    verification: Acceptance check confirmed exact bucket keys, owner keys, discover-companies owners, and search-jobs deterministic owners.
    status: complete
    human_judgment: false
  - deliverable: Decision traceability from D-01 through D-14
    requirement: ARCH-01
    evidence: source_decisions includes every decision ID from D-01 through D-14.
    verification: Plan automated command checked all D-01 through D-14 keys.
    status: complete
    human_judgment: false
metrics:
  duration: 40min
  completed: 2026-07-04
  tasks_completed: 1
  files_created: 1
  files_modified: 1
status: complete
---

# Phase 01 Plan 01: Skill Decomposition Inventory Summary

Machine-readable skill-to-runtime decomposition inventory covering high-priority skills, D-01 through D-14, and ARCH-01/ARCH-02 owner mappings.

## Overview

Created `.planning/architecture/skill-decomposition.yml` as the planning artifact for future runtime extraction. The map classifies each high-priority skill into deterministic code, bounded AI, retained skill runtime, prompt-spec, and deferred buckets, then links each bucket to an existing or planned owner.

No runtime files under `src/` were changed.

## Tasks Completed

| Task | Name | Commit | Status |
| --- | --- | --- | --- |
| 1 | Create skill decomposition inventory | `b418429` | Complete |

## Requirements Completed

| Requirement | Evidence |
| --- | --- |
| ARCH-01 | `.planning/architecture/skill-decomposition.yml` includes all required skills and D-01 through D-14 source decisions. |
| ARCH-02 | The same YAML defines the exact owner taxonomy and maps future runtime work to existing or planned owners. |

## Coverage

| Area | Status | Evidence |
| --- | --- | --- |
| Required skills | Complete | setup-searches, research-boards, discover-companies, search-jobs, evaluate-job, apply-job, email-comms, interview-prep, and track-outcomes are present. |
| Classification buckets | Complete | Every skill has deterministic, bounded_ai, full_skill_runtime, prompt_spec, and deferred arrays. |
| Owner taxonomy | Complete | `owner_types` contains existing_ts_module, planned_ts_module, api_route, db_verb, cli_command, and retained_skill_runtime. |
| Discover-companies ownership | Complete | Required refs include the skill doc, structured-oneshot AI wrapper, scoring persistence, source-config DB verb, and companies CLI. |
| Search-jobs ownership | Complete | Deterministic refs include `scripts/scan-sourced.mjs`, `src/core/scoring/sourced-scanner.mjs`, and `src/core/scoring/sourced-persistence.mjs`. |

## Verification Results

| Command | Result |
| --- | --- |
| Plan automated YAML parse and required key check | PASS |
| Additional bucket/owner acceptance check | PASS |
| `rg` acceptance check for non-runtime boundary and required owner refs | PASS |
| `git diff --check -- .planning/architecture/skill-decomposition.yml` | PASS |
| Commit hook structure guards | PASS |
| `node --test tests/decomposition-map.test.mjs` | Deferred by phase order: Plan 01-04 creates this test. Current output was `Could not find 'tests/decomposition-map.test.mjs'`. |

## Deviations from Plan

None - plan executed exactly as written.

The `tests/decomposition-map.test.mjs` command is documented as a later verification step in the plan itself, to be run after Plan 01-04 creates the validation test.

## Auth Gates

None.

## Known Stubs

None. Stub scan found no TODO, FIXME, placeholder, coming soon, not available, or hardcoded empty UI-flow values in the created artifact.

## Threat Flags

None. This plan added a planning YAML file only and introduced no runtime network endpoint, authentication path, file-access trust boundary, or schema mutation.

## Self-Check: PASSED

- Found `.planning/architecture/skill-decomposition.yml`.
- Found task commit `b418429`.
- Unrelated pre-existing dirty paths were not edited, staged, or committed: `tests/release-safety.test.mjs` and `tmp-skill-conversion/`.
