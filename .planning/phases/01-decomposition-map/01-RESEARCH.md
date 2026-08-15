# Phase 01: Decomposition Map - Research

**Researched:** 2026-07-04
**Domain:** CareerRat skill-to-local-API decomposition, discovery routing, source scanning
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
## Implementation Decisions

### Sourcing Cascade
- **D-01:** V1 should test and support multiple sourcing lanes instead of prematurely choosing one: cached direct ATS scans, local/free public career-page extraction, low/free-tier job APIs, crawler tools such as Firecrawl, AI web search/extract, and full skill runtime.
- **D-02:** The default runtime order should be cheapest-first: existing DB/source config -> cached company board resolution -> direct ATS scanner/local scraper -> free/cheap job API -> targeted crawler/extractor -> AI web search -> full skill runtime.
- **D-03:** AI web search is expected to cost more than deterministic or provider-based sourcing and should be used for discovery gaps, judgment, ranking, and ambiguous resolution, not routine repeated scans.

### Company Board Resolution Cache
- **D-04:** Company discovery should resolve a company board once and save the durable result. Future sweeps should scan cached metadata instead of rediscovering the same careers page.
- **D-05:** Cached resolution records should capture at least: company name, company domain, careers URL, job board URL, ATS/provider if known, API URL if known, confidence, source/provenance, first resolved time, last verified time, last scan result, and failure counters.
- **D-06:** Re-resolution should be event-driven or TTL-based: board 404/403, redirect/ATS change, repeated zero-job scans, stale cache window, or explicit user refresh. It should not happen on every sweep.

### Scraping and Extraction Posture
- **D-07:** Free/local scraping is in scope for public non-job-board career pages. Use Node `fetch` first, then Playwright for public JS-rendered pages when needed. Browser-authenticated automation remains v2.
- **D-08:** Phase 1 should not treat ordinary scraping/legal/copyright concern as the primary design blocker. The practical priorities are freshness, disappearing postings, cost, reliability, cacheability, and immediate JD capture.
- **D-09:** Every discovered job should preserve the first reachable full JD body locally as soon as it is found, because postings disappear or move.

### Provider/API Evaluation
- **D-10:** Phase 1 should specify a bakeoff, not a vendor commitment. Compare at least: direct ATS scanner/local scraper, Techmap/JobDataFeeds free tier, Firecrawl free tier, Tavily/free AI-search style extraction, and optionally Adzuna/Coresignal as benchmarks.
- **D-11:** The evaluation should measure usable jobs per dollar, full JD capture quality, apply-link quality, freshness, duplicate rate, unsupported-page rate, failure modes, and model/tool calls consumed.

### Skill Decomposition Contract
- **D-12:** Skill files remain human/agent workflow contracts, but product runtime should decompose them into local APIs, DB verbs, scanners, and bounded structured AI calls.
- **D-13:** `discover-companies` should no longer be modeled as "AI finds companies and the full skill resolves everything." It should be a pipeline: seed generation or source intake -> deterministic/cached resolver -> scanner/extractor -> gate/dedupe -> confirm-first write.
- **D-14:** The current "supported ATS only" wording in roadmap/requirements is too narrow for the user's clarified direction. Phase 1 should explicitly reconcile that by separating "promote to supported ATS scanner" from "cache unsupported/custom public career pages for generic extraction."

### the agent's Discretion
The agent may choose exact artifact format, route names, schema names, and cache table shape, provided the plan preserves the cascade above, keeps writes confirm-first where current skills require it, and references existing CareerRat modules rather than inventing parallel systems.

### Deferred Ideas (OUT OF SCOPE)
## Deferred Ideas

- Browser-authenticated sources such as LinkedIn, Wellfound, and logged-in portals remain v2 unless a future plan explicitly moves them forward.
- Managed paid provider commitments should wait until the bakeoff produces data.
- Automatic application submission remains out of scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ARCH-01 | Maintainer can read a skill decomposition inventory that classifies each skill step as deterministic code, bounded AI, full skill-agent run, prompt/spec, or deferred. | Use `.planning/architecture/skill-decomposition.yml` as the canonical inventory and keep readable rationale in adjacent Markdown. [VERIFIED: .planning/REQUIREMENTS.md; .planning/STATE.md] |
| ARCH-02 | The inventory maps each classified step to an existing or planned owner: TS module, API route, DB verb, CLI command, or retained skill runtime. | Existing owners are `src/cli/*-route.mjs`, `src/core/ai/*`, `src/core/db/verbs/*`, `src/core/scoring/sourced-scanner.mjs`, `scripts/scan-sourced.mjs`, and `.agents/skills/*/SKILL.md`. [VERIFIED: codebase grep] |
| ARCH-03 | The routing policy defines when UI, CLI, and agents should call local APIs instead of `POST /api/skill/run`. | Existing routing already separates `/api/search/scan`, `/api/data/*`, `/api/discovery/*`, `/api/chat/*`, and `/api/skill/run`; Phase 1 should document the selection policy. [VERIFIED: src/cli/search-route.mjs; src/cli/data-route.mjs; src/cli/discovery-route.mjs; src/cli/skill-run-route.mjs] |
</phase_requirements>

## Summary

Phase 1 should create planning artifacts only; it should not change runtime behavior. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md] The repo already contains the runtime seams the future phases need: full skill execution through `POST /api/skill/run`, conversational skill sessions through `/api/chat/*`, bounded structured AI helpers, deterministic scanner APIs, DB source-config verbs, and CLI wrappers. [VERIFIED: src/cli/skill-run-route.mjs; src/core/ai/chat-runtime.mjs; src/core/ai/structured-oneshot.mjs; scripts/scan-sourced.mjs; src/core/db/verbs/source-config.mjs]

The most important planning finding is the current supported-ATS gate. `careerrat companies` and `companyAtsUpsert()` reject company URLs that cannot be inferred as Ashby, Greenhouse, Lever, Workable, or SmartRecruiters. [VERIFIED: src/cli/companies.mjs; src/core/db/verbs/source-config.mjs; src/core/scoring/sourced-scanner.mjs] That is correct for today's tracked-company scanner, but the locked Phase 1 direction requires a separate cached resolver path for unsupported/custom public career pages so they can be revalidated and scanned by generic extraction later. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md]

