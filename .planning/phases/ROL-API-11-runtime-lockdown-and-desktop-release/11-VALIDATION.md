---
phase: 11
slug: runtime-lockdown-and-desktop-release
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-06
---

# Phase 11 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node `node:test` built into the project Node runtime |
| **Config file** | none; package script runs `node --test 'tests/**/*.test.mjs'` |
| **Quick run command** | `node --test tests/skill-runtime.test.mjs tests/skill-run-route.test.mjs tests/desktop-routing.test.mjs tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~60-180 seconds for focused suites; repo-wide runtime depends on existing Phase 08 blockers |

---

## Sampling Rate

- **After every task commit:** Run `node --test tests/skill-runtime.test.mjs tests/skill-run-route.test.mjs tests/desktop-routing.test.mjs tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs`
- **After every plan wave:** Run focused Phase 11 suite plus touched slice tests.
- **Before `$gsd-verify-work`:** Run full focused Phase 11 suite. Run `npm test` only when upstream Phase 08 deep-ingest AI blockers are resolved; otherwise record that known blocker from `.planning/STATE.md`.
- **Max feedback latency:** 180 seconds for focused feedback.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 1 | SEC-01 | T-11-01 | App-default slices cannot add hidden `/api/skill/run` calls where local owners exist. | static/unit | `node --test tests/app-default-runtime-guard.test.mjs` | No - W0 | pending |
| 11-01-02 | 01 | 1 | SEC-01 | T-11-02 | Retained runtime/chat/debug/test references are allowed only when classified. | static/unit | `node --test tests/app-default-runtime-guard.test.mjs tests/db-app-shell-regression.test.mjs` | Partial - W0 | pending |
| 11-02-01 | 02 | 1 | SEC-02 | T-11-03 | `runSkillStream()` default tools exclude `Write`, `Edit`, and `Bash`. | unit | `node --test tests/skill-runtime.test.mjs` | Partial - update existing | pending |
| 11-02-02 | 02 | 1 | SEC-02 | T-11-04 | Tool-heavy execution is explicit and classified before broad tools are available. | unit/integration | `node --test tests/skill-runtime.test.mjs tests/skill-run-route.test.mjs` | Partial - update existing | pending |
| 11-03-01 | 03 | 2 | DESK-01 | T-11-05 | Fresh packaged workspace boots to `/app/onboarding`; existing candidate boots to `/app`. | unit/smoke | `node --test tests/desktop-routing.test.mjs tests/desktop-smoke.test.mjs` | Partial - extend existing | pending |
| 11-03-02 | 03 | 2 | DESK-01 | T-11-06 | Staged desktop runtime is self-contained and excludes private workspace/candidate data. | unit/static | `node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs` | Partial - extend existing | pending |
| 11-03-03 | 03 | 2 | DESK-01 | T-11-07 | macOS release config supports signing, hardened runtime, notarization, and verification commands. | static/manual | `node --test tests/desktop-package-resources.test.mjs` plus manual notarization verification | Partial - extend existing | pending |
| 11-04-01 | 04 | 2 | DESK-02 | T-11-08 | Pilot-facing docs teach the desktop `/app` workflow and do not present compatibility surfaces as normal. | static/docs | `node --test tests/release-safety.test.mjs tests/desktop-docs-release.test.mjs` | No - W0 | pending |

*Status: pending, green, red, flaky*

---

## Wave 0 Requirements

- [ ] `tests/app-default-runtime-guard.test.mjs` - covers SEC-01 slice-aware product/default runtime ban.
- [ ] `tests/desktop-docs-release.test.mjs` - covers DESK-02 pilot docs truthfulness.
- [ ] Extend `tests/skill-runtime.test.mjs` - cover app-safe default tools and explicit tool-heavy profile.
- [ ] Extend `tests/skill-run-route.test.mjs` - cover route config/profile behavior and unclassified tool-heavy rejection/classification.
- [ ] Extend `tests/desktop-package-resources.test.mjs` - cover signing/notarization config, entitlements, staged runtime completeness, and update-readiness checks.
- [ ] Extend `tests/desktop-smoke.test.mjs` or add a packaged-smoke helper - cover packaged fresh/existing workspace and recoverable failure behavior.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Developer ID notarization | DESK-01 | Apple notary service requires developer-account credentials outside source control. | Build the DMG, notarize with a local/CI keychain profile, staple, and run Gatekeeper assessment. Record exact commands and outcome in phase summary. |
| Packaged fresh/existing workspace smoke | DESK-01 | Full packaged app behavior may require local macOS app launch with isolated data roots. | Launch packaged app with fresh data root and existing candidate data root; verify `/app/onboarding` and `/app` routing plus no blank-window failure. |
| Update readiness claim | DESK-01 | Existing project has privacy-guarded `rolester update`; full auto-update may remain out of scope. | Verify docs and release UI do not claim auto-update exists unless implementation and release metadata support it. |

---

## Validation Sign-Off

- [ ] All tasks have automated verify commands or Wave 0 dependencies.
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify.
- [ ] Wave 0 covers all missing test references.
- [ ] No watch-mode flags.
- [ ] Feedback latency under 180 seconds for focused checks.
- [ ] `nyquist_compliant: true` set in frontmatter after Wave 0 exists and every mapped behavior has coverage.

**Approval:** pending
