# Phase 6: Canonical DB App Shell - Research

**Researched:** 2026-07-05  
**Domain:** Electron/React app shell, Node local API routes, SQLite DB source-of-truth migration  
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

All content in this section is copied from `.planning/phases/06-canonical-db-app-shell/06-CONTEXT.md`. [VERIFIED: 06-CONTEXT.md]

### Locked Decisions

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

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within Phase 6 scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| APP-01 | Electron/React `/app` is the canonical product surface; compatibility surfaces are not normal UX. [VERIFIED: .planning/REQUIREMENTS.md] | Remove/demote React nav links and legacy exact routes from product paths; keep `/app` mounted as the SPA product entry. [VERIFIED: 06-CONTEXT.md + codebase grep] |
| APP-02 | Dashboard, packet, tracker/activity, scanner context, and source setup views read DB-derived snapshots. [VERIFIED: .planning/REQUIREMENTS.md] | Reuse `dashboard-route.mjs` and `data-route.mjs` DB patterns; migrate packet, boards/source setup, scanner context, and activity/tracker product reads to DB routes. [VERIFIED: codebase grep] |
| APP-03 | `workspace/tracker.json` and `workspace/activity.jsonl` remain compatibility/export only. [VERIFIED: .planning/REQUIREMENTS.md] | Keep export/debug owners allowlisted; product route code must not call `defaultAdapter().readTracker()` or raw workspace JSON endpoints. [VERIFIED: codebase grep] |
| APP-04 | Static guards prevent product routes or React app paths from depending on generated tracker/activity files. [VERIFIED: .planning/REQUIREMENTS.md] | Add a Node `node:test` static regression suite modeled on `tests/company-discovery-regression.test.mjs`. [VERIFIED: codebase grep; CITED: https://nodejs.org/api/test.html] |
</phase_requirements>

## Summary

Phase 6 is not a data model invention phase; the canonical DB layer already exists in `src/core/db/*`, app-facing DB route patterns already exist in `src/cli/data-route.mjs` and `src/cli/dashboard-route.mjs`, and the React app shell already runs under `/app` through Vite build output served by `tracker-dev.mjs`. [VERIFIED: codebase grep] The planner should therefore focus on removing legacy product dependencies, migrating the remaining product data seams to DB-derived reads/writes, and installing static guards that keep generated tracker/activity files in export/debug-only code. [VERIFIED: 06-CONTEXT.md]

The biggest known migration gaps are concrete: `NavList.jsx` still exposes `Classic` to `/tracker`; `tracker-dev.mjs` still serves legacy product-like routes and raw workspace JSON endpoints; `packet-route.mjs` still reads tracker exports via `defaultAdapter(repoRoot).readTracker()`; `boards-route.mjs` still writes `config/search-sources.yml`; `search-route.mjs` and scanner/company context code retain mixed DB/legacy source behavior; and `scripts/scan-sourced.mjs` still uses tracker-derived seen sets in the scan orchestration path. [VERIFIED: codebase grep]

**Primary recommendation:** Plan Phase 6 as a narrow DB-only boundary cleanup: promote `/app` and `/api/data/*`/DB verbs as the product path, migrate packet/source/scanner/activity reads to DB-derived routes, move all generated-file access behind named debug/export allowlists, and add static tests that fail on any new product dependency on `tracker.json`, `activity.jsonl`, `/api/tracker`, `/api/activity`, or `defaultAdapter().readTracker()`. [VERIFIED: 06-CONTEXT.md + codebase grep]

## Project Constraints (from AGENTS.md)

- In DB workspaces, `careerrat data status` exit 0 means tracker-visible mutations must go through `careerrat data <verb>` and generated files must not be hand-edited. [VERIFIED: AGENTS.md]
- In DB mode, `workspace/tracker.json` and `workspace/activity.jsonl` are regenerated compatibility exports, not canonical product state. [VERIFIED: AGENTS.md]
- The dashboard/dev server is read-only from the user's perspective; app and skill writers update canonical state, then exports/rendering reflect it. [VERIFIED: AGENTS.md]
- Source watermarks and source config belong in DB source config in DB workspaces; legacy config files are compatibility surfaces. [VERIFIED: AGENTS.md]
- Any JD captured by sourcing/evaluation/application flows must be saved locally under `workspace/jobs/<...>.md` and mirrored onto row artifacts. [VERIFIED: AGENTS.md]
- Sent-message writes must clear drafts in the same write, and completed tracked actions must clear their CTA fields in the same write. [VERIFIED: AGENTS.md]
- New tracker-visible display fields must respect typed field ownership and character budgets instead of dumping mixed topics into one note field. [VERIFIED: AGENTS.md]
- Interview round labels must use the canonical type vocabulary and not numbered rounds. [VERIFIED: AGENTS.md]
- Browser automation and full skill runtime are opt-in or fallback paths; local deterministic APIs should not silently start chat, browser, or `POST /api/skill/run`. [VERIFIED: AGENTS.md + docs/ARCHITECTURE.md]
- Candidate-specific gates and private preferences live in canonical candidate setup data; product source code must stay domain-neutral and must not hardcode candidate facts. [VERIFIED: AGENTS.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| `/app` product shell and navigation | Browser / Client | Frontend Server | React owns visible navigation and route composition, while `tracker-dev.mjs` serves the Vite bundle under `/app/*`. [VERIFIED: codebase grep; CITED: https://reactrouter.com/api/declarative-routers/BrowserRouter; CITED: https://vite.dev/guide/build] |
| Dashboard view model | API / Backend | Database / Storage | `/api/data/dashboard` already builds the view model from DB-derived `assembleTrackerObject(db)` and `assembleActivityEvents(db)`. [VERIFIED: src/cli/dashboard-route.mjs] |
| Application/tracker/activity product reads | API / Backend | Database / Storage | `data-route.mjs` exposes DB reads for applications, sourced rows, communications, activity, candidate config, and snapshots. [VERIFIED: src/cli/data-route.mjs] |
| Packet list and packet artifact reads | API / Backend | File Storage | Route logic should select applications from DB and use existing path-safe artifact resolution for markdown files. [VERIFIED: src/cli/packet-route.mjs] |
| Source setup | API / Backend | Database / Storage | `sourceConfigGet()` and `sourceConfigPut()` already own DB source config; `boards-route.mjs` should not be the product writer to YAML. [VERIFIED: src/core/db/verbs/source-config.mjs + src/cli/boards-route.mjs] |
| Scanner context and sourced results | API / Backend | Database / Storage | Scanner orchestration already persists sourced rows in DB when DB exists, but scan context and result reporting still have legacy file seams. [VERIFIED: scripts/scan-sourced.mjs + src/core/discovery/company-context.mjs + src/cli/search-route.mjs] |
| Compatibility exports and static dashboard | CLI / Debug Export | Static Files | `export-to-tracker.mjs`, `tracker.mjs`, raw `/workspace/*`, and generated `tracker.html` are compatibility/debug surfaces, not product state. [VERIFIED: AGENTS.md + codebase grep] |
| Regression guardrails | Test / CI | API / Backend | Node static tests can scan exact product files and allowlist only export/debug owners. [VERIFIED: tests/company-discovery-regression.test.mjs; CITED: https://nodejs.org/api/test.html] |

## Standard Stack

### Core

| Library / Module | Version | Purpose | Why Standard |
|------------------|---------|---------|--------------|
| Node.js | v24.18.0 available; package engine `>=24` | Runtime for local server, CLI, DB, and tests. | Existing repo runtime and built-in `node:sqlite` availability match this phase. [VERIFIED: environment command + package.json; CITED: https://nodejs.org/api/sqlite.html] |
| `node:sqlite` / `DatabaseSync` | Built into Node runtime | Local SQLite DB access. | Existing `src/core/db/connection.mjs` uses it; no external sqlite package is needed. [VERIFIED: src/core/db/connection.mjs + environment command; CITED: https://nodejs.org/api/sqlite.html] |
| React | 19.2.7 installed in lockfile | Product UI rendering under `apps/web`. | Existing app shell uses React; Phase 6 should not introduce a new frontend stack. [VERIFIED: package-lock.json + apps/web/package.json] |
| React DOM | 19.2.7 installed in lockfile | Browser rendering for the React app. | Existing Vite app depends on React DOM. [VERIFIED: package-lock.json + apps/web/package.json] |
| React Router DOM | 7.18.1 installed in lockfile | Client route map inside `/app`. | Existing app uses declarative React Router routes; official docs support basename-based app mounting. [VERIFIED: package-lock.json + apps/web/src/App.jsx; CITED: https://reactrouter.com/api/declarative-routers/BrowserRouter] |
| Vite | 6.4.3 installed and available | Builds `apps/web/dist` for `/app/*`. | Existing config sets `base: "/app/"`, matching the nested mount requirement. [VERIFIED: apps/web/vite.config.js + environment command; CITED: https://vite.dev/guide/build] |
| Electron | 43.0.0 installed in desktop workspace | Thin desktop shell over local server. | Existing desktop app opens `/app` or `/app/onboarding` through local server routing. [VERIFIED: apps/desktop/package.json + apps/desktop/main.mjs; CITED: https://www.electronjs.org/docs/latest/api/browser-window] |
| Node test runner | Built into Node runtime | Backend route and static regression tests. | Existing tests use `node:test`, route harnesses, and process-isolated test files. [VERIFIED: package.json + tests/*.test.mjs; CITED: https://nodejs.org/api/test.html] |
| Vitest | 3.2.6 installed and available | React component tests in `apps/web`. | Existing web package uses Vitest for app tests. [VERIFIED: apps/web/package.json + environment command] |

### Supporting

| Library / Module | Version | Purpose | When to Use |
|------------------|---------|---------|-------------|
| `@vitejs/plugin-react` | 4.7.0 installed in lockfile | React transform/HMR for Vite. | Keep existing app build behavior; do not upgrade for this phase. [VERIFIED: package-lock.json + apps/web/vite.config.js] |
| `@biomejs/biome` | 2.5.0 available | Formatting/lint infrastructure. | Use only if planner adds formatting or lint checks; not required for DB shell logic. [VERIFIED: package.json + environment command] |
| DB verbs in `src/core/db/verbs/*` | Project module | Canonical writes/reads for applications, sourced rows, comms, source config, candidate setup, activity. | Extend existing verbs/routes instead of new storage adapters. [VERIFIED: codebase grep] |
| `assembleTrackerObject(db)` / `assembleActivityEvents(db)` | Project module | DB-derived compatibility shape for existing dashboard view-model builders. | Reuse in-memory shapes; do not round-trip through generated files. [VERIFIED: src/core/db/export-to-tracker.mjs + src/cli/dashboard-route.mjs] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Existing DB verbs and `requireDb()` | Tracker file fallback | Rejected by locked decision D-04/D-05; fallback would preserve the wrong source-of-truth boundary. [VERIFIED: 06-CONTEXT.md] |
| Existing React/Vite app shell | New router or new frontend package | Unnecessary because `/app` shell, Vite base, and route map already exist. [VERIFIED: apps/web/src/App.jsx + apps/web/vite.config.js] |
| Existing `node:test` static checks | New lint framework | Unnecessary because current regression tests already use Node file scans and exact allowlists. [VERIFIED: tests/company-discovery-regression.test.mjs] |
| Existing source-config DB verbs | Direct YAML mutation from product route | Rejected for product paths because DB workspaces own source config through `candidate_source_configs`. [VERIFIED: AGENTS.md + src/core/db/migrations/005-source-config.mjs] |

**Installation:**
```bash
# No new package installation is recommended for Phase 6.
# Use the existing lockfile and workspaces.
```

**Version verification:** package and runtime versions were verified with `node --version`, `npm --version`, local workspace CLIs, `npm view`, and `package-lock.json`. [VERIFIED: environment command + package-lock.json + npm view]

## Package Legitimacy Audit

No new external package installation is recommended for this phase. [VERIFIED: codebase package.json] The package legitimacy seam was run against the existing frontend/build packages for awareness; suspicious latest-release signals on already-locked packages should not create install checkpoints unless a future plan upgrades them. [VERIFIED: gsd package-legitimacy]

| Package | Registry | Age / Publish Signal | Downloads / Signal | Source Repo | Verdict | Disposition |
|---------|----------|----------------------|--------------------|-------------|---------|-------------|
| `react` | npm | Existing locked package; registry check OK. | High-download package per legitimacy seam. | `github.com/facebook/react` | OK | Already locked; approved for continued use. [VERIFIED: gsd package-legitimacy + package-lock.json] |
| `react-dom` | npm | Existing locked package; registry check OK. | High-download package per legitimacy seam. | `github.com/facebook/react` | OK | Already locked; approved for continued use. [VERIFIED: gsd package-legitimacy + package-lock.json] |
| `react-router-dom` | npm | Existing locked package; seam flagged recent latest publish. | High-download package per legitimacy seam. | `github.com/remix-run/react-router` | SUS | Already locked; do not install or upgrade in Phase 6 without human checkpoint. [VERIFIED: gsd package-legitimacy + package-lock.json] |
| `vite` | npm | Existing locked package; seam flagged recent latest publish. | High-download package per legitimacy seam. | `github.com/vitejs/vite` | SUS | Already locked; do not install or upgrade in Phase 6 without human checkpoint. [VERIFIED: gsd package-legitimacy + package-lock.json] |
| `vitest` | npm | Existing locked package; seam flagged recent latest publish. | High-download package per legitimacy seam. | `github.com/vitest-dev/vitest` | SUS | Already locked; do not install or upgrade in Phase 6 without human checkpoint. [VERIFIED: gsd package-legitimacy + package-lock.json] |
| `@vitejs/plugin-react` | npm | Existing locked package; seam flagged recent latest publish. | Established package per legitimacy seam. | `github.com/vitejs/vite-plugin-react` | SUS | Already locked; do not install or upgrade in Phase 6 without human checkpoint. [VERIFIED: gsd package-legitimacy + package-lock.json] |
| `@biomejs/biome` | npm | Existing locked package; seam flagged recent latest publish. | Established package per legitimacy seam. | `github.com/biomejs/biome` | SUS | Already locked; do not install or upgrade in Phase 6 without human checkpoint. [VERIFIED: gsd package-legitimacy + package-lock.json] |

**Packages removed due to [SLOP] verdict:** none. [VERIFIED: gsd package-legitimacy]  
**Packages flagged as suspicious [SUS]:** existing locked packages only; no Phase 6 install recommended. [VERIFIED: gsd package-legitimacy]

## Architecture Patterns

### System Architecture Diagram

```text
Electron BrowserWindow / local browser
  -> http://127.0.0.1:<port>/app/*
  -> Vite-built React app shell (apps/web)
  -> apps/web/src/lib/api.js wrappers
  -> exact addRoute handlers in src/cli/*-route.mjs
  -> requireDb({ repoRoot, env }) fail-closed gate
  -> DB verbs / DB-derived snapshot builders
  -> .careerrat/db/careerrat.db

Debug/export-only lane:
CLI export/debug command or explicit debug URL
  -> export-to-tracker / tracker render / storage adapter
  -> workspace/tracker.json, workspace/activity.jsonl, workspace/tracker.html
```

This diagram reflects the locked boundary that product data flows through DB-derived APIs, while generated files stay on an explicit compatibility/export lane. [VERIFIED: 06-CONTEXT.md + AGENTS.md + codebase grep]

### Recommended Project Structure

```text
apps/web/src/
  app-shell/          # Product shell, nav, shared dashboard context.
  lib/api.js          # Central client API wrappers for product routes.
  pages/              # Product views that consume DB-derived APIs.

src/cli/
  data-route.mjs      # DB verb-backed product API routes.
  dashboard-route.mjs # DB-derived dashboard snapshot route.
  packet-route.mjs    # Migrate from tracker adapter to DB-derived packet API.
  boards-route.mjs    # Migrate product add path from YAML to DB source config.
  search-route.mjs    # Keep product scanner context DB-only.
  tracker-dev.mjs     # Serve /app and debug/export legacy routes with narrow labels.

src/core/db/
  connection.mjs
  export-to-tracker.mjs
  verbs/              # Canonical read/write owners.

tests/
  db-app-shell-regression.test.mjs # New static DB-only product guard.
```

The structure above follows existing ownership and avoids new storage adapters or a new server framework. [VERIFIED: codebase grep]

### Pattern 1: DB-Derived Snapshot Route

**What:** Build product JSON from DB rows in memory, then feed existing pure view-model builders without writing or reading compatibility files. [VERIFIED: src/cli/dashboard-route.mjs + src/core/db/export-to-tracker.mjs]  
**When to use:** Dashboard, tracker/activity summaries, scanner context summaries, and any page that needs existing tracker-shape view models. [VERIFIED: 06-CONTEXT.md]  
**Example:**

```js
// Source: src/cli/dashboard-route.mjs and src/core/db/export-to-tracker.mjs [VERIFIED: codebase grep]
addRoute("GET", "/api/data/dashboard", (_req, res) => {
  const db = requireDb({ repoRoot, env });
  const trackerData = assembleTrackerObject(db);
  const activityEvents = assembleActivityEvents(db);
  sendJson(res, 200, {
    ok: true,
    data: buildDashboardViewModel(trackerData, { activityEvents }),
  });
});
```

### Pattern 2: Thin DB Verb Route

**What:** Route modules parse/cap HTTP bodies, call shared DB verbs, return stable JSON, and translate missing DB to 409. [VERIFIED: src/cli/data-route.mjs + tests/data-route.test.mjs]  
**When to use:** Source setup writes, activity reads, sourced rows, application state, communications, and any future app-local state mutation. [VERIFIED: AGENTS.md + codebase grep]  
**Example:**

```js
// Source: src/cli/data-route.mjs [VERIFIED: codebase grep]
try {
  const result = appSetStatus({ repoRoot, env, id, to, note });
  sendJson(res, 200, { ok: true, data: result });
} catch (err) {
  if (err.code === "NO_DATABASE") {
    sendJson(res, 409, { ok: false, error: err.message });
  }
}
```

### Pattern 3: Product API Wrapper in `apps/web/src/lib/api.js`

**What:** Keep product views calling named wrappers instead of scattering raw `fetch` calls across pages. [VERIFIED: apps/web/src/lib/api.js]  
**When to use:** Every JSON API that product React pages call; binary upload can remain a documented exception because `resume-ai` posts raw file bytes today. [VERIFIED: apps/web/src/lib/api.js]  
**Example:**

```js
// Source: apps/web/src/lib/api.js [VERIFIED: codebase grep]
export function getDashboard() {
  return apiFetch("/api/data/dashboard");
}
```

### Pattern 4: Static Product-Dependency Guard

**What:** A `node:test` file scans app-facing source files for forbidden generated-file dependencies and keeps a narrow allowlist for export/debug modules. [VERIFIED: tests/company-discovery-regression.test.mjs; CITED: https://nodejs.org/api/test.html]  
**When to use:** APP-03 and APP-04 regression protection. [VERIFIED: .planning/REQUIREMENTS.md]  
**Example:**

```js
// Source pattern: tests/company-discovery-regression.test.mjs [VERIFIED: codebase grep]
const forbidden = /workspace\/tracker\.json|workspace\/activity\.jsonl|defaultAdapter|readTracker|\/api\/tracker|\/api\/activity/;
for (const file of productFiles) {
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(source, forbidden, `${file} must not depend on generated tracker exports`);
}
```

### Anti-Patterns to Avoid

- **Tracker-file fallback in product routes:** It violates locked decisions D-04/D-05 and makes missing DB look like a recoverable legacy mode. [VERIFIED: 06-CONTEXT.md]
- **Leaving `Classic` or legacy page links in `/app` navigation:** It keeps old product affordances alive despite APP-01. [VERIFIED: apps/web/src/app-shell/NavList.jsx + 06-CONTEXT.md]
- **Writing source setup through `config/search-sources.yml` from product UI:** DB source config already exists; YAML is compatibility state in DB workspaces. [VERIFIED: AGENTS.md + src/core/db/verbs/source-config.mjs + src/cli/boards-route.mjs]
- **Using `workspace/scan-results/*.json` as scanner context for product UI:** Scan result files are report/debug artifacts; product scanner context should use DB source config, sourced rows, and DB-owned watermarks. [VERIFIED: src/cli/search-route.mjs + scripts/scan-sourced.mjs]
- **Starting full skill runtime from local proposal or product data routes:** The architecture keeps full skill runtime for explicit handoffs, not default app primitives. [VERIFIED: AGENTS.md + docs/ARCHITECTURE.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQLite access | New sqlite package or ad hoc JSON DB | Existing `node:sqlite` connection and DB verbs | Repo already has `requireDb()`, migrations, verbs, import/export, and tests. [VERIFIED: src/core/db/*; CITED: https://nodejs.org/api/sqlite.html] |
| Dashboard/tracker shape | New dashboard serializer | `assembleTrackerObject(db)`, `assembleActivityEvents(db)`, `buildDashboardViewModel()` | Preserves existing view-model behavior without reading generated files. [VERIFIED: src/core/db/export-to-tracker.mjs + src/core/tracker/dashboard-data.js] |
| App route fetching | Scattered raw fetches | `apps/web/src/lib/api.js` wrappers | Keeps app API contracts auditable for static guards. [VERIFIED: apps/web/src/lib/api.js] |
| Source config storage | YAML writes from product route | `sourceConfigGet()`, `sourceConfigPut()`, `companyAtsUpsert()` | DB mode owns source config; YAML is compatibility output. [VERIFIED: AGENTS.md + src/core/db/verbs/source-config.mjs] |
| Packet artifact safety | New path resolver | Existing artifact/path safety helpers in `packet-route.mjs` and workspace path helpers | Existing route already handles traversal attempts and inline text. [VERIFIED: src/cli/packet-route.mjs + tests/packet-route.test.mjs] |
| Regression enforcement | Manual code review only | `node:test` static scans with explicit allowlists | Existing static regression pattern catches architectural drift. [VERIFIED: tests/company-discovery-regression.test.mjs; CITED: https://nodejs.org/api/test.html] |

**Key insight:** The hard part is not choosing libraries; it is closing every compatibility read/write seam that product code can reach while leaving export/debug tools functional and easy to audit. [VERIFIED: 06-CONTEXT.md + codebase grep]

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | Canonical data lives in `.careerrat/db/careerrat.db` when initialized; this checkout currently reports no database. DB tables and verbs exist for apps, sourced rows, comms, candidate config, source config, activity, and export shapes. [VERIFIED: `node src/cli/data.mjs status --json` + codebase grep] | Planner should use temp DB/import fixtures in tests and should not rely on this workspace's current `workspace/tracker.json`. No data migration is required by Phase 6 unless implementation changes DB schema. [VERIFIED: tests/data-route.test.mjs + 06-CONTEXT.md] |
| Live service config | Local `tracker-dev.mjs` route table still serves legacy exact routes, raw workspace endpoints, and `/app/*`; Electron opens `/app` or `/app/onboarding`. [VERIFIED: src/cli/tracker-dev.mjs + apps/desktop/main.mjs] | Classify or move legacy routes into debug/export-only labels and ensure product boot does not require tracker exports. [VERIFIED: 06-CONTEXT.md] |
| OS-registered state | No launchd/systemd/pm2 OS registration for this phase was found in the repository scan. [VERIFIED: codebase grep] | None for Phase 6; app packaging remains under `apps/desktop`. [VERIFIED: apps/desktop/package.json] |
| Secrets/env vars | BYOK keys resolve through active CareerRat home into `internal/ai.env` or `.internal/ai.env`, and product code must not echo them. [VERIFIED: AGENTS.md + src/core/ai/ai-env.mjs] | No secret rename is needed. Ensure new DB-first app routes do not expose secret content in setup/error responses. [VERIFIED: AGENTS.md] |
| Build artifacts | `apps/web/dist` serves `/app/*`; `workspace/tracker.html`, `workspace/tracker.json`, and `workspace/activity.jsonl` are generated compatibility artifacts; scan reports are written under `workspace/scan-results`. [VERIFIED: apps/web/vite.config.js + src/cli/tracker-dev.mjs + scripts/scan-sourced.mjs] | Rebuild web app after UI changes; keep generated files out of product dependencies and static guard allowlists except debug/export owners. [VERIFIED: 06-CONTEXT.md] |

## Common Pitfalls

### Pitfall 1: Reusing Export Helpers by Reading Export Files

**What goes wrong:** A route migrates to "DB-compatible" behavior by calling export code, then reads `workspace/tracker.json` or `workspace/activity.jsonl` afterward. [VERIFIED: codebase grep]  
**Why it happens:** Existing dashboard code historically consumed tracker-shaped data, and export helpers can make a tracker-shaped file. [VERIFIED: src/core/tracker/dashboard-data.js + src/core/db/export-to-tracker.mjs]  
**How to avoid:** Use `assembleTrackerObject(db)` and `assembleActivityEvents(db)` in memory; never round-trip through generated files in product routes. [VERIFIED: src/cli/dashboard-route.mjs]  
**Warning signs:** `defaultAdapter`, `readTracker`, `loadTrackerData`, `/api/tracker`, or raw `workspace/tracker.json` appears in app-facing route code. [VERIFIED: codebase grep]

### Pitfall 2: Treating Legacy Routes as "Still Useful" Product Paths

**What goes wrong:** `/tracker`, `/onboard`, `/search`, `/packet`, `/evaluate`, `/answer`, `/workspace/tracker.json`, and `/api/activity` remain discoverable as normal UX. [VERIFIED: src/cli/tracker-dev.mjs + apps/web/src/app-shell/NavList.jsx]  
**Why it happens:** `tracker-dev.mjs` serves both app and legacy routes today, and `NavList.jsx` still has a `Classic` link. [VERIFIED: codebase grep]  
**How to avoid:** Remove product links and either remove legacy routes or present them only through named debug/export paths. [VERIFIED: 06-CONTEXT.md]  
**Warning signs:** Product nav, onboarding copy, or Not Found text advertises legacy paths. [VERIFIED: apps/web/src/app-shell/NavList.jsx + src/cli/tracker-dev.mjs]

### Pitfall 3: Migrating Source Setup Halfway

**What goes wrong:** Source setup writes DB state in one path but the product page still reads `config/search-sources.yml` or `workspace/scan-results`. [VERIFIED: src/cli/boards-route.mjs + src/cli/search-route.mjs]  
**Why it happens:** Source config already has both legacy file config and DB `candidate_source_configs`. [VERIFIED: src/core/db/migrations/005-source-config.mjs]  
**How to avoid:** Add or promote DB product routes for source config read/write and scanner context, then make file config debug/export-only. [VERIFIED: AGENTS.md + src/core/db/verbs/source-config.mjs]  
**Warning signs:** Product route code calls `loadScannerConfig()`, parses `search-sources.yml`, or reads latest `workspace/scan-results/*.json`. [VERIFIED: codebase grep]

### Pitfall 4: Forgetting Scanner Dedupe Context

**What goes wrong:** A scan route is DB-first for source config and persistence but still calculates seen/dedupe state from tracker exports. [VERIFIED: scripts/scan-sourced.mjs + src/core/tracker/tracker-data.mjs]  
**Why it happens:** `buildSeenSets(repoRoot)` comes from legacy tracker data helpers. [VERIFIED: scripts/scan-sourced.mjs]  
**How to avoid:** Plan a DB-derived seen-set helper or inject current applications/sourced rows from DB when DB exists. [VERIFIED: src/core/db/verbs/*]  
**Warning signs:** A DB-mode scan test can pass while deleting `tracker.json` only because a fallback silently returns empty seen sets. [VERIFIED: tests/search-route.test.mjs + codebase grep]

### Pitfall 5: Overbroad Static Guards

**What goes wrong:** A static test forbids all generated-file references, breaking legitimate export/import/debug modules. [VERIFIED: codebase grep]  
**Why it happens:** Export compatibility is still required by AGENTS.md and DB import/export tests. [VERIFIED: AGENTS.md + tests/db-export.test.mjs]  
**How to avoid:** Define audited product-file globs and a separate allowlist for export/debug owners such as `src/core/db/export-to-tracker.mjs`, `src/core/db/import-from-tracker.mjs`, `src/core/storage/storage-adapter.mjs`, `src/cli/tracker.mjs`, and legacy tests. [VERIFIED: codebase grep]  
**Warning signs:** Guard failures in CLI export tests instead of product route/app files. [VERIFIED: tests/db-export.test.mjs + tests/storage-adapter.test.mjs]

## Code Examples

Verified patterns from official and project sources:

### Fail-Closed DB Route

```js
// Source: src/cli/data-route.mjs [VERIFIED: codebase grep]
try {
  const db = requireDb({ repoRoot, env });
  const rows = db.prepare("SELECT data FROM applications ORDER BY rowid ASC").all();
  sendJson(res, 200, { ok: true, data: rows.map((row) => JSON.parse(row.data)) });
} catch (err) {
  if (err.code === "NO_DATABASE") {
    sendJson(res, 409, { ok: false, error: err.message });
  }
}
```

### `/app` Nested Mount

```js
// Source: apps/web/vite.config.js [VERIFIED: codebase grep]
export default defineConfig({
  base: "/app/",
  plugins: [react()],
});
```

Vite official docs state that the `base` option rewrites asset paths for nested public paths. [CITED: https://vite.dev/guide/build]

### React App Route Map

```jsx
// Source: apps/web/src/App.jsx [VERIFIED: codebase grep]
<Routes>
  <Route element={<AppShell />}>
    <Route index element={<DashboardPage />} />
    <Route path="/settings" element={<SettingsPage />} />
    <Route path="/onboarding" element={<OnboardingPage />} />
  </Route>
</Routes>
```

React Router docs identify `BrowserRouter` as a browser History API router and document `basename` as the application basename. [CITED: https://reactrouter.com/api/declarative-routers/BrowserRouter]

### Source Config DB Owner

```js
// Source: src/core/db/verbs/source-config.mjs [VERIFIED: codebase grep]
sourceConfigPut({ repoRoot, name: "search-sources", data });
const config = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
```

Use this DB owner for product source setup routes instead of direct YAML writes. [VERIFIED: AGENTS.md + src/core/db/verbs/source-config.mjs]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Product dashboard reads generated `workspace/tracker.json` and `workspace/activity.jsonl`. | `/api/data/dashboard` reads DB and derives tracker/activity shapes in memory. | Existing before Phase 6, documented in Phase 6 context. [VERIFIED: src/cli/dashboard-route.mjs + 06-CONTEXT.md] | Planner should copy this pattern to packet, activity/tracker, source setup, and scanner context. [VERIFIED: 06-CONTEXT.md] |
| Byte-static pages are normal app affordances. | React `/app` is canonical; byte-static pages are debug/export-only or removed from product navigation. | Locked for Phase 6. [VERIFIED: 06-CONTEXT.md] | Remove old nav/copy and reclassify server routes. [VERIFIED: codebase grep] |
| Source setup writes `config/search-sources.yml`. | DB source config exists in `candidate_source_configs` through source-config verbs. | Existing before Phase 6. [VERIFIED: src/core/db/migrations/005-source-config.mjs + src/core/db/verbs/source-config.mjs] | Product source setup should read/write DB and leave YAML to compatibility flows. [VERIFIED: AGENTS.md] |
| Scanner reports rely on `workspace/scan-results/*.json`. | Product scanner context should be DB-derived from source config, sourced rows, and DB watermarks. | Locked for Phase 6 by D-07/D-08. [VERIFIED: 06-CONTEXT.md] | Keep scan-result files as debug/report artifacts unless a DB run-state table is planned. [VERIFIED: scripts/scan-sourced.mjs] |

**Deprecated/outdated:**
- Product use of `/tracker`, `/tracker.html`, `/api/tracker`, `/api/activity`, `/workspace/tracker.json`, and `/workspace/activity.jsonl` is deprecated by Phase 6 decisions. [VERIFIED: 06-CONTEXT.md]
- Product use of `defaultAdapter(repoRoot).readTracker()` is outdated for app-facing routes. [VERIFIED: src/cli/packet-route.mjs + 06-CONTEXT.md]
- Product source setup through `config/search-sources.yml` is outdated when a DB owner exists. [VERIFIED: AGENTS.md + src/cli/boards-route.mjs]

## Assumptions Log

All claims in this research were verified from project files, codebase inspection, registry/tool output, or official documentation. [VERIFIED: codebase grep + official docs + gsd tools]

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| - | No unverified assumptions recorded. | - | - |

## Open Questions (RESOLVED)

1. **RESOLVED — Should legacy exact routes be removed or moved behind `/debug/*` / `/export/*` names?**
   What we know: legacy routes still exist in `tracker-dev.mjs`, and locked decisions allow them only as explicit debug/export utilities. [VERIFIED: src/cli/tracker-dev.mjs + 06-CONTEXT.md]  
   Decision for Phase 6: remove normal product navigation and product copy for old routes, and keep only a small named debug/export allowlist if route compatibility is still needed. Do not preserve legacy routes as product UX. [VERIFIED: 06-CONTEXT.md + 06-01-PLAN.md + 06-04-PLAN.md]

2. **RESOLVED — Should scanner run state get a DB table in Phase 6?**
   What we know: source config and sourced rows already have DB owners, while `/api/search/results` reads the newest `workspace/scan-results` report file. [VERIFIED: src/core/db/verbs/source-config.mjs + src/cli/search-route.mjs]  
   Decision for Phase 6: do not add a new scanner run-state migration/table unless implementation proves it is required. Build DB-derived current scanner context from existing DB source config, applications, sourced rows, activity/watermark data, and a helper seam; keep scan-result JSON files debug/report-only. [VERIFIED: 06-CONTEXT.md + 06-03-PLAN.md + 06-07-PLAN.md]

3. **RESOLVED — Should source setup reuse `/api/boards/*` names or move under `/api/data/source-config/*`?**
   What we know: current board add route is legacy YAML-backed, while DB source config verbs already exist. [VERIFIED: src/cli/boards-route.mjs + src/core/db/verbs/source-config.mjs]  
   Decision for Phase 6: keep `POST /api/boards/preview` as a pure deterministic helper and migrate the existing product caller `POST /api/boards/add` to DB source config verbs. The planner may add clearer DB source-config aliases later, but this phase must make the currently reachable product route DB-owned. [VERIFIED: 06-CONTEXT.md + 06-03-PLAN.md + 06-06-PLAN.md]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Local server, DB, tests | yes | v24.18.0 | None needed. [VERIFIED: environment command] |
| npm | Workspace scripts | yes | 11.16.0 | None needed. [VERIFIED: environment command] |
| `node:sqlite` | Canonical DB | yes | Built into Node v24.18.0 | None needed. [VERIFIED: environment command; CITED: https://nodejs.org/api/sqlite.html] |
| Vite CLI | React app build | yes | 6.4.3 | Use existing workspace script. [VERIFIED: environment command] |
| Vitest CLI | React app tests | yes | 3.2.6 | Node route tests still cover backend. [VERIFIED: environment command] |
| Biome CLI | Formatting/lint checks | yes | 2.5.0 | Not required for this phase. [VERIFIED: environment command] |
| Electron | Desktop shell | yes | 43.0.0 | Browser-local `/app` can still test app shell. [VERIFIED: apps/desktop/package.json + environment command] |
| `careerrat` global CLI | Manual workspace commands | no | - | Use `node src/cli/*.mjs` or run `npm link` outside this research step if planner needs global CLI. [VERIFIED: environment command + AGENTS.md] |
| `.careerrat/db/careerrat.db` in current checkout | Live workspace state | no | - | Tests should create temp DBs with `importFromTracker()` or `data init`; product route should 409 when DB missing. [VERIFIED: `node src/cli/data.mjs status --json` + tests/data-route.test.mjs] |

**Missing dependencies with no fallback:**
- None for planning or route/test implementation. [VERIFIED: environment command]

**Missing dependencies with fallback:**
- `careerrat` global command is not on PATH in this shell; repository-local `node src/cli/*.mjs` commands are available. [VERIFIED: environment command]
- Current workspace DB is absent; test fixtures should create temporary DBs and product routes should fail closed when DB state is missing. [VERIFIED: environment command + tests/data-route.test.mjs]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node built-in `node:test` for backend/static tests; Vitest 3.2.6 for React app tests. [VERIFIED: package.json + apps/web/package.json + environment command] |
| Config file | Root tests use package scripts and direct `node --test`; React tests use `apps/web/vite.config.js`. [VERIFIED: package.json + apps/web/vite.config.js] |
| Quick run command | `node --test tests/dashboard-route.test.mjs tests/data-route.test.mjs tests/packet-route.test.mjs tests/search-route.test.mjs tests/boards-route.test.mjs tests/desktop-routing.test.mjs tests/db-app-shell-regression.test.mjs` [VERIFIED: tests directory scan; new file is Wave 0 gap] |
| Frontend quick command | `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` [VERIFIED: apps/web/package.json; new file is Wave 0 gap] |
| Full suite command | `npm test && npm --workspace apps/web run test` [VERIFIED: package.json + apps/web/package.json] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| APP-01 | `/app` is canonical and product nav no longer advertises Classic/legacy pages. [VERIFIED: .planning/REQUIREMENTS.md] | frontend + static | `npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx` and `node --test tests/db-app-shell-regression.test.mjs` | no - Wave 0 |
| APP-02 | Dashboard, packet, tracker/activity, scanner context, and source setup read DB-derived state. [VERIFIED: .planning/REQUIREMENTS.md] | backend route integration | `node --test tests/dashboard-route.test.mjs tests/data-route.test.mjs tests/packet-route.test.mjs tests/search-route.test.mjs tests/boards-route.test.mjs` | partial - packet/boards/search need updates |
| APP-03 | Generated tracker/activity files are export-only and not product dependencies. [VERIFIED: .planning/REQUIREMENTS.md] | static architecture | `node --test tests/db-app-shell-regression.test.mjs` | no - Wave 0 |
| APP-04 | Static tests fail on product route/app reads of generated tracker/activity files. [VERIFIED: .planning/REQUIREMENTS.md] | static architecture | `node --test tests/db-app-shell-regression.test.mjs` | no - Wave 0 |

### Sampling Rate

- **Per task commit:** run the narrow changed route/component test plus `node --test tests/db-app-shell-regression.test.mjs`. [VERIFIED: package.json + tests/company-discovery-regression.test.mjs]
- **Per wave merge:** run backend quick command and React quick command. [VERIFIED: package.json + apps/web/package.json]
- **Phase gate:** run `npm test && npm --workspace apps/web run test` before `$gsd-verify-work`. [VERIFIED: package.json + apps/web/package.json]

### Wave 0 Gaps

- [ ] `tests/db-app-shell-regression.test.mjs` - static APP-03/APP-04 guard for product files and debug/export allowlist. [VERIFIED: tests directory scan]
- [ ] `apps/web/src/app-shell/NavList.test.jsx` - verifies no `Classic`/`/tracker` normal product nav item remains. [VERIFIED: apps/web/src/app-shell/NavList.jsx]
- [ ] Update `tests/packet-route.test.mjs` - seed DB fixtures with `importFromTracker()` and expect 409 on missing DB, not 404 on missing tracker. [VERIFIED: tests/packet-route.test.mjs]
- [ ] Update `tests/boards-route.test.mjs` or add `tests/source-config-route.test.mjs` - product add/read path writes DB source config, not `config/search-sources.yml`. [VERIFIED: tests/boards-route.test.mjs]
- [ ] Update `tests/search-route.test.mjs` - product scanner context/results path does not read latest `workspace/scan-results/*.json` or legacy source config when DB is required. [VERIFIED: src/cli/search-route.mjs + tests/search-route.test.mjs]
- [ ] Add or update scanner seen-set tests - DB-mode scans derive dedupe from DB rows, not tracker exports. [VERIFIED: scripts/scan-sourced.mjs]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | Local app phase does not introduce user authentication; BYOK setup remains separate local key storage. [VERIFIED: AGENTS.md] |
| V3 Session Management | no | Phase 6 does not add browser-authenticated sessions; browser automation remains opt-in/fallback. [VERIFIED: AGENTS.md] |
| V4 Access Control | yes | Route ownership and explicit debug/export allowlists prevent product paths from reaching retained skill runtime or generated-file sources. [VERIFIED: docs/ARCHITECTURE.md + 06-CONTEXT.md] |
| V5 Input Validation | yes | Use capped JSON body parsing, URL validation, route param checks, DB verb validation, and path-safe artifact resolution. [VERIFIED: src/cli/skill-run-route.mjs + src/cli/boards-route.mjs + src/cli/packet-route.mjs] |
| V6 Cryptography | yes | Do not alter BYOK storage; local AI key storage remains chmod-limited and never echoed by API. [VERIFIED: AGENTS.md + src/core/ai/ai-env.mjs] |

### Known Threat Patterns for CareerRat Phase 6

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Generated-file tampering changes product UI state. | Tampering | Product routes read DB-derived state only; generated files are export/debug allowlisted. [VERIFIED: 06-CONTEXT.md + AGENTS.md] |
| Path traversal through packet artifact paths. | Information Disclosure | Reuse existing packet route path safety and workspace-bound artifact resolution. [VERIFIED: src/cli/packet-route.mjs + tests/packet-route.test.mjs] |
| SQL injection through route params or source setup fields. | Tampering | Use existing DB verbs and prepared statements instead of interpolated SQL. [VERIFIED: src/core/db/connection.mjs + src/core/db/verbs/*; CITED: https://nodejs.org/api/sqlite.html] |
| Product route accidentally starts full skill/chat runtime. | Elevation of Privilege | Keep full skill runtime behind explicit handoff routes; static guard product slices for `runSkillStream`, `startSession`, and `/api/skill/run` where relevant. [VERIFIED: docs/ARCHITECTURE.md + tests/company-discovery-regression.test.mjs] |
| Stale scanner report file drives product decisions. | Tampering | Product scanner context uses DB source config, sourced rows, DB watermarks, or a planned DB run-state table; scan-result JSON stays debug/report-only. [VERIFIED: scripts/scan-sourced.mjs + 06-CONTEXT.md] |

## Sources

### Primary (HIGH confidence)

- `.planning/phases/06-canonical-db-app-shell/06-CONTEXT.md` - locked Phase 6 decisions, discretion, deferred scope. [VERIFIED: 06-CONTEXT.md]
- `.planning/REQUIREMENTS.md` - APP-01 through APP-04 requirement mapping. [VERIFIED: .planning/REQUIREMENTS.md]
- `.planning/ROADMAP.md` - Phase 6 goal and success criteria. [VERIFIED: .planning/ROADMAP.md]
- `.planning/STATE.md` - current project direction and phase history. [VERIFIED: .planning/STATE.md]
- `.planning/APP-PRODUCT-PLAN.md` - app product shape and compatibility gaps. [VERIFIED: .planning/APP-PRODUCT-PLAN.md]
- `AGENTS.md` - DB write contract, compatibility export rules, source setup ownership, and app runtime constraints. [VERIFIED: AGENTS.md]
- `docs/ARCHITECTURE.md` - deterministic local API/DB ownership and skill runtime boundary. [VERIFIED: docs/ARCHITECTURE.md]
- Codebase files: `apps/web/src/App.jsx`, `apps/web/src/app-shell/*`, `apps/web/src/lib/api.js`, `apps/web/vite.config.js`, `apps/desktop/main.mjs`, `src/cli/dashboard-route.mjs`, `src/cli/data-route.mjs`, `src/cli/packet-route.mjs`, `src/cli/boards-route.mjs`, `src/cli/search-route.mjs`, `src/cli/tracker-dev.mjs`, `src/core/db/*`, `src/core/discovery/company-context.mjs`, `scripts/scan-sourced.mjs`, and relevant tests. [VERIFIED: codebase grep]

### Secondary (MEDIUM confidence)

- React Router BrowserRouter official docs - browser History API router and basename. [CITED: https://reactrouter.com/api/declarative-routers/BrowserRouter]
- Vite build official docs - production build and nested public base path behavior. [CITED: https://vite.dev/guide/build]
- Node SQLite official docs - `node:sqlite`, `DatabaseSync`, defensive mode and limits. [CITED: https://nodejs.org/api/sqlite.html]
- Node test runner official docs - matching test files and process-level isolation behavior. [CITED: https://nodejs.org/api/test.html]
- Electron BrowserWindow official docs - `loadURL()` can load local server URLs. [CITED: https://www.electronjs.org/docs/latest/api/browser-window]

### Tertiary (LOW confidence)

- None. [VERIFIED: research log]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - existing packages, local CLIs, and lockfile were verified; no new package installation is recommended. [VERIFIED: package-lock.json + environment command]
- Architecture: HIGH - recommendations are grounded in exact current route modules and locked Phase 6 decisions. [VERIFIED: 06-CONTEXT.md + codebase grep]
- Pitfalls: HIGH - each pitfall maps to an observed current seam or an existing regression-test pattern. [VERIFIED: codebase grep]
- External docs: MEDIUM - official docs were fetched and cached through the GSD research seam, but implementation should still follow local codebase patterns first. [CITED: official docs URLs]

**Research date:** 2026-07-05  
**Valid until:** 2026-08-04
