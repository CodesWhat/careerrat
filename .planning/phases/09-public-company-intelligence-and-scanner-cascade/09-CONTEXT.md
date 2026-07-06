# Phase 9: Public Company Intelligence and Scanner Cascade - Context

**Gathered:** 2026-07-06T00:56:12Z
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 9 builds the public company/job-board intelligence layer and deeper scanner cascade for the app-first discovery path. It stores reusable public company and careers-board metadata separately from private candidate/search state, adds opt-in sync-home with strict scrub gates, and extends discovery beyond supported ATS boards through best-effort public careers-page extraction before bounded AI is considered.

This phase does not sync individual job postings home, does not publish candidate-specific fit/comp/tracker context, and does not turn custom careers pages into confirmed supported ATS sources.

</domain>

<decisions>
## Implementation Decisions

### Public Intelligence Boundary
- **D-01:** Public sync exists to save future AI/model calls by reusing company and job-board/careers intelligence. It should not publish individual job postings in this phase.
- **D-02:** Public records must contain only public company/board metadata: stable IDs, company/domain, careers URL, ATS/provider or unsupported/custom classification, provenance, freshness, confidence, extraction status, and conflict/failure metadata.
- **D-03:** Candidate-private data is forbidden from public sync: resume/profile facts, candidate context, comp floors, fit scores, private notes, tracker/application IDs, sourced-row IDs, local paths, and job-search state.

### Storage and Sync Boundary
- **D-04:** Use the same local SQLite database, but create separate `public_*` tables for syncable public intelligence. Do not create a second database file for this phase.
- **D-05:** Sync-home may only read from the `public_*` table boundary. Candidate, proposal, sourced, tracker/export, fit, comp, and note tables must not be readable by the public publish path.
- **D-06:** Scrub validation is fail-closed. If a public record contains any forbidden private field or value, block the publish and surface a local error instead of silently dropping fields.

### Consent and Product Copy
- **D-07:** Onboarding should include one sync-home toggle, default on, framed as helping improve Rolester by sharing public company and job-board metadata.
- **D-08:** Consent copy must plainly say private data is never shared: resume, profile, notes, compensation, fit scores, jobs, tracker state, and local files are out of bounds.

### Unsupported Careers Pages
- **D-09:** Reachable public custom careers pages should be best-effort scraped in this phase. The product should not stop at "unsupported ATS" when the page can be fetched and parsed.
- **D-10:** Best-effort extraction can support local discovery and reduce future AI calls, but sync-home still publishes only company/board metadata and extraction confidence, not job postings.
- **D-11:** Unsupported/custom careers pages remain separate from supported ATS promotion. They must not be written to `sourced-scan` tracked companies unless they resolve to a supported provider through existing validation.

### Scanner Cascade and Review
- **D-12:** The cascade order is supported ATS APIs first, deterministic public-page extraction second, optional scraper/API fallback third, and bounded AI fallback last.
- **D-13:** User review is only for ambiguous or conflicting results: provider changes, multiple plausible boards, blocked scrape with prior data, robots-disallowed paths, or low-confidence extracted jobs/board metadata.
- **D-14:** If the scanner finds nothing useful, it should not interrupt the user. Record freshness/failure metadata if useful and move on.
- **D-15:** Bounded AI fallback should run only when deterministic/scraper paths found usable page text but the structure is ambiguous. Do not spend AI on empty pages, blocked pages, robots-disallowed pages, or pages that clearly have no useful jobs or board links.

### the agent's Discretion
The user delegated implementation mechanics to planning and execution: exact table names beyond the `public_*` boundary, migrations, route names, sync-home transport, crawler/scraper limits, confidence thresholds, robots handling details, UI placement within onboarding, and test file names. Preserve the locked product intent above: public-only sync, same SQLite DB with separate public tables, fail-closed scrub gates, best-effort local scraping, review only for ambiguity/conflict, and AI only for structured ambiguity after cheaper extraction has real text.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product Direction
- `.planning/PROJECT.md` - App-first runtime, local-first privacy posture, v2 public intelligence requirement, and bounded-AI project decisions.
- `.planning/APP-PRODUCT-PLAN.md` - Phase 9 product gap: no-PII public sync-home plus deeper public-page discovery.
- `.planning/ROADMAP.md` - Phase 9 goal and PUB-01 through PUB-03 / DSC-01 through DSC-03 success criteria.
- `.planning/REQUIREMENTS.md` - Public discovery intelligence requirements and traceability.
- `AGENTS.md` - Repository DB write contract, app-first routing, paste-intake/JD capture posture, and public/private operating constraints.
- `docs/ARCHITECTURE.md` - Local APIs/DB verbs first, bounded AI for finite judgment, discovery proposal defaults, and source-layer expectations.

### Prior Phase Decisions
- `.planning/phases/ROL-API-06-canonical-db-app-shell/06-CONTEXT.md` - `/app` plus SQLite is canonical; generated tracker/activity files are compatibility/export only.
- `.planning/phases/07-quick-onboarding-and-auto-sourcing/07-CONTEXT.md` - Durable sourcing run state, deterministic first search, and no hidden chat/skill runtime for app sourcing.
- `.planning/phases/08-deep-ingest-lane/08-CONTEXT.md` - Proposal-first handling of private candidate facts and no leakage of candidate truth without review.
- `.planning/phases/03-company-discovery-api/03-CONTEXT.md` - Confirm-first company proposals, bounded AI as untrusted seed input, deterministic resolver/scanner/gate checks, and DB-owned proposal state.
- `.planning/phases/02-bounded-ai-foundation/02-CONTEXT.md` - Shared bounded AI envelopes, schema validation, labels, no-AI/manual degradation, and metadata-only telemetry.

