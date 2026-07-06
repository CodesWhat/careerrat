---
phase: 10-local-packet-engine
plan: 05
subsystem: api
tags: [packet, export, pdf, docx, sqlite]

requires:
  - phase: 10-04
    provides: Packet source generation, manifests, and DB-owned packet artifact registration
provides:
  - Packet export service over existing document export helpers
  - Local POST /api/packet/export route
  - PDF default export policy and conditional DOCX export policy
  - Packet-level registration wrapper for source/export artifact stamping
affects: [10-local-packet-engine, packet, documents, export]

tech-stack:
  added: []
  patterns:
    - Export service delegates to existing src/core/documents/export.mjs
    - Packet exports return user-facing PDF/DOCX files while keeping markdown sources internal
    - DOCX is format-gated by explicit request or captured upload requirements

key-files:
  created:
    - src/core/packet/exports.mjs
  modified:
    - tests/packet-export.test.mjs
    - src/core/packet/schemas/packet-schemas.mjs
    - src/core/db/verbs/app.mjs
    - src/cli/packet-route.mjs

key-decisions:
  - "PDF is always included as the default packet export format."
  - "DOCX is added only for explicit formats:['docx'] requests or captured required DOCX upload metadata."
  - "Packet export registration uses the same DB-owned packet artifact verb and omits manifest.questions when no question metadata exists."

patterns-established:
  - "exportPacketArtifacts() reads stamped source markdown, calls exportArtifact({ ats:true }), and registers user-facing outputs."
  - "POST /api/packet/export is a local packet route and does not launch tailor-application or /api/skill/run."

requirements-completed: [PKT-04, PKT-01]

coverage:
  - id: D1
    description: "Packet export defaults to ATS-safe PDFs and keeps source markdown internal."
    requirement: PKT-04
    verification:
      - kind: unit
        ref: "tests/packet-export.test.mjs#exportPacketArtifacts defaults to ATS-safe PDFs and keeps markdown sources internal"
        status: pass
    human_judgment: false
  - id: D2
    description: "DOCX exports are generated only for explicit selection or captured upload requirements."
    requirement: PKT-04
    verification:
      - kind: unit
        ref: "tests/packet-export.test.mjs#exportPacketArtifacts generates DOCX only for explicit selection or captured upload requirement"
        status: pass
    human_judgment: false
  - id: D3
    description: "POST /api/packet/export exports saved packet sources through the local route without retained skill-runtime handoff."
    requirement: PKT-01
    verification:
      - kind: integration
        ref: "tests/packet-export.test.mjs#POST /api/packet/export exports saved packet sources through the local route"
        status: pass
    human_judgment: false

duration: 16min
completed: 2026-07-06
status: complete
---

# Phase 10 Plan 05: Packet Export Summary

**Packet export service with PDF defaults and conditional DOCX stamping**

## Performance

- **Duration:** 16 min
- **Started:** 2026-07-06T15:14:00Z
- **Completed:** 2026-07-06T15:30:43Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added a route-level RED contract for local `POST /api/packet/export`.
- Implemented `src/core/packet/exports.mjs` over the existing document `exportArtifact()` helper.
- Mounted packet export routing and extended packet schema/DB registration for `answersDocx` and manifests without question metadata.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED packet export contract** - `fdb03f8` (test)
2. **Task 2: GREEN export service, route, and generate integration** - `02604f4` (feat)

## Files Created/Modified

- `tests/packet-export.test.mjs` - adds local export route coverage.
- `src/core/packet/exports.mjs` - exports packet source markdown to PDF/DOCX and registers output artifacts.
- `src/core/packet/schemas/packet-schemas.mjs` - adds `packetExportRequestSchema` and `answersDocx` manifest support.
- `src/core/db/verbs/app.mjs` - avoids writing `questions: undefined` into packet manifests.
- `src/cli/packet-route.mjs` - mounts `POST /api/packet/export`.

## Decisions Made

- Kept source markdown out of the normal user-facing export list; it remains internal build input and DB artifact metadata.
- Reused document export helpers instead of adding renderer packages or Playwright install steps.
- Made the packet-level registration wrapper async so validation errors surface as route/test promise rejections.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope change.

## Issues Encountered

- The shared DB packet registration verb initially materialized `questions: undefined` for export-only manifests. The implementation now omits that field unless real question metadata exists.

## User Setup Required

None - no external service configuration required.

## Verification

- `node --test tests/packet-export.test.mjs tests/packet-engine.test.mjs tests/packet-generate-route.test.mjs tests/packet-route.test.mjs` - passed, 30/30.
- `node --test tests/data-route.test.mjs tests/packet-export.test.mjs tests/packet-engine.test.mjs tests/packet-generate-route.test.mjs tests/packet-route.test.mjs` - passed, 51/51.
- `node --check src/core/packet/exports.mjs && node --check src/cli/packet-route.mjs && node --check src/core/packet/schemas/packet-schemas.mjs` - passed.

## Self-Check: PASSED

- Created file exists and parses: `src/core/packet/exports.mjs`.
- Task commits found: `fdb03f8`, `02604f4`.
- PDF default, conditional DOCX, route export, DB stamping, and binary packet preview regressions pass.

## Next Phase Readiness

Plan 10-06 can switch the packet and answer page defaults to the local packet APIs now that gate, question capture, answer drafting, generation, and export routes exist.

---
*Phase: 10-local-packet-engine*
*Completed: 2026-07-06*
