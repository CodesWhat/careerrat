---
phase: 09
slug: public-company-intelligence-and-scanner-cascade
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-05
---

# Phase 09 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node test runner (`node --test`) |
| **Config file** | `package.json` |
| **Quick run command** | `npm test -- tests/public-intel-*.test.mjs` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30-90 seconds |

---

## Sampling Rate

- **After every task commit:** Run the relevant focused `node --test tests/<feature>.test.mjs` command.
- **After every plan wave:** Run `npm test`.
- **Before `$gsd-verify-work`:** `npm test`, `npm run lint:placeholders`, and any planner-specified static route/runtime guard must be green.
- **Max feedback latency:** 90 seconds for focused tests, 5 minutes for full suite.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 0/1 | PUB-01, PUB-03 | T-09-private-leak | Public tables cannot carry candidate/private fields | unit/db | `node --test tests/public-intel-db.test.mjs` | W0 | pending |
| 09-01-02 | 01 | 0/1 | PUB-02 | T-09-private-leak | Scrub validator blocks PII, candidate context, tracker IDs, local paths, raw prompt/model/page body | unit | `node --test tests/public-intel-scrub.test.mjs` | W0 | pending |
| 09-01-03 | 01 | 0/1 | PUB-02, PUB-03 | T-09-public-sync-scope | Sync preview reads only `public_*` tables and contains metadata only | route/db | `node --test tests/public-intel-route.test.mjs` | W0 | pending |
| 09-02-01 | 02 | 1 | DSC-01, DSC-03 | T-09-untrusted-url | Supported ATS branch remains deterministic and does not call AI | unit | `node --test tests/public-scanner-cascade.test.mjs` | W0 | pending |
| 09-02-02 | 02 | 1 | DSC-01, DSC-02, DSC-03 | T-09-review-spam | Custom public page extraction records metadata/confidence and clean no-results silently | unit | `node --test tests/public-scanner-cascade.test.mjs` | W0 | pending |
| 09-03-01 | 03 | 1 | DSC-03, PUB-02 | T-09-ai-overuse | AI fallback runs only for ambiguous reachable public text, max one retry | unit | `node --test tests/public-scanner-ai.test.mjs` | W0 | pending |
| 09-03-02 | 03 | 1 | PUB-02, DSC-03 | T-09-model-authority | AI schema/provider/URL output cannot write until deterministic validation passes | unit | `node --test tests/public-scanner-ai.test.mjs` | W0 | pending |
| 09-04-01 | 04 | 2 | PUB-01, PUB-03, DSC-03 | T-09-runtime-bypass | Local discovery APIs do not call chat, skill runtime, or `/api/skill/run` for scanner/public writes | route/static | `node --test tests/public-intel-route.test.mjs` | W0 | pending |
| 09-04-02 | 04 | 2 | PUB-02 | T-09-consent | Onboarding sync preference defaults on and persists opt-out | route/ui | `node --test tests/onboard-public-sync.test.mjs` | W0 | pending |
| 09-05-01 | 05 | 2 | DSC-03 | T-09-review-conflict | Review decisions enforce expected version and keep unsupported metadata separate from source config | route/db | `node --test tests/public-intel-review.test.mjs` | W0 | pending |

*Status: pending · green · red · flaky*

---

## Wave 0 Requirements

- [ ] `tests/public-intel-db.test.mjs` - DB migration, public table separation, generated columns, indexes.
- [ ] `tests/public-intel-scrub.test.mjs` - private-field and payload scrub invariants.
- [ ] `tests/public-scanner-cascade.test.mjs` - deterministic scanner branch contracts.
- [ ] `tests/public-scanner-ai.test.mjs` - bounded-AI fallback gates and schema failure behavior.
- [ ] `tests/public-intel-route.test.mjs` - local API behavior and no runtime/chat bypass.
- [ ] `tests/onboard-public-sync.test.mjs` - onboarding preference API/UI hooks.
- [ ] `tests/public-intel-review.test.mjs` - review queue decision and conflict contracts.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual polish of onboarding sharing toggle and scanner review row | PUB-02, DSC-03 | Byte-static UI layout needs human screenshot judgment in addition to DOM hooks | Run tracker-dev, open onboarding/discovery surfaces, verify UI-SPEC spacing/copy/action labels |

All privacy, scanner, AI, DB, and route behaviors must have automated verification.

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all missing references.
- [x] No watch-mode flags.
- [x] Feedback latency target documented.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** pending
