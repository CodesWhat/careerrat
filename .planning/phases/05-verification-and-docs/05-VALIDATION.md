---
phase: 05
slug: verification-and-docs
status: ready
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-05
---

# Phase 05 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node test runner + Vitest |
| **Config file** | `package.json`, `apps/web/package.json` |
| **Quick run command** | `node --test tests/company-discovery-regression.test.mjs tests/company-discovery-seeds.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/decomposition-map.test.mjs` |
| **Full suite command** | `node --test tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs tests/assist-route.test.mjs tests/onboard-route.test.mjs tests/intake-classify.test.mjs tests/company-discovery-regression.test.mjs tests/company-discovery-seeds.test.mjs tests/company-discovery-cache-db.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/discovery-route.test.mjs tests/db-source-config.test.mjs tests/companies-cli.test.mjs tests/scan-sourced.test.mjs tests/search-route.test.mjs tests/sourced-scanner.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs tests/decomposition-map.test.mjs && npm --workspace apps/web run test -- src/onboarding/OnboardingPage.test.jsx src/onboarding/steps/CompaniesStep.test.jsx src/onboarding/steps/FinishStep.test.jsx` |
| **Estimated runtime** | ~10 seconds |

`npm test` is not the primary Phase 05 signal while `tests/release-safety.test.mjs` has unrelated pre-existing local edits.

---

## Sampling Rate

- **After every task commit:** Run the quick command, or the narrower test file touched by that task plus any static scan named in the task.
- **After every plan wave:** Run the full suite command above.
- **Before `$gsd-verify-work`:** Full suite command plus static docs/runtime scans must be green.
- **Max feedback latency:** 30 seconds for focused checks.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | VER-01 | T-05-01 | Deterministic discovery resolver/scanner/gate/read/refresh/write paths do not invoke AI/chat/full skill runtime | static + unit | `node --test tests/company-discovery-regression.test.mjs` | ✅ | ⬜ pending |
| 05-02-01 | 02 | 1 | VER-02, VER-03 | T-05-02 | Malformed/schema-invalid seed AI responses retry once then degrade to manual/no-AI metadata without writes | unit | `node --test tests/company-discovery-seeds.test.mjs tests/company-proposals-route.test.mjs tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs` | ✅ | ⬜ pending |
| 05-03-01 | 03 | 2 | VER-04 | T-05-03 | Duplicate/excluded/in-play/unsupported/invalid approval states fail closed; only approve-supported-ATS writes source+sourced rows | unit | `node --test tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/db-source-config.test.mjs` | ✅ | ⬜ pending |
| 05-04-01 | 04 | 2 | VER-05 | T-05-04 | AGENTS.md, public architecture docs, and routing policy describe the same local/default, bounded-AI, chat, and retained-runtime split | static + unit | `node --test tests/decomposition-map.test.mjs` | ✅ | ⬜ pending |
| 05-05-01 | 05 | 3 | VER-01, VER-02, VER-03, VER-04, VER-05 | T-05-05 | Final verification command proves all phase boundaries together without real AI/network dependencies | integration regression | full suite command from Test Infrastructure | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Static Scan Requirements

Run these before verification closeout:

```bash
rg -n "company-proposals|company-proposal-decisions|/api/discovery/quick-start|/api/discovery/next|/api/chat|/api/skill/run" AGENTS.md docs/ARCHITECTURE.md .planning/architecture/runtime-routing-policy.md
rg -n "runSkillStream|startSession|/api/skill/run|callAI\\(|runBoundedAI" src/core/discovery src/cli/discovery-route.mjs
rg -n "companyAtsUpsert|sourcedUpsertBatch|sourceConfigPut|workspace/tracker\\.json|workspace/activity\\.jsonl" src/core/discovery/company-proposal-decisions.mjs src/core/discovery/company-proposals.mjs
```

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-05
