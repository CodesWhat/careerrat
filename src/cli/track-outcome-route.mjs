// track-outcome-route.mjs — POST /api/track-outcome, the HTTP surface for the
// bounded track-outcome AI pipeline (src/core/ai/track-outcome-bounded.mjs).
// Loads the application row, runs the bounded classification call, then
// persists ONLY the typed status/nextAction/nextActionDue fields through the
// SAME shared verbs the CLI and /api/data/app/* routes already call
// (appSetStatus/appSetFields, src/core/db/verbs/app.mjs) — decision 6's "one
// shared write path" holds here too. The raw pasted text and any AI prose
// never land in the DB, only the validated typed fields.
//
// Mirrors deep-ingest-route.mjs's split: proposeFromSource (shared.mjs) is
// AI-call-only and returns a validated result; buildAndPersistProposals (the
// route) does the actual persistence. Same shape here: runTrackOutcome
// validates and returns a decision; this route persists it.
//
// Fail-closed 409 no-DB (decision 7), same posture as data-route.mjs/
// deep-ingest-route.mjs — no application data means nothing to classify.
//
// Registers:
//   POST /api/track-outcome   { applicationId, text }
//     -> { ok, data: { applicationId, decision, meta }, ai, manual }
//        404 unknown applicationId, 409 no database yet, 422 AI_SCHEMA_INVALID
//        (surfaced as ok:false with the bounded envelope's code) when the
//        model never produces a valid decision after its retry.

import { runTrackOutcome as defaultRunTrackOutcome } from "../core/ai/track-outcome-bounded.mjs";
import { requireDb } from "../core/db/connection.mjs";
import { appSetFields, appSetStatus } from "../core/db/verbs.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB, same cap the other JSON-body routes use.

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  if (err?.code === "NOT_FOUND") return 404;
  return 400; // every other failure here is a caller/body validation problem
}

function respondError(res, err) {
  sendJson(res, statusForError(err), { ok: false, error: err?.message || String(err) });
}

function loadApp(db, id) {
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(id);
  return row ? JSON.parse(row.data) : null;
}

// Persist the validated decision through the existing typed verbs — never a
// second write path, never the raw pasted text. `appSetStatus` already writes
// `note` -> `statusNote` and `followUpDueAt` -> `followUp.dueAt` in one
// transaction (src/core/db/verbs/app.mjs); a non-empty `nextAction` is then
// merged into `followUp.title` via `appSetFields`'s one-level shallow merge,
// which lands alongside the `dueAt` the status call just wrote rather than
// clobbering it.
function persistDecision({ repoRoot, env, applicationId, decision }) {
  const statusResult = appSetStatus({
    repoRoot,
    env,
    id: applicationId,
    to: decision.status,
    note: decision.note || undefined,
    followUpDueAt: decision.nextActionDue || undefined,
  });

  if (decision.nextAction) {
    appSetFields({
      repoRoot,
      env,
      id: applicationId,
      patch: { followUp: { title: decision.nextAction } },
    });
  }

  return statusResult;
}

export function mountTrackOutcomeRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  runTrackOutcome = defaultRunTrackOutcome,
}) {
  addRoute("POST", "/api/track-outcome", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }

    const applicationId = String(body?.applicationId || "").trim();
    const text = String(body?.text || "").trim();
    if (!applicationId) {
      sendJson(res, 400, { ok: false, error: "body.applicationId is required" });
      return;
    }
    if (!text) {
      sendJson(res, 400, { ok: false, error: "body.text is required" });
      return;
    }

    let db;
    try {
      db = requireDb({ repoRoot, env });
    } catch (err) {
      respondError(res, err);
      return;
    }

    const app = loadApp(db, applicationId);
    if (!app) {
      sendJson(res, 404, { ok: false, error: `no application with id "${applicationId}"` });
      return;
    }

    try {
      const result = await runTrackOutcome({
        applicationId,
        pastedText: text,
        app,
        repoRoot,
        env,
      });

      if (result.status !== "ok" || !result.decision) {
        sendJson(res, 200, {
          ok: false,
          code: result.code,
          data: { applicationId, decision: null },
          ai: result.ai,
          manual: result.manual,
        });
        return;
      }

      const persisted = persistDecision({
        repoRoot,
        env,
        applicationId,
        decision: result.decision,
      });

      sendJson(res, 200, {
        ok: true,
        data: { applicationId, decision: result.decision, meta: persisted.meta },
        ai: result.ai,
        manual: result.manual,
      });
    } catch (err) {
      respondError(res, err);
    }
  });
}
