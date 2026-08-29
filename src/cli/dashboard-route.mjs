// dashboard-route.mjs — M10's GET /api/data/dashboard: the server-derived
// view model backing the SPA's Home/Jobs/Calendar surfaces (and, later, the
// header activity bell). One call gives every slice those surfaces need,
// derived consistently against the same DB snapshot — no risk of Home and
// Jobs disagreeing because they were fetched a few seconds apart against a
// db that changed in between (see the M10 design doc §2).
//
// `buildDashboardViewModel` (src/core/tracker/dashboard-data.js) is the shared
// JSON view-model builder used by this route. Its verified input contract (read
// directly off its own top ~20 lines, `buildDashboardViewModel(trackerData,
// {now, activityEvents, modes, settings, library, agentGuidance,
// calendarProviderStatus})`) is assembled from these sources:
//
//   trackerData             assembleTrackerObject(db), then safe local-JD completeness hydration
//   activityEvents          assembleActivityEvents(db)     same module
//   modes                   loadModes({ root })            src/core/profile/modes.mjs
//   settings                loadSettingsSnapshot({ root })  src/core/tracker/settings-snapshot.mjs
//   library                 loadLibrarySnapshot({ root })   src/core/tracker/library-snapshot.mjs
//   agentGuidance           loadAgentGuidanceSnapshot(...)  src/core/tracker/agent-guidance-snapshot.mjs
//   calendarProviderStatus  automationStatus({ root })      src/core/automation/consent.mjs
//
// The middle four are config-file-derived (candidate/*.yml, workspace/setup-
// state.json) and completely independent of the db/tracker.json — reusing the
// same loaders tracker.mjs calls is not an assumption, it's the same code path.
// calendarProviderStatus is calendar_sync's per-platform {enabled, consent,
// allowed} from candidate/automation.yml, keyed by platform — degrades to
// null (buildCalendarSync's existing "Consent gated" fallback) if that file
// is missing or automationStatus throws.
// Every buildXStatus() reader inside buildDashboardViewModel defaults its own
// input to `{}`/`null` (buildModeStatus, buildSettingsStatus, buildLibraryStatus,
// buildAgentGuidanceStatus — see dashboard-data.js:504-608), so this route
// degrades gracefully rather than 500ing when candidate/config files are
// absent; only a missing DATABASE fails closed.
//
// Fail-closed 409 no-DB, same as every other /api/data/* route (decision 7,
// see data-route.mjs's own header comment). Envelope shape matches that same
// file, with setup readiness kept outside the parity-tested view model:
// { ok, meta: { version, lastUpdatedAt }, data, setup }.
import { automationStatus } from "../core/automation/consent.mjs";
import { requireDb } from "../core/db/connection.mjs";
import { assembleActivityEvents, assembleTrackerObject } from "../core/db/export-to-tracker.mjs";
import { candidateConfigGet, chatFirstStateFromDb } from "../core/db/verbs.mjs";
import { hydrateJobDescriptionCompleteness } from "../core/jobs/job-description.mjs";
import { loadModes } from "../core/profile/modes.mjs";
import { loadAgentGuidanceSnapshotAsync } from "../core/tracker/agent-guidance-snapshot.mjs";
import { buildDashboardViewModel } from "../core/tracker/dashboard-data.js";
import { loadLibrarySnapshot } from "../core/tracker/library-snapshot.mjs";
import { loadSettingsSnapshot } from "../core/tracker/settings-snapshot.mjs";
import { sendJson } from "./skill-run-route.mjs";

function readMeta(db) {
  const row = db.prepare("SELECT version, last_updated_at FROM meta WHERE id = 1").get();
  return { version: row?.version ?? null, lastUpdatedAt: row?.last_updated_at ?? null };
}

function readDashboardDbSnapshot(db, { requestedAt }) {
  db.exec("BEGIN DEFERRED");
  try {
    const snapshot = {
      trackerData: assembleTrackerObject(db),
      activityEvents: assembleActivityEvents(db),
      chatFirst: chatFirstStateFromDb(db, { now: requestedAt }),
      meta: readMeta(db),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original read failure.
    }
    throw error;
  }
}

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  return 500; // this route has no caller-supplied body/params to 400 on
}

function respondError(res, err) {
  sendJson(res, statusForError(err), {
    ok: false,
    setup: null,
    error: err?.message || String(err),
  });
}

function readSetup({ repoRoot, env, candidateConfigGetForRoute }) {
  try {
    return candidateConfigGetForRoute({ repoRoot, env })?.setup || null;
  } catch {
    return null;
  }
}

// Reduces automationStatus()'s full capability matrix down to calendar_sync's
// per-platform {enabled, consent, allowed}, keyed by platform — the shape
// buildCalendarSync (dashboard-data.js) expects as its providerStatus arg.
// Degrades to null (its existing "Consent gated" fallback) rather than
// failing the whole dashboard route if automation.yml is missing/invalid.
function readCalendarProviderStatus({ repoRoot, env, automationStatusForRoute }) {
  try {
    const status = automationStatusForRoute({ root: repoRoot, env });
    const calendarSync = status.capabilities.find((c) => c.capability === "calendar_sync");
    if (!calendarSync) return null;
    return Object.fromEntries(
      calendarSync.platforms.map((p) => [
        p.platform,
        { enabled: p.enabled, consent: p.consent, allowed: p.allowed },
      ])
    );
  } catch {
    return null;
  }
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
  candidateConfigGet: candidateConfigGetForRoute = candidateConfigGet,
  automationStatus: automationStatusForRoute = automationStatus,
  loadAgentGuidance: loadAgentGuidanceForRoute = loadAgentGuidanceSnapshotAsync,
}) {
  addRoute("GET", "/api/data/dashboard", async (_req, res) => {
    let db;
    try {
      db = requireDb({ repoRoot, env });
    } catch (err) {
      respondError(res, err);
      return;
    }

    try {
      const requestedAt = now();
      const dbSnapshot = readDashboardDbSnapshot(db, { requestedAt });
      const trackerData = hydrateJobDescriptionCompleteness({
        trackerData: dbSnapshot.trackerData,
        repoRoot,
        env,
      });
      const modes = loadModes({ root: repoRoot });
      const settings = loadSettingsSnapshot({ root: repoRoot });
      const library = loadLibrarySnapshot({ root: repoRoot });
      const agentGuidance = await loadAgentGuidanceForRoute({ root: repoRoot, env });
      const calendarProviderStatus = readCalendarProviderStatus({
        repoRoot,
        env,
        automationStatusForRoute,
      });

      const viewModel = buildDashboardViewModel(trackerData, {
        now: requestedAt,
        activityEvents: dbSnapshot.activityEvents,
        modes,
        settings,
        library,
        agentGuidance,
        calendarProviderStatus,
      });
      viewModel.chatFirst = dbSnapshot.chatFirst;

      const setup = readSetup({ repoRoot, env, candidateConfigGetForRoute });

      sendJson(res, 200, { ok: true, meta: dbSnapshot.meta, data: viewModel, setup });
    } catch (err) {
      respondError(res, err);
    }
  });
}
