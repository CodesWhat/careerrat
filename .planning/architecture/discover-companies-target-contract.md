# Discover Companies Target Contract

This contract defines the future decomposed `discover-companies` pipeline. It is a
Phase 1 planning artifact only: later implementation plans may create runtime
routes, DB verbs, tests, and UI surfaces from it, but this file does not require
or authorize runtime source changes.

## Phase Boundary

Phase 1 establishes owner boundaries for `discover-companies`; it does not build
the runtime pipeline. The target shape follows D-12 and D-13: the skill remains
the agent-facing workflow contract, while product runtime decomposes the work
into deterministic code, DB/source verbs, scanners/extractors, bounded structured
AI, and retained full skill runtime for the cases that still need a live agent
loop.

This contract also preserves the Phase 1 sourcing decisions:

- D-01: support multiple sourcing lanes instead of selecting one vendor or tool.
- D-02: use the cheapest-first order before expensive AI or full skill runtime.
- D-03: keep AI web search for gaps, ranking, judgment, and ambiguous resolution,
  not routine repeated scans.
- D-07: public non-job-board pages may be fetched with Node `fetch` first, then
  Playwright for public JS-rendered pages when needed.
- D-08: ordinary scraping/legal/copyright concern is not the primary design
  blocker for Phase 1. Practical scraping priorities are freshness, disappearing
  postings, cost, reliability, cacheability, and immediate JD capture.
- D-09: every discovered job must preserve the first reachable full JD body
  locally as soon as it is found.
- D-14: supported ATS promotion and unsupported public-page cache are separate
  concepts so public/custom career pages can be cached for later extraction
  without weakening today's supported-ATS scanner path.

Authenticated browser automation is outside Phase 1. Logged-in LinkedIn,
Wellfound, webmail, authenticated ATS portals, captchas, 2FA, and session-browser
work remain v2 or full-skill/manual fallback territory.

## Inputs

The future pipeline receives inputs from existing Rolester state and skill
contracts:

- Candidate context: role families, keep/cut signals, excluded companies,
  location posture, comp floor screen, and usage modes from DB-backed candidate
  config or compatibility exports.
- Dedup context: already tracked companies, applications, sourced rows, rejected
  or excluded companies, and source watermarks.
- Existing source config: DB/source config for `search-sources` and
  `sourced-scan`, plus legacy config exports where DB mode is absent.
- User intent and confirmation posture: default confirm-first, optional explicit
  auto-add for high-confidence supported ATS entries only.
- Optional external discovery inputs: pasted company lists, public company
  homepages, public careers URLs, public board pages, and bounded AI seed
  generation.

No model output is a trusted write input. No model output can directly create a
tracked company, trusted URL, sourced row, or source config entry.

## AI Seed Schema

Bounded AI seed generation uses `runStructuredOneshot()` through the existing
`callAI()` route selection and usage-label path. The schema name is
`companySeedSchema`.

`companySeedSchema` returns:

- `companies[].name`: required company display name proposed by the model.
- `companies[].domain_hint`: optional untrusted website or domain hint.
- `companies[].why`: short reason tied to candidate role families or keep
  signals.
- `companies[].role_family_hint`: role family or bucket that made the company
  plausible.
- `companies[].confidence`: model confidence in the seed as a candidate for
  deterministic resolution, not as a write decision.
- `companies[].source_hint`: short hint about why the model surfaced the company
  or where it may have seen the signal.

Seed output is not write-ready. Per D-03 and D-13, `companySeedSchema` exists to
suggest candidates for deterministic resolution, gap filling, ranking, and
ambiguous discovery. It must not include final trusted `careers_url`, `job_board_url`,
`api_url`, provider identity, or write approval. If a future schema includes URL
hints, they remain untrusted hints until the resolver validates scheme, host,
redirects, provider identity, provenance, and fetch results.

## Resolver Cache Contract

The durable resolver concept is `companyBoardResolutionCache`. It records the
best known public board resolution for a company so repeated sweeps do not
rediscover the same careers page on every run.

`companyBoardResolutionCache` fields:

- `company_name`
- `company_domain`
- `careers_url`
- `job_board_url`
- `ats_provider`
- `api_url`
- `confidence`
- `source_provenance`
- `first_resolved_at`
- `last_verified_at`
- `last_scan_result`
- `failure_count`
- `next_refresh_reason`

The cache implements D-04, D-05, and D-06:

- Resolve once, then scan cached metadata on future runs.
- Preserve provenance for how the resolver found or validated each URL.
- Re-resolve only when a cache trigger fires: 404/403, redirect, provider or ATS
  change, repeated zero-job scans, stale TTL/window, explicit user refresh,
  or a failed generic extraction.
- Track failures without erasing the last known good result.
- Treat model seed data and fetched public pages as untrusted until deterministic
  validation passes.

