// dashboard-route.mjs — M10's GET /api/data/dashboard: the server-derived
// view model backing the SPA's Home/Jobs/Calendar surfaces (and, later, the
// header activity bell). One call gives every slice those surfaces need,
// derived consistently against the same DB snapshot — no risk of Home and
// Jobs disagreeing because they were fetched a few seconds apart against a
// db that changed in between (see the M10 design doc §2).
//
// Design: extract, don't rewrite. `buildDashboardViewModel` (src/core/tracker/
// dashboard-data.js) is the EXACT function the legacy dashboard render
// (`rolester tracker`, src/cli/tracker.mjs) already calls — reused here
// completely UNMODIFIED, never forked. Its verified input contract (read
// directly off its own top ~20 lines, `buildDashboardViewModel(trackerData,
// {now, activityEvents, modes, settings, library, agentGuidance})`) is
// assembled from the SAME sources tracker.mjs's runDashboard() already reads,
// just swapped from disk round-trips to in-process DB/config reads:
//
//   trackerData     assembleTrackerObject(db)      src/core/db/export-to-tracker.mjs
//   activityEvents  assembleActivityEvents(db)     same module
//   modes           loadModes({ root })            src/core/profile/modes.mjs
//   settings        loadSettingsSnapshot({ root })  src/core/tracker/settings-snapshot.mjs
//   library         loadLibrarySnapshot({ root })   src/core/tracker/library-snapshot.mjs
//   agentGuidance   loadAgentGuidanceSnapshot(...)  src/core/tracker/agent-guidance-snapshot.mjs
//
// The last four are config-file-derived (candidate/*.yml, workspace/setup-
// state.json) and completely independent of the db/tracker.json — reusing the
// same loaders tracker.mjs calls is not an assumption, it's the same code path.
// Every buildXStatus() reader inside buildDashboardViewModel defaults its own
// input to `{}`/`null` (buildModeStatus, buildSettingsStatus, buildLibraryStatus,
// buildAgentGuidanceStatus — see dashboard-data.js:504-608), so this route
// degrades gracefully rather than 500ing when candidate/config files are
// absent; only a missing DATABASE fails closed.
//
// Fail-closed 409 no-DB, same as every other /api/data/* route (decision 7,
// see data-route.mjs's own header comment). Envelope shape matches that same
// file: { ok, meta: { version, lastUpdatedAt }, data }.
import { requireDb } from "../core/db/connection.mjs";
import { assembleActivityEvents, assembleTrackerObject } from "../core/db/export-to-tracker.mjs";
import { loadModes } from "../core/profile/modes.mjs";
import { loadAgentGuidanceSnapshot } from "../core/tracker/agent-guidance-snapshot.mjs";
import { buildDashboardViewModel } from "../core/tracker/dashboard-data.js";
import { loadLibrarySnapshot } from "../core/tracker/library-snapshot.mjs";
import { loadSettingsSnapshot } from "../core/tracker/settings-snapshot.mjs";
import { sendJson } from "./skill-run-route.mjs";

function readMeta(db) {
  const row = db.prepare("SELECT version, last_updated_at FROM meta WHERE id = 1").get();
  return { version: row?.version ?? null, lastUpdatedAt: row?.last_updated_at ?? null };
}

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  return 500; // this route has no caller-supplied body/params to 400 on
}

function respondError(res, err) {
  sendJson(res, statusForError(err), { ok: false, error: err?.message || String(err) });
}

// `now` is injectable (mirrors chat-runtime.mjs's own `now = () => Date.now()`
// convention) so a parity test can hand the route the SAME Date instance a
// direct buildDashboardViewModel() call uses — otherwise two `new Date()`
// calls microseconds apart could disagree on relative-time strings or a
// grace-window boundary, which would be a false parity failure, not a real one.
export function mountDashboardRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  now = () => new Date(),
}) {
  addRoute("GET", "/api/data/dashboard", (_req, res) => {
    let db;
    try {
      db = requireDb({ repoRoot, env });
    } catch (err) {
      respondError(res, err);
      return;
    }

    try {
      const trackerData = assembleTrackerObject(db);
      const activityEvents = assembleActivityEvents(db);
      const modes = loadModes({ root: repoRoot });
      const settings = loadSettingsSnapshot({ root: repoRoot });
      const library = loadLibrarySnapshot({ root: repoRoot });
      const agentGuidance = loadAgentGuidanceSnapshot({ root: repoRoot, env });

      const viewModel = buildDashboardViewModel(trackerData, {
        now: now(),
        activityEvents,
        modes,
        settings,
        library,
        agentGuidance,
      });

      sendJson(res, 200, { ok: true, meta: readMeta(db), data: viewModel });
    } catch (err) {
      respondError(res, err);
    }
  });
}
