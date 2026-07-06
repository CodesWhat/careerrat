# Roadmap: Rolester Skill-to-API Runtime

**Created:** 2026-07-04
**Mode:** Vertical MVP
**Granularity:** Coarse

## Phase Overview

| Phase | Name | Goal | Requirements | Status |
|-------|------|------|--------------|--------|
| 1 | Decomposition Map | Classify current skill work into API, deterministic code, bounded AI, and retained skill runtime owners. | ARCH-01, ARCH-02, ARCH-03 | Complete (4/4, 2026-07-04) |
| 2 | Bounded AI Foundation | Provide the reusable runtime pieces needed for cheap structured AI calls. | AIR-01, AIR-02, AIR-03, AIR-04 | Complete (7/7, 2026-07-04) |
| 3 | Company Discovery API | Migrate `discover-companies` to AI seeds plus deterministic ATS resolution, scan, screening, confirmation, and writes. | DISC-01, DISC-02, DISC-03, DISC-04, DISC-05 | Complete (7/7, 2026-07-05) |
| 4 | Runtime Routing | Make the app use the cheapest correct runtime path by default. | RUNT-01, RUNT-02, RUNT-03 | Complete (5/5, 2026-07-05) |
| 5 | Verification and Docs | Prove cost boundaries, no-AI degradation, discovery write safety, and documentation alignment. | VER-01, VER-02, VER-03, VER-04, VER-05 | Complete (5/5, 2026-07-05) |
| 6 | Canonical DB App Shell | Make the Electron/React app DB-source-of-truth and remove compatibility surfaces from product paths. | APP-01, APP-02, APP-03, APP-04 | Complete (10/10, 2026-07-05) |
| 7 | Quick Onboarding and Auto Sourcing | Start background sourcing as soon as minimum viable onboarding is complete, then return the user to deeper onboarding. | ONB-01, ONB-02, RUN-01, RUN-02 | Complete (8/8, 2026-07-06) |
| 8 | Deep Ingest Lane | 2/9 | In Progress|  |
| 9 | Public Company Intelligence and Scanner Cascade | Build privacy-scrubbed public company/job-board intelligence and deepen non-ATS discovery. | PUB-01, PUB-02, PUB-03, DSC-01, DSC-02, DSC-03 | Complete (6/6, 2026-07-06) |
| 10 | Local Packet Engine | Generate ATS-ready resume, cover letter, and non-EEO answer packets through local APIs and bounded AI. | PKT-01, PKT-02, PKT-03, PKT-04 | Planned |
| 11 | Runtime Lockdown and Desktop Release | 1/7 | In Progress|  |

## Phase Details

### Phase 1: Decomposition Map

**Goal:** Make the architecture explicit before changing runtime behavior.
**Mode:** mvp

**Requirements:** ARCH-01, ARCH-02, ARCH-03

**Plans:** 4/4 plans complete

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Create the skill decomposition inventory.
- [x] 01-02-PLAN.md — Create the `discover-companies` target contract.
- [x] 01-03-PLAN.md — Create the runtime routing policy.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-04-PLAN.md — Create the decomposition-map validation test.

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

**Plans:** 5/5 plans complete

Plans:
**Wave 1**

- [x] 04-01-PLAN.md — Extend runtime config capability metadata while retaining `POST /api/skill/run`.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 04-02-PLAN.md — Load runtime capabilities into the onboarding app and pass them to steps.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 04-03-PLAN.md — Make Companies step default to local company proposal create/read routes.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 04-04-PLAN.md — Wire Companies step proposal decisions through the local decision route.

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 04-05-PLAN.md — Preserve explicit discovery chat handoffs and close routing docs.

**Success Criteria**:

1. App discovery controls call the new company discovery API instead of starting a whole skill session.
2. `POST /api/skill/run` remains documented, allowlisted, and available for flows that still need agent tools.
3. Discovery chat handoffs remain available for users who want an agent-led workflow.
4. Runtime config exposes enough capability information for the UI to hide or degrade unavailable AI controls.

