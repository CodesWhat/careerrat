---
phase: 7
slug: quick-onboarding-and-auto-sourcing
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-05
---

# Phase 7 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Backend framework** | Node `node:test` under Node `v24.18.0` |
| **Frontend framework** | Vitest `3.2.6` with React `19.2.7` |
| **Config file** | `apps/web/vite.config.js` |
| **Quick backend run** | `node --test tests/onboard-route.test.mjs tests/search-route.test.mjs tests/scan-sourced.test.mjs tests/db-migrations.test.mjs` |
| **Quick frontend run** | `npm --workspace apps/web run test -- FinishStep.test.jsx OnboardingPage.test.jsx SetupReadinessCard.test.jsx` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | Repo-dependent; use targeted commands after each task and full suite at phase gate |

---

## Sampling Rate

- **After every backend task commit:** Run the relevant targeted `node --test` command for changed modules.
- **After every frontend task commit:** Run the relevant Vitest file through `npm --workspace apps/web run test -- <file>`.
- **After every plan wave:** Run both targeted backend and frontend commands listed above.
- **Before `$gsd-verify-work`:** `npm test` must be green, or any failure must be captured as a blocking verification gap.
- **Max feedback latency:** No more than one task commit should land without a matching targeted automated check.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 07-W0-01 | TBD | 0 | RUN-01, RUN-02 | T-07-05 / T-07-06 | DB run state is durable and idempotent | migration + unit | `node --test tests/db-migrations.test.mjs tests/sourcing-runs.test.mjs` | missing W0 | pending |
| 07-W0-02 | TBD | 0 | ONB-02 | T-07-01 / T-07-02 / T-07-03 / T-07-04 | DOCX upload is capped, sanitized, raw-text only, and quality gated | route + unit | `node --test tests/onboard-route.test.mjs` | existing plus missing fixture cases | pending |
| 07-W0-03 | TBD | 0 | RUN-01 | T-07-07 | First search uses DB source config and deterministic unauthenticated sources only | route + scanner | `node --test tests/search-route.test.mjs tests/scan-sourced.test.mjs` | existing plus new cases | pending |
| 07-W0-04 | TBD | 0 | RUN-02 | T-07-08 | React shows durable first-search task status and errors after reload | component | `npm --workspace apps/web run test -- FinishStep.test.jsx SetupReadinessCard.test.jsx` | existing plus new cases | pending |
| 07-W0-05 | TBD | 0 | RUN-02 | T-07-08 | Jobs page shows manual `Search jobs` only after DB source setup exists | component | `npm --workspace apps/web run test -- JobsPage` | missing W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `tests/sourcing-runs.test.mjs` - status transitions, idempotency, and persisted error/summary JSON.
- [ ] `tests/db-migrations.test.mjs` additions - `sourcing_runs` migration is applied in order and is re-runnable.
- [ ] DOCX fixture coverage in `tests/onboard-route.test.mjs` - valid DOCX, empty/garbled DOCX, oversized DOCX, and no-AI path.
- [ ] `apps/web/src/onboarding/steps/ResumeStep.test.jsx` - DOCX accept path and fallback copy.
- [ ] `apps/web/src/onboarding/steps/FinishStep.test.jsx` updates - first search does not return `chat`, `chatId`, `nextSkill`, `research-boards`, or `search-jobs`.
- [ ] `apps/web/src/jobs/FunnelSankey.test.jsx` or a new Jobs-page test - `Search jobs` visibility after `/api/search/sources` reports DB source setup.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| First-run onboarding flow feels like a setup task, not a nagging reminder | RUN-02 | Automated tests can verify state and copy, but not product feel | Run `careerrat tracker-dev`, complete quick onboarding to `search_ready`, confirm the first-search row/card uses `Not started`, `Running`, `Completed`, or `Failed` and returns the user to deeper onboarding. |
| Search cadence recommendation is transparent when no data exists | ONB-01 | Requires reading UX copy in context | In a fresh DB workspace, inspect the cadence prompt and confirm any recommendation is framed as a default unless backed by local/source history. |

---

## Validation Sign-Off

- [ ] All tasks have automated verify commands or Wave 0 dependencies.
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify.
- [ ] Wave 0 covers every missing test file and fixture named above.
- [ ] No watch-mode flags in verification commands.
- [ ] Full `npm test` passes before phase verification.
- [ ] `nyquist_compliant: true` set in frontmatter after Wave 0 is complete and automated coverage is confirmed.

**Approval:** pending
