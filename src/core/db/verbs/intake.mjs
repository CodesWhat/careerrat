// verbs/intake.mjs — M9 Universal Intake's queue-state verbs.
//
// intake_items (migration 002) is workflow/queue bookkeeping, NOT tracker-
// visible domain data — the DB-backed analog of the throwaway
// workspace/captures/ the Browser Automation Contract already describes.
// Unlike every verb in app.mjs/sourced.mjs/comm.mjs, these do NOT go through
// verbs/shared.mjs's runVerb(): no meta.version/last_updated_at bump, no
// exportToTracker() call after commit — confirming an intake item into a
// real domain write (Lane A's appSetStatus, or whatever a Lane B/C skill
// calls) is what bumps those, exactly as it already does today; intake's own
// state machine (captured -> classifying -> proposed/needs_you -> confirmed
// -> running -> done/error, plus the dismissed side branch) is invisible to
// tracker.json and the legacy dashboard render by design.
//
// Activity logging is deliberately narrow: only intakeDecide's "confirm" path
// logs ONE activity_events row (type: "system", the closest fit in
// config/activity-event.schema.json's fixed enum — "intake" is not a
// recognized event type). Capture/classify transitions and dismissals log
// nothing — the domain verb or skill a confirm dispatches into logs its own
// event for the actual write, so this one row is "the user routed a paste
// somewhere," not a duplicate of that.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { userPath } from "../../paths/workspace.mjs";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";
import { logActivityEvent, NotFoundError, nowIso, putRow } from "./shared.mjs";

const TABLE = "intake_items";

export class InvalidTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidTransitionError";
    this.code = "INVALID_TRANSITION";
  }
}

// runIntakeVerb — the parallel to verbs/shared.mjs's runVerb() for queue-state
// writes: open the db (fail-closed, same requireDb() every domain verb uses),
// run `fn(db)` inside one BEGIN IMMEDIATE ... COMMIT. Deliberately does NOT
// bump meta and does NOT call exportToTracker() afterward — see this file's
// header comment for why intake_items sits outside the Tracker Write
// Contract entirely.
function runIntakeVerb({ repoRoot, env }, fn) {
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => fn(db));
}

function readItem(db, id) {
  const row = db
    .prepare(`SELECT data, created_at, updated_at FROM ${TABLE} WHERE id = ?`)
    .get(String(id));
  if (!row) return null;
  return { ...JSON.parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at };
}

function requireItem(db, id) {
  const item = readItem(db, id);
  if (!item) throw new NotFoundError(`no intake item with id "${id}"`);
  return item;
}

function writeItem(db, id, item, updatedAt) {
  // status/kind are read back out of `data` via the migration's GENERATED
  // columns — they must already be top-level keys on `item` for those
  // extractions to see them (mirrors applications/sourced's own blob shape:
  // company/role/status live at the object's top level, not nested).
  putRow(db, TABLE, id, item, { updated_at: updatedAt });
}

