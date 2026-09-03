// audit.mjs — records one plugin run as an Activity Pulse event.
//
// Plugins get no dedicated audit store: they reuse the same append-only
// activity feed every other subsystem writes user-visible activity to
// (../tracker/activity-log.mjs), the mechanism the dashboard's Activity Pulse
// panel already renders. This keeps a plugin run in the same audit trail as
// everything else the agent does, instead of inventing a second one.
//
// Two writers, one contract. A DB-backed workspace treats activity_events as
// canonical; the next `exportToTracker` regenerates workspace/activity.jsonl
// from that table, so an append that only ever touched the JSONL file would
// be silently dropped on the next export. src/cli/activity.mjs's `append
// --write` already makes this same DB-first choice (`dbExists(...) ?
// activityAppend(...) : appendActivity(...)`); this module follows the exact
// same detector and the exact same canonical verb rather than inventing a
// second one. Legacy (non-DB) workspaces keep writing straight to the JSONL
// file, unchanged.

import { dbExists } from "../db/connection.mjs";
import { activityAppend } from "../db/verbs/index.mjs";
import { appendActivity } from "../tracker/activity-log.mjs";

function oneLine(value) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value?.message ?? value);
  const trimmed = text.trim();
  return trimmed || null;
}

export function recordPluginRun({
  plugin,
  version,
  roleId,
  startedAt,
  finishedAt,
  ok,
  error,
  fetched,
  timedOut = false,
  root,
  env,
} = {}) {
  const durationMs =
    startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null;
  const errorText = ok ? null : oneLine(error) || "plugin run failed";
  const status = timedOut ? "timeout" : ok ? "ok" : "error";

  const event = {
    type: "system",
    actor: "agent",
    title: ok ? `Plugin ${plugin} ran` : `Plugin ${plugin} failed`,
    summary: errorText,
    refs: roleId ? { applicationId: roleId } : null,
    tone: ok ? "info" : "warning",
    skill: `plugin:${plugin}`,
    operation: "plugin:run",
    detail: {
      version: version || null,
      startedAt: startedAt || null,
      finishedAt: finishedAt || null,
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      fetched: Array.isArray(fetched) ? fetched : [],
      error: errorText,
      status,
    },
  };

  // Same detector src/cli/activity.mjs's `append --write` uses: a DB-backed
  // workspace's activity_events table is canonical, so the append has to go
  // through the DB verb (which also re-exports workspace/activity.jsonl) or
  // the row never survives the next export. A legacy (non-DB) workspace has
  // no such table, so it keeps writing straight to the JSONL file.
  if (dbExists({ repoRoot: root, env })) {
    return activityAppend({ repoRoot: root, env, event });
  }
  return appendActivity(event, { root, env });
}