**Primary recommendation:** Create `.planning/architecture/skill-decomposition.yml`, `.planning/architecture/discover-companies-target-contract.md`, and `.planning/architecture/runtime-routing-policy.md`; validate them with a focused `tests/decomposition-map.test.mjs` so later phases cannot drift from the documented owner map. [VERIFIED: .planning/REQUIREMENTS.md; .planning/ROADMAP.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Skill decomposition inventory | Repository planning artifact | API / Backend | The inventory satisfies ARCH-01/ARCH-02 before runtime code changes, but each row must point to backend/API/DB owners. [VERIFIED: .planning/REQUIREMENTS.md] |
| `discover-companies` AI seed schema | API / Backend | Bounded AI runtime | Seed generation is model-shaped judgment, but it must return schema-validated JSON through existing bounded AI helpers. [VERIFIED: src/core/ai/structured-oneshot.mjs; src/cli/assist-route.mjs] |
| Company board resolution cache | Database / Storage | API / Backend | Durable board metadata must outlive sweeps and revalidate by TTL or events rather than rediscovering every run. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md] |
| Direct ATS scanner | API / Backend | Database / Storage | `runSourcedScan()` already calls provider fetchers, filters, dedupes, captures JD files, and writes sourced rows in DB mode. [VERIFIED: scripts/scan-sourced.mjs; src/core/scoring/sourced-persistence.mjs] |
| Generic public career-page extraction | API / Backend | Browser / Client | V1 can use Node `fetch` first and Playwright for public JS-rendered pages, while authenticated browser automation remains v2. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md; scripts/capture-search-sources.mjs] |
| Proposal confirmation | Browser / Client | API / Backend | Current discovery app routes start visible confirm-first chat sessions; future local APIs should still surface proposals before writes. [VERIFIED: src/cli/discovery-route.mjs; .agents/skills/discover-companies/SKILL.md] |
| Confirmed source writes | API / Backend | Database / Storage | Existing source-config and companies helpers are the canonical write path for supported ATS entries; generic cache writes need a planned DB owner. [VERIFIED: src/core/db/verbs/source-config.mjs; src/cli/companies.mjs] |
| Runtime routing policy | API / Backend | Browser / Client, CLI | `tracker-dev` mounts exact local routes; UI should prefer deterministic/bounded local routes and reserve full skill runs for tool-heavy workflows. [VERIFIED: src/cli/tracker-dev.mjs; src/cli/skill-run-route.mjs] |

## Project Constraints (from AGENTS.md)

- Skills are the "how-to" workflow contracts, and agents should open the owning skill instead of improvising procedure. [VERIFIED: AGENTS.md]
- The post-onboarding discovery order is `setup-searches -> research-boards -> discover-companies -> search-jobs`. [VERIFIED: AGENTS.md; src/core/agent-guidance.mjs]
- Candidate-specific sources and preferences must not leak into shipped docs; discovered boards belong in user source config and workspace research logs, not `docs/SOURCES.md`. [VERIFIED: AGENTS.md; docs/SOURCES.md; tests/release-safety.test.mjs]
- Tracker-visible writes must be durable workspace or DB state, not chat-only state. [VERIFIED: AGENTS.md]
- DB workspaces use `careerrat data <verb>` for tracker-visible mutations; generated `workspace/tracker.json` and `workspace/activity.jsonl` should not be hand-edited in DB mode. [VERIFIED: AGENTS.md; src/cli/data-route.mjs]
- Source config writes should go through `careerrat searches`, `careerrat companies`, or DB source-config verbs, not ad hoc edits in DB workspaces. [VERIFIED: .agents/skills/setup-searches/SKILL.md; .agents/skills/discover-companies/SKILL.md; src/cli/searches.mjs; src/cli/companies.mjs]
- `discover-companies` and `research-boards` are confirm-first by default; high-confidence auto-add is explicit opt-in, not the baseline. [VERIFIED: .agents/skills/discover-companies/SKILL.md; .agents/skills/research-boards/SKILL.md]
- Every grabbed posting must capture the first reachable full JD body locally because live postings disappear or become inaccessible. [VERIFIED: AGENTS.md; .agents/skills/search-jobs/SKILL.md; src/core/scoring/sourced-persistence.mjs]
- Runtime code and shipped docs must remain domain-neutral; candidate gates live in candidate config, not hardcoded defaults. [VERIFIED: AGENTS.md; docs/SOURCES.md; config/sourced-scan.example.json]
- Browser-authenticated sources require explicit automation consent and are deferred from this Phase 1 target. [VERIFIED: AGENTS.md; .planning/phases/01-decomposition-map/01-CONTEXT.md]

## Standard Stack

### Core
| Library / Module | Version | Purpose | Why Standard |
|------------------|---------|---------|--------------|
| Node.js ESM | v24.18.0 available locally | Runtime and test execution | `package.json` requires Node `>=24`, and repo scripts are ESM `.mjs`. [VERIFIED: package.json; environment probe] |
| `node:test` | Node v24.18.0 bundled | Phase validation tests | Existing test suite uses `node --test 'tests/**/*.test.mjs'`. [VERIFIED: package.json; tests directory] |
| Markdown + YAML planning artifacts | Repository-local | Human-readable contracts plus machine-checkable decomposition inventory | Requirements ask for a readable inventory, and `.planning/STATE.md` leaves machine-readable metadata as an open question. [VERIFIED: .planning/REQUIREMENTS.md; .planning/STATE.md] |
| `src/core/ai/structured-oneshot.mjs` | Current repo | Bounded structured AI parse/validate/retry loop | Existing route code uses it for bounded structured-output calls and tests malformed JSON/schema failures. [VERIFIED: src/core/ai/structured-oneshot.mjs; tests/structured-oneshot.test.mjs] |
| `src/core/ai/call-ai.mjs` | Current repo | BYOK/proxy AI route selection and usage labels | It resolves BYOK vs proxy vs no-AI and attaches `skill`/`action` labels for proxy calls. [VERIFIED: src/core/ai/call-ai.mjs] |
| `src/core/scoring/sourced-scanner.mjs` | Current repo | Deterministic ATS/RSS scanner, filters, scoring, dedupe helpers | It owns provider inference/fetch, title/location filters, score flags, req-id extraction, and dedupe. [VERIFIED: src/core/scoring/sourced-scanner.mjs] |
| `src/core/db/verbs/source-config.mjs` | Current repo | DB-backed source config and supported-company ATS writes | It stores `search-sources`/`sourced-scan` JSON in SQLite and exposes `companyAtsUpsert()`. [VERIFIED: src/core/db/verbs/source-config.mjs; src/core/db/migrations/005-source-config.mjs] |
| `scripts/scan-sourced.mjs` | Current repo | Importable deterministic scan orchestration | `runSourcedScan()` is imported by `/api/search/scan` and writes scan results/intake/JD captures. [VERIFIED: scripts/scan-sourced.mjs; src/cli/search-route.mjs] |

