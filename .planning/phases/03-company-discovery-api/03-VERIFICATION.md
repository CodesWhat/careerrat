---
phase: 03-company-discovery-api
verified: 2026-07-05T00:59:54Z
status: passed
score: 10/10 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 03: Company Discovery API Verification Report

**Phase Goal:** Prove the skill-to-API pattern on the highest-leverage discovery flow.
**Verified:** 2026-07-05T00:59:54Z
**Status:** passed
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Company seed generation returns schema-validated JSON using candidate context and dedup inputs. | VERIFIED | `src/core/discovery/company-seeds.mjs:20` defines `companySeedSchema` with top-level `companies[]`, max 12, and no trusted URL/provider/write fields; `:165` calls `runBoundedAI()` with `COMPANY_SEED_LABELS`; `tests/company-discovery-seeds.test.mjs:149` verifies schema rejection, `:185` verifies context/dedupe fields and privacy, and `:300` verifies native output labels and prompt context. |
| 2 | Manual seeds work without AI and no-AI/no-manual degrades to a manual 501 envelope. | VERIFIED | `src/core/discovery/company-seeds.mjs:154` returns manual seeds with `ai.used:false`; `:164` only calls bounded AI after manual seed bypass; `tests/company-discovery-seeds.test.mjs:227` proves manual seeds do not invoke AI and `:268` proves `NO_AI_ROUTE` returns 501 with manual fallback. |
| 3 | Deterministic code resolves candidate companies to supported ATS URLs and rejects unsupported or unsafe boards. | VERIFIED | `src/core/discovery/company-board-resolver.mjs:174` validates scheme/host/DNS safety, `:398` validates URLs before fetch, `:399` uses `inferProvider()`, and `:486` owns resolution/cache lookup; `tests/company-board-resolver.test.mjs:145`, `:180`, `:204`, `:235`, and `:282` cover unsafe hints, unsafe redirects, supported ATS, homepage link discovery, and unsupported cache-only pages. |
| 4 | Resolver cache and proposal state are DB-owned, versioned, and not generated tracker/dashboard writes. | VERIFIED | `src/core/db/migrations/006-company-discovery-cache.mjs:9` and `:33` create dedicated JSON-checked cache/proposal tables; `src/core/db/verbs/company-discovery.mjs:114` through `:249` implement cache, latest-pending, and version-conflict verbs; `tests/company-discovery-cache-db.test.mjs:93`, `:138`, `:155`, and `:205` verify schema, D-15 field round-trip, refresh due reasons, latest reads, conflict protection, and absence of generated files. |
| 5 | Existing ATS scanners verify current relevant roles before a company is proposed. | VERIFIED | `src/core/discovery/company-proposals.mjs:127` builds a scanner config from resolved ATS data, `:137` calls `scanCompaniesImpl()`, `:138` scores/prepares scan output, and `:145` gates against the scan result; `tests/company-proposals-route.test.mjs:247`, `:365`, `:506`, and `tests/company-discovery-regression.test.mjs:314` verify scanner-backed proposals. |
| 6 | Proposal generation captures reachable JD bodies, keeps them on proposals, and does not persist sourced rows before approval. | VERIFIED | `src/core/discovery/company-proposals.mjs:139` calls `offersWithCapturedJobs()` during proposal creation and `:233` persists only proposal batch state; `tests/company-proposals-route.test.mjs:506` verifies captured `workspace/jobs/*` artifacts and `:533`-`:584` proves no pre-approval source/sourced writes. |
| 7 | Proposal gates enforce dedupe, excluded-company, relevance, comp-plausibility, supported-ATS, high-confidence, borderline, and reject states. | VERIFIED | `src/core/discovery/company-proposal-gate.mjs:215` rejects tracked/excluded/in-play companies, `:252` separates unsupported cache-only pages, `:273` rejects no role signal, `:286` applies comp floor states, and `:347` distinguishes high-confidence from borderline; `tests/company-proposals-route.test.mjs:587`, `:662`, and `:728` cover comp, review-only, and hard-reject branches. |
| 8 | Proposed companies are presented for confirmation with a stable proposal contract and clear high-confidence/borderline states. | VERIFIED | `src/core/discovery/company-proposal-gate.mjs:354` emits `proposalId`, `company`, `jobBoardUrl`, `atsProvider`, `classification`, `confidenceTier`, `scanSummary`, `jdCapture`, `proposedAction`, `reviewReasons`, `rejectReasons`, `capturedOffers`, and `version`; `tests/company-proposals-route.test.mjs:506` and `tests/company-discovery-regression.test.mjs:421` verify the contract and confidence states. |
| 9 | Confirmed companies write only through the existing source-config/companies and sourced-row paths. | VERIFIED | `src/core/discovery/company-proposal-decisions.mjs:172` allows approval only for high-confidence supported ATS proposals; `:362` calls `companyAtsUpsertImpl()` and `:371` calls `sourcedUpsertBatchImpl()`; `tests/company-proposal-decisions.test.mjs:212` verifies source config and sourced row promotion with JD artifacts. |
| 10 | Phase 03 routes are thin, stable, local API paths that avoid full skill runtime, avoid private comp leakage, and return expected status envelopes. | VERIFIED | `src/cli/discovery-route.mjs:186`, `:224`, and `:240` mount exact POST/GET proposal and POST decision routes over core functions; `tests/company-discovery-regression.test.mjs:364` verifies current-comp privacy, `:534` verifies 400/409/422/501/502 envelopes, and `:600` verifies no runtime/generated-write seams in the Phase 03 core/route slice. |

