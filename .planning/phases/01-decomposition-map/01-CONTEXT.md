# Phase 1: Decomposition Map - Context

**Gathered:** 2026-07-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 produces the implementation map for converting Rolester discovery from whole-skill execution into cheaper app/runtime primitives. It does not implement the new discovery runtime yet. It must define the decomposition artifact, the `discover-companies` target contract, the sourcing cascade, and the routing policy for when Rolester uses deterministic code, bounded AI, external tools, or the retained full skill runtime.

</domain>

<decisions>
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
The agent may choose exact artifact format, route names, schema names, and cache table shape, provided the plan preserves the cascade above, keeps writes confirm-first where current skills require it, and references existing Rolester modules rather than inventing parallel systems.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### GSD Project Direction
- `.planning/PROJECT.md` - Project-level decision that skills become contracts while deterministic code owns deterministic work.
- `.planning/REQUIREMENTS.md` - Current v1/v2 requirements; note the Phase 1 context above clarifies that sourcing must include generic public-page extraction, not only supported ATS URLs.
- `.planning/ROADMAP.md` - Phase boundaries and success criteria for Decomposition Map and Company Discovery API.
- `.planning/config.json` - Current GSD quality/automation settings.

### Rolester Operating Contract
- `AGENTS.md` - Data write contracts, JD-body capture invariant, browser automation deferral, and job-search workflow routing.
- `docs/ARCHITECTURE.md` - Existing skill/script/source layer split and provider adapter expectations.
- `docs/SOURCES.md` - Source-layer guidance referenced by architecture docs.

### Current Skill Contracts
- `.agents/skills/discover-companies/SKILL.md` - Current agent-led company discovery flow and confirm-first write contract.
- `.agents/skills/search-jobs/SKILL.md` - Current sourced sweep contract.
- `.agents/skills/research-boards/SKILL.md` - Current board/source discovery contract.
- `tmp-skill-conversion/discover-companies/SKILL.md` - Local conversion scratch copy, if still present.

### Existing Runtime Owners
- `src/cli/discovery-route.mjs` - Current app discovery route starts or reuses full skill chat sessions.
- `src/core/ai/skill-runtime.mjs` - Current full `SKILL.md` runtime path via `POST /api/skill/run`.
- `src/core/ai/call-ai.mjs` - Existing bounded AI invocation and labeling path.
- `src/core/ai/structured-oneshot.mjs` - Existing schema-validated structured model call helper.
- `src/core/scoring/sourced-scanner.mjs` - Existing deterministic scanner, title/location filters, scoring, dedupe, provider fetchers, and JD text extraction helpers.
- `src/core/db/verbs/source-config.mjs` - Existing DB-backed source config and `companyAtsUpsert` write path.
- `src/core/db/verbs/sourced.mjs` - Existing sourced-row write path.
- `src/cli/companies.mjs` - Existing CLI for tracked company ATS sources.
- `config/search-sources.schema.json` - Current search source config schema and source type vocabulary.
- `config/sourced-scan.example.json` - Current tracked-company scanner config shape.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/core/scoring/sourced-scanner.mjs`: already supports Ashby, Greenhouse, Lever, Workable, SmartRecruiters, RSS, filtering, dedupe, scoring, and body text extraction. New resolution/cache work should feed this scanner where possible.
- `src/core/db/verbs/source-config.mjs`: already owns DB-backed `search-sources` and `sourced-scan` config. New resolver cache should integrate with DB-backed config instead of hand-editing generated tracker files.
- `src/cli/companies.mjs`: existing confirm-first mental model for adding tracked company sources. It currently rejects unsupported hosts, so the new design needs either a separate resolver cache or an expanded source config for unsupported/custom pages.
- `src/core/ai/structured-oneshot.mjs`: suitable for bounded AI seed generation or JSON normalization when cheaper deterministic paths cannot produce enough candidates.
- Playwright is already in dev dependencies, so public JS-rendered career page extraction can be planned without adding a new browser package.

### Established Patterns
- DB workspaces use `rolester data`/DB verbs as source of truth; `workspace/tracker.json` is generated compatibility output.
- Confirm-first writes are part of `discover-companies` and `research-boards`; high-confidence auto-add can be a later explicit mode, not the default assumption.
- Full skill runtime exists and should remain as a fallback for long-running, tool-heavy, or user-led workflows.
- Source and scan code is domain-neutral; new provider/crawler adapters should not hardcode real employer assumptions.

### Integration Points
- A new resolver cache likely belongs near DB source config, not in `workspace/tracker.json`.
- A new provider/local scraper interface should normalize into the same sourced-offer shape consumed by scanner/dedupe/scoring.
- The app discovery route should eventually call new local API routes for deterministic and bounded-AI work, while retaining skill chat handoff as fallback.
- Existing JD-body capture and sourced write contracts must apply to any new source lane.

</code_context>

<specifics>
## Specific Ideas

- Use free/local scrapers for public non-job-board career pages before paid tools.
- Cache company board discovery so repeated sweeps do not re-resolve the same careers site.
- Treat job APIs, Firecrawl, Tavily/search-extract, and direct scraping as a measured bakeoff.
- Defer browser-authenticated automation to v2; public Playwright extraction is allowed for v1 source experiments.
- Do not optimize Phase 1 around avoiding scraping. Optimize around figuring out the cheapest reliable sourcing cascade.

</specifics>

<deferred>
## Deferred Ideas

- Browser-authenticated sources such as LinkedIn, Wellfound, and logged-in portals remain v2 unless a future plan explicitly moves them forward.
- Managed paid provider commitments should wait until the bakeoff produces data.
- Automatic application submission remains out of scope.

</deferred>

---

*Phase: 1-Decomposition Map*
*Context gathered: 2026-07-04*