### Supporting
| Library / Module | Version | Purpose | When to Use |
|------------------|---------|---------|-------------|
| Playwright | `^1.60.0` in devDependencies | Public JS-rendered page capture fallback | Plan for public career-page extraction experiments; do not move authenticated browser automation into Phase 1. [VERIFIED: package.json; .planning/phases/01-decomposition-map/01-CONTEXT.md] |
| `src/cli/skill-run-route.mjs` | Current repo | Full skill SSE runtime surface | Use only for allowlisted full-skill runs that need live tool visibility or retained agent workflow. [VERIFIED: src/cli/skill-run-route.mjs] |
| `src/core/ai/chat-runtime.mjs` | Current repo | Conversational multi-turn skill runtime | Use for confirm-first discovery workflows until decomposed into local APIs. [VERIFIED: src/core/ai/chat-runtime.mjs; src/cli/discovery-route.mjs] |
| `src/cli/data-route.mjs` | Current repo | HTTP shims over DB verbs | Use when UI needs the same atomic data mutations as CLI verbs. [VERIFIED: src/cli/data-route.mjs] |
| `src/core/providers/search-sources.mjs` | Current repo | Search-source config builders and URL import handling | Use for board/source additions instead of duplicating provider/auth/source-type logic. [VERIFIED: src/core/providers/search-sources.mjs; src/cli/searches.mjs] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `.planning/architecture/skill-decomposition.yml` plus Markdown | Markdown-only decomposition doc | Markdown-only is easier to read but harder to test for ARCH-02 owner coverage. [VERIFIED: .planning/REQUIREMENTS.md] |
| `.planning/architecture/` | `docs/ARCHITECTURE.md` immediately | Public docs should update in Phase 5 after behavior is implemented; Phase 1 needs planning artifacts that can reference future owners without overpromising shipped behavior. [VERIFIED: .planning/ROADMAP.md; docs/ARCHITECTURE.md] |
| Local deterministic routes | `POST /api/skill/run` for all app buttons | Full skill runs are already allowlisted and tool-heavy; deterministic scans and writes have cheaper local owners. [VERIFIED: src/cli/search-route.mjs; src/cli/skill-run-route.mjs] |
| New source writer | Existing `careerrat searches` / `careerrat companies` / DB verbs | Existing helpers validate, dedupe, and preserve DB-vs-compat behavior. [VERIFIED: src/cli/searches.mjs; src/cli/companies.mjs; src/core/db/verbs/source-config.mjs] |

**Installation:**
```bash
# No external packages should be installed for Phase 1.
```

## Package Legitimacy Audit

No external package installation is recommended for Phase 1, so the package legitimacy gate is not applicable. [VERIFIED: .planning/ROADMAP.md; package.json] Existing dev dependencies remain the repo's current tooling and were not newly selected by this research. [VERIFIED: package.json]

## Architecture Patterns

### System Architecture Diagram

```text
Phase 1 planning input
  |
  v
.agents/skills/*/SKILL.md + AGENTS.md + docs/ARCHITECTURE.md + current code owners
  |
  v
.planning/architecture/skill-decomposition.yml
  |       \
  |        -> .planning/architecture/runtime-routing-policy.md
  |        -> .planning/architecture/discover-companies-target-contract.md
  |
  v
Later phases consume the map:
  deterministic code -> src/core/* + src/cli/*-route.mjs
  bounded AI        -> callAI() / runStructuredOneshot()
  source writes     -> source-config DB verbs / careerrat searches / careerrat companies
  full workflows    -> /api/skill/run or /api/chat/* fallback
```

### Recommended Project Structure

```text
.planning/
├── architecture/
│   ├── skill-decomposition.yml              # canonical machine-readable ARCH-01/ARCH-02 inventory
│   ├── discover-companies-target-contract.md # detailed future pipeline contract for DISC phases
│   └── runtime-routing-policy.md            # ARCH-03 policy for UI, CLI, and agents
└── phases/01-decomposition-map/
    └── 01-RESEARCH.md

tests/
└── decomposition-map.test.mjs                # Wave 0 validation for artifact shape and required paths
```

