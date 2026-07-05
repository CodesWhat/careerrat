---
phase: 04-runtime-routing
verified: 2026-07-05T02:56:09Z
status: passed
score: "15/15 must-haves verified"
behavior_unverified: 0
overrides_applied: 0
human_verification:

  - test: "Open the onboarding Companies step, create or load company proposals, try approve/reject/refresh/conflict/no-AI states, and review the proposal panel ergonomics."
    expected: "Proposal actions remain understandable, conflict/no-AI/manual states are clear, and local proposal errors do not feel like hidden chat or full-runtime handoffs."
    why_human: "04-VALIDATION.md marks proposal review ergonomics as manual-only; visual layout, interaction feel, and error-message clarity require human review."
---

# Phase 04: Runtime Routing Verification Report

**Phase Goal:** Make the app use the cheapest correct runtime path by default.
**Verified:** 2026-07-05T02:56:09Z
**Status:** passed
**Re-verification:** No - initial verification

## User Flow Coverage

MVP mode note: roadmap mode is `mvp`, but the phase goal is not in formal user-story syntax. `user-story.validate` returned invalid, so this coverage is derived from the roadmap success criteria and Phase 04 plan truths.

| Step | Expected | Evidence | Status |
| --- | --- | --- | --- |
| Load onboarding | App loads runtime capability metadata before steps choose AI/chat/full-runtime controls. | `getRuntimeConfig()` wraps `/api/runtime/config` in `apps/web/src/lib/api.js:136`; `loadOnboardingRuntimeState()` loads state plus runtime config in `apps/web/src/onboarding/OnboardingPage.jsx:93`; props are passed at `OnboardingPage.jsx:193`. | VERIFIED |
| Use Companies discovery | Primary Companies controls create/read local proposal batches, not a whole skill session. | `createCompanyProposals()` and `getCompanyProposals()` hit `/api/discovery/company-proposals` in `api.js:140`; CompaniesStep primary panel calls `runCompanyProposalCreate()`/`runCompanyProposalRead()` in `CompaniesStep.jsx:415`; focused test proves no `/api/skill/run` call in `CompaniesStep.test.jsx:127`. | VERIFIED |
| Decide proposals | User can approve/reject/suppress/escalate/refresh with expected-version protection. | `runCompanyProposalDecision()` sends `batchId`, `proposalId`, `action`, `expectedVersion` in `CompaniesStep.jsx:257`; backend validates actions and versions in `company-proposal-decisions.mjs:77` and `:141`; tests cover success, conflict, invalid approval, and rejected states. | VERIFIED |
| Choose agent-led discovery | Chat handoffs remain explicit and visible only after user action. | `/api/discovery/quick-start` and `/api/discovery/next` start/reuse chat in `discovery-route.mjs:287` and `:330`; FinishStep only renders ChatPanel from returned chat state in `FinishStep.jsx:166`; tests gate CTAs by `runtimeCapabilities.discoveryChatHandoffs`. | VERIFIED |
| Degrade unavailable AI | UI hides/degrades chat/full AI controls while leaving local/manual discovery available. | Runtime config exposes `ai`, `skills`, `chatSkills`, and `discovery` in `skill-run-route.mjs:139`; `deriveRuntimeCapabilities()` keeps local/manual true while disabling AI/chat on no route in `OnboardingPage.jsx:74`; tests cover proxy and no-AI cases. | VERIFIED |
| Outcome | Cheapest correct runtime path is the documented and tested default. | Routing policy names local proposals as default and retained chat/full runtimes as explicit paths in `.planning/architecture/runtime-routing-policy.md:7`; public architecture docs repeat the split in `docs/ARCHITECTURE.md:83`. | VERIFIED |

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | App discovery controls call the new company discovery API instead of starting a whole skill session. | VERIFIED | CompaniesStep local proposal panel calls wrappers to `/api/discovery/company-proposals`; route tests assert no `runSkillStream`, no chat start, and no confirmed writes during proposal generation. |
| 2 | `POST /api/skill/run` remains documented, allowlisted, and available for flows that still need agent tools. | VERIFIED | `mountSkillRunRoute()` still mounts `POST /api/skill/run` in `src/cli/skill-run-route.mjs:159`; `runSkillStream()` enforces `resolveAllowedSkills()` before SDK load at `skill-runtime.mjs:432`; tests cover allowlist, body cap, SSE, abort, no-AI, SDK missing. |
| 3 | Discovery chat handoffs remain available for users who want an agent-led workflow. | VERIFIED | `discovery-route.mjs` starts/reuses chat only through explicit quick-start/next routes; FinishStep gates CTAs by runtime capability and renders `ChatPanel` only from returned chat data. |
| 4 | Runtime config exposes enough capability information for UI unavailable-AI degradation. | VERIFIED | `GET /api/runtime/config` returns `skills`, `chatSkills`, `ai.available`, `ai.route`, and discovery booleans without invoking `runSkillStream`; Onboarding derives and propagates booleans centrally. |
| 5 | Runtime config reports one-shot skill, chat skill, AI route, and discovery state without starting runtime sessions. | VERIFIED | `tests/skill-run-route.test.mjs:83` asserts full payload and `called === false` for injected `runSkillStream`. |
| 6 | Existing pages that read `body.skills` keep working after the capability payload expands. | VERIFIED | Plan artifact checks and focused runtime/page tests pass; `skills` remains top-level at `skill-run-route.mjs:145`. |
| 7 | Onboarding loads runtime capability data instead of inferring AI/chat availability only from the onboarding key flag. | VERIFIED | `loadOnboardingRuntimeState()` calls `getState` then `getRuntime`; tests assert one call each and derive from runtime config. |
| 8 | A managed proxy AI route can enable AI controls even when `state.keyConfigured` is false. | VERIFIED | `deriveRuntimeCapabilities()` ignores the key flag and uses `runtimeConfig.ai.available`; `OnboardingPage.test.jsx:30` covers proxy availability with `keyConfigured: false`. |
| 9 | No-AI mode still leaves local/manual discovery capability available to child steps. | VERIFIED | Defaults set `companyProposals` and `manualCompanySeeds` true unless explicitly false; no-AI test covers local/manual availability. |
| 10 | Manual company seeds can create local proposals with no chat or retained full-skill runtime. | VERIFIED | `proposalSeedsFromCompanies()` maps shortlist seeds; route test `POST /api/discovery/company-proposals creates a persisted manual-seed proposal batch without confirmed writes` asserts no chat start and no `runSkillStream`. |
| 11 | Users can approve, reject, suppress, escalate, or refresh company proposals from the local Companies step. | VERIFIED | CompaniesStep renders all actions in `CompaniesStep.jsx:160`; decision route supports the same set in `company-proposal-decisions.mjs:19`; component and route tests cover actions. |
| 12 | Every proposal decision sends `proposalId`, `batchId`, `action`, and `expectedVersion` to the Phase 3 decision route. | VERIFIED | `runCompanyProposalDecision()` payload includes all four fields; component test asserts exact payload. |
| 13 | Conflict and no-AI/manual states are visible and do not silently hand off to chat/full skill runtime. | VERIFIED | Conflict path returns local refresh-needed outcome in `CompaniesStep.jsx:283`; tests assert no ChatPanel render on conflict and local failures. No-AI local/manual capability tests pass. |
| 14 | Docs identify local company proposals as default app path, discovery chat as explicit agent-led workflow, and `POST /api/skill/run` as retained allowlisted full runtime. | VERIFIED | `.planning/architecture/runtime-routing-policy.md:75` and `docs/ARCHITECTURE.md:97` document local default; retained chat/full paths are documented at policy lines 84-89 and docs lines 116-129. |
| 15 | Regression commands cover runtime config, CompaniesStep local routing, FinishStep handoffs, and Phase 3 proposal routes together. | VERIFIED | Fresh verifier runs passed: backend 89 pass, 2 skipped live integrations; frontend 29 pass. |

