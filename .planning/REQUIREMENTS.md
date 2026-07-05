# Requirements: Rolester Skill-to-API Runtime

**Defined:** 2026-07-04
**Core Value:** Rolester must complete job-search work locally with predictable cost: deterministic code does deterministic work, and AI is reserved for judgment that actually needs a model.

## v1 Requirements

### Architecture

- [x] **ARCH-01**: Maintainer can read a skill decomposition inventory that classifies each skill step as deterministic code, bounded AI, full skill-agent run, prompt/spec, or deferred.
- [x] **ARCH-02**: The inventory maps each classified step to an existing or planned owner: TS module, API route, DB verb, CLI command, or retained skill runtime.
- [x] **ARCH-03**: The routing policy defines when UI, CLI, and agents should call local APIs instead of `POST /api/skill/run`.

### AI Runtime

- [x] **AIR-01**: Bounded AI assists call through `callAI()` or `runStructuredOneshot()` with explicit skill/action labels.
- [x] **AIR-02**: Bounded AI assists validate model output against JSON schemas before downstream code can use it.
- [x] **AIR-03**: Bounded AI assists expose a no-AI degradation path that returns a clear 501-style response and leaves manual input possible.
- [x] **AIR-04**: AI usage and cost telemetry are preserved for BYOK and managed-proxy paths.

### Discovery

- [x] **DISC-01**: Company discovery can request structured company seeds from AI using candidate profile, role families, keep signals, exclusions, and already-in-play companies.
- [x] **DISC-02**: Company discovery resolves seed companies to supported ATS careers URLs using deterministic code, not model-generated final URLs.
- [x] **DISC-03**: Company discovery scans resolved ATS boards for current roles using existing provider APIs before proposing a company.
- [x] **DISC-04**: Company discovery enforces dedupe, excluded-company, relevance, comp-plausibility, and supported-ATS gates before presentation.
- [x] **DISC-05**: Company discovery writes confirmed additions only through the existing source-config/companies write path.

### Runtime Routing

- [x] **RUNT-01**: `POST /api/skill/run` remains allowlisted and documented as the path for tool-heavy or long-running skill workflows.
- [x] **RUNT-02**: App discovery controls call local API routes for deterministic or bounded-AI work instead of launching a whole skill session.
- [x] **RUNT-03**: Conversational agent handoffs still have a clear prompt/spec path for cases where the user wants the agent to drive the workflow.

### Verification

- [x] **VER-01**: Tests prove deterministic discovery steps do not call AI.
- [x] **VER-02**: Tests cover structured-output parse failure, corrective retry, and schema rejection.
- [x] **VER-03**: Tests cover no-AI behavior for migrated app routes.
- [x] **VER-04**: Tests cover duplicate/excluded company handling and confirmed source-config writes.
- [x] **VER-05**: Documentation updates keep `AGENTS.md`, `docs/ARCHITECTURE.md`, and app route behavior aligned.

## v2 Requirements

### App Shell and DB Source of Truth

- [x] **APP-01**: Electron/React `/app` is the canonical product surface; compatibility surfaces are not part of the normal UX.
- **APP-02**: Dashboard, packet, tracker/activity, scanner context, and source setup views read DB-derived snapshots.
- **APP-03**: `workspace/tracker.json` and `workspace/activity.jsonl` are compatibility/export artifacts only.
- [x] **APP-04**: Static regression guards prevent product routes or React app code from depending on generated tracker/activity files as source of truth.

### Quick Onboarding and Auto Sourcing

- **ONB-01**: Quick onboarding captures the minimum profile, resume, role, location, comp, and search posture needed to start searching.
- **ONB-02**: Resume support treats PDF as the standard, keeps text/markdown fallback, and records board-required import/export formats such as DOCX where needed.
- **RUN-01**: A DB-backed sourcing run starts automatically when candidate setup first reaches `search_ready`.
- **RUN-02**: React surfaces durable sourcing run progress, errors, and results while returning the user to deeper onboarding.

### Deep Ingest

- **ING-01**: The app supports drop-all intake for resumes, notes, LinkedIn/project links, repos, portfolios, pasted facts, recruiter context, and job context.
- **ING-02**: Deep ingest derives evidence, story bank entries, honesty boundaries, writing voice, role-specific signals, and unanswered gaps into DB state.
- **ING-03**: Deep ingest combines structured forms with an optional AI interview that asks role/job-dependent follow-ups.
- **ING-04**: Deep ingest progress is durable, resumable, visible in readiness state, and independent from any running sourcing job.

### Public Discovery Intelligence