This location keeps Phase 1 artifacts inside GSD planning space and avoids premature changes to shipped docs. [VERIFIED: .planning/STATE.md; .planning/ROADMAP.md; package.json#files]

### Pattern 1: Machine-Readable Inventory With Readable Rationale

**What:** Use YAML for the canonical decomposition rows and Markdown for rationale. [VERIFIED: .planning/REQUIREMENTS.md]

**When to use:** Use this for ARCH-01/ARCH-02 so tests can verify each high-priority skill has `deterministic`, `bounded_ai`, `full_skill_runtime`, `prompt_spec`, and `deferred` buckets plus owner paths. [VERIFIED: .planning/REQUIREMENTS.md]

**Recommended YAML shape:**
```yaml
skills:
  discover-companies:
    source: .agents/skills/discover-companies/SKILL.md
    deterministic:
      - step: load candidate context and dedup set
        owner: planned:src/core/discovery/company-context.mjs
      - step: resolve/cache board metadata
        owner: planned:src/core/discovery/company-board-resolver.mjs
    bounded_ai:
      - step: generate company seed candidates
        owner: planned:src/cli/company-discovery-route.mjs
        schema: planned:config/company-seeds.schema.json
    full_skill_runtime:
      - step: ambiguous exploratory discovery or user-led refinement
        owner: src/core/ai/chat-runtime.mjs
    prompt_spec:
      - .agents/skills/discover-companies/SKILL.md
    deferred:
      - browser-authenticated LinkedIn/Wellfound/company portals
```

### Pattern 2: Exact Route Mounters

**What:** New API surfaces should follow the repo's route-mounter pattern: a pure `mount*Routes({ addRoute, repoRoot, env, ...deps })` function registered by `tracker-dev`. [VERIFIED: src/cli/tracker-dev.mjs; src/cli/search-route.mjs; src/cli/assist-route.mjs]

**When to use:** Use for future deterministic/bounded discovery APIs so tests can mount a bare route map and inject fetch/AI stubs. [VERIFIED: tests/search-route.test.mjs; tests/assist-route.test.mjs]

**Example:**
```js
// Source: src/cli/search-route.mjs
export function mountSearchRoutes({ addRoute, repoRoot, env = process.env, fetchImpl = fetch }) {
  // Registers POST /api/search/scan and read-only search result/source routes.
}
```

### Pattern 3: DB Verb First, CLI and HTTP as Thin Wrappers

**What:** DB verbs own mutations; CLI and HTTP route layers adapt input and call the same verb functions. [VERIFIED: src/cli/data-route.mjs; src/core/db/verbs/sourced.mjs]

**When to use:** Use for future board-resolution cache writes and proposal acceptance so UI, CLI, and agents share one write path. [VERIFIED: src/cli/data-route.mjs]

**Example:**
```js
// Source: src/core/db/verbs/source-config.mjs
companyAtsUpsert({ repoRoot, env, entry });
```

### Pattern 4: Normalize Extracted Jobs Into Scanner Offers

**What:** Provider, RSS, browser, and future generic career-page extractors should normalize into the scanner offer shape: company, title, URL, location, comp, body text, source metadata. [VERIFIED: src/core/scoring/sourced-scanner.mjs; scripts/capture-search-sources.mjs; src/core/scoring/sourced-persistence.mjs]

**When to use:** Use for all sourcing lanes so existing dedupe, scoring, JD capture, and DB sourced-row persistence stay shared. [VERIFIED: scripts/scan-sourced.mjs; src/core/scoring/sourced-persistence.mjs]

### Anti-Patterns to Avoid

- **Docs-only inventory:** A prose-only decomposition can satisfy reading but cannot cheaply prove ARCH-02 path coverage. [VERIFIED: .planning/REQUIREMENTS.md]
- **Supported-ATS-only cache:** Current `companies` writes reject unsupported hosts; Phase 1 must separate supported ATS promotion from unsupported/custom public-page cache records. [VERIFIED: src/cli/companies.mjs; .planning/phases/01-decomposition-map/01-CONTEXT.md]
- **Model-generated final URLs:** Requirements say URL resolution must be deterministic and validated, not trusted from model output. [VERIFIED: .planning/REQUIREMENTS.md]
- **Hand-editing generated state:** DB workspaces should write through verbs/helpers rather than generated tracker/source compatibility files. [VERIFIED: AGENTS.md; src/cli/data-route.mjs]
- **Putting candidate-specific source discoveries in shipped docs:** `docs/SOURCES.md` is field-neutral provider infrastructure; discovered boards belong in user config/research logs. [VERIFIED: docs/SOURCES.md; tests/release-safety.test.mjs]

## Discover-Companies Target Contract

Phase 1 should document this target contract, not implement it. [VERIFIED: .planning/ROADMAP.md]

| Stage | Owner | Contract |
|-------|-------|----------|
| Context load | Planned `src/core/discovery/company-context.mjs`; existing inputs from candidate config and tracker | Read candidate domain, role families, keep/cut signals, exclusions, compensation screen, and already-in-play companies through DB-first accessors or compatibility exports. [VERIFIED: .agents/skills/discover-companies/SKILL.md; src/core/profile/config-store.mjs] |
| AI seed generation | Planned local route using `runStructuredOneshot()` and `callAI()` labels | Return schema-validated company seeds only; do not return trusted final careers URLs. [VERIFIED: src/core/ai/structured-oneshot.mjs; .planning/REQUIREMENTS.md] |
| Seed schema | Planned `config/company-seeds.schema.json` | Fields should include `companyName`, optional `domain`, `whyFit`, `roleFamilies`, `signals`, `seedSource`, `confidence`, and `excludedCandidate`/`dedupeKey`; final URLs should be absent or marked untrusted hints only. [VERIFIED: .planning/REQUIREMENTS.md; .planning/phases/01-decomposition-map/01-CONTEXT.md] |
| Board resolver | Planned `src/core/discovery/company-board-resolver.mjs` | Resolve company homepage/careers page/job board deterministically using fetched pages, known ATS URL patterns, and cache lookup before any AI search fallback. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md; src/core/scoring/sourced-scanner.mjs] |
| Resolution cache | Planned DB migration near `src/core/db/migrations/005-source-config.mjs` and verbs near `src/core/db/verbs/source-config.mjs` | Persist D-05 fields: company name/domain, careers URL, board URL, provider, API URL, confidence, provenance, first/last times, last scan result, and failure counters. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md; src/core/db/migrations/005-source-config.mjs] |
| Supported ATS scan | Existing `fetchProvider()` / `scanCompanies()` / `runSourcedScan()` | Use current Ashby, Greenhouse, Lever, Workable, SmartRecruiters, and RSS provider fetchers where possible. [VERIFIED: src/core/scoring/sourced-scanner.mjs; scripts/scan-sourced.mjs] |
| Generic public extraction | Planned extractor normalized to scanner offer shape | Use Node `fetch` first, then Playwright for public JS-rendered pages; leave authenticated sources to v2. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md; scripts/capture-search-sources.mjs] |
| Gate/dedupe | Existing scanner filters plus planned company proposal gate | Reuse title/location filters, excluded-company checks, req-id URL dedupe, and scoring where job offers are available. [VERIFIED: src/core/scoring/sourced-scanner.mjs] |
| Confirmation | Existing discovery route/chat posture; planned local proposal API | Present high-confidence and borderline proposals before writes; default confirm-first. [VERIFIED: src/cli/discovery-route.mjs; .agents/skills/discover-companies/SKILL.md] |
| Write path | Supported ATS: `careerrat companies` / `companyAtsUpsert()`; generic cache: planned cache verb | Supported ATS entries can promote to `sourced-scan`; unsupported/custom pages must remain in resolver cache until generic extraction support can scan them. [VERIFIED: src/cli/companies.mjs; src/core/db/verbs/source-config.mjs; .planning/phases/01-decomposition-map/01-CONTEXT.md] |

## High-Priority Skill Decomposition Targets

