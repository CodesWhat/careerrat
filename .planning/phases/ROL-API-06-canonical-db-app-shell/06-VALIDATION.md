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

- **After every task commit:** Run the narrow changed route/component test plus `node --test tests/db-app-shell-regression.test.mjs`
- **After every plan wave:** Run the backend quick command and the frontend quick command
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 180 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-W0-01 | TBD | 0 | APP-03, APP-04 | T-06-01 | Product files cannot read generated tracker/activity exports | static architecture | `node --test tests/db-app-shell-regression.test.mjs` | ❌ W0 | ⬜ pending |
| 06-W0-02 | TBD | 0 | APP-01 | — | Product nav has no normal `Classic`/`/tracker` path | frontend unit | `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` | ❌ W0 | ⬜ pending |
| 06-W0-03 | TBD | 0 | APP-02, APP-03 | T-06-01 | Packet API reads DB-derived rows and fails closed without DB | backend route | `node --test tests/packet-route.test.mjs` | ⚠️ update | ⬜ pending |
| 06-W0-04 | TBD | 0 | APP-02, APP-03 | T-06-03 | Source setup product path writes DB source config, not YAML | backend route | `node --test tests/boards-route.test.mjs` or `node --test tests/source-config-route.test.mjs` | ⚠️ update/new | ⬜ pending |
| 06-W0-05 | TBD | 0 | APP-02, APP-03 | T-06-04 | Scanner context/results do not use scan-result JSON or tracker exports as product state | backend route | `node --test tests/search-route.test.mjs` | ⚠️ update | ⬜ pending |
| 06-W0-06 | TBD | 0 | APP-02, APP-03 | T-06-04 | DB-mode scan dedupe derives seen sets from DB rows, not tracker exports | backend unit/integration | Planner chooses exact test command | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/db-app-shell-regression.test.mjs` — static APP-03/APP-04 guard for product files and debug/export allowlist.
- [ ] `apps/web/src/app-shell/NavList.test.jsx` — verifies no `Classic`/`/tracker` normal product nav item remains.
- [ ] Update `tests/packet-route.test.mjs` — seed DB fixtures and expect 409 on missing DB instead of tracker-file fallback.
- [ ] Update `tests/boards-route.test.mjs` or add `tests/source-config-route.test.mjs` — product add/read path writes DB source config, not `config/search-sources.yml`.
- [ ] Update `tests/search-route.test.mjs` — product scanner context/results path does not read latest `workspace/scan-results/*.json` or legacy source config when DB is required.
- [ ] Add or update scanner seen-set tests — DB-mode scans derive dedupe from DB rows, not tracker exports.

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
