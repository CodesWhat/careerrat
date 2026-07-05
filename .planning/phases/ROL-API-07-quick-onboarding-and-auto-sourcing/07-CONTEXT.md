# Phase 7: Quick Onboarding and Auto Sourcing - Context

**Gathered:** 2026-07-05
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase turns app-first onboarding into a search-starting workflow: once the
candidate has enough local DB setup to search, Rolester should prepare DB-backed
deterministic sources, ask for search cadence and whether to search now, start
the first deterministic job search without chat, and show that first search as a
simple setup task while the user continues deeper onboarding.

This phase does not move gate/apply readiness earlier, does not use chat as the
search mechanism, and does not auto-run authenticated/browser sources.

</domain>

<decisions>
## Implementation Decisions

### Search Readiness
- **D-01:** Starting search should be cheap and early. Do not require a
  compensation floor before the first search; comp can gate evaluation/apply
  later.
- **D-02:** The minimum search-start gate remains resume plus target role/title
  plus location or remote posture. Search cadence is collected before or at the
  first run, but missing deep-ingest data must not block first sourcing.
- **D-03:** `gate_ready` and `apply_ready` stay stricter than `search_ready`.
  Planning must preserve the existing staged readiness model instead of merging
  all setup requirements into one gate.

### First Search Trigger
- **D-04:** Auto-sourcing is core behavior. When onboarding first reaches
  search-ready state, the app should guide the user into the first search rather
  than telling them to run an agent skill.
- **D-05:** The first-run prompt should ask "search now?" with the yes/default
  path selected. Continuing onboarding from that prompt should start the first
  deterministic search unless the user explicitly declines.
- **D-06:** Later searches are manual from the Jobs page. The Jobs page should
  show a `Search jobs` action only after DB source setup exists.
- **D-07:** The app should ask how often the user wants to search. The
  recommendation should be data-backed when data exists; if no useful local or
  shipped data exists, the UI should be transparent that it is using a default
  recommendation.

### Search Mechanism
- **D-08:** Do not use chat to search. Quick onboarding must not start
  `research-boards`, `discover-companies`, `search-jobs`, or any visible chat as
  the first-search path.
- **D-09:** The first search should use deterministic, unauthenticated sources
  only. Authenticated/browser sources can appear as setup tasks or later
  enhancements, but they are not part of the automatic run.
- **D-10:** DB source setup is product state. Compatibility files remain
  CLI/debug output and must not become the readiness signal.

### Setup Task Surface
- **D-11:** The first search belongs in the setup/checklist model, not as a
  nagging reminder. It should read like "did this happen?" alongside simple
  setup and deep setup items.
- **D-12:** First-search task statuses should be `Not started`, `Running`,
  `Completed`, and `Failed`. `Failed` must be actionable.
- **D-13:** The run surface can be a compact banner/card/checklist row. It
  should keep the user oriented while returning them to deeper onboarding.

### Resume Intake
- **D-14:** Accept DOCX resume uploads in quick onboarding.
- **D-15:** Save the original DOCX and extract plain text locally with a
  deterministic parser. Do not feed DOCX to AI by default.
- **D-16:** If DOCX extraction is empty or garbled, keep the original file but
  do not treat extracted text as search-ready. Ask the user for copy-paste, PDF,
  text, or markdown instead.
- **D-17:** PDF remains a standard resume format. Existing PDF/image AI
  extraction can remain for formats that need visual/file interpretation, but
  DOCX support should not depend on AI.

### the agent's Discretion
- The exact persistence shape for first-search run state is open, but it must be
  DB-backed, durable across reloads, and visible to React.
- The exact cadence recommendation algorithm is open. Use local/source history
  when available; otherwise choose a conservative transparent default rather
  than inventing data.
- If a deterministic search completes successfully with zero results, planners
  may choose whether the first-search task counts as `Completed` with refinement
  guidance or `Failed`/`Needs setup`, as long as the UI tells the truth about the
  run.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Direction
- `.planning/ROADMAP.md` - Phase 7 goal and success criteria for quick
  onboarding and automatic sourcing.
- `.planning/PROJECT.md` - App-first, local SQLite product direction and
  decision that bounded AI is advisory rather than the app runtime.