| Skill | Deterministic Pieces | Bounded AI Pieces | Full-Skill Runtime Pieces | Deferred Pieces |
|-------|----------------------|-------------------|---------------------------|-----------------|
| `setup-searches` | Candidate config read, source generation, URL import, enable/disable, schema validation via `careerrat searches`. [VERIFIED: .agents/skills/setup-searches/SKILL.md; src/cli/searches.mjs] | None required for Phase 1. [VERIFIED: .agents/skills/setup-searches/SKILL.md] | Conversational curation and user corrections. [VERIFIED: .agents/skills/setup-searches/SKILL.md] | Durable source-preference helper gap noted in skill. [VERIFIED: .agents/skills/setup-searches/SKILL.md] |
| `research-boards` | Dedupe configured sources, add confirmed URLs through `careerrat searches`, optional research log. [VERIFIED: .agents/skills/research-boards/SKILL.md; src/cli/searches.mjs] | Later board ranking/extraction could be bounded, but current skill uses web search. [VERIFIED: .agents/skills/research-boards/SKILL.md] | Web-search board discovery and confirm-first screening stays skill/chat until decomposed. [VERIFIED: src/core/ai/chat-runtime.mjs; .agents/skills/research-boards/SKILL.md] | Broad provider bakeoff and candidate-specific board research automation. [VERIFIED: .planning/REQUIREMENTS.md] |
| `discover-companies` | Context load, dedupe, resolver cache, direct ATS scan, generic extraction, proposal/write gate. [VERIFIED: .agents/skills/discover-companies/SKILL.md; .planning/phases/01-decomposition-map/01-CONTEXT.md] | Company seed generation and ambiguous ranking through schema-validated JSON. [VERIFIED: .planning/REQUIREMENTS.md; src/core/ai/structured-oneshot.mjs] | User-led refinement, exploratory search, and ambiguous cases. [VERIFIED: src/core/ai/chat-runtime.mjs; .agents/skills/discover-companies/SKILL.md] | Browser-authenticated sources and vendor commitment. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md] |
| `search-jobs` | `runSourcedScan()`, provider fetches, scoring, dedupe, liveness, JD capture, sourced writes. [VERIFIED: scripts/scan-sourced.mjs; src/core/scoring/sourced-persistence.mjs] | None required for deterministic scan path. [VERIFIED: scripts/scan-sourced.mjs] | Agent orchestration for browser/auth fallbacks and optional evaluate-job handoff. [VERIFIED: .agents/skills/search-jobs/SKILL.md] | Authenticated saved-search sources beyond explicit consent gates. [VERIFIED: .agents/skills/search-jobs/SKILL.md] |
| `evaluate-job` | Deterministic legitimacy, comp extraction, saved JD handling, tracker write-back pieces. [VERIFIED: .agents/skills/evaluate-job/SKILL.md; src/core/evaluate/gate.mjs] | Future bounded assists may summarize structured judgments, but body-read gate remains evidence-bound. [VERIFIED: .planning/REQUIREMENTS.md] | Body-read judgment and ambiguous fit/comp/action verdicts remain skill-owned until v2 decomposition. [VERIFIED: .agents/skills/evaluate-job/SKILL.md] | Broader migration is v2 MIGR-02. [VERIFIED: .planning/REQUIREMENTS.md] |
| `apply-job` | Application-limit checks, form-fill recipes, artifact registration, tracker status writes. [VERIFIED: .agents/skills/apply-job/SKILL.md; src/core/apply/form-fill.mjs] | None for Phase 1. [VERIFIED: .planning/ROADMAP.md] | Live browser form interaction and submission supervision remain full skill. [VERIFIED: .agents/skills/apply-job/SKILL.md] | Automatic submission remains out of scope. [VERIFIED: .planning/REQUIREMENTS.md] |
| `email-comms` | Thread matching, comm/message DB verbs, draft persistence, CTA clearing. [VERIFIED: .agents/skills/email-comms/SKILL.md; src/core/db/verbs/comm.mjs] | Draft generation can later become bounded where context is finite. [VERIFIED: .planning/REQUIREMENTS.md] | Negotiation, nuanced reply strategy, and ambiguous threading remain full skill. [VERIFIED: .agents/skills/email-comms/SKILL.md] | Communications migration is v2 MIGR-03. [VERIFIED: .planning/REQUIREMENTS.md] |
| `interview-prep` | Packet renderer, story-bank reads, artifact registration, schedule fields. [VERIFIED: .agents/skills/interview-prep/SKILL.md; src/core/interview/packet.mjs] | Future structured packet assists may be bounded after discovery proves pattern. [VERIFIED: .planning/REQUIREMENTS.md] | Live coaching, debrief synthesis, and nuanced packet assembly remain full skill. [VERIFIED: .agents/skills/interview-prep/SKILL.md] | Communications/interview migration is v2 MIGR-03. [VERIFIED: .planning/REQUIREMENTS.md] |
| `track-outcomes` | Status transitions, app/comm write-back, analytics refresh, validation. [VERIFIED: .agents/skills/track-outcomes/SKILL.md; src/core/db/verbs/app.mjs] | None required for ordinary status changes. [VERIFIED: src/core/intake/dispatch.mjs] | Ambiguous outcome interpretation and learning synthesis remain skill-owned. [VERIFIED: .agents/skills/track-outcomes/SKILL.md] | Cross-record combined transactions are not present today. [VERIFIED: .agents/skills/track-outcomes/SKILL.md] |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Structured AI JSON parsing | A new JSON regex/retry loop | `runStructuredOneshot()` | It already extracts fenced JSON, validates against schemas, and retries once with real errors. [VERIFIED: src/core/ai/structured-oneshot.mjs; tests/structured-oneshot.test.mjs] |
| AI route selection and labels | Per-route BYOK/proxy branching | `callAI()` / existing AI route helpers | They already implement BYOK/proxy/no-AI behavior and usage labels. [VERIFIED: src/core/ai/call-ai.mjs] |
| Full skill execution | A new agent runner | `POST /api/skill/run` / `runSkillStream()` / chat runtime | Existing runtimes handle allowlists, tool surfaces, SSE, aborts, and no-AI errors. [VERIFIED: src/cli/skill-run-route.mjs; src/core/ai/skill-runtime.mjs; src/core/ai/chat-runtime.mjs] |
| Supported ATS scanning | New provider clients | `fetchProvider()` / `scanCompanies()` | Current scanner supports Ashby, Greenhouse, Lever, Workable, SmartRecruiters, and RSS. [VERIFIED: src/core/scoring/sourced-scanner.mjs] |
| Sourced row persistence | Manual tracker edits | `captureAndPersistOffersIfDb()` / `sourcedUpsertBatch()` | Existing path captures JD files and writes sourced rows through DB verbs in DB mode. [VERIFIED: src/core/scoring/sourced-persistence.mjs; src/core/db/verbs/sourced.mjs] |
| Search/source writes | Direct YAML/JSON writes in DB workspaces | `careerrat searches`, `careerrat companies`, source-config verbs | Existing helpers validate, dedupe, and respect DB-vs-compat behavior. [VERIFIED: src/cli/searches.mjs; src/cli/companies.mjs; src/core/db/verbs/source-config.mjs] |
| Route body parsing | New uncapped body readers | `readJsonBodyCapped()` | Existing route helper enforces a 1MB cap and clean 400/413 responses. [VERIFIED: src/cli/skill-run-route.mjs] |
| Candidate-specific source registry | Updating shipped `docs/SOURCES.md` | User source config and workspace research logs | Release-safety tests guard against private/candidate-specific source leakage. [VERIFIED: docs/SOURCES.md; tests/release-safety.test.mjs] |

