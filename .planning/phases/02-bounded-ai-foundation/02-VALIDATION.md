---
phase: 02
slug: bounded-ai-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-04
---

# Phase 02 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node built-in `node:test` on Node >=24 |
| **Config file** | none - `node:test` plus package scripts in `package.json` |
| **Quick run command** | `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | quick route/runtime subset should stay under 30 seconds; full suite is project-dependent |

---

## Sampling Rate

- **After every task commit:** Run `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs` once `tests/bounded-ai.test.mjs` exists.
- **After every plan wave:** Run the quick subset plus every touched route test, including `tests/assist-route.test.mjs`, `tests/intake-classify.test.mjs`, and `tests/onboard-route.test.mjs` when those routes change.
- **Before `$gsd-verify-work`:** Full suite should be green, except for explicitly documented unrelated pre-existing failures.
- **Max feedback latency:** 30 seconds for the bounded-AI subset.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-W0-labels | TBD | 0 | AIR-01 | T-02-label-repudiation | Missing or blank `skill`, `action`, or `operation` fails before any model/proxy invocation. | unit | `node --test tests/bounded-ai.test.mjs` | W0 missing | pending |
| 02-W0-schema | TBD | 0 | AIR-02 | T-02-output-tampering | Native and fallback model output is parsed and locally schema-validated before route data is exposed. | unit | `node --test tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs` | partial | pending |
| 02-W0-no-ai | TBD | 0 | AIR-03 | T-02-availability | No AI route returns a 501-style envelope with `ok:false`, `code:"NO_AI_ROUTE"`, `ai.used:false`, and `manual.available:true`. | unit/route | `node --test tests/bounded-ai.test.mjs tests/assist-route.test.mjs` | partial | pending |
| 02-W0-telemetry | TBD | 0 | AIR-04 | T-02-info-disclosure | Usage/cost telemetry remains metadata-only and does not store prompts, raw outputs, resumes, JDs, candidate facts, or page bodies. | unit/integration-fake | `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs` | partial | pending |
| 02-W0-native | TBD | 0 | AIR-01, AIR-02 | T-02-provider-trust | Provider-native structured output request shape is generated behind the wrapper, but local validation still gates success. | unit | `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs` | W0 missing | pending |

---

## Wave 0 Requirements

- [ ] `tests/bounded-ai.test.mjs` - wrapper contract tests for labels, envelope mapping, schema failure, no-AI fallback, provider failure, native/fallback mode selection, and no content leakage.
- [ ] `tests/call-ai.test.mjs` additions - request-shape coverage for Anthropic native structured output options without live provider calls.
- [ ] Route-test updates for any migrated route - assert shared envelope fields instead of legacy route-local shapes.
- [ ] Usage label regression tests - prove BYOK and proxy paths preserve label and cost metadata without prompt/body leakage.

---

## Manual-Only Verifications

All Phase 02 behaviors should have automated verification. Live provider smoke tests are optional and should be skipped when no AI credentials are configured.

---

## Validation Sign-Off

- [ ] All tasks have automated verify commands or Wave 0 dependencies.
- [ ] Sampling continuity: no three consecutive implementation tasks without an automated verify step.
- [ ] Wave 0 covers every missing test reference above.
- [ ] No watch-mode commands are used as verification.
- [ ] Feedback latency for the bounded-AI subset stays under 30 seconds.
- [ ] `nyquist_compliant: true` is set in frontmatter when Wave 0 is complete and all rows have automated coverage.

**Approval:** pending
