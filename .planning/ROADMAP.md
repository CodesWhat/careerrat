# Roadmap: Rolester Skill-to-API Runtime

**Created:** 2026-07-04
**Mode:** Vertical MVP
**Granularity:** Coarse

## Phase Overview

| Phase | Name | Goal | Requirements | Status |
|-------|------|------|--------------|--------|
| 1 | Decomposition Map | Classify current skill work into API, deterministic code, bounded AI, and retained skill runtime owners. | ARCH-01, ARCH-02, ARCH-03 | In Progress |
| 2 | Bounded AI Foundation | Make small structured AI routes first-class, observable, schema-validated app primitives. | AIR-01, AIR-02, AIR-03, AIR-04 | Pending |
| 3 | Company Discovery API | Migrate `discover-companies` to AI seeds plus deterministic ATS resolution, scan, screening, confirmation, and writes. | DISC-01, DISC-02, DISC-03, DISC-04, DISC-05 | Pending |
| 4 | Runtime Routing | Route app and agent surfaces through the cheapest correct layer while preserving full skill runs for tool-heavy workflows. | RUNT-01, RUNT-02, RUNT-03 | Pending |
| 5 | Verification and Docs | Prove cost boundaries, no-AI degradation, discovery write safety, and documentation alignment. | VER-01, VER-02, VER-03, VER-04, VER-05 | Pending |

## Phase Details

### Phase 1: Decomposition Map

**Goal:** Make the architecture explicit before changing runtime behavior.
**Mode:** mvp

**Requirements:** ARCH-01, ARCH-02, ARCH-03

**Plans:** 1/4 plans executed

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Create the skill decomposition inventory.
- [ ] 01-02-PLAN.md — Create the `discover-companies` target contract.
- [ ] 01-03-PLAN.md — Create the runtime routing policy.

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 01-04-PLAN.md — Create the decomposition-map validation test.

**Success Criteria**:

1. A project-local decomposition artifact lists each high-priority skill and its deterministic, bounded-AI, full-skill, and deferred pieces.
2. `discover-companies` has a detailed target contract that names its AI seed schema, deterministic resolver, scanner, confirmation, and write path.
3. The routing policy explains when UI, CLI, and agents should call local APIs versus `POST /api/skill/run`.
4. Existing code owners are referenced by path so later plans do not invent new seams.

### Phase 2: Bounded AI Foundation

**Goal:** Provide the reusable runtime pieces needed for cheap structured AI calls.
**Mode:** mvp

**Requirements:** AIR-01, AIR-02, AIR-03, AIR-04

**Success Criteria**:

1. Bounded AI routes have a common invocation pattern using `callAI()` or `runStructuredOneshot()`.
2. Route schemas and parse/retry behavior are tested without making real model calls.
3. No-AI responses use a consistent response shape that app surfaces can render as manual paths.
4. Usage labels and cost telemetry identify the feature and action for each AI call.

### Phase 3: Company Discovery API

**Goal:** Prove the skill-to-API pattern on the highest-leverage discovery flow.
**Mode:** mvp

**Requirements:** DISC-01, DISC-02, DISC-03, DISC-04, DISC-05

**Success Criteria**:

1. Company seed generation returns schema-validated JSON using candidate context and dedup inputs.
2. Deterministic code resolves candidate companies to supported ATS URLs and rejects unsupported boards.
3. Existing ATS provider scanners verify current relevant roles before a company is proposed.
4. Proposed companies are presented for confirmation with clear high-confidence and borderline states.
5. Confirmed companies are written through the existing source-config/companies path and exported to the dashboard.

### Phase 4: Runtime Routing

**Goal:** Make the app use the cheapest correct runtime path by default.
**Mode:** mvp

**Requirements:** RUNT-01, RUNT-02, RUNT-03

**Success Criteria**:

1. App discovery controls call the new company discovery API instead of starting a whole skill session.
2. `POST /api/skill/run` remains documented, allowlisted, and available for flows that still need agent tools.
3. Discovery chat handoffs remain available for users who want an agent-led workflow.
4. Runtime config exposes enough capability information for the UI to hide or degrade unavailable AI controls.

### Phase 5: Verification and Docs

**Goal:** Lock in the cost, safety, and routing guarantees before broader migration.
**Mode:** mvp

**Requirements:** VER-01, VER-02, VER-03, VER-04, VER-05

**Success Criteria**:

1. Tests prove deterministic discovery resolver/scanner/write paths do not invoke AI.
2. Tests cover malformed AI JSON, schema rejection, and corrective retry.
3. Tests cover no-AI route behavior and manual fallback metadata.
4. Tests cover dedupe, excluded company, unsupported ATS, and confirmed write behavior.
5. `AGENTS.md`, `docs/ARCHITECTURE.md`, and route docs describe the final split consistently.

## Requirement Coverage

| Requirement | Phase |
|-------------|-------|
| ARCH-01 | Phase 1 |
| ARCH-02 | Phase 1 |
| ARCH-03 | Phase 1 |
| AIR-01 | Phase 2 |
| AIR-02 | Phase 2 |
| AIR-03 | Phase 2 |
| AIR-04 | Phase 2 |
| DISC-01 | Phase 3 |
| DISC-02 | Phase 3 |
| DISC-03 | Phase 3 |
| DISC-04 | Phase 3 |
| DISC-05 | Phase 3 |
| RUNT-01 | Phase 4 |
| RUNT-02 | Phase 4 |
| RUNT-03 | Phase 4 |
| VER-01 | Phase 5 |
| VER-02 | Phase 5 |
| VER-03 | Phase 5 |
| VER-04 | Phase 5 |
| VER-05 | Phase 5 |

---
*Roadmap created: 2026-07-04*
*Last updated: 2026-07-04 after initialization*
