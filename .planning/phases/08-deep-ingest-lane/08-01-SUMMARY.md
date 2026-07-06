---
phase: 08-deep-ingest-lane
plan: 01
subsystem: testing
tags: [node-test, vitest, sqlite, deep-ingest, bounded-ai, react]

requires:
  - phase: 06-canonical-db-app-shell
    provides: SQLite-backed app state and React `/app` shell are canonical product paths.
  - phase: 07-quick-onboarding-and-auto-sourcing
    provides: Setup readiness and first-search surfaces that Deep ingest readiness must stay independent from.
provides:
  - RED SQLite migration, table, DB verb, and terminal-lane readiness contracts for Deep ingest.
  - RED local source scanner and `/api/deep-ingest/*` route contracts with visible fallback/gap outcomes.
  - RED bounded proposal, privacy/grounding validator, React workbench, Library, and FinishStep contracts.
affects: [08-02-deep-ingest-db, 08-03-source-scanner-routes, 08-04-bounded-proposals, 08-06-deep-ingest-ui, 08-07-library-deep-ingest, 08-08-readiness]

tech-stack:
  added: []
  patterns:
    - RED wrappers pass only when the new Phase 8 contracts fail against missing implementation.
    - Temp SQLite and route harness tests pin local DB/API behavior before implementation.
    - Vitest server-rendered markup tests pin UI-SPEC labels and forbid chat/skill runtime handoffs.

key-files:
  created:
    - tests/deep-ingest-db.test.mjs
    - tests/deep-ingest-source-scanner.test.mjs
    - tests/deep-ingest-route.test.mjs
    - tests/deep-ingest-ai.test.mjs
    - apps/web/src/deep-ingest/DeepIngestPage.test.jsx
  modified:
    - tests/db-migrations.test.mjs
    - tests/db-verbs.test.mjs
    - tests/intake-route.test.mjs
    - apps/web/src/onboarding/steps/FinishStep.test.jsx
    - apps/web/src/library/LibraryPage.test.jsx

key-decisions:
  - "Plan 08-01 is intentionally RED and test-only; production Deep ingest implementation remains in later Phase 8 plans."
  - "Deep ingest contracts are SQLite-native and do not require candidate/ compatibility files for product readiness."
  - "Every source submission must resolve to exactly one visible outcome instead of silently invoking chat or the full skill runtime."
  - "Proposal generation remains untrusted until schema validation, grounding/privacy checks, and explicit user confirmation."
  - "Finish and Library contracts route Deep ingest work to `/deep-ingest`, not the old deeper-interview chat handoff."

patterns-established:
  - "Deep ingest readiness is expressed as seven terminal lane states: completed, deferred, or not_available."
  - "Route and UI tests scan serialized output/markup for forbidden `/api/chat`, `/api/skill/run`, guided interview, and hidden runtime handoff tokens."
  - "Bounded AI proposal tests require stable `deep-ingest:proposal:*` labels, native-preferred schema mode, safe manual fallback envelopes, and no trusted candidate writes."

requirements-completed: [ING-01, ING-02, ING-03, ING-04]

coverage:
  - id: D1
    description: "RED Deep ingest migration, table, DB verb, expected-version, proposal-first, and terminal readiness contracts"
    requirement: ING-02
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/deep-ingest-db.test.mjs tests/db-migrations.test.mjs tests/db-verbs.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D2
    description: "RED source scanner and local API route contracts for paste, URL, repo, upload, explicit local path, caps, unsafe sources, and visible outcomes"
    requirement: ING-01
    verification:
      - kind: integration
        ref: "bash -lc 'node --test tests/deep-ingest-source-scanner.test.mjs tests/deep-ingest-route.test.mjs tests/intake-route.test.mjs; test $? -ne 0'"
        status: pass
    human_judgment: false
  - id: D3
    description: "RED bounded extraction/manual fallback, React workbench, Library add-flow, and Finish readiness contracts excluding guided interview/chat behavior"
    requirement: ING-03
    verification:
      - kind: unit
        ref: "bash -lc 'node --test tests/deep-ingest-ai.test.mjs tests/bounded-ai.test.mjs; node_status=$?; npm --workspace apps/web run test -- src/deep-ingest/DeepIngestPage.test.jsx src/onboarding/steps/FinishStep.test.jsx src/library/LibraryPage.test.jsx; web_status=$?; test $node_status -ne 0 -o $web_status -ne 0'"
        status: pass
    human_judgment: false

duration: 9 min
completed: 2026-07-06
status: complete
---

# Phase 08 Plan 01: Wave 0 Deep Ingest Validation Foundation Summary

**RED SQLite, local API, bounded extraction, and React workbench contracts for the Deep ingest lane**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-06T00:44:09Z
- **Completed:** 2026-07-06T00:53:25Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Added RED SQLite and DB verb contracts for migration `008-deep-ingest`, JSON-valid Deep ingest tables, generated query columns/indexes, expected-version conflicts, proposal-first state, and `deep_ingest_complete` terminal lane semantics.
- Added RED scanner and route contracts for paste, URL, upload, repo, and explicit local-path source ingestion with fail-closed validation and one visible source outcome per submission.
- Added RED bounded proposal and UI contracts covering lane-specific AI schemas, no-AI/manual fallback, grounding/privacy validators, `/deep-ingest`, Library target-shaped add flow, and FinishStep readiness handoff.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add RED DB, migration, and decision-state contracts** - `fd1d190` (test)
2. **Task 2: Add RED source scanner and API route contracts** - `5ede857` (test)
3. **Task 3: Add RED bounded extraction and React workbench contracts** - `961c8ea` (test)

