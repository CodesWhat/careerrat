// dead-boards.mjs — decide which scan results say "this board does not exist"
// and key a configured source so edits to it reset what we remembered.
import { createHash } from "node:crypto";
import { dbExists } from "../db/connection.mjs";
import {
  deadBoardList,
  deadBoardPrune,
  deadBoardRecord,
  isDeadBoardSkipped,
} from "../db/verbs/search-liveness.mjs";

// Fields that change on every run or don't affect where the board lives.
const VOLATILE_FIELDS = new Set(["lastRunAt", "recency", "enabled", "label", "name"]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !VOLATILE_FIELDS.has(key))
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

export function deadBoardSourceKey(kind, entry) {
  const digest = createHash("sha256")
    .update(JSON.stringify(stable(entry || {})))
    .digest("hex")
    .slice(0, 24);
  return `${kind}:${digest}`;
}

const DEAD_STATUS = /\bHTTP (404|410)\b/;

// "dead": the only thing the board said was 404/410 and it returned nothing.
// "alive": it answered cleanly. "unknown": anything else (timeout, 5xx, 429,
// network error, login wall, a mix) says nothing about whether the board exists.
export function classifyBoardOutcome(result = {}) {
  const errors = result.errors || [];
  if (result.needsLogin) return "unknown";
  if (errors.length === 0) return "alive";
  if ((result.offers || []).length > 0) return "unknown";
  return errors.every((entry) => DEAD_STATUS.test(String(entry?.error || ""))) ? "dead" : "unknown";
}

// Drop confirmed-dead sources from this run. `companies` are tracked-company
// entries, `tasks` are search-source tasks ({ kind, source }). Browser tasks
// are never remembered. With `bypass` (an explicit --company or --recheck-dead)
// nothing is skipped. Rows for sources no longer configured are pruned first,
// so removing a source and adding it back is an immediate re-check.
// Returns { companies, tasks, skipped, keys } where keys maps each entry to
// its key for recording the outcome afterwards.
export function planDeadBoardSkips({
  pathCtx,
  companies,
  tasks,
  allCompanies = companies,
  allSources = [],
  bypass = false,
  prune = false,
  now = new Date(),
}) {
  const keys = new Map();
  const companyKey = (entry) => {
    if (!keys.has(entry)) keys.set(entry, deadBoardSourceKey("company", entry));
    return keys.get(entry);
  };
  const taskKey = (task) => {
    if (!keys.has(task)) keys.set(task, deadBoardSourceKey(task.kind, task.source));
    return keys.get(task);
  };
  if (!dbExists(pathCtx)) return { companies, tasks, skipped: [], keys, companyKey, taskKey };
  if (prune) {
    const keep = [
      ...allCompanies.map((entry) => deadBoardSourceKey("company", entry)),
      ...allSources.flatMap((entry) => [
        deadBoardSourceKey("rss", entry),
        deadBoardSourceKey("board", entry),
      ]),
    ];
    deadBoardPrune({ ...pathCtx, keepKeys: keep });
  }
  const dead = new Map(deadBoardList(pathCtx).map((row) => [row.source_key, row]));
  const skipped = [];
  const skip = (key) => {
    const row = dead.get(key);
    if (bypass || !isDeadBoardSkipped(row, now)) return false;
    skipped.push({
      label: row.label,
      kind: row.kind,
      since: row.dead_since,
      error: row.last_error,
    });
    return true;
  };
  return {
    companies: companies.filter((entry) => !skip(companyKey(entry))),
    tasks: tasks.filter((task) => !["rss", "board"].includes(task.kind) || !skip(taskKey(task))),
    skipped,
    keys,
    companyKey,
    taskKey,
  };
}

// Record one scan result against its source. Transient failures change nothing.
export function recordDeadBoardOutcome({ pathCtx, key, kind, label, result, now = new Date() }) {
  const outcome = classifyBoardOutcome(result);
  if (outcome === "unknown" || !dbExists(pathCtx)) return null;
  try {
    return deadBoardRecord({
      ...pathCtx,
      sourceKey: key,
      kind,
      label,
      outcome,
      error: outcome === "dead" ? result.errors?.[0]?.error : null,
      now,
    });
  } catch {
    return null; // Best-effort: memory must never fail the scan.
  }
}