// Every paste's raw content also lands as a plain, human-readable file under
// workspace/intake/pastes/ — belt-and-suspenders recovery alongside the DB
// row itself, and the one place "nothing the user pastes is ever dropped"
// (AGENTS.md's Paste Intake rule) is visible outside a database file. File
// drops (a screenshot, a PDF) are NOT written here — those already have their
// own on-disk copy via whatever route saved them (mirrors
// src/cli/onboard-route.mjs's resume-ai upload convention), referenced via
// `sourceFilePath` instead.
function writeRawCapture({ repoRoot, env, id, inputKind, rawInput, capturedAt }) {
  if (inputKind === "file") return null;
  const relPath = `workspace/intake/pastes/${id}.md`;
  const fullPath = userPath({ repoRoot, env }, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  const frontmatter = [
    "---",
    `id: ${id}`,
    `inputKind: ${inputKind}`,
    `capturedAt: ${capturedAt}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(fullPath, `${frontmatter}\n${rawInput ?? ""}\n`, "utf8");
  return relPath;
}

// ---------------------------------------------------------------------------
// intakeCapture — the pre-confirm, always-happens write (Tier 1). Creates the
// row at status "captured" the instant a paste/url lands, BEFORE classify
// ever runs — a crashed/timed-out classify call still leaves this row (and
// the recovery file above) intact.
// ---------------------------------------------------------------------------
export function intakeCapture({ repoRoot, env, rawInput, inputKind, sourceFilePath = null } = {}) {
  if (!inputKind) throw new Error("intakeCapture: inputKind is required");
  if (inputKind !== "file" && !String(rawInput || "").trim()) {
    throw new Error("intakeCapture: rawInput is required for text/url captures");
  }
  const id = `intake_${randomUUID()}`;
  const now = nowIso();
  const capturedPath = writeRawCapture({ repoRoot, env, id, inputKind, rawInput, capturedAt: now });

  return runIntakeVerb({ repoRoot, env }, (db) => {
    const item = {
      id,
      status: "captured",
      kind: null,
      inputKind,
      rawInput: rawInput ?? null,
      sourceFilePath,
      capturedPath,
      classification: null,
      trackerMatch: null,
      dispatch: null,
      decision: null,
      decidedAt: null,
      result: null,
      error: null,
    };
    writeItem(db, id, item, now);
    return { id, item: { ...item, createdAt: now, updatedAt: now } };
  });
}

// ---------------------------------------------------------------------------
// intakeUpdate — the generic status/classification/result/error patch used by
// classify.mjs (captured -> classifying -> proposed/needs_you, stamping
// classification + trackerMatch + dispatch) and by the confirm-route's
// execution layer (confirmed -> running -> done/error, stamping result/
// error). Shallow-merges `patch` onto the existing row; never logs activity
// (see this file's header comment) and never bumps meta.
// ---------------------------------------------------------------------------
export function intakeUpdate({ repoRoot, env, id, patch } = {}) {
  if (!patch || typeof patch !== "object") throw new Error("intakeUpdate: patch is required");
  return runIntakeVerb({ repoRoot, env }, (db) => {
    const existing = requireItem(db, id);
    const updated = { ...existing, ...patch, id: existing.id };
    delete updated.createdAt;
    delete updated.updatedAt;
    const now = nowIso();
    writeItem(db, id, updated, now);
    return { id, item: { ...updated, createdAt: existing.createdAt, updatedAt: now } };
  });
}

// ---------------------------------------------------------------------------
// intakeDecide — the confirm-first gate itself. decision: "confirm" | "dismiss".
//
// "confirm" requires the row be in "proposed" (a needs_you item has no
// resolved dispatch target to confirm INTO — see src/core/intake/dispatch.mjs;
// the only actions available on a needs_you item are re-classify or dismiss).
// "dismiss" is allowed from "proposed", "needs_you", or "error" (a bad read
// or a failed run the user chooses to drop rather than retry) — it never
// deletes the row (AGENTS.md: "nothing the user pastes is ever dropped").
//
// Only "confirm" logs an activity event — dismissing isn't an outcome worth
// surfacing on the Activity Pulse feed.
// ---------------------------------------------------------------------------
const CONFIRMABLE_STATUSES = new Set(["proposed"]);
const DISMISSABLE_STATUSES = new Set(["proposed", "needs_you", "error"]);

export function intakeDecide({ repoRoot, env, id, decision, dispatchSummary } = {}) {
  if (decision !== "confirm" && decision !== "dismiss") {
    throw new Error('intakeDecide: decision must be "confirm" or "dismiss"');
  }
  return runIntakeVerb({ repoRoot, env }, (db) => {
    const existing = requireItem(db, id);
    const allowed = decision === "confirm" ? CONFIRMABLE_STATUSES : DISMISSABLE_STATUSES;
    if (!allowed.has(existing.status)) {
      throw new InvalidTransitionError(
        `intakeDecide: cannot ${decision} an intake item in status "${existing.status}"`
      );
    }

    const now = nowIso();
    const nextStatus = decision === "confirm" ? "confirmed" : "dismissed";
    const updated = { ...existing, status: nextStatus, decision, decidedAt: now };
    delete updated.createdAt;
    delete updated.updatedAt;
    writeItem(db, id, updated, now);

    let event = null;
    if (decision === "confirm") {
      event = logActivityEvent(db, {
        type: "system",
        title: `Intake: ${existing.kind || "paste"} confirmed${dispatchSummary ? ` — ${dispatchSummary}` : ""}`,
        refs: existing.trackerMatch?.id ? { applicationId: existing.trackerMatch.id } : null,
      });
    }

    return {
      id,
      item: { ...updated, createdAt: existing.createdAt, updatedAt: now },
      event,
    };
  });
}

// ---------------------------------------------------------------------------
// intakeList — read-only query, newest-first. The Inbox's data source.
// ---------------------------------------------------------------------------
export function intakeList({ repoRoot, env, status, limit } = {}) {
  const db = requireDb({ repoRoot, env });
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limitClause = Number.isInteger(limit) && limit > 0 ? "LIMIT ?" : "";
  if (limitClause) params.push(limit);

  const rows = db
    .prepare(
      `SELECT data, created_at, updated_at FROM ${TABLE} ${where} ORDER BY created_at DESC ${limitClause}`
    )
    .all(...params);
  return rows.map((row) => ({
    ...JSON.parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// intakeOne — read-only single-row lookup (GET /api/intake/one?id=).
export function intakeOne({ repoRoot, env, id } = {}) {
  const db = requireDb({ repoRoot, env });
  return readItem(db, id);
}