**Key insight:** The migration should be decomposition, not replacement; most future tasks should wire existing deterministic modules and verbs into new route contracts instead of re-implementing scanning, writing, validation, or skill execution. [VERIFIED: .planning/PROJECT.md; docs/ARCHITECTURE.md]

## Common Pitfalls

### Pitfall 1: Supported ATS Gate Hiding the Generic Cache Requirement
**What goes wrong:** The plan only documents adding companies through `careerrat companies`, so unsupported/custom public career pages remain "intel only." [VERIFIED: .agents/skills/discover-companies/SKILL.md; src/cli/companies.mjs]
**Why it happens:** `companyAtsUpsert()` currently rejects URLs with no supported inferred provider. [VERIFIED: src/core/db/verbs/source-config.mjs]
**How to avoid:** The target contract must create a separate resolver-cache concept from supported ATS promotion. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md]
**Warning signs:** A proposed schema only has `tracked_companies[].careers_url` and no cache state for unsupported/custom pages. [VERIFIED: config/sourced-scan.example.json]

### Pitfall 2: Re-Resolving Boards on Every Sweep
**What goes wrong:** Sourcing cost and latency stay high because every search repeats company careers-page discovery. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md]
**Why it happens:** Current `discover-companies` is an agent-led web-search workflow rather than a durable resolver cache. [VERIFIED: .agents/skills/discover-companies/SKILL.md]
**How to avoid:** Cache resolution records and only re-resolve on TTL, 404/403, redirects, repeated zero-job scans, stale windows, or explicit refresh. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md]
**Warning signs:** A route named "refresh companies" calls AI/web search before checking saved board metadata. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md]

### Pitfall 3: Trusting AI With Final URLs
**What goes wrong:** Model output becomes a trusted write path for careers URLs or provider APIs. [VERIFIED: .planning/REQUIREMENTS.md]
**Why it happens:** The current skill uses web search for both seed discovery and board resolution in one agent loop. [VERIFIED: .agents/skills/discover-companies/SKILL.md]
**How to avoid:** AI should generate seeds and rationale; deterministic resolver code should validate URLs and provider/API identity. [VERIFIED: .planning/REQUIREMENTS.md]
**Warning signs:** The AI seed schema includes `careers_url` as a write-ready field instead of an untrusted hint. [VERIFIED: .planning/REQUIREMENTS.md]

### Pitfall 4: Full Skill Runtime for Cheap Deterministic Work
**What goes wrong:** UI buttons launch skill sessions for actions already implemented as local modules. [VERIFIED: src/cli/search-route.mjs; src/cli/skill-run-route.mjs]
**Why it happens:** `/api/discovery/next` currently starts chat sessions for discovery skills. [VERIFIED: src/cli/discovery-route.mjs]
**How to avoid:** Routing policy should prefer local routes for deterministic scans, DB writes, and bounded schema outputs; retain skill/chat fallback for exploratory or confirm-first work. [VERIFIED: src/core/intake/dispatch.mjs; src/cli/discovery-route.mjs]
**Warning signs:** A new app control posts to `/api/skill/run` even though it calls `runSourcedScan()` or a DB verb. [VERIFIED: scripts/scan-sourced.mjs; src/cli/data-route.mjs]

### Pitfall 5: Skipping Immediate JD Capture
**What goes wrong:** Discovered jobs enter sourced state with links but no durable JD body. [VERIFIED: AGENTS.md]
**Why it happens:** Provider listings can include metadata without full body text unless capture/persistence is wired. [VERIFIED: src/core/scoring/sourced-persistence.mjs]
**How to avoid:** All lanes must normalize body text and call the existing capture/persist path or mark partial capture explicitly. [VERIFIED: src/core/scoring/sourced-persistence.mjs; .agents/skills/search-jobs/SKILL.md]
**Warning signs:** A proposed provider bakeoff counts jobs but does not measure full JD capture quality. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md]

## Code Examples

Verified patterns from repo sources:

### Local API Route Pattern
```js
// Source: src/cli/search-route.mjs
export function mountSearchRoutes({ addRoute, repoRoot, env = process.env, fetchImpl = fetch }) {
  addRoute("POST", "/api/search/scan", async (req, res) => {
    const summary = await runSourcedScan({ repoRoot, env, fetchImpl, write: true });
    sendJson(res, 200, summary);
  });
}
```

### Bounded Structured AI Pattern
```js
// Source: src/cli/assist-route.mjs + src/core/ai/structured-oneshot.mjs
const outcome = await runStructuredOneshot({
  schema,
  maxRetries: 1,
  invoke,
});
```

### Supported ATS Provider Dispatch
```js
// Source: src/core/scoring/sourced-scanner.mjs
export async function fetchProvider(provider, entry, fetchImpl = fetch) {
  if (provider === "ashby") return fetchAshby(entry, fetchImpl);
  if (provider === "greenhouse") return fetchGreenhouse(entry, fetchImpl);
  if (provider === "lever") return fetchLever(entry, fetchImpl);
  if (provider === "workable") return fetchWorkable(entry, fetchImpl);
  if (provider === "smartrecruiters") return fetchSmartRecruiters(entry, fetchImpl);
  if (provider === "rss") return fetchRss(entry, fetchImpl);
  throw new Error(`unsupported provider: ${provider}`);
}
```

### Source Config Write Pattern
```js
// Source: src/core/db/verbs/source-config.mjs
export function companyAtsUpsert({ repoRoot, env, entry } = {}) {
  const normalized = normalizeCompanyEntry(entry);
  // writes sourced-scan config in SQLite-backed source config
}
```