### Discovery Architecture Contracts
- `.planning/architecture/discover-companies-target-contract.md` - Cheapest-first sourcing cascade, resolver cache fields, unsupported public-page cache, supported ATS promotion separation, JD capture posture, and bakeoff metrics.
- `.planning/architecture/runtime-routing-policy.md` - Route-class policy: local deterministic/API/DB owners before bounded AI, chat, or full skill runtime.

### Existing Runtime Owners
- `src/core/db/migrations/006-company-discovery-cache.mjs` - Current resolver/proposal cache tables and generated columns for status, provider, freshness, failures, and due refresh.
- `src/core/db/migrations/007-sourcing-runs.mjs` - Durable sourcing run table pattern with JSON payload plus generated query columns.
- `src/core/db/verbs/company-discovery.mjs` - DB-owned company board resolution cache, due-refresh logic, and proposal-batch state.
- `src/core/db/verbs/source-config.mjs` - DB-owned `search-sources` and `sourced-scan` config; `companyAtsUpsert()` validates supported ATS entries only.
- `src/core/db/verbs/sourced.mjs` - Sourced-row batch persistence transaction and activity/analytics behavior.
- `src/core/discovery/company-board-resolver.mjs` - Current safe URL validation, resolver cache TTL/failure counters, supported vs unsupported result shape, provenance, and refresh reasons.
- `src/core/discovery/company-proposals.mjs` - Current seed -> resolution -> scan -> JD capture -> proposal batch pipeline.
- `src/core/discovery/company-proposal-gate.mjs` - Current gate behavior for already-tracked, excluded, unsupported, no-role, comp, JD-capture, and review/reject outcomes.
- `src/core/scoring/sourced-scanner.mjs` - Supported provider inference/fetchers, RSS fetcher, scoring, title/location filters, dedupe, req ID extraction, and offer shape.
- `src/core/scoring/sourced-persistence.mjs` - JD artifact capture, sourced-row conversion, and DB persistence for scanner offers.
- `scripts/scan-sourced.mjs` - Importable deterministic scan orchestration used by app search routes.
- `src/cli/discovery-route.mjs` - Local company proposal API routes and explicit discovery chat handoff routes.
- `src/cli/search-route.mjs` - Local deterministic search scan/results/sources routes.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `company_board_resolutions` already stores resolver metadata as JSON with generated columns for company key/domain, provider, status, freshness, refresh reason, failure count, and zero-job count.
- `companyBoardResolutionListDue()` already models public-ish freshness/retry metadata and due reasons that can inspire public-intel refresh behavior.
- `resolveCompanyBoard()` already performs SSRF-style safety checks for schemes, local/private hosts, DNS resolution, redirects, supported-provider inference, provenance, unsupported public-page results, TTL, failure, and zero-job refresh triggers.
- `scanCompanies()`, `fetchProvider()`, and `scanSearchSources()` already normalize supported ATS/RSS output into scanner offers.
- `offersWithCapturedJobs()` and `captureAndPersistOffersIfDb()` already capture JD artifacts locally and convert offers to sourced rows when local persistence is appropriate.

### Established Patterns
- Product routes fail closed without SQLite and do not use generated tracker/activity files as source of truth.
- Route modules are thin adapters; durable behavior belongs in core modules and DB verbs.
- Source-config writes are separate from proposal/cache state; supported ATS promotion goes through `companyAtsUpsert()`.
- AI output is advisory until schema validation and deterministic checks pass; deterministic owners handle URL validation, dedupe, scan, persistence, and writes.
- Local proposal errors stay local and do not silently start chat or full skill runtime.

### Integration Points
- Add new public-intelligence migrations and verbs near the existing company-discovery DB ownership, but keep private proposal/candidate/sourced state out of the public publish path.
- Extend resolver/scanner modules so unsupported/custom public pages can produce extraction metadata and possibly local offers without weakening supported ATS promotion.
- Add scrub/publish tests that prove sync-home can only serialize public-table records and fails closed on forbidden private fields.
- Surface sync-home consent in onboarding alongside app-first setup, while preserving Settings control if planners choose to mirror the toggle later.
- Ensure search/discovery APIs can consume public-intel cache hits to avoid repeated resolver/model work, while keeping app search runs DB-backed and deterministic by default.

</code_context>

<specifics>
## Specific Ideas

- The user's main intent is cost reduction: save AI calls by reusing public companies and job-board intelligence.
- The user explicitly does not want personal data synced: "nothing personal."
- Public sync should probably exclude jobs for now; companies and their job boards/careers pages are the useful shared layer.
- The sync-home pitch should feel like "help us improve" during onboarding, with simple copy rather than a heavy form.
- Custom careers pages should be scraped when reachable. A clean "found nothing" result should quietly move on rather than asking the user to review.
- Research guardrails consulted during discussion: data minimization/privacy risk management, robots exclusion behavior, and SSRF-safe external fetching. Downstream implementation should verify current legal/security details during planning if it changes crawler behavior materially.

</specifics>

<deferred>
## Deferred Ideas

- Publishing or syncing individual job postings from scraped careers pages - future phase after public company/board metadata is proven safe and useful.

</deferred>

---

*Phase: 9-Public Company Intelligence and Scanner Cascade*
*Context gathered: 2026-07-06T00:56:12Z*