### Phase 5: Verification and Docs

**Goal:** Lock in the cost, safety, and routing guarantees before broader migration.
**Mode:** mvp

**Requirements:** VER-01, VER-02, VER-03, VER-04, VER-05

**Plans:** 5/5 plans complete

Plans:
**Wave 1**

- [x] 05-01-PLAN.md — Cost-boundary regression lock for deterministic discovery paths.
- [x] 05-02-PLAN.md — Structured-output and no-AI route negative coverage.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 05-03-PLAN.md — Confirm-first write safety rollup.
- [x] 05-04-PLAN.md — Docs alignment and docs drift guard.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 05-05-PLAN.md — Final focused verification rollup.

**Success Criteria**:

1. Tests prove deterministic discovery resolver/scanner/write paths do not invoke AI.
2. Tests cover malformed AI JSON, schema rejection, and corrective retry.
3. Tests cover no-AI route behavior and manual fallback metadata.
4. Tests cover dedupe, excluded company, unsupported ATS, and confirmed write behavior.
5. `AGENTS.md`, `docs/ARCHITECTURE.md`, and route docs describe the final split consistently.

### Phase 6: Canonical DB App Shell

**Goal:** Make the Electron/React app DB-source-of-truth and remove compatibility surfaces from product paths.
**Mode:** mvp

**Requirements:** APP-01, APP-02, APP-03, APP-04

**Plans:** 10/10 plans complete

Plans:
**Wave 0**

- [x] 06-01-PLAN.md — Add static and nav RED guards for DB app shell retirement.
- [x] 06-02-PLAN.md — Add packet route RED tests for DB-derived application rows.
- [x] 06-03-PLAN.md — Add source setup, scanner context, and scanner seen-set RED tests.

**Wave 1** *(blocked on Wave 0 completion)*

- [x] 06-04-PLAN.md — Retire legacy product nav and classify debug/export routes.
- [x] 06-05-PLAN.md — Migrate packet product APIs to DB-derived reads.
- [x] 06-06-PLAN.md — Migrate board/source setup product writes to DB source config.
- [x] 06-07-PLAN.md — Migrate scanner context, results, and seen sets to DB-derived state.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 06-08-PLAN.md — Run the final backend, frontend, and global static-guard rollup.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 06-09-PLAN.md — Close onboarding legacy affordance and static compatibility route-copy gaps.
- [x] 06-10-PLAN.md — Close DB-mode onboarding source-readiness and compatibility export-copy gaps.

**Success Criteria**:

1. React `/app` is the canonical product surface; legacy `/onboard`, `/tracker`, generated `tracker.html`, and static dashboard routes are debug/export-only or removed from product navigation.
2. App routes including dashboard, packet, tracker/activity, scanner context, and source setup read DB-derived snapshots directly.
3. `workspace/tracker.json` and `workspace/activity.jsonl` remain compatibility exports only and are not app dependencies.
4. Static tests fail if a product route or React app path reads generated tracker/activity files as source of truth.

### Phase 7: Quick Onboarding and Auto Sourcing

**Goal:** Start background sourcing as soon as minimum viable onboarding is complete, then return the user to deeper onboarding.
**Mode:** mvp

**Requirements:** ONB-01, ONB-02, RUN-01, RUN-02

**Plans:** 8/8 plans complete

Plans:
**Wave 0**

- [x] 07-01-PLAN.md — Add RED DOCX resume intake contracts.
- [x] 07-02-PLAN.md — Add RED durable sourcing run and first-search route contracts.
- [x] 07-03-PLAN.md — Add RED first-search UI, readiness, and Jobs search action contracts.

**Wave 1** *(blocked on Wave 0 completion)*

