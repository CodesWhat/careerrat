import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dbFilePath } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { userPath } from "../paths/workspace.mjs";
import { extractCompBand } from "../scoring/sourced-scanner.mjs";
import { classifyStage, isKnownStatusLabel, isTerminalStage } from "../tracker/dashboard.mjs";
import { readHistorySnapshot } from "./history.mjs";

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
  let history = { threads: new Map(), jobMessages: new Map(), workspaceMessages: [], changes: [] };
  let mode = "legacy";
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN");
      tracker = assembleTrackerObject(db);
      history = readHistorySnapshot(db);
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
  return {
    mode,
    version: tracker.meta?.version ?? null,
    jobs: jobRows(tracker).map((job) => ({
      ...job,
      thread: history.threads.get(job.id) || null,
      contextMessages: history.jobMessages.get(job.id) || [],
    })),
    searchRuns,
    workspaceMessages: history.workspaceMessages,
    changes: history.changes,
  };
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function unknownPay(comp = {}) {
  return {
    currency: comp.currency ?? null,
    basis: comp.basis ?? null,
    source: comp.source ?? "unknown",
    min: null,
    max: null,
    comparable: false,
  };
}

// Saved jobs usually carry pay as free text (base, tc), not a structured
// evaluation. Read a range only where the existing compensation parser finds
// one; vague text such as "unlisted" stays unknown.
function notePay(record, currency, basis) {
  const text = basis === "annual-earnings" ? record.tc : record.base;
  if (typeof text !== "string" || !text.trim()) return null;
  const band = extractCompBand(text);
  const min = numeric(band?.min);
  const max = numeric(band?.max);
  if (min === null || max === null) return null;
  return {
    currency: band.currency ?? null,
    basis,
    source: "saved-note",
    min,
    max,
    comparable: band.currency === currency && min <= max,
  };
}

function payFor(record, currency, basis) {
  const comp = record.evaluation?.compensation || {};
  const min = numeric(comp.basis === "annual-earnings" ? comp.minAnnualEarnings : comp.minBase);
  const max = numeric(comp.basis === "annual-earnings" ? comp.maxAnnualEarnings : comp.maxBase);
  if (min === null && max === null) return notePay(record, currency, basis) || unknownPay(comp);
  const comparable =
    comp.currency === currency &&
    comp.basis === basis &&
    comp.source === "job-description" &&
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

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// What the Fit column shows. Prefer the saved evaluation, else the scores
// the tracker already holds on the job itself.
function fitFor(record) {
  const evaluation = record.evaluation || {};
  const score = numeric(evaluation.fitScore ?? record.fitScore);
  const verdict = text(evaluation.gate) ?? text(record.gate?.gate) ?? text(record.fitBucket);
  return {
    score,
    verdict,
    label: [score, verdict].filter((part) => part !== null).join(" ") || null,
  };
}

// A job in a closed-out stage (rejected, withdrawn) is not live work.
export function isClosedJob(job) {
  return isTerminalStage(job.stage.id);
}

export function viewJobs(
  data,
  { stage = "active", currency = "USD", basis = "base", order = "desc", selectedId = null } = {}
) {
  if (!["asc", "desc"].includes(order)) throw new TypeError("Pay order must be asc or desc");
  if (!["base", "annual-earnings"].includes(basis))
    throw new TypeError("Pay basis must be base or annual-earnings");
  const direction = order === "desc" ? -1 : 1;
  const jobs = data.jobs
    .filter((job) =>
      stage === "all"
        ? true
        : stage === "active"
          ? !isTerminalStage(job.stage.id)
          : job.stage.id === stage
    )
    .map((job) => ({
      ...job,
      pay: payFor(job.record, currency, basis),
      fit: fitFor(job.record),
    }))
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
    total: data.jobs.length,
    stages: [
      ...new Map(
        [...data.jobs]
          .sort((a, b) => a.stage.order - b.stage.order)
          .map((job) => [job.stage.id, { id: job.stage.id, label: job.stage.label }])
      ).values(),
    ],
    selectedId: jobs.some((job) => job.id === selectedId) ? selectedId : (jobs[0]?.id ?? null),
  };
}

const SNAPSHOT_WORKSPACE_MESSAGE_LIMIT = 100;
const SNAPSHOT_WORKSPACE_BYTE_LIMIT = 2 * 1024 * 1024;

// The Textual bridge sends each snapshot as one JSON line with a 32 MiB read
// limit. Send only the newest workspace messages; the saved data and the
// Changes list are untouched.
export function capWorkspaceMessages(
  messages,
  { limit = SNAPSHOT_WORKSPACE_MESSAGE_LIMIT, bytes = SNAPSHOT_WORKSPACE_BYTE_LIMIT } = {}
) {
  const rows = Array.isArray(messages) ? messages : [];
  const kept = [];
  let size = 0;
  for (let index = rows.length - 1; index >= 0 && kept.length < limit; index--) {
    size += Buffer.byteLength(JSON.stringify(rows[index]) ?? "");
    if (size > bytes) break;
    kept.push(rows[index]);
  }
  return { messages: kept.reverse(), total: rows.length };
}