- **PUB-01**: Public company/job-board intelligence is stored separately from candidate proposal, fit, comp, tracker, and notes data.
- **PUB-02**: Sync-home is opt-in and enabled by default, with scrub tests proving no PII, candidate context, comp floors, fit scores, private notes, tracker IDs, or local paths leave the machine.
- **PUB-03**: Public records include stable IDs, company/domain, careers URL, ATS/provider, provenance, freshness, confidence, and conflict metadata.
- **DSC-01**: Discovery uses a scanner cascade: supported ATS APIs, deterministic public-page extraction, scraper/API fallback, then bounded AI fallback.
- **DSC-02**: Board/source discovery and search sweeps run through local APIs with DB-backed run state, not default chat or full skill runtime.
- **DSC-03**: Unsupported or custom careers pages can produce current jobs or clear review/cache metadata without poisoning confirmed ATS sources.

### Local Packet Engine

- **PKT-01**: Evaluate/gate, packet generation, and artifact stamping are app-local APIs that write through DB verbs.
- **PKT-02**: Packets include ATS-optimized resumes, cover letters when appropriate, and evidence-grounded answers with honesty/placeholder gates.
- **PKT-03**: Company-specific questions such as "why this company" or recent tools are captured and answered; EEO, disability, and demographic questions are excluded from generated-answer automation.
- **PKT-04**: Exports support board-required formats, with PDF as standard and DOCX where upload workflows require it.

### Runtime and Desktop Hardening

- **SEC-01**: Static checks fail new app-default calls to full skill runtime where a local API owner exists.
- **SEC-02**: The retained skill runtime removes broad `Write`, `Edit`, and `Bash` tools by default; tool-heavy execution is explicit.
- **DESK-01**: Electron first-run, database initialization, routing, packaging, error recovery, and update/notarization readiness are verified for pilot use.
- **DESK-02**: Product docs teach the app-first workflow and no longer present compatibility surfaces as the normal path.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Hosted candidate database | Violates the local-first Shape 2 boundary. |
| Full browser automation migration | Deferred to v2 because current app scope is browser-free discovery and apply packets. |
| Automatic application submission | Current product promise is packet generation and supervised user action. |
| Model-generated ATS URLs as trusted writes | URL resolution must be deterministic and validated against supported providers. |
| One-shot migration of every skill | Too large and risky; app-product migration is sequenced by surface and user workflow. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ARCH-01 | Phase 1 | Complete |
| ARCH-02 | Phase 1 | Complete |
| ARCH-03 | Phase 1 | Complete |
| AIR-01 | Phase 2 | Complete |
| AIR-02 | Phase 2 | Complete |
| AIR-03 | Phase 2 | Complete |
| AIR-04 | Phase 2 | Complete |
| DISC-01 | Phase 3 | Complete |
| DISC-02 | Phase 3 | Complete |
| DISC-03 | Phase 3 | Complete |
| DISC-04 | Phase 3 | Complete |
| DISC-05 | Phase 3 | Complete |
| RUNT-01 | Phase 4 | Complete |
| RUNT-02 | Phase 4 | Complete |
| RUNT-03 | Phase 4 | Complete |
| VER-01 | Phase 5 | Complete |
| VER-02 | Phase 5 | Complete |
| VER-03 | Phase 5 | Complete |
| VER-04 | Phase 5 | Complete |
| VER-05 | Phase 5 | Complete |
| APP-01 | Phase 6 | Complete |
| APP-02 | Phase 6 | Planned |
| APP-03 | Phase 6 | Planned |
| APP-04 | Phase 6 | Complete |
| ONB-01 | Phase 7 | Planned |
| ONB-02 | Phase 7 | Planned |
| RUN-01 | Phase 7 | Planned |
| RUN-02 | Phase 7 | Planned |
| ING-01 | Phase 8 | Planned |
| ING-02 | Phase 8 | Planned |
| ING-03 | Phase 8 | Planned |
| ING-04 | Phase 8 | Planned |
| PUB-01 | Phase 9 | Planned |
| PUB-02 | Phase 9 | Planned |
| PUB-03 | Phase 9 | Planned |
| DSC-01 | Phase 9 | Planned |
| DSC-02 | Phase 9 | Planned |
| DSC-03 | Phase 9 | Planned |
| PKT-01 | Phase 10 | Planned |
| PKT-02 | Phase 10 | Planned |
| PKT-03 | Phase 10 | Planned |
| PKT-04 | Phase 10 | Planned |
| SEC-01 | Phase 11 | Planned |
| SEC-02 | Phase 11 | Planned |
| DESK-01 | Phase 11 | Planned |
| DESK-02 | Phase 11 | Planned |

**Coverage:**

- v1 requirements: 20 total
- v2 product requirements: 26 total
- Mapped to phases: 46
- Unmapped: 0

---
*Requirements defined: 2026-07-04*
*Last updated: 2026-07-05 after v2 app-product planning*
