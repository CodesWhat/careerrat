---
phase: 6
slug: canonical-db-app-shell
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-05
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node built-in `node:test` for backend/static tests; Vitest for React app tests |
| **Config file** | `package.json`, `apps/web/vite.config.js` |
| **Quick run command** | `node --test tests/dashboard-route.test.mjs tests/data-route.test.mjs tests/packet-route.test.mjs tests/search-route.test.mjs tests/boards-route.test.mjs tests/desktop-routing.test.mjs tests/db-app-shell-regression.test.mjs` |
| **Frontend quick command** | `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` |
| **Full suite command** | `npm test && npm --workspace apps/web run test` |
| **Estimated runtime** | ~180 seconds |

---

## Sampling Rate

- **After every task commit:** Run only the narrow changed route/component/helper test owned by that task.
- **After Wave 0:** Run RED contract commands with expected nonzero exits as specified in Plans 06-01 through 06-03.
- **After Wave 1:** Run each implementation plan's local verify command only; do not run the global static guard until the dependent Wave 2 rollup.
- **Wave 2 final rollup:** Run the backend quick command, including `tests/db-app-shell-regression.test.mjs`, and the frontend quick command.
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 180 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-W0-01 | 06-01 | 0 | APP-03, APP-04 | T-06-01 | Product files cannot read generated tracker/activity exports | static architecture RED | `bash -lc 'node --test tests/db-app-shell-regression.test.mjs; test $? -ne 0'` | ❌ W0 | ⬜ pending |
| 06-W0-02 | 06-01 | 0 | APP-01 | T-06-02 | Product nav has no normal `Classic`/`/tracker` path | frontend unit RED | `bash -lc 'npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx; test $? -ne 0'` | ❌ W0 | ⬜ pending |
| 06-W0-03 | 06-02 | 0 | APP-02, APP-03 | T-06-04 | Packet API reads DB-derived rows and fails closed without DB | backend route RED | `bash -lc 'node --test tests/packet-route.test.mjs; test $? -ne 0'` | ⚠️ update | ⬜ pending |
| 06-W0-04 | 06-03 | 0 | APP-02, APP-03 | T-06-06 | Source setup product path writes DB source config, not YAML | backend route RED | `bash -lc 'node --test tests/boards-route.test.mjs; test $? -ne 0'` | ⚠️ update | ⬜ pending |
| 06-W0-05 | 06-03 | 0 | APP-02, APP-03 | T-06-07 | Scanner context/results do not use scan-result JSON or tracker exports as product state | backend route RED | `bash -lc 'node --test tests/search-route.test.mjs; test $? -ne 0'` | ⚠️ update | ⬜ pending |
| 06-W0-06 | 06-03 | 0 | APP-02, APP-03 | T-06-08 | DB-mode scan dedupe derives seen sets from DB rows, not tracker exports | backend integration RED | `bash -lc 'node --test tests/scanner-seen-set-db.test.mjs; test $? -ne 0'` | ❌ W0 | ⬜ pending |
| 06-W1-01 | 06-04 | 1 | APP-01 | T-06-02 | Product nav retirement is green | frontend unit | `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` | ✅ after 06-01 | ⬜ pending |
| 06-W1-02 | 06-04 | 1 | APP-03, APP-04 | T-06-03 | `tracker-dev.mjs` has local debug/export route classification | static route check | `bash -lc 'node --check src/cli/tracker-dev.mjs && node -e "const fs=require(\"node:fs\"); const s=fs.readFileSync(\"src/cli/tracker-dev.mjs\",\"utf8\"); for (const token of [\"DEBUG_EXPORT_ROUTES\",\"isDebugExportRoute\"]) { if (!s.includes(token)) { throw new Error(token + \" missing from tracker-dev debug/export classification\"); } }"'` | ✅ source | ⬜ pending |
| 06-W1-03 | 06-05 | 1 | APP-02, APP-03 | T-06-04 | Packet product APIs are DB-derived and fail closed without DB | backend route | `node --test tests/packet-route.test.mjs` | ✅ after 06-02 | ⬜ pending |
| 06-W1-04 | 06-06 | 1 | APP-02, APP-03 | T-06-06 | Board/source setup writes DB source config only | backend route | `node --test tests/boards-route.test.mjs` | ✅ after 06-03 | ⬜ pending |
| 06-W1-05 | 06-07 | 1 | APP-02, APP-03 | T-06-08 | DB scan-context helper reads DB rows only | backend helper | `node --test tests/db-scan-context.test.mjs` | ❌ W1 | ⬜ pending |
| 06-W1-06 | 06-07 | 1 | APP-02, APP-03 | T-06-08 | `runSourcedScan` uses DB seen sets when DB exists | backend integration | `node --test tests/scanner-seen-set-db.test.mjs` | ✅ after 06-03 | ⬜ pending |
| 06-W1-07 | 06-07 | 1 | APP-02, APP-03 | T-06-07 | Search product routes are DB-only for sources and results | backend route | `node --test tests/search-route.test.mjs` | ✅ after 06-03 | ⬜ pending |
| 06-W2-01 | 06-08 | 2 | APP-01, APP-02, APP-03, APP-04 | T-06-12, T-06-13 | Final backend, frontend, and global static guard pass after all Wave 1 files are migrated | final rollup | `node --test tests/dashboard-route.test.mjs tests/data-route.test.mjs tests/packet-route.test.mjs tests/search-route.test.mjs tests/boards-route.test.mjs tests/desktop-routing.test.mjs tests/db-app-shell-regression.test.mjs && npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` | ❌ W2 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/db-app-shell-regression.test.mjs` — static APP-03/APP-04 guard for product files and debug/export allowlist.
- [ ] `apps/web/src/app-shell/NavList.test.jsx` — verifies no `Classic`/`/tracker` normal product nav item remains.
- [ ] Update `tests/packet-route.test.mjs` — seed DB fixtures and expect 409 on missing DB instead of tracker-file fallback.
- [ ] Update `tests/boards-route.test.mjs` or add `tests/source-config-route.test.mjs` — product add/read path writes DB source config, not `config/search-sources.yml`.
- [ ] Update `tests/search-route.test.mjs` — product scanner context/results path does not read latest `workspace/scan-results/*.json` or legacy source config when DB is required.
- [ ] Add or update scanner seen-set tests — DB-mode scans derive dedupe from DB rows, not tracker exports.

## Wave 2 Rollup Requirement

- [ ] `06-08-PLAN.md` — run the backend quick command, frontend quick command, and global `tests/db-app-shell-regression.test.mjs` static guard only after Plans 06-04 through 06-07 complete.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| None | APP-01 - APP-04 | All phase behaviors have automated route/static/frontend coverage. | N/A |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 180s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-05