**Score:** 15/15 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/cli/skill-run-route.mjs` | Runtime config and retained full skill route | VERIFIED | GET config uses one-shot/chat allowlists and AI route; POST remains capped SSE route. |
| `tests/skill-run-route.test.mjs` | Runtime config and POST regression tests | VERIFIED | Covers config payload, no runtime start, body validation, statuses, SSE, abort. |
| `src/core/ai/skill-runtime.mjs` | One-shot runtime allowlist and stream driver | VERIFIED | `resolveAllowedSkills()` and pre-SDK validation preserved. |
| `src/core/ai/chat-runtime.mjs` | Conversational runtime allowlist and sessions | VERIFIED | `resolveAllowedChatSkills()` includes discovery skills; session start validates no-AI/SDK before registration. |
| `src/cli/discovery-route.mjs` | Local proposal and explicit handoff routes | VERIFIED | Proposal create/read/decision routes are separate from quick-start/next chat routes. |
| `apps/web/src/lib/api.js` | API wrappers | VERIFIED | Runtime, proposal, decision, and handoff wrappers point to expected routes. |
| `apps/web/src/onboarding/OnboardingPage.jsx` and test | Capability loading and propagation | VERIFIED | Derivation/loading helpers tested. |
| `apps/web/src/onboarding/steps/CompaniesStep.jsx` and test | Local proposal default and decision UI | VERIFIED | Primary local panel plus secondary chat only when capability true. |
| `apps/web/src/onboarding/steps/FinishStep.jsx` and test | Explicit discovery handoff gating | VERIFIED | Quick-start/next handoff helpers and capability gating tested. |
| `.planning/architecture/runtime-routing-policy.md` | Project routing policy | VERIFIED | Phase 4 route split documented. |
| `docs/ARCHITECTURE.md` | Public architecture docs | VERIFIED | Local, bounded AI, chat, and retained runtime layers documented. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `src/cli/skill-run-route.mjs` | `src/core/ai/skill-runtime.mjs` | `resolveAllowedSkills()` | VERIFIED | GSD key-link query passed; code import at line 33 and use at line 141. |
| `src/cli/skill-run-route.mjs` | `src/core/ai/chat-runtime.mjs` | `resolveAllowedChatSkills()` | VERIFIED | Import/use at lines 32 and 142. |
| `src/cli/skill-run-route.mjs` | `src/core/ai/call-ai.mjs` | `resolveAIRoute()` | VERIFIED | Import/use at lines 31 and 143. |
| `OnboardingPage.jsx` | `api.js` | `getRuntimeConfig()` | VERIFIED | Loader uses API wrapper and passes runtime capabilities to all steps. |
| `CompaniesStep.jsx` | `api.js` | Proposal create/read/decision wrappers | VERIFIED | Helper functions call wrappers; tests assert exact route paths. |
| `api.js` | `discovery-route.mjs` | `/api/discovery/company-proposals`, `/api/discovery/company-proposal-decisions` | VERIFIED | App wrapper paths match backend route mounts. |
| `FinishStep.jsx` | `api.js` and `ChatPanel.jsx` | `startDiscoveryQuickStart`, `startDiscoveryNext`, returned chat render | VERIFIED | ChatPanel renders only after explicit handoff response. |
| `docs/ARCHITECTURE.md` | `.planning/architecture/runtime-routing-policy.md` | Same route class language | VERIFIED | Both docs name local default, explicit chat handoff, retained full skill runtime. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| Runtime config route | `skills`, `chatSkills`, `ai`, `discovery` | `.agents/skills`, env allowlists, `resolveAIRoute()` | Yes | FLOWING |
| OnboardingPage | `runtimeCapabilities` | `getRuntimeConfig()` then `deriveRuntimeCapabilities()` | Yes | FLOWING |
| CompaniesStep | `proposalBatch`, `manualSeeds`, decision outcome | User shortlist plus local proposal/decision API responses | Yes | FLOWING |
| Discovery routes | Proposal batches and decisions | Phase 3 core modules plus DB verbs | Yes | FLOWING |
| FinishStep | `discoveryGuidance`, `discoveryChat` | Dashboard guidance plus quick-start/next API responses | Yes | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Phase 04 backend route/runtime gate | `node --test tests/discovery-route.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs` | 89 pass, 2 skipped live integrations, 0 fail | PASS |
| Phase 04 frontend gate | `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx src/onboarding/steps/FinishStep.test.jsx src/onboarding/OnboardingPage.test.jsx` | 29 pass, 0 fail | PASS |
| Static retained route scan | `rg -n "/api/skill/run" ...` | POST route present in `skill-run-route.mjs`; no CompaniesStep production caller | PASS |
| Static local proposal scan | `rg -n "company-proposals|company-proposal-decisions" ...` | App wrappers and backend tests reference Phase 3 routes | PASS |
| MVP goal format guard | `node ... user-story.validate --story "Make the app use the cheapest correct runtime path by default." --raw` | Invalid formal user-story syntax; report uses roadmap-derived flow coverage | NOTE |

### Probe Execution

No phase-declared or conventional `scripts/*/tests/probe-*.sh` probes were found for Phase 04.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| RUNT-01 | 04-01, 04-05 | `POST /api/skill/run` remains allowlisted and documented for tool-heavy or long-running workflows. | SATISFIED | POST route and `runSkillStream()` allowlist preserved; backend tests passed; docs updated. |
| RUNT-02 | 04-02, 04-03, 04-04, 04-05 | App discovery controls call local API routes for deterministic or bounded-AI work instead of whole skill sessions. | SATISFIED | CompaniesStep wrappers call proposal routes; proposal and decision tests cover no hidden chat/full runtime. |
| RUNT-03 | 04-01, 04-02, 04-03, 04-05 | Conversational agent handoffs still have clear prompt/spec path for agent-led workflows. | SATISFIED | Discovery quick-start/next handoff routes and FinishStep chat rendering remain tested and capability-gated. |

### Anti-Patterns Found

None blocking. Static scans found only ordinary React null-render guards, UI placeholder attributes, and existing explanatory comments; no unreferenced `TBD`, `FIXME`, or `XXX` debt markers in the verified Phase 04 files.

### Disconfirmation Notes

- Partial requirement checked: no-AI degradation is covered beyond config shape; UI keeps local/manual proposals available and hides chat/full AI affordances.
- Potentially misleading test checked: wrapper tests assert exact local route URLs and negative `/api/skill/run`, while backend route tests assert `runSkillStream` is not called for proposal generation.
- Error path checked: stale proposal versions produce local conflict handling; invalid approvals fail closed; live Agent SDK integration tests are skipped without `ANTHROPIC_API_KEY`.

### Human Verification Completed

#### 1. Proposal Review Ergonomics

**Test:** Open the onboarding Companies step, create or load proposals, reject/approve/refresh a proposal, and inspect conflict/no-AI/manual states.
**Expected:** The proposal review panel is understandable, action affordances are clear, conflict/no-AI messages are readable, and no local error appears to launch chat or full runtime.
**Result:** Passed in `04-UAT.md` through desktop and mobile Playwright browser UAT. The UAT covered local proposal create/read, approve/reject/suppress/escalate/refresh controls, stale-version conflict handling, refresh recovery, no-AI/manual availability, and verified no `/api/skill/run` calls. The pass found mobile proposal-action overflow; the UI was fixed and rerun successfully.

### Gaps Summary

No implementation gaps found. Automated must-haves are verified, and the manual proposal-review ergonomics checkpoint passed after the mobile overflow fix.

### Limitations

- `npm test` was intentionally not used as a signal because `tests/release-safety.test.mjs` is pre-existing dirty/unrelated in this worktree. Focused backend/frontend gates were used instead.
- Prior phase focused regressions were supplied by the orchestrator and were not rerun during this verifier pass.

---

_Verified: 2026-07-05T02:56:09Z_
_Verifier: Claude (gsd-verifier)_