## Files Created/Modified

- `tests/deep-ingest-db.test.mjs` - New RED SQLite/verb/readiness contract suite.
- `tests/db-migrations.test.mjs` - Requires migration version 8 named `deep-ingest`.
- `tests/db-verbs.test.mjs` - Requires Deep ingest verbs to be exported from DB verb surfaces.
- `tests/deep-ingest-source-scanner.test.mjs` - New RED scanner contract suite for source kinds, caps, unsafe inputs, repo/local path handling, and visible outcomes.
- `tests/deep-ingest-route.test.mjs` - New RED route contract suite for local `/api/deep-ingest/*` endpoints and no hidden chat/skill runtime handoffs.
- `tests/intake-route.test.mjs` - Guards Universal Intake from owning Deep ingest local routes.
- `tests/deep-ingest-ai.test.mjs` - New RED bounded proposal, schema, fallback, grounding, privacy, and no-runtime contract suite.
- `apps/web/src/deep-ingest/DeepIngestPage.test.jsx` - New RED React route/workbench contract suite.
- `apps/web/src/onboarding/steps/FinishStep.test.jsx` - Requires incomplete Deep ingest readiness to link to `/deep-ingest`, not chat.
- `apps/web/src/library/LibraryPage.test.jsx` - Requires proposal-first Library add flow with target-shape selection.

## Verification

- `bash -lc 'node --test tests/deep-ingest-db.test.mjs tests/db-migrations.test.mjs tests/db-verbs.test.mjs; test $? -ne 0'` passed as a RED wrapper. Underlying result: failing as expected on missing `src/core/db/verbs/deep-ingest.mjs`, missing migration 008, and missing Deep ingest tables.
- `bash -lc 'node --test tests/deep-ingest-source-scanner.test.mjs tests/deep-ingest-route.test.mjs tests/intake-route.test.mjs; test $? -ne 0'` passed as a RED wrapper. Underlying result: failing as expected on missing `src/core/deep-ingest/source-scanner.mjs` and `src/cli/deep-ingest-route.mjs`.
- `bash -lc 'node --test tests/deep-ingest-ai.test.mjs tests/bounded-ai.test.mjs; node_status=$?; npm --workspace apps/web run test -- src/deep-ingest/DeepIngestPage.test.jsx src/onboarding/steps/FinishStep.test.jsx src/library/LibraryPage.test.jsx; web_status=$?; test $node_status -ne 0 -o $web_status -ne 0'` passed as a RED wrapper. Underlying result: failing as expected on missing proposal modules/validators, missing `/deep-ingest` route/page, and missing Library/Finish Deep ingest flows.
- Plan-level RED wrapper run confirmed `task1_underlying=1 wrapper=0`, `task2_underlying=1 wrapper=0`, and `task3_node_underlying=1 task3_web_underlying=1 wrapper=0`.

## Decisions Made

- Kept Plan 08-01 test-only and intentionally RED; no production Deep ingest DB, route, AI, scanner, or React implementation was added.
- Used the future implementation paths already declared by later Phase 8 plans: `src/core/db/verbs/deep-ingest.mjs`, `src/core/deep-ingest/source-scanner.mjs`, `src/cli/deep-ingest-route.mjs`, proposal modules under `src/core/deep-ingest/proposals/`, validators under `src/core/deep-ingest/validators/`, and `apps/web/src/deep-ingest/DeepIngestPage.jsx`.
- Tightened FinishStep contracts so Deep ingest setup points to `/deep-ingest` and rejects the old deeper-interview chat handoff.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The first Task 2 wrapper attempt used `status`, which is a readonly zsh variable. Reran the same command with `test_status`; the RED verification then passed.
- The Task 3 commit initially had a Biome performance warning in a test assertion. The assertion was simplified and the same task commit was amended with hooks enabled.
- GSD state/roadmap handlers updated execution metadata, but the roadmap row needed repair to preserve the table columns after `roadmap.update-plan-progress`.

## Known Stubs

None. The stub-pattern scan only matched intentional UI contract text `Mark not available` in tests; it is a required Phase 8 terminal action label, not a runtime stub.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for Plan 08-02. The next implementation plan can begin from the RED DB and migration contracts, then downstream plans can satisfy the scanner, route, proposal, UI, Library, and readiness tests added here.

## Self-Check

PASSED.

- Found `tests/deep-ingest-db.test.mjs`.
- Found `tests/deep-ingest-route.test.mjs`.
- Found `tests/deep-ingest-ai.test.mjs`.
- Found `tests/deep-ingest-source-scanner.test.mjs`.
- Found `apps/web/src/deep-ingest/DeepIngestPage.test.jsx`.
- Found `apps/web/src/onboarding/steps/FinishStep.test.jsx`.
- Found `apps/web/src/library/LibraryPage.test.jsx`.
- Found task commits `fd1d190`, `5ede857`, and `961c8ea`.
- No file deletions were introduced by task commits.

---
*Phase: 08-deep-ingest-lane*
*Completed: 2026-07-06*