**Score:** 10/10 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/cli/discovery-route.mjs` | Exact company proposal/decision API routes | VERIFIED | POST proposal, GET proposal, and POST decision routes are mounted at `:186`, `:224`, and `:240`; company slice delegates to core modules. |
| `src/core/discovery/company-context.mjs` | Candidate/dedupe context with private-comp filtering | VERIFIED | Builds profile domain, role families, location posture, keep/cut, exclusions, tracked/applied/sourced dedupe, and allowed comp floors at `:121`-`:168`; no `current_base` references. |
| `src/core/discovery/company-seeds.mjs` | Schema, manual seed normalization, bounded AI seed call | VERIFIED | Schema at `:20`; labels at `:6`; manual bypass at `:154`; bounded AI call at `:165`. |
| `src/core/discovery/company-board-resolver.mjs` | Deterministic safe URL/provider resolver and cache writer | VERIFIED | Safety checks, provider inference, cache read/write, refresh constants, supported/unsupported outputs all present and tested. |
| `src/core/discovery/company-proposal-gate.mjs` | Hard reject, high-confidence, borderline, comp gate classification | VERIFIED | Implements dedupe/exclusion/in-play, unsupported, no-role, comp, JD capture, and confidence logic. |
| `src/core/discovery/company-proposals.mjs` | Seed -> resolve -> scan -> capture -> gate orchestration | VERIFIED | Uses resolver/scanner/capture/gate and writes only proposal batches. |
| `src/core/discovery/company-proposal-decisions.mjs` | Approve/reject/suppress/refresh/escalate decision authority | VERIFIED | Version checks, approval ownership, sourced promotion, refresh revalidation, and simple decisions are implemented. |
| `src/core/db/migrations/006-company-discovery-cache.mjs` | SQLite resolver cache and proposal tables | VERIFIED | Migration id 6 creates both DB-owned tables with JSON checks and generated/indexed query fields. |
| `src/core/db/verbs/company-discovery.mjs` | Cache/proposal DB verbs | VERIFIED | Upsert/get/list-due/latest/patch-state verbs exist and are exported through `src/core/db/verbs/index.mjs`. |
| Phase 03 tests | Behavioral proof for DISC-01..DISC-05 | VERIFIED | Focused gate ran locally with 105 tests passing. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `discovery-route.mjs` | `company-proposals.mjs` | `createCompanyProposalBatch()` | WIRED | POST `/api/discovery/company-proposals` delegates at `src/cli/discovery-route.mjs:200`. |
| `discovery-route.mjs` | `company-proposal-decisions.mjs` | `applyCompanyProposalDecision()` | WIRED | POST `/api/discovery/company-proposal-decisions` delegates at `src/cli/discovery-route.mjs:250`. |
| `company-proposals.mjs` | `company-seeds.mjs` | `generateCompanySeeds()` | WIRED | Seeds generated at `src/core/discovery/company-proposals.mjs:183`. |
| `company-proposals.mjs` | `company-board-resolver.mjs` | `resolveCompanyBoard()` | WIRED | Resolver called at `src/core/discovery/company-proposals.mjs:126`. |
| `company-proposals.mjs` | `sourced-scanner.mjs` | `scanCompanies()` / scoring helpers | WIRED | Scan and filtering helpers imported at `src/core/discovery/company-proposals.mjs:4`-`:9` and invoked at `:137`. |
| `company-proposals.mjs` | `sourced-persistence.mjs` | `offersWithCapturedJobs()` | WIRED | JD capture called at `src/core/discovery/company-proposals.mjs:139`. |
| `company-proposal-decisions.mjs` | `source-config.mjs` | `companyAtsUpsert()` | WIRED | Approval write at `src/core/discovery/company-proposal-decisions.mjs:362`. |
| `company-proposal-decisions.mjs` | `sourced.mjs` | `sourcedUpsertBatch()` | WIRED | Sourced promotion at `src/core/discovery/company-proposal-decisions.mjs:371`. |
| `company-board-resolver.mjs` | `company-discovery.mjs` | cache get/upsert | WIRED | Cache read/write through DB verbs at `src/core/discovery/company-board-resolver.mjs:340` and `:347`. |
| `migrations.mjs` / `verbs/index.mjs` | Phase 03 DB migration/verbs | imports/exports | WIRED | Migration 006 registered at `src/core/db/migrations.mjs:19` and `:28`; verbs exported at `src/core/db/verbs/index.mjs:26`-`:34`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `POST /api/discovery/company-proposals` | `data.proposals`, `data.rejected`, `counts` | manual or bounded-AI seeds -> deterministic resolver -> scanner -> capture -> gate -> `company_discovery_proposals` | Yes | FLOWING |
| `GET /api/discovery/company-proposals` | `data.batch` | `companyProposalBatchLatest()` over SQLite proposal table | Yes | FLOWING |
| `POST /api/discovery/company-proposal-decisions` | `data.decision`, `sourceConfig`, `sourced`, `refreshedProposal` | proposal table -> version check -> approval or refresh core path -> DB source/sourced verbs where allowed | Yes | FLOWING |
| `companyBoardResolutionGet/ListDue` | resolver records | `company_board_resolutions` JSON rows with generated lookup fields | Yes | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Full Phase 03 focused gate | `node --test tests/company-discovery-regression.test.mjs tests/company-discovery-seeds.test.mjs tests/company-board-resolver.test.mjs tests/company-discovery-cache-db.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/bounded-ai.test.mjs tests/discovery-route.test.mjs tests/db-source-config.test.mjs tests/companies-cli.test.mjs tests/scan-sourced.test.mjs tests/search-route.test.mjs tests/sourced-scanner.test.mjs` | 105 pass, 0 fail, 0 skipped | PASS |
| Private comp scan | `rg -n "current_base|current_comp_shareable|145000" src/cli/discovery-route.mjs src/core/discovery` | no matches | PASS |
| Generated-write boundary scan | `rg -n "writeFileSync|appendFileSync|createWriteStream|writeTracker|workspace/tracker\\.html|workspace/activity\\.jsonl|captureAndPersistOffersIfDb" src/cli/discovery-route.mjs src/core/discovery` | no matches | PASS |
| Full skill runtime scan in Phase 03 core | `rg -n "runSkillStream|/api/skill/run" src/core/discovery` | no matches | PASS |
| Approval ownership scan | `rg -n "companyAtsUpsert|sourcedUpsertBatch" src/core/discovery/company-proposal-decisions.mjs` | expected approval-path matches only | PASS |

### Probe Execution

No phase-declared `probe-*.sh` files or `<human-check>` blocks were found in Phase 03 plans/summaries, and no conventional project probe scripts were present.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| DISC-01 | 03-01, 03-04, 03-07 | Structured AI/manual company seeds using candidate context and dedup inputs | SATISFIED | `companySeedSchema`, `buildCompanySeedContext()`, `generateCompanySeeds()`, and seed tests pass. |
| DISC-02 | 03-01, 03-02, 03-03, 03-07 | Deterministic supported ATS resolution with unsupported rejection/cache-only behavior | SATISFIED | Resolver safety/cache tests and migration/DB verb tests pass. |
| DISC-03 | 03-01, 03-05, 03-07 | Existing ATS scanner verifies current relevant roles before proposal | SATISFIED | Proposal route and regression tests verify `scanCompaniesImpl()` before proposal output. |
| DISC-04 | 03-01, 03-02, 03-05, 03-07 | Dedupe, exclusion, relevance, comp-plausibility, supported-ATS gates before presentation | SATISFIED | Gate code and proposal route/regression tests cover high, borderline, and rejected states. |
| DISC-05 | 03-02, 03-06, 03-07 | Confirmed additions write through source-config/companies path and export sourced rows | SATISFIED | Decision tests verify `companyAtsUpsert()` plus `sourcedUpsertBatch()` on approval and no writes for non-approval/refresh paths. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| - | - | None blocking | - | Stub/runtime/write-boundary scans found no blocker in Phase 03 production code. Matches in tests were expected setup/assertions; `startSession()` remains only in pre-existing discovery chat handoff routes outside the company-proposal slice. |

### Human Verification Required

None. The phase goal is API/core behavior and all behavior-dependent truths are exercised by automated tests that passed locally.

### Gaps Summary

No gaps found. Phase 03 achieves the Company Discovery API goal: AI is limited to structured seed suggestions, deterministic code owns ATS resolution/scanning/gating, proposals remain confirm-first, and confirmed writes flow through existing source-config and sourced persistence paths.

---

_Verified: 2026-07-05T00:59:54Z_
_Verifier: Codex (generic-agent fallback following gsd-verifier contract)_
