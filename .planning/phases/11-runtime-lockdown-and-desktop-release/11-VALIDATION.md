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
| **Quick run command** | `node --test tests/app-default-runtime-guard.test.mjs tests/skill-runtime.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/desktop-runtime.test.mjs tests/desktop-routing.test.mjs tests/desktop-smoke.test.mjs tests/desktop-package-resources.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs tests/desktop-docs-release.test.mjs tests/release-safety.test.mjs` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~60-180 seconds for focused suites; repo-wide runtime depends on existing Phase 08 blockers |

---

## Sampling Rate

- **After every task commit:** Run the task-local command from the map below, plus any adjacent focused suite listed in the plan.
- **After every plan wave:** Run focused Phase 11 suite plus touched slice tests.
- **Before `$gsd-verify-work`:** Run full focused Phase 11 suite. Run `npm test` only when upstream Phase 08 deep-ingest AI blockers are resolved; otherwise record that known blocker from `.planning/STATE.md`.
- **Max feedback latency:** 180 seconds for focused feedback.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 1 | SEC-01 | T-11-01, T-11-02 | App-default slices cannot add hidden retained-runtime calls and retained runtime/chat/debug/test references are allowed only when classified. | static/unit | `node --test tests/app-default-runtime-guard.test.mjs tests/db-app-shell-regression.test.mjs tests/quick-onboarding-auto-sourcing-regression.test.mjs` | No - created by plan | pending |
| 11-02-01 | 02 | 1 | SEC-02 | T-11-03, T-11-04, T-11-05 | `runSkillStream()` defaults to app-safe tools, excludes mutation/shell tools, preserves narrow overrides, and exposes explicit tool-heavy profile tests. | unit | `node --test tests/skill-runtime.test.mjs` | Partial - update existing | pending |
| 11-02-02 | 02 | 1 | SEC-02 | T-11-03, T-11-04, T-11-05 | Runtime profile helper and `runSkillStream()` implementation make broad tools opt-in by named profile only. | unit | `node --test tests/skill-runtime.test.mjs` | Partial - update existing | pending |
| 11-03-01 | 03 | 2 | SEC-02 | T-11-06, T-11-07, T-11-08 | Runtime config exposes non-secret profile metadata; unclassified tool-heavy POSTs fail before streaming; chat uses explicit profile classification. | unit/integration | `node --test tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs` | Partial - update existing | pending |
| 11-03-02 | 03 | 2 | SEC-02 | T-11-06, T-11-07, T-11-08 | Retained runtime route/session code validates named tool-heavy and chat profiles without changing existing stream/abort/status behavior. | unit/integration | `node --test tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs` | Partial - update existing | pending |
| 11-04-01 | 04 | 1 | DESK-01 | T-11-09, T-11-10, T-11-11 | Desktop tests pin packaged `ROLESTER_HOME`, SQLite DB migration state, BYOK key storage path/mode, first-run routing, external-link policy, and smoke failures. | unit/smoke | `node --test tests/desktop-runtime.test.mjs tests/desktop-smoke.test.mjs tests/desktop-routing.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs` | Mixed - create/extend | pending |
| 11-04-02 | 04 | 1 | DESK-01 | T-11-09, T-11-10, T-11-11 | Electron main wires packaged data root before DB/ai-env imports and opens external URLs only through the safe helper. | unit/smoke | `node --test tests/desktop-runtime.test.mjs tests/desktop-smoke.test.mjs tests/desktop-routing.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs` | Mixed - create/extend | pending |
| 11-05-01 | 05 | 2 | DESK-01 | T-11-12, T-11-13, T-11-14 | Package tests pin force signing, hardened runtime, entitlements, real notarization config, no credential literals, and private-data exclusions. | static/unit | `node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs` | Partial - extend existing | pending |
| 11-05-02 | 05 | 2 | DESK-01 | T-11-12, T-11-13, T-11-14 | electron-builder config and entitlements support signed/notarized pilot DMG without tracked Apple credentials. | static/unit | `node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs` | Partial - extend existing | pending |
| 11-05-03 | 05 | 2 | DESK-01 | T-11-12, T-11-13 | Notarization credential readiness is checked through non-destructive `notarytool` profile history or blocks with exact setup instructions. | static/manual | `xcrun notarytool history --keychain-profile rolester-notary --limit 1` | External credential checkpoint | pending |
| 11-06-01 | 06 | 3 | DESK-02, SEC-01, SEC-02 | T-11-15, T-11-16, T-11-17 | Docs guard pins app-first desktop workflow, compatibility-surface wording, notarization posture, update-readiness truth, and runtime-lockdown wording. | static/docs | `node --test tests/desktop-docs-release.test.mjs` | No - created by plan | pending |
| 11-06-02 | 06 | 3 | DESK-02, SEC-01, SEC-02 | T-11-15, T-11-16, T-11-17 | Desktop README, release checklist, and architecture docs are pilot-accurate and credential-neutral. | static/docs | `node --test tests/desktop-docs-release.test.mjs tests/release-safety.test.mjs && npm run lint:placeholders` | Mixed - create/update | pending |
| 11-07-01 | 07 | 4 | SEC-01, SEC-02, DESK-01, DESK-02 | T-11-18, T-11-20 | Final rollup records focused Phase 11 commands, requirement evidence, packaged DB/BYOK checks, and unrelated repo-wide blockers separately. | rollup | `node --test tests/app-default-runtime-guard.test.mjs tests/skill-runtime.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/desktop-runtime.test.mjs tests/desktop-routing.test.mjs tests/desktop-smoke.test.mjs tests/desktop-package-resources.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs tests/desktop-docs-release.test.mjs tests/release-safety.test.mjs && npm run lint:placeholders` | Rollup created by plan | pending |
| 11-07-02 | 07 | 4 | DESK-01 | T-11-19, T-11-20 | Signed/notarized DMG evidence, Gatekeeper assessment, code-sign verification, fresh/existing packaged smoke, DB path, and BYOK path are recorded without secrets. | static/manual | `npm --workspace apps/desktop run stage && node --test tests/desktop-package-resources.test.mjs tests/desktop-runtime.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs` | External credential checkpoint | pending |