Resolver validation for future implementation should reject non-http schemes,
local/private hosts, unsupported redirects, provider mismatches, and missing
provenance before cache promotion.

## Cheapest-First Sourcing Cascade

The default lane order is fixed by D-02 and preserves D-01/D-03:

1. existing DB/source config
2. cached company board resolution
3. direct ATS scanner/local scraper
4. free or cheap job API
5. targeted crawler/extractor
6. AI web search/extract
7. full skill runtime

Lane responsibilities:

- existing DB/source config: read current `search-sources` and `sourced-scan`
  config before discovering anything new.
- cached company board resolution: reuse `companyBoardResolutionCache` when it is
  fresh enough or event-valid.
- direct ATS scanner/local scraper: call existing supported ATS scanners and
  public local scrapers before paid tools.
- free or cheap job API: evaluate low-cost APIs such as Techmap and JobDataFeeds
  free tier when direct scanning lacks coverage.
- targeted crawler/extractor: use tool-assisted public extraction such as
  Firecrawl free tier after local fetch/scrape is insufficient.
- AI web search/extract: use Tavily-style search/extract or model-assisted search
  for gaps, ambiguous resolution, and ranking.
- full skill runtime: retain the agent-led `discover-companies` skill for
  exploratory, tool-heavy, user-led, or ambiguous sessions.

Optional Adzuna and Coresignal checks are benchmarks only per D-10 and D-11; they
are not Phase 1 vendor commitments.

## Scanner And Extractor Cascade

The scanner and extractor path normalizes every lane into the sourced-offer shape
consumed by the existing scanner, dedupe, scoring, JD capture, and DB persistence
owners.

Supported ATS path:

- Infer and validate Ashby, Greenhouse, Lever, Workable, or SmartRecruiters
  provider identity.
- Use `src/core/scoring/sourced-scanner.mjs` provider fetchers where possible.
- Promote scannable supported boards to `sourced-scan` only after confirmation.

Public unsupported/custom page path:

- Keep unsupported public-page cache entries separate from supported ATS
  promotion. This is the D-14 separation between supported ATS promotion and
  unsupported public-page cache.
- Use Node `fetch` before Playwright for public JS-rendered pages per D-07.
- Normalize extracted postings into the same offer shape as supported ATS output:
  company, title, URL, location, comp if present, body text if reachable, source
  metadata, req ID or stable key, and provenance.
- Mark unsupported pages as cached/extractable, not as tracked ATS companies,
  until generic extraction support proves current roles and capture quality.

JD capture posture:

- D-08 keeps the design focused on freshness, disappearing postings, cost,
  reliability, cacheability, and JD capture rather than treating ordinary
  scraping/legal/copyright concern as the primary blocker.
- D-09 requires preserving the first reachable full JD body locally at discovery
  time through sourced persistence and JD artifacts.
- When full text is unavailable, future implementation must mark the capture as
  partial instead of saving only a URL.

Authenticated browser automation remains outside Phase 1 and must not be pulled
into this scanner cascade.

## Proposal Gate

The proposal gate decides which resolved companies are worth showing to the user
before any write. It preserves the current `discover-companies` skill posture:
confirm-first by default, dedup hard, and comp floor used only as an internal
screen.

Inputs to the gate:

- dedup set from tracked companies, applications, sourced rows, and excluded
  companies;
- resolver output and cache freshness;
- role relevance from visible current jobs, candidate role families, and keep/cut
  signals;
- comp plausibility as an internal screen;
- provider support, page reachability, and scan/extraction quality;
- JD body capture quality and apply-link quality;
- confidence tier: high-confidence or borderline/medium.

Reject before proposal when:

- company is already tracked, applied, sourced, capped, or excluded;
- resolver cannot reach a public careers/job board URL;
- source has no current role signal;
- role signal is cut-only;
- provider or page identity cannot be validated;
- liveness checks show closed/unavailable pages;
- no usable JD body or partial-capture explanation can be produced for discovered
  jobs.

Borderline/medium proposals are always confirm-first. High-confidence proposals
may be eligible for explicit user-opted auto-add only when they resolve to
supported ATS promotion and pass all quality gates.

## Confirmation Contract

Confirmation is a separate contract from discovery and scanning. Future local API
or UI surfaces must present proposed companies before writes unless the user
explicitly opted into auto-add for high-confidence supported ATS entries in the
current session.

Required proposal fields:

- company name
- why it fits
- role family or role seen
- careers URL
- job board URL
- provider or unsupported/custom classification
- confidence tier
- provenance
- scan or extraction result summary
- JD capture status
- proposed write action: supported ATS promotion, unsupported public-page cache,
  reject, or needs user decision

Confirmation outcomes:

- approve supported ATS promotion;
- approve unsupported public-page cache for later generic extraction;
- reject or suppress the company;
- request refresh/re-resolution;
- escalate to AI web search/extract or full skill runtime.

