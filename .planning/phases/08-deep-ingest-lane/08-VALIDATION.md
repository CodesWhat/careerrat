---
phase: 08
slug: deep-ingest-lane
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-05
---

# Phase 08 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Backend `node:test`; frontend Vitest |
| **Config file** | Backend: none; frontend: existing Vite/Vitest workspace config |
| **Quick run command** | `node --test tests/deep-ingest-*.test.mjs tests/bounded-ai.test.mjs` |
| **Full suite command** | `npm test && npm --workspace apps/web run test && npm run app:build` |
| **Estimated runtime** | ~90 seconds quick, ~5 minutes full |

---

## Sampling Rate

- **After every task commit:** Run `node --test tests/deep-ingest-*.test.mjs tests/bounded-ai.test.mjs` plus any touched frontend Vitest file.
- **After every plan wave:** Run `npm test && npm --workspace apps/web run test`.
- **Before `$gsd-verify-work`:** Run `npm test && npm --workspace apps/web run test && npm run app:build`.
- **Max feedback latency:** 5 minutes for full wave feedback.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-W0-01 | TBD | 0 | ING-01 | T-08-URL / T-08-DOS | Source caps and unsafe/unreadable source outcomes are explicit. | unit/integration | `node --test tests/deep-ingest-source-scanner.test.mjs tests/deep-ingest-route.test.mjs` | no W0 | pending |
| 08-W0-02 | TBD | 0 | ING-02 | T-08-FAB / T-08-REVIEW | Unconfirmed proposals never write trusted candidate state. | unit/integration | `node --test tests/deep-ingest-db.test.mjs tests/deep-ingest-ai.test.mjs tests/story-bank.test.mjs tests/writing-style.test.mjs` | no W0 | pending |
| 08-W0-03 | TBD | 0 | ING-03 | T-08-NOAI / T-08-INJECTION | Bounded extraction has manual fallback and no chat/interview UI. | unit/frontend | `node --test tests/deep-ingest-ai.test.mjs && npm --workspace apps/web run test -- src/deep-ingest/DeepIngestPage.test.jsx src/onboarding/steps/FinishStep.test.jsx` | no W0 | pending |
| 08-W0-04 | TBD | 0 | ING-04 | T-08-STATE | Lane terminality drives `deep_ingest_complete` independently from sourcing readiness. | unit/integration/frontend | `node --test tests/deep-ingest-db.test.mjs tests/db-verbs.test.mjs tests/data-route.test.mjs && npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx src/library/LibraryPage.test.jsx` | partial W0 | pending |

*Status: pending, green, red, flaky.*

---

## Wave 0 Requirements

- [ ] `tests/deep-ingest-db.test.mjs` - DB schema, proposal confirmation, defer/not-available state, and `deep_ingest_complete` terminality.
- [ ] `tests/deep-ingest-route.test.mjs` - no-DB 409, source create/list/decision behavior, body caps, and source outcome persistence.
- [ ] `tests/deep-ingest-ai.test.mjs` - bounded AI schema validation, grounding checks, `NO_AI_ROUTE` manual fallback, and privacy/honesty guard behavior.
- [ ] `tests/deep-ingest-source-scanner.test.mjs` - paste/text/URL/repo/local-path scan limits plus too-large, login-gated, unsupported, and truncated outcomes.
- [ ] `apps/web/src/deep-ingest/DeepIngestPage.test.jsx` - target selector, source submit, review queue, source preview, proposal editor, manual fallback, no chat copy.
- [ ] `apps/web/src/onboarding/steps/FinishStep.test.jsx` - Deep ingest/form flow replaces any required AI interview assumption for Phase 8.
- [ ] `apps/web/src/library/LibraryPage.test.jsx` - Library reads DB-backed evidence/story/voice/deep-ingest state and exposes target-shaped add/ingest flow.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual responsive polish for the Deep ingest workspace | ING-01, ING-03 | Automated tests can assert controls and states but not final layout density across viewports. | Run the app, inspect desktop and mobile widths, confirm no nested cards, no chat/interview UI, no overlapping controls, and source/proposal panels remain usable. |
| Real public URL/repo scan behavior | ING-01 | Network content varies and should not make unit tests flaky. | Use one small public URL and one public repo fixture during manual QA; verify bounded scan, source artifact, proposal/gap row, and retry/manual fallback behavior. |

---

## Validation Sign-Off

- [ ] All tasks have automated verify commands or Wave 0 dependencies.
- [ ] Sampling continuity: no 3 consecutive tasks without automated verification.
- [ ] Wave 0 covers all missing deep-ingest test files.
- [ ] No watch-mode flags in verification commands.
- [ ] Feedback latency under 5 minutes for full wave feedback.
- [ ] `nyquist_compliant: true` set in frontmatter after Wave 0 tests exist and pass.

**Approval:** pending
