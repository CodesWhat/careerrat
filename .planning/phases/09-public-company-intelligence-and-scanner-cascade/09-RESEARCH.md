# Phase 09 Research - Public Company Intelligence and Scanner Cascade

## Objective

Plan Phase 09 implementation for privacy-scrubbed public company/job-board intelligence and deeper non-ATS discovery without executing source changes.

Phase requirements covered: PUB-01, PUB-02, PUB-03, DSC-01, DSC-02, DSC-03.

## Locked Decisions From Context

- Public sync includes company, board, and careers metadata only.
- No personal/candidate data and no individual job postings are synced in this phase.
- Use the same local SQLite database with separate `public_*` tables.
- Sync-home may only read from public tables.
- Onboarding gets a default-on "help improve CareerRat" toggle with clear no-private-data copy.
- Scrub validation fails closed when any private field is present.
- Reachable public custom careers pages should be scraped locally best-effort.
- Public sync receives metadata/confidence/provenance only, not full page bodies.
- Review only ambiguous or conflicting extraction.
- Clean "found nothing" records metadata and moves on silently.
- Bounded AI fallback is last resort only when usable public page text exists but structure is ambiguous.
- No AI for empty, blocked, robots-disallowed, login-gated, or useless pages.

## Existing Architecture To Preserve

### Discovery Routes

`src/cli/discovery-route.mjs` already owns app-local discovery APIs:

- `POST /api/discovery/company-proposals`
- `GET /api/discovery/company-proposals`
- `POST /api/discovery/company-proposal-decisions`
- `GET /api/discovery/state`
- `POST /api/discovery/quick-start`
- `POST /api/discovery/next`

The route contract says local proposal creation and decisions should not silently start chat, `/api/chat/*`, the full skill runtime, or `POST /api/skill/run`. Quick-start and next are explicit chat handoffs. Phase 09 should extend the local route path for public scanner metadata and review decisions, not replace it with skill-runtime calls.

### Existing Company Resolver

`src/core/discovery/company-board-resolver.mjs` already has:

- safe URL parsing and private/local host rejection
- DNS lookup checks
- redirect cap
- supported ATS detection via `inferProvider()`
- homepage link extraction
- cached resolver records in `company_board_resolutions`
- statuses like `supported_ats` and `unsupported_public`
- provenance arrays with sources such as `seed-url-hint`, `redirect`, `public-page-fetch`, `homepage-link`

Phase 09 should build on this resolver. The missing piece is deeper custom-page extraction and public-table persistence, not supported ATS detection.

### Existing Proposal Flow

`src/core/discovery/company-proposals.mjs` currently:

- builds company seed context
- generates/manual accepts seed companies
- resolves boards deterministically
- scans supported ATS companies
- captures JD bodies for sourced offers
- writes pending proposal batches

`src/core/discovery/company-proposal-decisions.mjs` currently:

- enforces `expectedVersion`
- approves only high-confidence supported ATS proposals into source config
- supports reject, suppress, refresh, and escalate actions
- writes sourced rows from captured offers only on approval

Phase 09 should avoid mixing public metadata decisions with candidate-specific proposal approval. Supported ATS approval still writes private/local source config; public metadata review decisions should write `public_*` metadata only.

### DB Pattern

Migrations live in `src/core/db/migrations/NNN-name.mjs` and are registered in `src/core/db/migrations.mjs`. Existing company discovery tables:

- `company_board_resolutions`
- `company_discovery_proposals`

Verbs live under `src/core/db/verbs/*.mjs` and are re-exported by `src/core/db/verbs/index.mjs` and `src/core/db/verbs.mjs`. DB transactions must stay synchronous and must not call network or models inside transactions.

### Source Config Boundary

`src/core/db/verbs/source-config.mjs` writes private candidate source config:

- `search-sources`
- `sourced-scan`

`companyAtsUpsert()` accepts only supported ATS entries. Phase 09 must not write custom public careers pages into private source config unless a later explicit supported-ATS validation path approves them.

### Scanner

`src/core/scoring/sourced-scanner.mjs` already scans:

- tracked company ATS boards
- RSS/search sources
- provider APIs for supported ATS vendors

It currently treats custom public pages mainly as unsupported metadata. Phase 09 needs a scanner cascade that keeps supported ATS APIs first, then deterministic public page extraction, then optional scraper/API fallback, then bounded AI fallback for ambiguous reachable page text.

### Bounded AI

The existing bounded-AI stack is sufficient:

- `src/core/ai/bounded-ai.mjs`
- `src/core/ai/call-ai.mjs`
- `src/core/ai/structured-oneshot.mjs`
- `src/core/profile/schema-validator.mjs`

Use `runBoundedAI()` with labels, JSON Schema, one retry, and manual fallback. Never call `callAI()` directly from scanner route code. AI output remains advisory until deterministic URL/provider/public-scrub validation passes.

### Onboarding

`src/core/onboarding/onboard-page.mjs` is a byte-static non-AI onboarding page with eight steps. `src/cli/onboard-route.mjs` owns onboarding API writes through DB verbs. Phase 09 needs one additional default-on sharing preference surface and API. The UI-SPEC requires a grouped toggle, saved-state hint, and copy that says no resumes, profile, applications, or private notes are shared.