- [x] 07-04-PLAN.md — Implement deterministic DOCX upload through onboarding.
- [x] 07-05-PLAN.md — Implement durable SQLite sourcing run state.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 07-06-PLAN.md — Implement first-search sourcing service, routes, and quick-start replacement.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 07-07-PLAN.md — Wire first-search task UI, cadence, and setup-card status.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 07-08-PLAN.md — Wire Jobs-page manual search and final Phase 7 regression rollup. (completed 2026-07-05)

**Success Criteria**:

1. Quick onboarding captures enough profile, resume, target role, location, comp floor, and search posture to mark `search_ready` without requiring deep ingest.
2. Resume intake supports the formats candidates and job boards actually need, with PDF as the standard and text/markdown fallback; export needs for DOCX/PDF are recorded for packet generation.
3. When `search_ready` first becomes true, the app starts a DB-backed sourcing run automatically and returns the user to onboarding/deep ingest instead of launching a hidden skill.
4. React shows durable sourcing run state, progress, errors, and results while all writes go through DB verbs.

### Phase 8: Deep Ingest Lane

**Goal:** Capture rich profile, project, story, and evidence context through drop-all intake plus an optional AI interview.
**Mode:** mvp

**Requirements:** ING-01, ING-02, ING-03, ING-04

**Success Criteria**:

1. The app accepts a "drop everything" intake: resumes, notes, LinkedIn/project links, repos, portfolio links, pasted facts, and recruiter/job context.
2. Deep ingest derives evidence claims, story bank entries, honesty boundaries, writing voice, role-specific keep/cut signals, and unanswered gaps into DB state.
3. The user can complete deeper context through both structured React forms and an AI interview; the interview asks role/job-dependent follow-ups rather than a fixed form.
4. Deep ingest progress is durable, resumable, visible in onboarding/dashboard readiness, and independent from the already-running sourcing job.

### Phase 9: Public Company Intelligence and Scanner Cascade

**Goal:** Build privacy-scrubbed public company/job-board intelligence and deepen non-ATS discovery.
**Mode:** mvp

**Requirements:** PUB-01, PUB-02, PUB-03, DSC-01, DSC-02, DSC-03

**Plans:** 6/6 plans complete

Plans:
**Wave 0**

- [x] 09-01-PLAN.md — Add RED public-intel, scanner, onboarding, and review contracts.

**Wave 1** *(blocked on Wave 0 completion)*

- [x] 09-02-PLAN.md — Implement public-intel storage, scrub validation, and onboarding preference.
- [x] 09-03-PLAN.md — Implement deterministic scanner cascade and local scan route.
- [x] 09-04-PLAN.md — Add bounded AI fallback for genuinely ambiguous public pages.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 09-05-PLAN.md — Add public-intel review queue, decisions, and UI affordances.
- [x] 09-06-PLAN.md — Add privacy/runtime guards, docs, and final verification.

**Success Criteria**:

1. Public company/job-board intelligence is stored separately from candidate-specific proposal, fit, comp, tracker, and notes data.
2. Sync-home is opt-in and enabled by default, but every publish path has scrub tests proving no PII, candidate context, comp floors, fit scores, private notes, tracker IDs, or local paths leave the machine.
3. Public records include stable IDs, company/domain, careers URL, ATS/provider, provenance, freshness, confidence, and conflict/freshness metadata.
4. Discovery uses a scanner cascade: supported ATS APIs first, generic deterministic public-page extraction second, optional scraper/API fallback third, bounded AI fallback last for ambiguous pages.
5. Board/source discovery and search sweeps run through local APIs and DB-backed run state rather than defaulting to chat or full skill runtime.

### Phase 10: Local Packet Engine

**Goal:** Generate ATS-ready resume, cover letter, and non-EEO answer packets through local APIs and bounded AI.
**Mode:** mvp

**Requirements:** PKT-01, PKT-02, PKT-03, PKT-04

**Plans:** 7 plans

Plans:
**Wave 0**

- [ ] 10-01-PLAN.md - Add RED packet route, engine, answer, export, page, and runtime-boundary contracts.