## State of the Art

| Old Approach | Current / Target Approach | When Changed | Impact |
|--------------|---------------------------|--------------|--------|
| Whole skill session for discovery actions | Local deterministic APIs and bounded structured AI for decomposed pieces, with skill/chat fallback for exploratory flows | Active project direction dated 2026-07-04 | Phase 1 must document owners before implementation. [VERIFIED: .planning/PROJECT.md; .planning/ROADMAP.md] |
| `discover-companies` resolves only supported ATS boards for `careerrat companies` | Target contract separates supported ATS promotion from unsupported/custom public-page resolver cache | Locked Phase 1 context dated 2026-07-04 | Later plans can implement generic extraction without weakening current supported-ATS writes. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md] |
| Scanner-only company watchlist in `config/sourced-scan.json` / DB source config | Existing scanner remains supported-ATS owner; new cache stores board resolution metadata separately | Current code plus Phase 1 direction | Avoid overloading `tracked_companies` with unscannable pages. [VERIFIED: src/core/db/verbs/source-config.mjs; config/sourced-scan.example.json] |
| App discovery route starts chat sessions for research/discover/search | Future discovery controls should call local APIs for deterministic or bounded-AI pieces | Phase 4 roadmap target, Phase 1 policy prerequisite | Routing policy prevents UI from overusing `/api/skill/run`. [VERIFIED: src/cli/discovery-route.mjs; .planning/ROADMAP.md] |

**Deprecated/outdated:**
- Treating unsupported/custom public career pages as useless "intel only" is outdated for this phase because D-14 requires caching unsupported/custom public pages for generic extraction. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md]
- Treating `/api/skill/run` as the default implementation path is outdated for deterministic or bounded app actions because the project core value reserves AI for judgment that needs a model. [VERIFIED: .planning/PROJECT.md]

## Assumptions Log

All factual claims in this research were traced to repo files, phase context, commands, or targeted tests. No `[ASSUMED]` claims are used. [VERIFIED: codebase grep; environment probe; test run]

## Open Questions (RESOLVED)

1. **Should `.planning/architecture/skill-decomposition.yml` become runtime-consumed later?**
   - What we know: Phase 1 only needs an implementation map before runtime changes. [VERIFIED: .planning/ROADMAP.md]
   - Deferred boundary: Future phases may want route code to consume decomposition metadata. [VERIFIED: .planning/STATE.md]
   - Resolution: Keep Phase 1 artifacts testable but not runtime-consumed; defer runtime consumption until routing code needs it. [VERIFIED: .planning/ROADMAP.md]

2. **Which UI surface should confirm company proposals?**
   - What we know: Current `/api/discovery/next` starts confirm-first chat sessions and `/search` owns scan controls. [VERIFIED: src/cli/discovery-route.mjs; src/cli/search-route.mjs]
   - Deferred boundary: The final proposal confirmation surface is not locked in STATE. [VERIFIED: .planning/STATE.md]
   - Resolution: Phase 1 names a "discovery proposal confirmation" contract without binding the final screen; Phase 3/4 can choose the UI. [VERIFIED: .planning/ROADMAP.md]

3. **What exact DB table should hold board-resolution cache?**
   - What we know: Existing source config table only stores `search-sources` and `sourced-scan`, and company ATS entries reject unsupported hosts. [VERIFIED: src/core/db/migrations/005-source-config.mjs; src/core/db/verbs/source-config.mjs]
   - Deferred boundary: Whether to extend `candidate_source_configs` JSON or add a dedicated table is not implemented. [VERIFIED: codebase grep]
   - Resolution: Phase 1 target contract specifies the fields and owner boundary; Phase 3 chooses table shape with tests. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Runtime and `node:test` | yes | v24.18.0 | Required by package engines. [VERIFIED: environment probe; package.json] |
| npm | Scripts and package metadata | yes | 11.16.0 | Use direct `node` commands for focused tests. [VERIFIED: environment probe] |
| git | Status and optional docs commit | yes | 2.53.0 | None needed. [VERIFIED: environment probe] |
| ripgrep | Codebase tracing | yes | 15.1.0 | `grep` if unavailable. [VERIFIED: environment probe] |
| Repo-local CareerRat CLI | Local command surface | yes via `node bin/careerrat.mjs` | 0.5.2 | Use `npm run <script>` or `node src/cli/*.mjs`. [VERIFIED: environment probe; package.json] |
| Global `careerrat` on PATH | Convenience command | no | command not found | Use `node bin/careerrat.mjs`. [VERIFIED: environment probe] |
| SQLite workspace DB | DB-mode local state | no current DB | `careerrat data status` reports no database | Planning phase can proceed; implementation plans should not assume DB state exists in this workspace. [VERIFIED: environment probe] |

**Missing dependencies with no fallback:**
- None for Phase 1 planning artifacts. [VERIFIED: environment probe]