## Required New Public Data Surface

Add a separate public-intelligence layer in SQLite. Recommended tables:

- `public_company_intel`
- `public_board_intel`
- `public_careers_pages`
- `public_intel_review_items`
- `public_sync_preferences`

Keep table names explicit and separate from private/candidate tables. These rows may contain:

- stable ID
- company/board name
- normalized domain
- careers URL
- public board URL
- ATS/provider hint or validated provider
- source kind
- provenance
- first seen / last seen / last verified
- freshness status
- confidence
- conflict/review metadata
- public extraction status
- input hash for public page text

They must not contain:

- candidate profile fields
- resume/evidence fields
- compensation floor or current/base fields
- fit scores or gate outputs
- tracker IDs
- sourced/application row IDs
- private notes
- local filesystem paths
- raw prompts or raw model text
- full page bodies in sync payloads
- individual job postings

## Scrub Boundary

Create a reusable public scrub validator with a denylist and allowlist. It should be called before:

- writing public table rows from mixed internal objects
- exporting/sync-home payloads
- returning public sync previews from routes

Fail closed with a local error when private fields are present. Tests should include nested/private contamination, local paths, candidate field aliases, and raw AI/prompt/page body fields.

## Scanner Cascade Design

Recommended branch order:

1. Supported ATS API/resolver.
2. Generic deterministic public-page extraction from reachable public HTML.
3. Optional scraper/API fallback for reachable public pages.
4. Bounded AI fallback only for ambiguous structured extraction from usable public text.
5. Review item only for ambiguity or conflict.
6. Silent metadata record for no-result, unsupported, empty, blocked, or clean custom pages.

Important branch distinctions:

- Empty page is not ambiguity.
- Blocked/robots-disallowed/login-gated is not ambiguity.
- Unsupported public custom page is not necessarily review-worthy.
- Provider conflict, redirect provider change, stale contradictory metadata, or ambiguous extracted careers links are review-worthy.
- AI cannot approve a source-config write.

## API Surface To Add Or Extend

Use local app APIs, not skill runtime:

- `GET /api/discovery/public-intel/state`
- `POST /api/discovery/public-intel/scan`
- `GET /api/discovery/public-intel/review`
- `POST /api/discovery/public-intel/review-decisions`
- `GET /api/discovery/public-intel/sync-preview`
- `POST /api/onboard/public-sync-preference`

Routes should accept injected `fetchImpl`, scanner, AI call, and clock for tests. They should return bounded local errors, not chat fallbacks.

## UI Surface

Use existing byte-static page patterns and local CSS. UI-SPEC controls final layout.

Onboarding:

- Add sharing toggle near finish/discovery setup.
- Default on for new setup.
- Persist preference locally.
- Show copy that public company/board metadata may improve CareerRat and private job-search data is not shared.
- Provide saved-state and scrub-failure feedback.

Discovery review:

- Render only ambiguous/conflicting public-intel items.
- Include provider, confidence, freshness, provenance, and reason.
- Actions: `Use supported ATS`, `Keep public metadata`, `Refresh scan`, `Suppress review`, `Escalate to agent`.
- Do not render rows for clean no-result scans.

## Test Strategy

Use Node test runner and existing route/DB test patterns.

Core RED tests should cover:

- migration creates `public_*` tables with generated columns and indexes
- public rows reject private/candidate contamination
- public sync preview reads only `public_*` rows
- onboarding preference defaults on and persists off/on changes
- supported ATS branch does not call AI
- deterministic custom page extraction records metadata
- empty/blocked/robots-disallowed/useless pages do not call AI or create review items
- ambiguous reachable page text calls bounded AI at most once plus one retry
- invalid AI schema produces manual/review result and no write
- AI-suggested URL/provider cannot write unless deterministic validation passes
- clean "found nothing" advances silently
- review decisions enforce expected version/conflict handling
- local APIs do not call chat, skill runtime, or `/api/skill/run`

## Planning Implications

Implementation should split into TDD-friendly plans:

1. DB schema, verbs, scrub validator, sync preference.
2. Scanner cascade and public-page extraction.
3. Bounded AI fallback and validation guardrails.
4. Local discovery/onboarding APIs.
5. UI onboarding toggle and discovery review panel.
6. Integration/static guard tests and docs.

Because schema files change, the planner must include a blocking migration/schema verification task before final verification. No interactive schema push is needed for SQLite migrations, but tests must prove migrations apply in order.

## Validation Architecture

Nyquist-critical surfaces:

- Privacy scrub validator: denylist, allowlist, nested object traversal, local path detection, raw prompt/model/page-body exclusion.
- Scanner cascade: branch coverage for ATS, deterministic custom page, scraper fallback, AI fallback, no-result, blocked, conflict, and stale.
- DB read/write boundaries: public tables separated from candidate/source/tracker tables.
- Route isolation: local discovery routes cannot call chat or skill runtime for proposal creation, validation, dedupe, confirmed writes, or sync preview.
- UI state: onboarding toggle default-on, save errors, scrub failure copy, and review queue empty state.

## RESEARCH COMPLETE