**Wave 1** *(blocked on Wave 0 completion)*

- [ ] 10-02-PLAN.md - Implement local packet gate context, schemas, bounded-AI service, and route.

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 10-03-PLAN.md - Implement application-question capture, self-identification exclusion, answer drafting, and local routes.

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 10-04-PLAN.md - Implement packet generation and DB-owned source artifact stamping.

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 10-05-PLAN.md - Implement PDF-default and conditional DOCX export generation and stamping.

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 10-06-PLAN.md - Replace packet and answer page defaults with local packet APIs.

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 10-07-PLAN.md - Update runtime docs and run final Phase 10 verification.

**Success Criteria**:

1. Evaluate/gate, packet generation, and artifact stamping are app-local APIs using DB verbs; `tailor-application`, `answer-question`, and `evaluate-job` skill runtime are not the product default.
2. Packets include ATS-optimized resume, cover letter when appropriate, and application-answer markdown for company-specific prompts such as "why this company" or recent tools.
3. EEO/disability/demographic questions are explicitly identified and excluded from generated-answer automation.
4. Packet export supports board-required formats, with PDF as standard and DOCX support where boards require uploadable documents.

### Phase 11: Runtime Lockdown and Desktop Release

**Goal:** Remove broad skill-tool power from app defaults and harden the desktop product path for pilot use.
**Mode:** mvp

**Requirements:** SEC-01, SEC-02, DESK-01, DESK-02

**Plans:** 1/7 plans executed

Plans:
**Wave 1**

- [x] 11-01-PLAN.md - Add the slice-aware app-default runtime guard.
- [ ] 11-02-PLAN.md - Implement app-safe one-shot runtime tool profiles.
- [ ] 11-04-PLAN.md - Harden desktop runtime paths, smoke, and external-link handling.

**Wave 2** *(blocked on relevant Wave 1 completion)*

- [ ] 11-03-PLAN.md - Make retained runtime and chat tool-heavy execution explicit.
- [ ] 11-05-PLAN.md - Configure signed and notarized macOS pilot packaging.

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 11-06-PLAN.md - Guard and update pilot-facing app-first docs.

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 11-07-PLAN.md - Run final Phase 11 verification and release rollup.

**Success Criteria**:

1. App buttons call local APIs, DB verbs, bounded AI, or explicit chat; static checks fail on new app-default calls to `POST /api/skill/run`.
2. The retained skill runtime no longer exposes broad `Write`, `Edit`, or `Bash` tools by default; tool-heavy execution is explicit and reserved for browser/auth/interview workflows that actually need it.
3. Electron first-run, database initialization, app routing, packaging, error recovery, and update/notarization readiness are verified for pilot use.
4. Product docs reflect the final app-first workflow and no longer teach compatibility surfaces as the normal user path.

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
| APP-01 | Phase 6 |
| APP-02 | Phase 6 |
| APP-03 | Phase 6 |
| APP-04 | Phase 6 |
| ONB-01 | Phase 7 |
| ONB-02 | Phase 7 |
| RUN-01 | Phase 7 |
| RUN-02 | Phase 7 |
| ING-01 | Phase 8 |
| ING-02 | Phase 8 |
| ING-03 | Phase 8 |
| ING-04 | Phase 8 |
| PUB-01 | Phase 9 |
| PUB-02 | Phase 9 |
| PUB-03 | Phase 9 |
| DSC-01 | Phase 9 |
| DSC-02 | Phase 9 |
| DSC-03 | Phase 9 |
| PKT-01 | Phase 10 |
| PKT-02 | Phase 10 |
| PKT-03 | Phase 10 |
| PKT-04 | Phase 10 |
| SEC-01 | Phase 11 |
| SEC-02 | Phase 11 |
| DESK-01 | Phase 11 |
| DESK-02 | Phase 11 |

---
*Roadmap created: 2026-07-04*
*Last updated: 2026-07-06 after Phase 09 completion*
