import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dbFilePath } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { userPath } from "../paths/workspace.mjs";
import { classifyStage, isKnownStatusLabel } from "../tracker/dashboard.mjs";

function jobRows(tracker) {
  const rows = new Map();
  for (const [kind, records] of [
    ["sourced", tracker.sourced],
    ["application", tracker.applications],
  ]) {
    if (records != null && !Array.isArray(records)) {
      throw new TypeError(`Saved ${kind} jobs must be an array`);
    }
    for (const record of records || []) {
      if (!record || typeof record !== "object" || !record.id) {
        throw new TypeError("A saved job is missing its stable ID");
      }
      const status = String(record.status || (kind === "sourced" ? "sourced" : ""));
      const customStage = tracker.stages?.some(
        (stage) =>
          stage?.id &&
          (stage.id === status ||
            stage.patterns?.some((pattern) =>
              status.toLowerCase().includes(String(pattern).toLowerCase())
            ))
      );
      const stage =
        status === "sourced"
          ? { id: "sourced", label: "Sourced", order: 0 }
          : isKnownStatusLabel(status) || customStage
            ? classifyStage(status, tracker.stages)
            : { id: "unknown", label: status || "Unknown", order: 99 };
      rows.set(record.id, { id: record.id, kind, stage, record });
    }
  }
  return [...rows.values()];
}

export function readJobs({ repoRoot, env = process.env } = {}) {
  const ctx = { repoRoot, env };
  const path = dbFilePath(ctx);
  let tracker;
  let searchRuns = [];
  let mode = "legacy";
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN");
      tracker = assembleTrackerObject(db);
      searchRuns = db
        .prepare(
          "SELECT data FROM sourcing_runs ORDER BY (status = 'running') DESC, updated_at DESC LIMIT 6"
        )
        .all()
        .map((row) => JSON.parse(row.data));
      db.exec("COMMIT");
      mode = "database";
    } finally {
      db.close();
    }
  } else {
    const legacyPath = userPath(ctx, "workspace/tracker.json");
    try {
      tracker = JSON.parse(readFileSync(legacyPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      tracker = {};
    }
  }
  if (!tracker || typeof tracker !== "object" || Array.isArray(tracker)) {
    throw new TypeError("Saved tracker must be an object");
  }
  return { mode, version: tracker.meta?.version ?? null, jobs: jobRows(tracker), searchRuns };
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function payFor(record, currency, basis) {
  const comp = record.evaluation?.compensation || {};
  const min = numeric(comp.basis === "annual-earnings" ? comp.minAnnualEarnings : comp.minBase);
  const max = numeric(comp.basis === "annual-earnings" ? comp.maxAnnualEarnings : comp.maxBase);
  const comparable =
    comp.currency === currency &&
    comp.basis === basis &&
    comp.source === "job-description" &&
    (min !== null || max !== null) &&
    (min === null || max === null || min <= max);
  return {
    currency: comp.currency ?? null,
    basis: comp.basis ?? null,
    source: comp.source ?? "unknown",
    min,
    max,
    comparable,
  };
}

export function viewJobs(
  data,
  { stage = "all", currency = "USD", basis = "base", order = "desc", selectedId = null } = {}
) {
  if (!["asc", "desc"].includes(order)) throw new TypeError("Pay order must be asc or desc");
  if (!["base", "annual-earnings"].includes(basis))
    throw new TypeError("Pay basis must be base or annual-earnings");
  const direction = order === "desc" ? -1 : 1;
  const jobs = data.jobs
    .filter((job) => stage === "all" || job.stage.id === stage)
    .map((job) => ({ ...job, pay: payFor(job.record, currency, basis) }))
    .sort((a, b) => {
      if (a.pay.comparable !== b.pay.comparable) return a.pay.comparable ? -1 : 1;
      if (a.pay.comparable) {
        const low = (a.pay.min ?? a.pay.max) - (b.pay.min ?? b.pay.max);
        const high = (a.pay.max ?? a.pay.min) - (b.pay.max ?? b.pay.min);
        if (low || high) return direction * (low || high);
      }
      const aKey = `${a.record.company || ""}\0${a.record.role || ""}\0${a.id}`;
      const bKey = `${b.record.company || ""}\0${b.record.role || ""}\0${b.id}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
  return {
    ...data,
    currency,
    basis,
    order,
    jobs,
    selectedId: jobs.some((job) => job.id === selectedId) ? selectedId : (jobs[0]?.id ?? null),
  };
}
