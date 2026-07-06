---
phase: 10
slug: local-packet-engine
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-06
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node `node:test` on Node v24.18.0 |
| **Config file** | none; package script is `node --test 'tests/**/*.test.mjs'` |
| **Quick run command** | `node --test tests/packet-route.test.mjs tests/form-questions.test.mjs tests/documents-tailor.test.mjs tests/structured-oneshot.test.mjs tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/evaluate-gate.test.mjs tests/data-route.test.mjs tests/packet-page.test.mjs tests/answer-page.test.mjs` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~60 seconds focused; full suite runtime varies |

---

## Sampling Rate

- **After every task commit:** Run the quick packet command above, narrowed to touched files when safe.
- **After every plan wave:** Run the focused packet command plus `node src/cli/export.mjs <fixture.md> --pdf --ats` and a DOCX smoke when export logic changes.
- **Before `$gsd-verify-work`:** Focused packet suite green; run `npm test` and document unrelated failures if present.
- **Max feedback latency:** ~60 seconds for focused packet feedback.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 0 | PKT-01 | T-10-01 / T-10-02 | Product packet generation uses local APIs/DB verbs and does not default to `/api/skill/run`. | integration/static | `node --test tests/packet-generate-route.test.mjs tests/packet-runtime-boundary.test.mjs tests/packet-page.test.mjs tests/answer-page.test.mjs` | ❌ W0 | ⬜ pending |
| 10-01-02 | 01 | 0 | PKT-02 | T-10-03 | Packet content is evidence-grounded, ATS-safe, and placeholder/forbidden-word clean. | unit/integration | `node --test tests/documents-tailor.test.mjs tests/packet-engine.test.mjs` | ❌ W0 | ⬜ pending |
| 10-01-03 | 01 | 0 | PKT-03 | T-10-04 | EEO/disability/demographic prompts are excluded before AI answer generation. | unit/integration | `node --test tests/form-questions.test.mjs tests/packet-answers.test.mjs` | ❌ W0 | ⬜ pending |
| 10-01-04 | 01 | 0 | PKT-04 | T-10-05 | PDF is default; DOCX is generated only when required or explicitly selected. | integration/smoke | `node --test tests/packet-export.test.mjs` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/packet-generate-route.test.mjs` — covers PKT-01 local generate/gate route behavior and DB artifact stamping.
- [ ] `tests/packet-engine.test.mjs` — covers PKT-02 packet orchestration over deterministic document builders and bounded AI envelopes.
- [ ] `tests/packet-answers.test.mjs` — covers PKT-03 non-EEO answer generation and manual-paste exclusion.
- [ ] `tests/packet-export.test.mjs` — covers PKT-04 PDF default and conditional DOCX.
- [ ] Update `tests/packet-page.test.mjs` — old expected skill-runtime post becomes a regression that default packet generation calls local APIs.
- [ ] Update `tests/answer-page.test.mjs` — old runtime allowlist expectation becomes local answer API behavior or explicit handoff-only behavior.
- [ ] Add static guard for new app-default references to `tailor-application`, `answer-question`, or `evaluate-job` through `/api/skill/run` where local packet owners exist.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real board-specific DOCX requirement judgment | PKT-04 | Board upload requirements vary and provider fixtures may not cover every real board. | Verify one fixture or captured application context marks DOCX required/selected and one does not; confirm only the required/selected path stamps DOCX. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s for focused packet checks
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