- `.planning/REQUIREMENTS.md` - `ONB-01`, `ONB-02`, `RUN-01`, and `RUN-02`.
- `.planning/APP-PRODUCT-PLAN.md` - Product sequence: quick onboarding,
  background discovery/search, then deeper ingest.

### Prior Phase Contracts
- `.planning/phases/ROL-API-06-canonical-db-app-shell/06-CONTEXT.md` - React
  `/app` plus SQLite DB-derived state is canonical; legacy/static tracker
  surfaces are export/debug only.
- `.planning/phases/03-company-discovery-api/03-CONTEXT.md` - Local discovery
  APIs are deterministic/confirm-first; chat handoff is explicit, not the
  default app path.
- `.planning/phases/02-bounded-ai-foundation/02-CONTEXT.md` - AI helpers are
  bounded, schema-first, and optional; degraded/manual paths must remain.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/core/db/verbs/candidate.mjs`: computes `search_ready`, `gate_ready`,
  `apply_ready`, and `deep_ingest_complete`. Today `search_ready` requires
  source resume, role titles, and location/remote posture; comp is already part
  of later gates.
- `src/cli/onboard-route.mjs`: owns `/api/onboard/state`, resume upload routes,
  candidate DB patches, `prepareQuickStartSourcing`, and DB source setup via
  `writeDbCompatibilityBundle`.
- `apps/web/src/onboarding/steps/ResumeStep.jsx`: current upload split supports
  text/markdown deterministically and PDF/image through `resume-ai`.
- `apps/web/src/onboarding/steps/FinishStep.jsx`: current finish screen already
  shows readiness rows and quick-start UI, but quick start prepares sources and
  launches discovery chat today.
- `apps/web/src/pages/SetupReadinessCard.jsx`: existing home-page setup
  checklist pattern for Search/Gate/Apply/Deep ingest.
- `apps/web/src/jobs/JobsPage.jsx`: React product Jobs page where the manual
  `Search jobs` action should appear after source setup exists.
- `src/cli/search-route.mjs`: existing deterministic `/api/search/scan`,
  `/api/search/results`, and `/api/search/sources` HTTP surface.
- `scripts/scan-sourced.mjs` and `src/core/scoring/sourced-persistence.mjs`:
  deterministic scanner persists sourced rows and captures reachable JD bodies
  through DB mode.

### Established Patterns
- DB mode is canonical for app-visible state. Product routes should fail closed
  without DB rather than reading legacy generated files as source of truth.
- Source setup belongs in DB source config. `config/search-sources.yml` and
  candidate compatibility files are support/export artifacts.
- Deterministic scanning already writes sourced rows and job artifacts; first
  search should reuse this rather than invent a second sourcing path.
- Chat handoffs still exist for supervised discovery expansion, but Phase 7's
  first search must not depend on chat or skill sessions.
- Resume readiness is driven by the `source-resume` candidate artifact. DOCX
  extraction quality must therefore decide whether the artifact is usable for
  readiness.

### Integration Points
- Replace or split `/api/onboard/quick-start` and `/api/discovery/quick-start`
  behavior so first search does not start discovery chat.
- Add DB-backed durable run state that React can poll/read for the first-search
  setup task.
- Add React API wrappers in `apps/web/src/lib/api.js` for first-search run
  state/start and DOCX upload if the route surface changes.
- Add Jobs page search action gated by DB source setup.
- Extend resume upload accept lists, route validation, storage, and tests for
  DOCX deterministic extraction and garbled-extraction fallback.

</code_context>

<specifics>
## Specific Ideas

- The user framed the first-search task as a checklist item: simple setup, deep
  setup, source setup, first search. It should not feel like a nagging reminder.
- Search cadence should be chosen by the user, with a recommended option based
  on real data when available.
- The Jobs page should own repeat searches through a `Search jobs` button once
  source setup exists.

</specifics>

<deferred>
## Deferred Ideas

- Authenticated/browser-based sourcing can be represented as setup work, but it
  is not part of the automatic first run in this phase.
- A fully autonomous recurring scheduler is not locked by this discussion. At
  minimum, Phase 7 must capture cadence preference and avoid implying a hidden
  scheduler unless a durable start/stop/run-state implementation is included.

</deferred>

---

*Phase: 7-Quick Onboarding and Auto Sourcing*
*Context gathered: 2026-07-05*
