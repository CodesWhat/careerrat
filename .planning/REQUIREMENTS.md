# Requirements: Rolester Skill-to-API Runtime

**Defined:** 2026-07-04
**Core Value:** Rolester must complete job-search work locally with predictable cost: deterministic code does deterministic work, and AI is reserved for judgment that actually needs a model.

## v1 Requirements

### Architecture

- [x] **ARCH-01**: Maintainer can read a skill decomposition inventory that classifies each skill step as deterministic code, bounded AI, full skill-agent run, prompt/spec, or deferred.
- [x] **ARCH-02**: The inventory maps each classified step to an existing or planned owner: TS module, API route, DB verb, CLI command, or retained skill runtime.
- [ ] **ARCH-03**: The routing policy defines when UI, CLI, and agents should call local APIs instead of `POST /api/skill/run`.

### AI Runtime

- [ ] **AIR-01**: Bounded AI assists call through `callAI()` or `runStructuredOneshot()` with explicit skill/action labels.
- [ ] **AIR-02**: Bounded AI assists validate model output against JSON schemas before downstream code can use it.
- [ ] **AIR-03**: Bounded AI assists expose a no-AI degradation path that returns a clear 501-style response and leaves manual input possible.
- [ ] **AIR-04**: AI usage and cost telemetry are preserved for BYOK and managed-proxy paths.

### Discovery

- [ ] **DISC-01**: Company discovery can request structured company seeds from AI using candidate profile, role families, keep signals, exclusions, and already-in-play companies.
- [ ] **DISC-02**: Company discovery resolves seed companies to supported ATS careers URLs using deterministic code, not model-generated final URLs.
- [ ] **DISC-03**: Company discovery scans resolved ATS boards for current roles using existing provider APIs before proposing a company.
- [ ] **DISC-04**: Company discovery enforces dedupe, excluded-company, relevance, comp-plausibility, and supported-ATS gates before presentation.
- [ ] **DISC-05**: Company discovery writes confirmed additions only through the existing source-config/companies write path.

### Runtime Routing

- [ ] **RUNT-01**: `POST /api/skill/run` remains allowlisted and documented as the path for tool-heavy or long-running skill workflows.
- [ ] **RUNT-02**: App discovery controls call local API routes for deterministic or bounded-AI work instead of launching a whole skill session.
- [ ] **RUNT-03**: Conversational agent handoffs still have a clear prompt/spec path for cases where the user wants the agent to drive the workflow.

### Verification

- [ ] **VER-01**: Tests prove deterministic discovery steps do not call AI.
- [ ] **VER-02**: Tests cover structured-output parse failure, corrective retry, and schema rejection.
- [ ] **VER-03**: Tests cover no-AI behavior for migrated app routes.
- [ ] **VER-04**: Tests cover duplicate/excluded company handling and confirmed source-config writes.
- [ ] **VER-05**: Documentation updates keep `AGENTS.md`, `docs/ARCHITECTURE.md`, and app route behavior aligned.

## v2 Requirements

### Broader Skill Migration

- **MIGR-01**: Apply the same decomposition pattern to `research-boards`.
- **MIGR-02**: Apply the same decomposition pattern to `evaluate-job` where body capture and gate math can be made deterministic.
- **MIGR-03**: Apply the same decomposition pattern to communications and interview prep only after discovery proves the pattern.

### Browser Surface

- **BROW-01**: Browser-authenticated sources such as LinkedIn, Wellfound, and webmail can plug into the same deterministic write and confirmation layer.
- **BROW-02**: Browser automation preserves the session-browser permission model from `AGENTS.md`.

### Product Controls

- **PROD-01**: User-facing spend caps and route-level cost estimates are visible in settings.
- **PROD-02**: Managed-AI proxy go-live gates are wired to app runtime controls after pilot pay-intent.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Hosted candidate database | Violates the local-first Shape 2 boundary. |
| Full browser automation migration | Deferred to v2 because current app scope is browser-free discovery and apply packets. |
| Automatic application submission | Current product promise is packet generation and supervised user action. |
| Model-generated ATS URLs as trusted writes | URL resolution must be deterministic and validated against supported providers. |
| One-shot migration of every skill | Too large and risky; discovery is the first proof point. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ARCH-01 | Phase 1 | Complete |
| ARCH-02 | Phase 1 | Complete |
| ARCH-03 | Phase 1 | Pending |
| AIR-01 | Phase 2 | Pending |
| AIR-02 | Phase 2 | Pending |
| AIR-03 | Phase 2 | Pending |
| AIR-04 | Phase 2 | Pending |
| DISC-01 | Phase 3 | Pending |
| DISC-02 | Phase 3 | Pending |
| DISC-03 | Phase 3 | Pending |
| DISC-04 | Phase 3 | Pending |
| DISC-05 | Phase 3 | Pending |
| RUNT-01 | Phase 4 | Pending |
| RUNT-02 | Phase 4 | Pending |
| RUNT-03 | Phase 4 | Pending |
| VER-01 | Phase 5 | Pending |
| VER-02 | Phase 5 | Pending |
| VER-03 | Phase 5 | Pending |
| VER-04 | Phase 5 | Pending |
| VER-05 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0

---
*Requirements defined: 2026-07-04*
*Last updated: 2026-07-04 after initialization*
