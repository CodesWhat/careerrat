---
phase: 04
slug: runtime-routing
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-05
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Backend: Node `node:test`; Frontend: Vitest via `apps/web` |
| **Config file** | Backend: none for `node --test`; Frontend: Vite/Vitest workspace config |
| **Quick run command** | `node --test tests/discovery-route.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs` |
| **Frontend focused command** | `npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/onboarding/steps/CompaniesStep.test.jsx` |
| **Full suite command** | `npm test && npm --workspace apps/web run test` |
| **Estimated runtime** | Quick backend under 10s; focused frontend under 10s; full suite project-dependent |

---

## Sampling Rate

- **After every backend route/runtime task commit:** run the quick backend command, narrowed further when only one surface changed.
- **After every frontend task commit:** run the frontend focused command for the touched onboarding step(s).
- **After every plan wave:** run the quick backend command plus focused frontend tests.
- **Before `$gsd-verify-work`:** run full backend and frontend suites where feasible; if unrelated pre-existing tests are dirty or failing, record the exact unaffected focused gates.
- **Max feedback latency:** one task commit.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | RUNT-01 | route-allowlist | Retained full skill runtime stays allowlisted, capped, and explicit. | backend | `node --test tests/skill-run-route.test.mjs tests/skill-runtime.test.mjs` | ✅ | ⬜ pending |
| 04-01-02 | 01 | 1 | RUNT-01/RUNT-03 | capability-gating | Runtime config exposes one-shot, chat, AI-route, and discovery capabilities without starting runtime sessions. | backend | `node --test tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs` | ✅ | ⬜ pending |
| 04-02-01 | 02 | 2 | RUNT-02 | route-escalation | App API wrappers call company proposal and decision routes directly, not chat or full skill runtime. | frontend/backend | `node --test tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs` plus focused wrapper/component tests | ⚠️ W0 | ⬜ pending |
| 04-03-01 | 03 | 3 | RUNT-02 | hidden-chat | Default company discovery UI uses local proposals and does not render/start `ChatPanel skill="discover-companies"` as the primary path. | frontend | `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` | ❌ W0 | ⬜ pending |
| 04-04-01 | 04 | 4 | RUNT-02 | decision-conflict | Proposal decisions send expectedVersion and surface conflict/no-AI states without hidden chat escalation. | frontend | `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` | ❌ W0 | ⬜ pending |
| 04-05-01 | 05 | 5 | RUNT-01/RUNT-02/RUNT-03 | docs-drift | Docs and regression gates describe local default, explicit chat handoff, and retained full skill runtime consistently after decision wiring lands. | docs/tests | `node --test tests/discovery-route.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs && npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/onboarding/steps/CompaniesStep.test.jsx` | ⚠️ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ missing initial test/file.*

---

## Wave 0 Requirements

- [ ] `apps/web/src/onboarding/steps/CompaniesStep.test.jsx` — proves the default company discovery control calls proposal APIs and leaves chat as an explicit secondary path.
- [ ] `apps/web/src/lib/api.js` proposal wrapper coverage — either through `CompaniesStep.test.jsx` or a small API-wrapper unit if the project adds one.
- [ ] `tests/skill-run-route.test.mjs` runtime-config assertions — proves the expanded capability payload is stable and read-only.
- [ ] Route/doc assertions for retained `POST /api/skill/run` and explicit discovery chat handoffs.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Proposal review ergonomics | RUNT-02 | Visual layout and interaction feel need human review after automated component tests pass. | Open the onboarding companies step, create/read proposals, reject/approve/refresh a proposal, and confirm conflict/no-AI states are understandable. |

---

## Validation Sign-Off

- [x] All tasks have an automated verification path or a Wave 0 dependency.
- [x] Sampling continuity: no 3 consecutive tasks without automated verification.
- [x] Wave 0 covers all missing test references.
- [x] No watch-mode flags.
- [x] Feedback latency target is one task commit.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** pending
