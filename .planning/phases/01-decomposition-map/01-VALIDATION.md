---
phase: 01
slug: decomposition-map
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-04
---

# Phase 01 - Validation Strategy

Per-phase validation contract for feedback sampling during execution.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` |
| **Config file** | none for the runner; `package.json` owns test scripts |
| **Quick run command** | `node --test tests/decomposition-map.test.mjs` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | quick: less than 5s; full suite varies with repository state |

## Sampling Rate

- **After every task commit:** Run the task's `<automated>` command; once Wave 0 creates `tests/decomposition-map.test.mjs`, also run `node --test tests/decomposition-map.test.mjs`.
- **After every plan wave:** Run `npm test`.
- **Before `$gsd-verify-work`:** Full suite must be green.
- **Max feedback latency:** less than one plan wave.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | ARCH-01, ARCH-02 | T-01-01 / T-01-02 / T-01-03 | Inventory keeps AI, deterministic APIs, prompts, skill fallback, and deferred browser/auth paths separated. | doc-shape | `node --input-type=module -e "import { readFileSync } from 'node:fs'; const t=readFileSync('.planning/architecture/skill-decomposition.yml','utf8'); for (const s of ['discover-companies','search-jobs','evaluate-job','apply-job','local_api','bounded_ai','full_skill_runtime','deferred']) { if (!t.includes(s)) throw new Error('missing '+s); }"` | no - W0 | pending |
| 01-02-01 | 02 | 1 | ARCH-02 | T-01-04 / T-01-05 / T-01-06 | Company discovery contract treats AI seeds and fetched pages as untrusted and gates writes through confirmation/source owners. | doc-shape | `node --input-type=module -e "import { readFileSync } from 'node:fs'; const t=readFileSync('.planning/architecture/discover-companies-target-contract.md','utf8'); for (const s of ['## AI Seed Schema','companySeedSchema','companyBoardResolutionCache','existing DB/source config','cached company board resolution','direct ATS scanner/local scraper','free or cheap job API','targeted crawler/extractor','AI web search/extract','full skill runtime','supported ATS promotion','unsupported public-page cache']) { if (!t.includes(s)) throw new Error('missing '+s); }"` | no - W0 | pending |
| 01-03-01 | 03 | 1 | ARCH-03 | T-01-07 / T-01-08 / T-01-09 | Runtime routing reserves skill/chat runtime for exploratory flows and keeps deterministic work on local APIs or DB verbs. | doc-shape | `node --input-type=module -e "import { readFileSync } from 'node:fs'; const t=readFileSync('.planning/architecture/runtime-routing-policy.md','utf8'); for (const s of ['local API','DB verb or CLI','bounded structured AI','/api/chat/*','/api/skill/run','cost tier']) { if (!t.includes(s)) throw new Error('missing '+s); }"` | no - W0 | pending |
| 01-04-01 | 04 | 2 | ARCH-01, ARCH-02, ARCH-03 | T-01-10 / T-01-11 | Validation test guards required decomposition artifacts without adding runtime code or network dependencies. | unit | `node --test tests/decomposition-map.test.mjs` | no - W0 | pending |

Status: pending, green, red, or flaky.

## Wave 0 Requirements

- [ ] `.planning/architecture/skill-decomposition.yml` - canonical decomposition inventory artifact.
- [ ] `.planning/architecture/discover-companies-target-contract.md` - company discovery target contract.
- [ ] `.planning/architecture/runtime-routing-policy.md` - runtime routing policy.
- [ ] `tests/decomposition-map.test.mjs` - focused node:test validation for Phase 1 artifacts.

## Manual-Only Verifications

All phase behaviors have automated verification through artifact-shape checks or `node:test`.

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies.
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify.
- [ ] Wave 0 covers all missing references.
- [ ] No watch-mode flags.
- [ ] Feedback latency is less than one plan wave.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** pending
