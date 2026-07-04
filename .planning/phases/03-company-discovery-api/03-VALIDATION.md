---
phase: 03
slug: company-discovery-api
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-04
---

# Phase 03 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node `node:test` on Node v24.18.0 |
| **Config file** | none for core `node:test`; scripts live in `package.json` |
| **Quick run command** | `node --test tests/company-discovery-seeds.test.mjs tests/company-board-resolver.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/company-discovery-cache-db.test.mjs` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | focused slice: <30s target; full suite varies by local workspace state |

## Sampling Rate

- **After every task commit:** Run the focused new Phase 03 test slice plus any directly touched existing test file.
- **After every plan wave:** Run the focused new Phase 03 slice and the existing related slice:
  `node --test tests/bounded-ai.test.mjs tests/discovery-route.test.mjs tests/db-source-config.test.mjs tests/companies-cli.test.mjs tests/scan-sourced.test.mjs tests/search-route.test.mjs tests/sourced-scanner.test.mjs`
- **Before `$gsd-verify-work`:** Run `npm test`; if `tests/release-safety.test.mjs` fails, isolate whether it is pre-existing dirty-worktree state before signoff.
- **Max feedback latency:** Keep focused verification under 30 seconds where practical.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-00-01 | 00 | 0 | DISC-01 | — | Schema rejects untrusted URL/write fields in AI seed output | unit | `node --test tests/company-discovery-seeds.test.mjs` | No - W0 | pending |
| 03-00-02 | 00 | 0 | DISC-02 | SSRF-01 | Resolver rejects unsupported schemes, localhost/private targets, unsafe redirects, and unsupported providers | unit | `node --test tests/company-board-resolver.test.mjs` | No - W0 | pending |
| 03-00-03 | 00 | 0 | DISC-02/DISC-04 | STATE-01 | Cache/proposal tables preserve versioned pending state and conflict detection | DB integration | `node --test tests/company-discovery-cache-db.test.mjs` | No - W0 | pending |
| 03-00-04 | 00 | 0 | DISC-01/DISC-03/DISC-04 | DOS-01 | Route enforces body caps, bounded batch size, no-AI/manual fallback, and stable envelopes | route integration | `node --test tests/company-proposals-route.test.mjs` | No - W0 | pending |
| 03-00-05 | 00 | 0 | DISC-05 | AUTHZ-01 | Decisions require current pending proposal and only approved supported ATS writes source state | DB integration | `node --test tests/company-proposal-decisions.test.mjs` | No - W0 | pending |

## Wave 0 Requirements

- [ ] `tests/company-discovery-seeds.test.mjs` - covers DISC-01 seed schema and no-AI/manual fallback.
- [ ] `tests/company-board-resolver.test.mjs` - covers DISC-02 deterministic URL/provider resolution and unsafe fetch rejection.
- [ ] `tests/company-discovery-cache-db.test.mjs` - covers cache/proposal migration, verbs, latest-pending read, and conflict behavior.
- [ ] `tests/company-proposals-route.test.mjs` - covers DISC-01 through DISC-04 route envelopes.
- [ ] `tests/company-proposal-decisions.test.mjs` - covers DISC-05 confirmation writes, reject/suppress/refresh decisions, and dashboard export path.

## Manual-Only Verifications

All phase behaviors have automated verification. Full UI confirmation is deferred; Phase 03 verifies confirmation through route and DB integration tests.

## Validation Sign-Off

- [x] All tasks have automated verification or Wave 0 dependencies.
- [x] Sampling continuity: no 3 consecutive tasks without automated verification.
- [x] Wave 0 covers all missing references.
- [x] No watch-mode flags.
- [x] Feedback latency target is under 30 seconds for focused slices.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-07-04 for planning; execution must keep this file current if task IDs or test files change.
