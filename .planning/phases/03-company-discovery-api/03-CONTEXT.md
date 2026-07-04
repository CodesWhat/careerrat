# Phase 3: Company Discovery API - Context

**Gathered:** 2026-07-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 3 builds the local API and core runtime for decomposed `discover-companies`.
It turns the Phase 1 target contract and Phase 2 bounded-AI helper into a
working company discovery pipeline: bounded AI can propose untrusted company
seeds, deterministic code resolves and caches careers/ATS boards, existing
scanner code verifies current relevant roles, proposal gates dedupe and screen
results, and confirmed supported ATS additions write through the existing
company/source config path.

This phase does not build a full new frontend confirmation screen, migrate the
entire discovery pipeline UI, perform authenticated browser automation, or turn
unsupported public career pages into first-class sourced-scan tracked companies.
Those remain later routing/UI or v2 work unless the planner finds a tiny API-only
hook that is required for Phase 3 verification.

</domain>

<decisions>
## Implementation Decisions

### Overall Posture
- **D-01:** Use modern local-first API best practices by default. The user explicitly delegated the remaining technical choices to current best practices rather than bespoke preference gathering.
- **D-02:** Keep the Phase 1 and Phase 2 architecture locked: AI proposes untrusted judgment-shaped data, deterministic code owns URLs, cache state, scan verification, dedupe, confirmation, and writes.
- **D-03:** `POST /api/skill/run` remains a fallback or user-led handoff path, not the default app runtime for this company discovery flow.

### API Surface
- **D-04:** Add a local resource-oriented API under the existing `/api/discovery` surface instead of creating an unrelated service namespace.
- **D-05:** Prefer static, exact-match route paths consistent with the current app server router. A good target shape is:
  - `POST /api/discovery/company-proposals` - create a proposal batch from AI seeds, pasted/manual seeds, cache, resolver, scanner, and gate inputs.
  - `GET /api/discovery/company-proposals` - read the latest pending or cached proposal batch if persisted.
  - `POST /api/discovery/company-proposal-decisions` - apply confirmation decisions such as approve supported ATS, reject, suppress, refresh, or escalate.
- **D-06:** Keep HTTP route handlers thin. Route modules parse/cap JSON bodies, call shared core modules/DB verbs, and return stable envelopes; discovery logic belongs under `src/core/discovery/` or adjacent core modules, not inside route handlers.
- **D-07:** Use explicit status codes and stable JSON envelopes: `200` for successful proposal generation/decision responses, `400` for malformed requests, `409` for state conflicts or unavailable DB state, `422` for schema/gate validation failures, `501` only when no AI route is available and no manual seed input was provided, and `502` for provider/proxy/runtime failures.

### AI Seed Generation
- **D-08:** The bounded AI seed call should use `runBoundedAI()` in native-preferred mode where available, with fallback structured parsing retained by the helper.
- **D-09:** Use strict labels for cost telemetry: `skill: "discover-companies"`, `action: "seed-generate"`, and an operation such as `"company-seeds"`.
- **D-10:** The final Phase 3 seed schema should use the Phase 1 contract name `companySeedSchema` and a top-level `companies[]` collection. Each item should include `name`, optional `domain_hint`, `why`, `role_family_hint`, `confidence`, and `source_hint`.
- **D-11:** Model output must not include trusted final `careers_url`, `job_board_url`, `api_url`, or write approval. Any URL-like hint remains untrusted until the deterministic resolver validates scheme, host, redirects, provider identity, provenance, and scan results.
- **D-12:** Bound the seed request for cost and response quality. Default to a moderate batch size and enforce a hard max; a planner may choose exact numbers, but the API should not accept unbounded "as many as possible" generation.
- **D-13:** If no AI route is configured, the proposal API should still support manual/pasted company seeds. Without AI and without manual seeds, return the shared no-AI/manual fallback envelope instead of silently starting a full skill session.

### Resolver Cache
- **D-14:** Implement `companyBoardResolutionCache` as durable DB-owned state, preferably a dedicated DB table plus verbs rather than stuffing independent resolution rows into generated tracker files or `sourced-scan`.
- **D-15:** Cache records should preserve at least the Phase 1 fields: company name, company domain, careers URL, job board URL, ATS provider, API URL, confidence, source provenance, first resolved time, last verified time, last scan result, failure count, and next refresh reason.
- **D-16:** Reuse the cache on future proposal/sweep runs. Re-resolve only on explicit refresh, stale TTL, 404/403, redirect/provider change, repeated zero-job scans, failed extraction, or other recorded refresh reason.
- **D-17:** Supported ATS promotion and unsupported/custom public-page caching remain separate. Supported ATS entries may be promoted to `sourced-scan` after confirmation; unsupported pages are cache/provenance records for later extraction work.