**Missing dependencies with fallback:**
- Global `careerrat` command is unavailable; use `node bin/careerrat.mjs` or npm scripts. [VERIFIED: environment probe]

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` on Node v24.18.0. [VERIFIED: package.json; environment probe] |
| Config file | none for test runner; package script is in `package.json`. [VERIFIED: package.json] |
| Quick run command | `node --test tests/decomposition-map.test.mjs` after Wave 0 creates it. [VERIFIED: tests directory] |
| Full suite command | `npm test` (`node --test 'tests/**/*.test.mjs'`). [VERIFIED: package.json] |

### Existing Verification Baseline

The command `node --test tests/structured-oneshot.test.mjs tests/discovery-route.test.mjs tests/search-route.test.mjs tests/companies-cli.test.mjs tests/db-source-config.test.mjs` passed 38 tests during research. [VERIFIED: test run]

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| ARCH-01 | Decomposition inventory exists and every high-priority skill has deterministic, bounded AI, full-skill, prompt/spec, and deferred buckets. | unit / doc-shape | `node --test tests/decomposition-map.test.mjs -x` | no - Wave 0 |
| ARCH-02 | Every inventory owner path either exists now or is explicitly prefixed as planned. | unit / doc-shape | `node --test tests/decomposition-map.test.mjs -x` | no - Wave 0 |
| ARCH-03 | Routing policy contains local API, DB verb/CLI, bounded AI, `/api/chat/*`, and `/api/skill/run` decision rules. | unit / doc-shape | `node --test tests/decomposition-map.test.mjs -x` | no - Wave 0 |

### Sampling Rate
- **Per task commit:** `node --test tests/decomposition-map.test.mjs` after Wave 0 exists. [VERIFIED: package.json]
- **Per wave merge:** `npm test`. [VERIFIED: package.json]
- **Phase gate:** Full suite green before `$gsd-verify-work`. [VERIFIED: .planning/config.json]

### Wave 0 Gaps
- [ ] `tests/decomposition-map.test.mjs` - parses `.planning/architecture/skill-decomposition.yml` and checks ARCH-01/ARCH-02/ARCH-03 coverage. [VERIFIED: tests directory]
- [ ] `.planning/architecture/skill-decomposition.yml` - canonical inventory artifact. [VERIFIED: .planning/ROADMAP.md]
- [ ] `.planning/architecture/discover-companies-target-contract.md` - detailed contract artifact. [VERIFIED: .planning/ROADMAP.md]
- [ ] `.planning/architecture/runtime-routing-policy.md` - routing policy artifact. [VERIFIED: .planning/ROADMAP.md]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no for Phase 1 docs | Authenticated browser automation is deferred; do not add browser-auth requirements in Phase 1. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md] |
| V3 Session Management | no for Phase 1 docs | Existing chat/skill sessions are already route-owned; Phase 1 should only document routing. [VERIFIED: src/core/ai/chat-runtime.mjs; src/cli/skill-run-route.mjs] |
| V4 Access Control | yes for runtime policy | Preserve skill allowlists and route selection rules for `/api/skill/run` and `/api/chat/*`. [VERIFIED: src/core/ai/skill-runtime.mjs; src/core/ai/chat-runtime.mjs] |
| V5 Input Validation | yes | Use schemas for machine-readable planning artifacts and future AI seed outputs; reuse existing schema validation helpers. [VERIFIED: src/core/profile/schema-validator.mjs; src/core/ai/structured-oneshot.mjs] |
| V6 Cryptography | no new crypto | Phase 1 should not add secret storage or encryption changes. [VERIFIED: .planning/ROADMAP.md] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection from web/JD/career-page text | Tampering | Treat fetched content as untrusted data; AI seed output cannot directly write URLs or state. [VERIFIED: $HOME/.codex/gsd-core/references/untrusted-input-boundary.md; .planning/REQUIREMENTS.md] |
| Candidate/private data leakage into shipped docs | Information Disclosure | Keep candidate-specific discoveries in user config/workspace logs; use release-safety tests for shipped docs. [VERIFIED: docs/SOURCES.md; tests/release-safety.test.mjs] |
| Over-broad skill runtime access | Elevation of Privilege | Keep `/api/skill/run` allowlisted and use local routes for deterministic work. [VERIFIED: src/core/ai/skill-runtime.mjs; src/cli/skill-run-route.mjs] |
| Unvalidated AI JSON controlling downstream code | Tampering | Validate against JSON schema with `runStructuredOneshot()` and reject malformed/invalid outputs. [VERIFIED: src/core/ai/structured-oneshot.mjs; tests/structured-oneshot.test.mjs] |
| Arbitrary URL resolver fetches becoming SSRF-like local probes | Spoofing / Information Disclosure | Future resolver should validate schemes/hosts, time out fetches, and persist provenance; Phase 1 should name this as a resolver contract requirement. [VERIFIED: src/core/scoring/sourced-scanner.mjs; .planning/phases/01-decomposition-map/01-CONTEXT.md] |

## Sources

### Primary (HIGH confidence)
- `.planning/phases/01-decomposition-map/01-CONTEXT.md` - locked sourcing cascade, cache, scraping posture, and artifact scope. [VERIFIED: file read]
- `.planning/REQUIREMENTS.md` - ARCH-01/02/03 and downstream AIR/DISC/RUNT/VER requirements. [VERIFIED: file read]
- `.planning/ROADMAP.md` - Phase 1 success criteria and future phase boundaries. [VERIFIED: file read]
- `.planning/PROJECT.md` - project-level skill-to-local-API direction. [VERIFIED: file read]
- `AGENTS.md` - operating contracts for skills, write paths, discovery order, and domain-neutral constraints. [VERIFIED: file read]
- `.agents/skills/discover-companies/SKILL.md`, `.agents/skills/search-jobs/SKILL.md`, `.agents/skills/research-boards/SKILL.md`, `.agents/skills/setup-searches/SKILL.md` - discovery skill contracts. [VERIFIED: file read]
- `src/cli/skill-run-route.mjs`, `src/core/ai/skill-runtime.mjs`, `src/core/ai/chat-runtime.mjs` - full skill and chat runtime owners. [VERIFIED: file read]
- `src/core/ai/call-ai.mjs`, `src/core/ai/structured-oneshot.mjs`, `src/cli/assist-route.mjs` - bounded AI owners and examples. [VERIFIED: file read]
- `src/core/scoring/sourced-scanner.mjs`, `scripts/scan-sourced.mjs`, `src/core/scoring/sourced-persistence.mjs` - deterministic scanner and sourced persistence owners. [VERIFIED: file read]
- `src/core/db/verbs/source-config.mjs`, `src/cli/companies.mjs`, `src/cli/searches.mjs`, `src/core/providers/search-sources.mjs` - source config write owners. [VERIFIED: file read]

### Secondary (MEDIUM confidence)
- Targeted test run covering structured one-shot, discovery route, search route, companies CLI, and DB source config. [VERIFIED: test run]
- Environment probes for Node, npm, git, rg, repo-local CareerRat CLI, and DB status. [VERIFIED: environment probe]

### Tertiary (LOW confidence)
- None used. No web search results or training-only claims were used. [VERIFIED: research-plan seam returned no external items]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - based on `package.json`, local environment probes, and existing code owners. [VERIFIED: package.json; environment probe; codebase grep]
- Architecture: HIGH - based on phase context, roadmap requirements, and direct route/module tracing. [VERIFIED: .planning/phases/01-decomposition-map/01-CONTEXT.md; codebase grep]
- Pitfalls: HIGH - based on current code gaps and locked context, especially supported-ATS-only writes versus generic cache requirement. [VERIFIED: src/cli/companies.mjs; src/core/db/verbs/source-config.mjs; .planning/phases/01-decomposition-map/01-CONTEXT.md]

**Research date:** 2026-07-04
**Valid until:** 2026-08-03 for Phase 1 planning artifacts; re-check if source-config or discovery route code changes first. [VERIFIED: current date; codebase grep]
