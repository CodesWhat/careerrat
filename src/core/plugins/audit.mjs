// audit.mjs — records one plugin run as an Activity Pulse event.
//
// Plugins get no dedicated audit store: they reuse the same append-only
// activity feed every other subsystem writes user-visible activity to
// (../tracker/activity-log.mjs), the mechanism the dashboard's Activity Pulse
// panel already renders. This keeps a plugin run in the same audit trail as
// everything else the agent does, instead of inventing a second one.

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
  root,
  env,
} = {}) {
  const durationMs =
    startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null;
  const errorText = ok ? null : oneLine(error) || "plugin run failed";

  return appendActivity(
    {
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
      },
    },
    { root, env }
  );
}
