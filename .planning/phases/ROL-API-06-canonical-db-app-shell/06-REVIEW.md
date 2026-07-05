---
phase: ROL-API-06-canonical-db-app-shell
reviewed: 2026-07-05T19:25:21Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - tests/db-app-shell-regression.test.mjs
  - apps/web/src/onboarding/steps/WelcomeStep.test.jsx
  - apps/web/src/onboarding/steps/WelcomeStep.jsx
  - src/cli/tracker-dev.mjs
  - tests/onboard-route.test.mjs
  - src/cli/onboard-route.mjs
  - apps/web/src/onboarding/steps/FinishStep.jsx
  - apps/web/src/onboarding/steps/FinishStep.test.jsx
findings:
  critical: 1
  warning: 2
  info: 0
  total: 3
status: issues_found
---

# Phase ROL-API-06-canonical-db-app-shell: Code Review Report

**Reviewed:** 2026-07-05T19:25:21Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Reviewed the Phase 6 gap-closure changes for DB-mode onboarding source readiness and legacy/static-page demotion. The read-side `searchSourcesPresent` fix is pointed at SQLite now, but the export/quick-start writer still replaces the existing DB `search-sources` config with a regenerated baseline. That can drop user-curated sources, disabled/auth state, and watermarks.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Compatibility Export Clobbers Existing SQLite Search Sources

**File:** `src/cli/onboard-route.mjs:395`

**Issue:** `writeDbCompatibilityBundle()` builds a fresh baseline from profile/targeting and writes it directly with `sourceConfigPut()` at lines 397-398. Both quick-start (`prepareQuickStartSourcing()` at line 476) and explicit `/api/onboard/write-config` export (line 926) call this helper. In DB mode, a user may already have sources added through `/api/boards/add`, `rolester searches --add-url`, disabled authenticated sources, or source watermarks. This path replaces that whole SQLite row, so a normal Finish/Quick Start action can silently delete curated DB source setup while producing a passing compatibility YAML export. The tests at `tests/onboard-route.test.mjs:1145` and `tests/onboard-route.test.mjs:1212` only assert that a generated file exists; they never seed an existing DB config and assert preservation.

**Fix:**
```js
import { mergeSearchConfigs } from "../core/providers/search-sources.mjs";

function buildSearchSourceExport(pathCtx, targeting, profile) {
  const baseline = buildSearchSources(targeting, profile);
  const existing = sourceConfigGet({ ...pathCtx, name: "search-sources" });
  return existing.stored ? mergeSearchConfigs(existing.data, baseline) : baseline;
}

// For quick-start: persist the merged config.
const sources = buildSearchSourceExport(pathCtx, config.targeting, config.profile);
sourceConfigPut({ ...pathCtx, name: "search-sources", data: sources });

// For compatibility-only export: write YAML from `sources`, but do not replace
// SQLite unless the route is intentionally preparing source setup.
```

Add route tests that pre-store a custom search with `enabled: false`, `auth/platform`, and a `recency.lastRunAt`, then call both `/api/onboard/write-config` and `/api/discovery/quick-start`/`/api/onboard/quick-start` and assert the custom entry and watermark survive.

## Warnings

### WR-01: FinishStep Still Treats Compatibility Export As Source Readiness

**File:** `apps/web/src/onboarding/steps/FinishStep.jsx:205`

**Issue:** `sourceSetupReady` is computed as `compatibilityExported || !!state?.searchSourcesPresent` at line 206. That recreates the false-readiness class the phase was closing: a local "export compatibility files" result can unlock source-ready UI paths (`previewBoards()` at lines 278-292 and the LinkedIn add card at line 424) without relying on the backend's DB-derived `searchSourcesPresent`. The copy says export is CLI/debug support only, but the state machine still uses export freshness as product readiness.

**Fix:** Keep these concepts separate. Derive product readiness only from backend DB state (or a quick-start response that actually wrote/merged DB source setup), and keep `written` only for the export status message.

```jsx
const compatibilityExported = Array.isArray(written) && written.length > 0;
const sourceSetupReady =
  state?.searchSourcesPresent === true || (quickStartResult?.searches?.count ?? 0) > 0;

async function handleWriteConfig() {
  const result = await writeConfig();
  setWritten(result.written || []);
  await refreshWorkspace();
}
```

Extend `FinishStep.test.jsx` with a case where `state.searchSourcesPresent` is false but `writeConfig()` returns written files; assert the LinkedIn source card and "SQLite source setup is ready" state do not appear until refreshed DB state reports readiness.

### WR-02: Tracker-dev Help Still Presents Static Pages As Utility UX

**File:** `src/cli/tracker-dev.mjs:928`

**Issue:** `printHelp()` still groups `/evaluate`, `/answer`, `/onboard`, `/search`, and `/packet` under `Retained utility pages and APIs:` and describes them as normal pages at lines 928-934. The new regression test only scans the 404/help string from `buildNotFoundText()` and a narrow source regex; it does not execute `rolester tracker-dev --help`, so this user-facing help path still violates the Phase 6 requirement that static byte pages be compatibility/debug/export surfaces, not product utilities.

**Fix:** Split the help output into explicit buckets and test the actual CLI help output.

```text
Static compatibility/debug/export pages (not normal product UX):
  GET  /evaluate  Compatibility evaluation page
  GET  /answer    Compatibility answer drafting page
  GET  /onboard   Compatibility onboarding page
  GET  /search    Compatibility search page
  GET  /packet    Compatibility packet page

Explicit user-selected chat page:
  GET  /chat

Local app APIs:
  GET  /api/health
  ...
```

Add a regression that spawns `node src/cli/tracker-dev.mjs --help` and asserts the output contains the compatibility/debug/export heading and does not contain `Retained utility pages` around those static routes.

## Verification

Ran:

```bash
node --test tests/db-app-shell-regression.test.mjs tests/onboard-route.test.mjs
npm --workspace apps/web run test -- src/onboarding/steps/WelcomeStep.test.jsx src/onboarding/steps/FinishStep.test.jsx
```

Result: both commands passed. The passing tests do not cover the source-config preservation or `--help` copy failures above.

---

_Reviewed: 2026-07-05T19:25:21Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
