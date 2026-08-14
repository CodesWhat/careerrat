---
phase: 10-local-packet-engine
plan: 04
subsystem: api
tags: [packet, generation, bounded-ai, sqlite, artifacts]

requires:
  - phase: 10-03
    provides: Durable packet question capture and bounded non-EEO answer drafting
provides:
  - Local POST /api/packet/generate route
  - Packet source map enumeration and confirmed/proposed source splitting
  - Packet manifest schema and DB-owned packet artifact registration
  - Resume, cover-letter, answer, manifest, and PDF artifact stamping
affects: [10-local-packet-engine, packet, export, apply-flow]

tech-stack:
  added: []
  patterns:
    - Generation service returns reviewable NEEDS YOU gaps instead of fabricating unsupported packet prose
    - Application packet artifact writes go through one DB verb transaction
    - Route mounts remain thin adapters over src/core/packet services

key-files:
  created:
    - src/core/packet/generate.mjs
  modified:
    - tests/packet-engine.test.mjs
    - src/core/packet/schemas/packet-schemas.mjs
    - src/core/db/verbs/app.mjs
    - src/core/db/verbs/index.mjs
    - src/core/packet/context.mjs
    - src/cli/packet-route.mjs

key-decisions:
  - "Packet generation separates the full manifest file from the compact DB packetManifest.questions summary so question lineage is preserved without overwriting capture metadata."
  - "Claimable packet evidence excludes raw/proposed material and strips forbidden-word metadata before exposing source-split output."
  - "Missing AI or missing confirmed evidence produces reviewable NEEDS YOU packet artifacts, never upload-ready output."

patterns-established:
  - "enumeratePacketSources() names every D-08 source class before packet prose is generated."
  - "splitConfirmedAndProposedPacketSources() is the boundary between evidence-backed claims and review/gap context."
  - "appRegisterPacketArtifacts() owns manifest/artifact stamping and uses the existing runVerb export path."

requirements-completed: [PKT-01, PKT-02, PKT-03]

coverage:
  - id: D1
    description: "POST /api/packet/generate creates and stamps packet source/export artifacts through the DB without generated tracker input."
    requirement: PKT-01
    verification:
      - kind: integration
        ref: "tests/packet-generate-route.test.mjs#POST /api/packet/generate: stamps packet source/export artifacts through DB without tracker input"
        status: pass
    human_judgment: false
  - id: D2
    description: "Packet source enumeration covers every D-08 class while excluding private current compensation."
    requirement: PKT-02
    verification:
      - kind: unit
        ref: "tests/packet-engine.test.mjs#packet source enumeration covers every D-08 source class without private current comp"
        status: pass
    human_judgment: false
  - id: D3
    description: "Confirmed evidence can support packet claims, while raw/proposed material stays review/gap context."
    requirement: PKT-02
    verification:
      - kind: unit
        ref: "tests/packet-engine.test.mjs#source splitting keeps raw/proposed material out of claimable packet evidence"
        status: pass
    human_judgment: false
  - id: D4
    description: "Persisted non-EEO question capture flows into generated answer manifests without re-capture."
    requirement: PKT-03
    verification:
      - kind: unit
        ref: "tests/packet-engine.test.mjs#generatePacket carries captured questions into packetManifest.questions by application id"
        status: pass
    human_judgment: false

duration: 28min
completed: 2026-07-06
status: complete
---

# Phase 10 Plan 04: Packet Generation Summary

**Local packet generation with DB-stamped source artifacts and evidence boundaries**

## Performance

- **Duration:** 28 min
- **Started:** 2026-07-06T14:59:00Z
- **Completed:** 2026-07-06T15:26:58Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Tightened packet-engine tests for D-08 source enumeration, confirmed/proposed source splitting, and private/current-comp leakage prevention.
- Added `packetManifestSchema`, `packetCoverLetterProposalSchema`, `packetGenerateRequestSchema`, and `appRegisterPacketArtifacts()`.
- Implemented `generatePacket()`, `draftCoverLetterBlocks()`, source artifact writing, manifest construction, DB artifact stamping, and `POST /api/packet/generate`.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED packet generation contract** - `6930e12` (test)
2. **Task 2: GREEN DB-owned packet artifact registration** - `8b1970d` (feat)
3. **Task 3: GREEN packet generation service and route** - `e52b5d8` (feat)

## Files Created/Modified

- `tests/packet-engine.test.mjs` - adds D-08/D-10 generation and source-boundary contracts.
- `src/core/packet/schemas/packet-schemas.mjs` - adds manifest, cover-letter, and generate request schemas.
- `src/core/db/verbs/app.mjs` - adds atomic packet artifact registration.
- `src/core/db/verbs/index.mjs` - exports packet artifact registration.
- `src/core/packet/context.mjs` - carries saved packet manifest metadata into packet context.
- `src/core/packet/generate.mjs` - orchestrates packet generation, validation, source writing, and manifest assembly.
- `src/cli/packet-route.mjs` - mounts `POST /api/packet/generate`.

## Decisions Made

- The generated manifest file carries full question arrays for packet review, while the application row keeps its compact `packetManifest.questions` capture summary.
- Reviewable packets are first-class: `NEEDS YOU` artifacts are persisted for user completion, but `uploadReady` stays false.
- Plan 10-04 writes default PDF-path artifacts so the local generation route has durable outputs; Plan 10-05 still owns the dedicated export module and DOCX-required behavior.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope change.

## Issues Encountered

- `tests/packet-engine.test.mjs` originally let forbidden-word metadata ride along with claimable evidence. The GREEN implementation strips that metadata from the source-split output while keeping full evidence internally for validation.
- Packet export rendering remains intentionally incomplete until Plan 10-05, which owns `src/core/packet/exports.mjs` and conditional DOCX generation.

## User Setup Required

None - no external service configuration required.

## Verification

- `node --test tests/packet-engine.test.mjs tests/packet-generate-route.test.mjs tests/packet-answers.test.mjs tests/documents-tailor.test.mjs tests/bounded-ai.test.mjs tests/packet-route.test.mjs tests/data-route.test.mjs` - passed, 107/107.
- `node --check src/core/packet/generate.mjs && node --check src/cli/packet-route.mjs && node --check src/core/packet/schemas/packet-schemas.mjs && node --check src/core/packet/context.mjs` - passed.

## Self-Check: PASSED

- Created file exists and parses: `src/core/packet/generate.mjs`.
- Task commits found: `6930e12`, `8b1970d`, `e52b5d8`.
- Local generation creates reviewable/upload-ready status, artifact paths, manifest lineage, and no submit/browser side effect.

## Next Phase Readiness

Plan 10-05 can replace the built-in PDF artifact writing path with `exportPacketArtifacts()`, keep PDF as the default, and add DOCX only for explicit or board-required formats.

---
*Phase: 10-local-packet-engine*
*Completed: 2026-07-06*