### Resolver and Scanner Pipeline
- **D-18:** The cheapest-first lane order from Phase 1 stays active: existing DB/source config, cached company board resolution, direct ATS scanner/local scraper, free or cheap job API, targeted crawler/extractor, AI web search/extract, then full skill runtime.
- **D-19:** Phase 3 should prioritize the supported ATS path for runtime writes because existing scanner and `companyAtsUpsert()` support Ashby, Greenhouse, Lever, Workable, and SmartRecruiters today.
- **D-20:** Deterministic resolution should use safe public HTTP fetches, redirects, provider URL inference, known provider host patterns, and homepage/careers link discovery before invoking search/crawler/AI-search lanes.
- **D-21:** Public unsupported career pages may be cached with provenance, but this phase should not pretend they are scannable ATS boards unless the planner explicitly builds and verifies a generic extractor path.
- **D-22:** When the pipeline fetches jobs to prove relevance, preserve reachable JD bodies locally before presenting actionable proposals. If the user has not confirmed the company yet, keep captured jobs attached to the proposal/cache; promote sourced rows only after confirmation.

### Proposal Gate and Confirmation
- **D-23:** Confirm-first remains the default. No proposed company is written to tracked source config unless the user explicitly approves it, except for a future explicit high-confidence auto-add mode that is not the default.
- **D-24:** Hard reject before proposal when the company is already tracked, already applied/sourced enough to be in play, excluded, capped, unreachable, unsupported without cache value, or has no current role signal.
- **D-25:** A high-confidence proposal requires a validated supported ATS board, at least one current role matching target role families or keep signals, clean dedupe/exclusion checks, and acceptable JD capture status.
- **D-26:** Borderline proposals can be returned to the UI/API for user review, but they must include why they are borderline and must not auto-write.
- **D-27:** Proposal records should include company name, why it fits, role family or role seen, careers URL, job board URL, provider or unsupported/custom classification, confidence tier, provenance, scan/extraction summary, JD capture status, and proposed action.

### Write Path
- **D-28:** Approved supported ATS promotions must write through the existing source-config/companies path: `companyAtsUpsert()` and the `rolester companies` mental model.
- **D-29:** DB mode is canonical for the app route. Legacy config compatibility can remain in existing CLI paths, but the new app API should not create a second hand-written legacy state path unless the planner finds an existing helper that makes it low risk.
- **D-30:** Generated dashboard/tracker files are never direct write targets for this phase. DB/source verbs export compatibility state where needed.
- **D-31:** If approved proposals include captured current jobs, persist them through existing sourced persistence and `sourcedUpsertBatch()` after confirmation, preserving JD artifacts under `workspace/jobs/`.

### the Agent's Discretion
The user delegated technical choices to modern best practices. The planner may choose exact module names, endpoint names, DB schema details, cache indexes, TTL values, batch sizes, and proposal IDs, provided the plan preserves the decisions above, the existing write contracts, bounded-AI envelope behavior, and route-thin/core-owned architecture.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### GSD Project Direction
- `.planning/PROJECT.md` - Project-level architecture: skills are contracts, deterministic code owns deterministic work, bounded AI owns judgment.
- `.planning/REQUIREMENTS.md` - DISC-01 through DISC-05 define the Phase 3 requirement surface.
- `.planning/ROADMAP.md` - Phase 3 goal and boundaries inside the current milestone.
- `.planning/phases/01-decomposition-map/01-CONTEXT.md` - Locked sourcing cascade, resolver cache, scraping posture, and confirm-first discovery decisions.
- `.planning/phases/02-bounded-ai-foundation/02-CONTEXT.md` - Locked bounded-AI helper, response envelope, no-AI, telemetry, and native-structured-output decisions.
- `.planning/architecture/discover-companies-target-contract.md` - Detailed target contract for company seeds, resolver cache, proposal gate, confirmation, and write path.
- `.planning/architecture/skill-decomposition.yml` - Machine-readable decomposition and owner mapping for `discover-companies`.
- `.planning/architecture/runtime-routing-policy.md` - Cheapest-correct route policy for local APIs, bounded AI, chat, and full skill runtime.

### Operating Contract
- `AGENTS.md` - DB write contract, source config ownership, JD-body capture invariant, browser automation deferral, and discover-companies skill routing.
- `.agents/skills/discover-companies/SKILL.md` - Current agent-led workflow contract and confirm-first behavior.
- `.agents/skills/search-jobs/SKILL.md` - Current sweep, JD capture, sourced-row, and handoff expectations.
- `.agents/skills/research-boards/SKILL.md` - Adjacent board discovery workflow and source-confirmation posture.

