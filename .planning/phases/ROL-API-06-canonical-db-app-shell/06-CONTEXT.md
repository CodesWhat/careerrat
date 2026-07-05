# Phase 6: Canonical DB App Shell - Context

**Gathered:** 2026-07-05T14:21:23.139Z
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 6 makes the Electron/React `/app` plus SQLite DB-derived state the canonical Rolester product surface. Legacy byte-static pages, generated tracker HTML, raw workspace JSON feeds, and tracker-file-backed product routes must be removed from normal product navigation or demoted to explicit debug/export-only surfaces. This phase establishes the app shell and route/data boundaries that Phases 7-11 build on.

</domain>

<decisions>
## Implementation Decisions

### Product Surface Retirement
- **D-01:** Remove legacy product affordances from the app path. The React app should not advertise or depend on legacy `/tracker`, `/onboard`, `/search`, `/packet`, `/evaluate`, `/answer`, raw workspace JSON feeds, or the `Classic` nav link as normal user flows.
- **D-02:** Legacy/generated surfaces may remain only as explicit developer/debug/export utilities when they are still needed for CLI compatibility or troubleshooting. They should not be framed as product UX, first-run UX, or user-facing navigation.
- **D-03:** Treat this as a new app structure, not a compatibility project. Do not spend Phase 6 preserving old product behavior for its own sake.

### DB-Only Product Reads
- **D-04:** The product app does not need tracker-file fallback. If a product route requires data, it should read DB-derived state and fail closed with a clear no-database/setup response when DB state is missing.
- **D-05:** `workspace/tracker.json` and `workspace/activity.jsonl` are compatibility/export artifacts only. Product app routes and React pages must not treat them as source of truth.
- **D-06:** App-visible dashboard, packet, tracker/activity, scanner context, and source setup surfaces should converge on DB-derived snapshots or DB verbs, even when they reuse legacy view-model builders internally.

### Source Setup and Scanner Context
- **D-07:** Do the correct DB-first work in Phase 6 instead of deferring obvious source setup seams. Routes such as board/source setup and scanner context should stop writing or reading product state directly through legacy YAML/generated files when a DB owner exists or should exist.
- **D-08:** It is acceptable for planners to choose the exact route/module split, but the target state is one app-local DB/API layer that later auto-sourcing can call without legacy file shims.

### Regression Guards
- **D-09:** Add aggressive static regression guards. New product routes, React app code, and app-facing server modules should fail tests if they read generated tracker/activity files as source of truth.
- **D-10:** Any remaining generated-file access must live behind named, narrow allowlists for CLI export/debug/static preview tools only. The allowlist should be easy to audit and should not include normal `/app` UX.

### the agent's Discretion
The user delegated implementation details to the planner and executor: choose the exact modules, route names, migration ordering, test file names, and debug/export affordance labels that best fit the codebase. Preserve the locked product intent above: DB-only product state, no fallback, no legacy product nav, and strict tests against regression.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product Direction
- `.planning/PROJECT.md` — App-first runtime definition, active v2 product requirements, and locked project decisions.
- `.planning/APP-PRODUCT-PLAN.md` — Product shape, Phase 6 sequence position, compatibility decision, and known product gaps.
- `.planning/ROADMAP.md` — Phase 6 goal, success criteria, and requirement mapping.
- `.planning/REQUIREMENTS.md` — APP-01 through APP-04 requirements and v2 traceability.
- `AGENTS.md` — Repository operating contract, DB write contract, tracker/export compatibility rules, and dashboard route constraints.
- `docs/ARCHITECTURE.md` — Existing architecture and skill-to-API/runtime split context.

### Prior Phase Decisions
- `.planning/phases/01-decomposition-map/01-CONTEXT.md` — Cheapest-first runtime, source cache, and skill decomposition posture.
- `.planning/phases/02-bounded-ai-foundation/02-CONTEXT.md` — Bounded AI helper and no-full-skill-runtime default.
- `.planning/phases/03-company-discovery-api/03-CONTEXT.md` — DB canonical app routes, generated dashboard/tracker non-write targets, and confirm-first discovery APIs.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/web/src/App.jsx` and `apps/web/src/app-shell/AppShell.jsx` already define the React `/app` product shell and route map.
- `apps/web/src/app-shell/DashboardContext.jsx` already centralizes the shared `/api/data/dashboard` snapshot for app pages.
- `src/cli/dashboard-route.mjs` already builds `/api/data/dashboard` from DB-derived inputs through `assembleTrackerObject(db)` and `assembleActivityEvents(db)`.
- `src/cli/data-route.mjs` already exposes DB-backed app/application/sourced/communications/activity/candidate/source verbs.

### Established Patterns
- Server route modules are mounted through exact method/path `addRoute` handlers in `src/cli/tracker-dev.mjs`.
- DB routes fail closed with 409 on missing database instead of silently falling back.
- Existing React fetch wrappers live in `apps/web/src/lib/api.js`; product routes should be represented there instead of scattered raw fetches.
- Compatibility exports are generated from DB where needed, not hand-edited product state.

### Integration Points
- `apps/web/src/app-shell/NavList.jsx` currently exposes the `Classic` link to `/tracker`; Phase 6 should remove or demote that normal navigation path.
- `src/cli/tracker-dev.mjs` still serves `/`, `/tracker`, `/tracker.html`, `/workspace/tracker.json`, `/workspace/activity.jsonl`, `/api/tracker`, and `/api/activity`; Phase 6 should classify these as debug/export-only or remove them from product paths.
- `src/cli/packet-route.mjs` still reads tracker exports through `defaultAdapter(repoRoot).readTracker()`; product packet APIs should become DB-derived.
- `src/cli/boards-route.mjs` still writes `config/search-sources.yml` directly; source setup should move to DB-owned routes/verbs for product use.
- `src/cli/search-route.mjs` has mixed DB/legacy source config behavior; product scanner context should be DB-first and no-fallback.

</code_context>

<specifics>
## Specific Ideas

- "Remove old bullshit" means old byte-static pages and generated dashboard paths should not remain as product affordances.
- "We don't need fallback" means missing DB is setup/error state, not permission to read exported tracker files.
- "Do what is correct" means planners should apply modern app/API best practices inside the locked DB-first product boundary.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within Phase 6 scope.

</deferred>

---

*Phase: 6-Canonical DB App Shell*
*Context gathered: 2026-07-05T14:21:23.139Z*