*Status: pending, green, red, flaky*

---

## Planned Test Additions and Extensions

- [ ] `tests/app-default-runtime-guard.test.mjs` - covers SEC-01 slice-aware product/default runtime ban.
- [ ] `tests/desktop-docs-release.test.mjs` - covers DESK-02 pilot docs truthfulness.
- [ ] Extend `tests/skill-runtime.test.mjs` - cover app-safe default tools and explicit tool-heavy profile.
- [ ] Extend `tests/skill-run-route.test.mjs` - cover route config/profile behavior and unclassified tool-heavy rejection/classification.
- [ ] Extend `tests/chat-runtime.test.mjs` - cover explicit chat runtime profile classification.
- [ ] Add `tests/desktop-runtime.test.mjs` - cover packaged `ROLESTER_HOME`, DB migration state, BYOK path/mode, external-link policy, and runtime path helpers.
- [ ] Extend `tests/desktop-package-resources.test.mjs` - cover signing/notarization config, entitlements, staged runtime completeness, and update-readiness checks.
- [ ] Extend `tests/desktop-smoke.test.mjs` or add a packaged-smoke helper - cover packaged fresh/existing workspace and recoverable failure behavior.
- [ ] Extend `tests/ai-env.test.mjs` and reuse `tests/db-migrations.test.mjs` - cover `ai-env` and migration behavior under packaged `ROLESTER_HOME`.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Developer ID notarization | DESK-01 | Apple notary service requires developer-account credentials outside source control. | Build the DMG, notarize with a local/CI keychain profile, staple, and run Gatekeeper assessment. Record exact commands and outcome in phase summary. |
| Packaged fresh/existing workspace smoke | DESK-01 | Full packaged app behavior may require local macOS app launch with isolated data roots. | Launch packaged app with fresh data root and existing candidate data root; verify `/app/onboarding` and `/app` routing, `<ROLESTER_HOME>/db/rolester.db` migration state, `<ROLESTER_HOME>/internal/ai.env` BYOK path shape, and no blank-window failure. |
| Update readiness claim | DESK-01 | Existing project has privacy-guarded `rolester update`; full auto-update may remain out of scope. | Verify docs and release UI do not claim auto-update exists unless implementation and release metadata support it. |

---

## Validation Sign-Off

- [ ] All tasks have automated verify commands or planned test dependencies.
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify.
- [ ] Planned test additions cover all missing test references.
- [ ] No watch-mode flags.
- [ ] Feedback latency under 180 seconds for focused checks.
- [ ] `nyquist_compliant: true` set in frontmatter after every mapped behavior has coverage.

**Approval:** pending