### Existing Runtime Owners
- `src/cli/discovery-route.mjs` - Existing discovery app route surface and full-skill chat handoff behavior.
- `src/cli/search-route.mjs` - Existing deterministic scan API route pattern and source summary route.
- `src/cli/data-route.mjs` - Existing thin HTTP route over DB verbs pattern.
- `src/core/ai/bounded-ai.mjs` - Shared bounded-AI envelope, native/fallback structured modes, no-AI, provider failure, and label validation.
- `src/core/ai/call-ai.mjs` - BYOK/proxy request path and usage label propagation.
- `src/core/ai/structured-oneshot.mjs` - Structured JSON parse, validation, and corrective retry behavior.
- `src/core/db/migrations/005-source-config.mjs` - Current DB-owned source config table.
- `src/core/db/verbs/source-config.mjs` - Existing `sourceConfigGet`, `sourceConfigPut`, `companyAtsUpsert`, and supported ATS validation.
- `src/core/db/verbs/sourced.mjs` - Existing sourced-row batch write path.
- `src/core/db/verbs/index.mjs` - Re-export surface for DB verbs.
- `src/core/scoring/sourced-scanner.mjs` - Supported provider inference and Ashby, Greenhouse, Lever, Workable, SmartRecruiters fetchers.
- `src/core/scoring/sourced-persistence.mjs` - JD artifact capture and sourced-row conversion/persistence.
- `src/cli/companies.mjs` - Confirm-first CLI model for tracked company ATS additions.
- `scripts/scan-sourced.mjs` - Existing scan orchestration and persistence handoff.
- `config/search-sources.schema.json` - Existing search/source config vocabulary and tracked company source shape.

### Existing Tests
- `tests/bounded-ai.test.mjs` - Current bounded-AI envelope and `discover-companies` label fixture.
- `tests/discovery-route.test.mjs` - Current `/api/discovery` route behavior and skill handoff expectations.
- `tests/db-source-config.test.mjs` - DB source config and company ATS upsert behavior.
- `tests/companies-cli.test.mjs` - CLI and DB write expectations for tracked company additions.
- `tests/scan-sourced.test.mjs` - Supported ATS scan and DB-mode scan behavior.
- `tests/search-route.test.mjs` - Existing scan route and source summary route expectations.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `runBoundedAI()` already provides the exact structured, labeled, no-AI-safe AI call shape needed for company seed generation.
- `mountDiscoveryRoutes()` already owns the `/api/discovery` namespace and can be extended without introducing another local server surface.
- `companyAtsUpsert()` already validates supported ATS hosts and writes confirmed tracked companies into DB source config.
- `scanCompanies()` and provider fetchers in `sourced-scanner.mjs` already verify current jobs for supported ATS providers and return offer objects with body text where available.
- `captureAndPersistOffersIfDb()` already captures JD artifacts and persists sourced rows through the DB write path.

### Established Patterns
- App routes are small adapters around shared core functions and use dependency injection for fetch/chat/runtime seams in tests.
- DB mode is canonical; compatibility files are exports or legacy fallbacks, not primary app writes.
- No-AI is a normal degraded state and should leave manual entry possible.
- Deterministic shortcuts and existing config/cache reads run before model calls.
- Full skill runtime remains visible for user-led or tool-heavy discovery, but should not be launched for cheap bounded app actions.

### Integration Points
- Add Phase 3 route handlers near `src/cli/discovery-route.mjs`, but keep reusable business logic in `src/core/discovery/` or an equivalent core namespace.
- Add DB cache verbs near source-config ownership or a new discovery/source verb, then re-export them from `src/core/db/verbs/index.mjs`.
- Wire supported ATS approval to `companyAtsUpsert()` rather than duplicating source config mutation logic.
- Use `sourced-scanner.mjs` and `sourced-persistence.mjs` for scan verification and JD capture instead of a parallel scanner.
- Extend tests around existing route and DB-verb patterns so network and AI calls stay injected and hermetic.

</code_context>

<specifics>
## Specific Ideas

- Treat `POST /api/discovery/company-proposals` as the primary app primitive for Phase 3: one local call can seed, resolve, scan, gate, and return confirmable proposals.
- Keep proposal generation side effects limited to durable cache/proposal state and JD capture artifacts; source-config and sourced-row writes happen only after explicit confirmation.
- Return enough proposal metadata for a later `/search` or discovery drawer UI without making Phase 3 responsible for the final UI.
- Prefer supported ATS proof first; unsupported public pages can be cached as "not yet promotable" unless generic extraction is explicitly built and tested.
- User preference for this phase: use modern best practices and avoid further interviewing on purely technical API/cache/schema details.

</specifics>

<deferred>
## Deferred Ideas

- A full proposal confirmation UI belongs to Phase 4 runtime routing or a dedicated UI phase unless a minimal existing surface hook is needed for API verification.
- Browser-authenticated LinkedIn, Wellfound, webmail, authenticated ATS portals, captchas, 2FA, and session-browser flows remain v2 or full-skill fallback.
- Generic unsupported public-page extraction can build on the cache later; Phase 3 should not dilute supported ATS promotion by writing unsupported pages to `sourced-scan`.
- Paid provider commitments, crawler vendor selection, and broad job API bakeoff remain measured follow-up work unless the planner includes a tiny stub/interface for future lanes.

</deferred>

---

*Phase: 3-company-discovery-api*
*Context gathered: 2026-07-04*