No write path should treat `companySeedSchema` output or an unverified public page
as confirmed.

## Write Path

Supported ATS promotion:

- Write confirmed supported ATS entries through the existing company/source
  config owner: `rolester companies` and `companyAtsUpsert()` in
  `src/core/db/verbs/source-config.mjs`.
- Supported ATS promotion feeds `sourced-scan` tracked companies and can be
  scanned by `runSourcedScan()` and `src/core/scoring/sourced-scanner.mjs`.
- Existing helpers reject unsupported hosts; this is correct for supported ATS
  promotion.

unsupported public-page cache:

- Write public/custom pages to the planned `companyBoardResolutionCache`, not to
  `sourced-scan` tracked companies.
- Preserve cache metadata, provenance, scan/extraction status, and refresh
  reason so later generic extraction can run without rediscovering the page.
- Do not hand-edit generated `workspace/tracker.json`, `workspace/activity.jsonl`,
  or compatibility config in DB mode.

Sourced row and JD artifact ownership:

- When a lane produces actual job offers, normalize them into the scanner offer
  shape and use the sourced persistence path in
  `src/core/scoring/sourced-persistence.mjs`.
- DB workspaces persist sourced rows through `sourcedUpsertBatch()` in
  `src/core/db/verbs/sourced.mjs`.
- JD bodies must be saved under `workspace/jobs/` and mirrored to row artifacts
  when offers are persisted.

Phase 1 does not create new DB tables, migrations, route handlers, or runtime
source changes. Later phases choose whether `companyBoardResolutionCache` lives
inside DB source config JSON or a dedicated table.

## Bakeoff Metrics

Per D-10, Phase 1 specifies a bakeoff instead of committing to one vendor. Compare:

- direct ATS scanner/local scraper
- Techmap free tier
- JobDataFeeds free tier
- Firecrawl free tier
- Tavily-style search/extract
- optional Adzuna benchmark
- optional Coresignal benchmark
- AI web search/extract
- full skill runtime fallback

Per D-11, measure:

- usable jobs per dollar
- full JD capture quality
- apply-link quality
- freshness
- duplicate rate
- unsupported-page rate
- failure modes
- model/tool calls consumed
- resolver cache hit rate
- scan latency
- sourced-row persistence success
- partial-capture rate
- user confirmation acceptance rate

The bakeoff should count only jobs with enough durable evidence to be acted on.
Links without preserved JD text do not satisfy the JD capture requirement.

## Existing Code Owners

- `src/core/ai/call-ai.mjs`: BYOK/proxy/no-AI route selection and AI usage labels
  for bounded model calls.
- `src/core/ai/structured-oneshot.mjs`: schema-validated structured JSON parsing
  and corrective retry for `companySeedSchema`.
- `src/core/scoring/sourced-scanner.mjs`: supported ATS provider inference,
  provider fetchers, scoring, filters, dedupe, req ID extraction, and offer shape.
- `src/core/scoring/sourced-persistence.mjs`: JD artifact capture and sourced row
  conversion/persistence.
- `src/core/db/verbs/source-config.mjs`: DB-backed `search-sources` and
  `sourced-scan` config ownership plus `companyAtsUpsert()`.
- `src/core/db/verbs/sourced.mjs`: `sourcedUpsertBatch()` for sourced-row writes.
- `src/cli/companies.mjs`: confirm-first CLI mental model for supported tracked
  company ATS additions.
- `src/cli/searches.mjs`: source config authoring for boards/aggregators and
  search source setup.
- `config/search-sources.schema.json`: current search-source config vocabulary.
- `config/sourced-scan.example.json`: current tracked-company scanner config
  shape.
- `scripts/scan-sourced.mjs`: importable deterministic scan orchestration and JD
  capture handoff.
- `.agents/skills/discover-companies/SKILL.md`: current confirm-first
  company-discovery workflow contract and full skill fallback.
- `.agents/skills/search-jobs/SKILL.md`: scanner sweep, JD capture, and
  evaluate-job handoff contract.
- `.agents/skills/research-boards/SKILL.md`: board/source discovery contract for
  non-company source expansion.

## Non-Goals

- Do not modify runtime files under `src/` in Phase 1.
- Do not create package-manager installs or introduce new vendor SDKs in Phase 1.
- Do not make model output a trusted write path.
- Do not auto-submit applications or promote sourced rows to applications.
- Do not migrate browser-authenticated sources into Phase 1.
- Do not write candidate-specific discovered sources into shipped docs such as
  `docs/SOURCES.md`.
- Do not collapse supported ATS promotion and unsupported public-page cache into
  one write path.
- Do not re-resolve every company board on every sweep.
- Do not save discovered jobs as URL-only rows when a first reachable full JD body
  can be captured.
