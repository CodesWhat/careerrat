// intake-route.mjs — M9 Universal Intake's HTTP surface: the drop zone for
// anything a candidate pastes (a JD, a job posting URL, a recruiter email, an
// interview transcript, a status update) plus the confirm-first gate that
// turns a proposed classification into an actual domain write / skill run /
// chat handoff.
//
// Registers:
//   POST /api/intake            capture: { text, inputKind? } -> classify pipeline
//   POST /api/intake/upload     raw bytes, ?name=<filename> -> durable file item
//   GET  /api/intake/list       ?status=&limit=
//   GET  /api/intake/one        ?id=
//   POST /api/intake/classify   { id } — re-run classification
//   POST /api/intake/confirm    { id } — the ONLY place a domain write / skill
//                                run / chat session may start for an intake item
//   POST /api/intake/dismiss    { id }
//
// Fail-closed 409 no-DB, same as data-route.mjs: intake_items is DB-native
// (migration 002) — a legacy tracker.json-only workspace sees the same
// NoDatabaseError "run rolester data import/init first" every other
// /api/data/* route already surfaces, not a silent fallback.
//
// ONE-WRITE-PATH + CONFIRM-FIRST: capture/classify never call a domain verb,
// runSkillStream, or chatRuntime — see src/core/db/verbs/intake.mjs's own
// header comment and src/core/intake/dispatch.mjs's header comment. Only
// POST /api/intake/confirm executes the {lane, action, params} dispatch
// src/core/intake/dispatch.mjs already resolved at classify time:
//   Lane A — appSetStatus() called directly, then intakeUpdate to done/error
//            (synchronous, same request).
//   Lane B — intakeUpdate to "running", then runSkillStream() fired in the
//            background (NOT awaited by this response — /api/skill/run is
//            normally an SSE stream a live client consumes; this confirm
//            endpoint is a plain JSON responder, so the run's own done/error
//            transition lands via a later intakeUpdate once it settles).
//   Lane C — chatRuntime.findBySkill(skill): reuse an existing live session
//            via postMessage(), or startSession() when none exists — the
//            SAME chatRuntime instance tracker-dev.mjs already constructs for
//            /api/chat/*, never a second registry.
//
// `fetchImpl`, `loadSdk`, `runSkillStream`, and `chatRuntime` are all
// dependency-injected (mirroring skill-run-route.mjs/chat-route.mjs/
// resolve.mjs's own conventions) so every path here is testable without a
// real network, SDK devDependency, or subprocess.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runSkillStream as defaultRunSkillStream } from "../core/ai/skill-runtime.mjs";
import { requireDb } from "../core/db/connection.mjs";
import {
  appSetStatus,
  InvalidTransitionError,
  intakeCapture,
  intakeDecide,
  intakeList,
  intakeOne,
  intakeUpdate,
} from "../core/db/verbs.mjs";
import { classifyIntakeItem } from "../core/intake/classify.mjs";
import { resolveIntakeDispatch } from "../core/intake/dispatch.mjs";
import { summarizeDispatch } from "../core/intake/dispatch-summary.mjs";
import { matchTrackerRecord } from "../core/intake/match.mjs";
import { resolveJobUrl } from "../core/intake/resolve.mjs";
import { userPath } from "../core/paths/workspace.mjs";
import { sanitizeUploadFilename } from "./onboard-route.mjs";
import { readJsonBodyCapped, readRawBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap every other JSON-body route uses.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // binary intake artifacts: PDFs/images/JDs.

// A re-classify (POST /api/intake/classify) is allowed from any status short
// of "confirmed and past it" — an item already being executed/decided is not
// re-classified out from under that in-flight work.
const RECLASSIFIABLE_STATUSES = new Set([
  "captured",
  "classifying",
  "proposed",
  "needs_you",
  "error",
]);

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  if (err?.code === "NOT_FOUND") return 404;
  if (err?.code === "INVALID_TRANSITION") return 409;
  return 400; // every other failure here is a caller/body validation problem
}

function respondError(res, err) {
  sendJson(res, statusForError(err), { ok: false, error: err?.message || String(err) });
}

// Single-token http(s) string -> "url"; anything else -> "text". Only used
// when the caller doesn't pass an explicit body.inputKind.
function detectInputKind(raw) {
  const trimmed = raw.trim();
  if (!/\s/.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return "url";
    } catch {
      // not a URL — falls through to "text"
    }
  }
  return "text";
}

// ---------------------------------------------------------------------------
// classifyAndPropose — capture -> classify -> match -> dispatch, shared by
// both POST /api/intake (first pass) and POST /api/intake/classify (re-run).
//
// Never lets an unexpected failure here strand the item: the raw capture is
// already durably written (intakeCapture's own DB row + workspace/intake/
// pastes/*.md) before this ever runs, so any error past that point degrades
// the item to status "error" (with the message) rather than 500ing the whole
// request and leaving the caller unsure whether anything was saved at all.
// ---------------------------------------------------------------------------
async function classifyAndPropose({ repoRoot, env, id, inputKind, rawInput, fetchImpl, loadSdk }) {
  try {
    intakeUpdate({ repoRoot, env, id, patch: { status: "classifying" } });

    let resolved = null;
    if (inputKind === "url") {
      resolved = await resolveJobUrl(rawInput, { fetchImpl });
    }

    const db = requireDb({ repoRoot, env });

    // Pre-classify trackerMatch: only what's deterministically known before
    // AI runs — a resolved URL's own company/title, or the bare URL itself.
    // Free-text pastes (jd-text, status-update, recruiter-email, …) have no
    // known entities yet at this point, so trackerMatch stays null until the
    // model extracts some.
    let preMatch = null;
    if (resolved?.bodyFetchStatus === "resolved") {
      preMatch = matchTrackerRecord({
        db,
        url: resolved.url,
        company: resolved.company,
        role: resolved.title,
      });
    } else if (inputKind === "url") {
      preMatch = matchTrackerRecord({ db, url: rawInput });
    }

    const classifyResult = await classifyIntakeItem({
      rawInput,
      inputKind,
      resolved,
      trackerMatch: preMatch,
      repoRoot,
      env,
      ...(loadSdk ? { loadSdk } : {}),
    });
    const classification = classifyResult.data;
    const entities = classification.entities || {};

    // Recompute the AUTHORITATIVE trackerMatch off whatever the model
    // extracted — never invented by the model, always this same
    // deterministic query, just re-run with better inputs than pre-classify
    // had. Falls back to preMatch when the model extracted nothing new.
    const finalMatch =
      entities.company || entities.role || entities.url
        ? matchTrackerRecord({
            db,
            url: entities.url || resolved?.url || (inputKind === "url" ? rawInput : null),
            company: entities.company,
            role: entities.role,
          })
        : preMatch;

    let dispatch = null;
    let nextStatus;
    if (classification.needsUser) {
      nextStatus = "needs_you";
    } else {
      dispatch = resolveIntakeDispatch({
        kind: classification.kind,
        entities,
        trackerMatch: finalMatch,
      });
      nextStatus = dispatch.action === "needs_you" ? "needs_you" : "proposed";
    }

    return intakeUpdate({
      repoRoot,
      env,
      id,
      patch: {
        status: nextStatus,
        kind: classification.kind,
        classification,
        trackerMatch: finalMatch,
        dispatch,
      },
    }).item;
  } catch (err) {
    return intakeUpdate({ repoRoot, env, id, patch: { status: "error", error: err.message } }).item;
  }
}

// ---------------------------------------------------------------------------
// Confirm-time lane execution — the ONLY code path in this file allowed to
// call a domain verb, runSkillStream, or chatRuntime. See dispatch.mjs's own
// header comment for the lane definitions.
// ---------------------------------------------------------------------------

// withDispatchSummary — every response that carries an item with a `dispatch`
// field also carries a `dispatchSummary` string alongside it (M10: killing
// apps/web/src/inbox/dispatch-summary.js's hand-maintained client mirror —
// see dispatch-summary.mjs's own header comment). A cheap pure-function call
// right before sendJson, computed off the SAME dispatch object the item
// already has — never a second derivation.
function withDispatchSummary(item) {
  if (!item) return item;
  return { ...item, dispatchSummary: summarizeDispatch(item.dispatch) };
}

function executeLaneA({ repoRoot, env, id, dispatch }) {
  const { applicationId, to, note } = dispatch.params;
  const verbResult = appSetStatus({
    repoRoot,
    env,
    id: applicationId,
    to,
    note: note || undefined,
  });
  return intakeUpdate({
    repoRoot,
    env,
    id,
    patch: { status: "done", result: { applicationId, to, meta: verbResult.meta } },
  }).item;
}

// The evaluate-job input shape a Lane B run needs isn't pinned by name
// elsewhere in this milestone's scope — this is the smallest defensible
// mapping off what classify.mjs already extracted: the URL when one is
// known, the raw pasted JD text otherwise, plus whatever company/role the
// model pulled out as extra grounding.
function buildLaneBInput(item) {
  const entities = item.classification?.entities || {};
  return {
    url: entities.url || (item.inputKind === "url" ? item.rawInput : null),
    text: item.inputKind === "text" ? item.rawInput : null,
    company: entities.company || null,
    role: entities.role || null,
  };
}

// Fires runSkillStream() in the background and returns immediately with the
// item already flipped to "running" — this confirm endpoint is a plain JSON
// responder, not the SSE stream POST /api/skill/run normally is, so nothing
// here awaits the run itself; onEvent is a no-op (a future iteration could
// persist progress events onto the item, or re-expose them over its own SSE
// — out of this milestone's scope).
function executeLaneB({ repoRoot, env, id, item, dispatch, runSkillStream }) {
  const running = intakeUpdate({ repoRoot, env, id, patch: { status: "running" } }).item;
  const skill = dispatch.params.skill;
  const input = buildLaneBInput(item);
  const controller = new AbortController();
  runSkillStream({ skill, input, repoRoot, env, onEvent: () => {}, signal: controller.signal })
    .then((resultData) => {
      const failed = resultData?.ok === false;
      intakeUpdate({
        repoRoot,
        env,
        id,
        patch: {
          status: failed ? "error" : "done",
          result: resultData,
          error: failed ? resultData?.error || "skill run did not complete" : null,
        },
      });
    })
    .catch((err) => {
      intakeUpdate({ repoRoot, env, id, patch: { status: "error", error: err.message } });
    });
  return running;
}

function buildChatHandoffText(item) {
  const entities = item.classification?.entities || {};
  return [
    "A new intake item was confirmed and routed to this skill.",
    "",
    "Raw paste:",
    item.rawInput || "(no text captured)",
    "",
    `Extracted entities: ${JSON.stringify(entities)}`,
  ].join("\n");
}

// mapCloseReasonToIntakePatch — chat-runtime.mjs's onClose() fires with one of
// six close reasons (see that file's closeSessionInternal); this is the
// intake-specific outcome each one maps to (M10 decisions memo §5's table).
// "done" reasons are normal/user-intentional endings; "error" reasons are
// genuine failures OR (shutdown) a restart this milestone deliberately does
// NOT try to auto-resume across — an honest "this got interrupted" beats
// silently mis-marking it done or leaving the item stuck "running" forever.
function mapCloseReasonToIntakePatch(reason, lastError) {
  switch (reason) {
    case "process_exited":
    case "closed":
      return { status: "done" };
    case "idle_timeout":
      // classifyChatEvent already maps a `result` event to state "idle" before
      // any idle-sweep eviction can fire, so an idle-timeout almost always
      // means the last turn already completed — best-effort "done", not error.
      return { status: "done" };
    case "error":
      return { status: "error", error: lastError || "chat session ended in error" };
    case "aborted":
      return { status: "error", error: "session aborted" };
    case "shutdown":
      return {
        status: "error",
        error: "server restarted mid-session; re-open to retry",
      };
    default:
      return { status: "error", error: `chat session closed for unknown reason "${reason}"` };
  }
}

// Chat session collision per the decisions memo: reuse an existing live
// session for the skill via findBySkill and post the intake as a message;
// only start a new session when none exists. Either way, register an
// onClose() listener for THIS intake item — even a reused session's eventual
// close must resolve this item, not just whichever item happened to start it
// (a live session can carry multiple confirmed intake items across its
// lifetime, each needing its own done/error outcome when the chat ends).
async function executeLaneC({ repoRoot, env, id, item, dispatch, chatRuntime }) {
  const skill = dispatch.params.skill;
  const handoffText = buildChatHandoffText(item);
  const liveSession = chatRuntime.findBySkill(skill);
  let chatId;
  if (liveSession) {
    chatRuntime.postMessage(liveSession.chatId, handoffText);
    chatId = liveSession.chatId;
  } else {
    const started = await chatRuntime.startSession({
      skill,
      input: {
        intakeId: id,
        rawInput: item.rawInput,
        entities: item.classification?.entities || {},
      },
    });
    chatId = started.chatId;
  }
  chatRuntime.onClose(chatId, ({ reason, lastError }) => {
    intakeUpdate({ repoRoot, env, id, patch: mapCloseReasonToIntakePatch(reason, lastError) });
  });
  return intakeUpdate({ repoRoot, env, id, patch: { status: "running", result: { chatId } } }).item;
}

// ---------------------------------------------------------------------------
// mountIntakeRoutes
// ---------------------------------------------------------------------------

export function mountIntakeRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  loadSdk,
  runSkillStream = defaultRunSkillStream,
  chatRuntime,
}) {
  addRoute("POST", "/api/intake", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }

    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) {
      sendJson(res, 400, { ok: false, error: "body.text is required" });
      return;
    }
    let inputKind = body?.inputKind;
    if (inputKind !== undefined && inputKind !== "text" && inputKind !== "url") {
      sendJson(res, 400, { ok: false, error: 'body.inputKind must be "text" or "url" when given' });
      return;
    }
    if (!inputKind) inputKind = detectInputKind(text);

    let captured;
    try {
      captured = intakeCapture({ repoRoot, env, rawInput: text, inputKind });
    } catch (err) {
      respondError(res, err);
      return;
    }

    const finalItem = await classifyAndPropose({
      repoRoot,
      env,
      id: captured.id,
      inputKind,
      rawInput: text,
      fetchImpl,
      loadSdk,
    });
    sendJson(res, 200, { ok: true, item: withDispatchSummary(finalItem) });
  });

  addRoute("POST", "/api/intake/upload", async (req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const name = (requestUrl.searchParams.get("name") || "").trim();
    if (!name) {
      sendJson(res, 400, { ok: false, error: "?name=<filename> is required" });
      return;
    }

    try {
      requireDb({ repoRoot, env });
    } catch (err) {
      respondError(res, err);
      return;
    }

    let bytes;
    try {
      bytes = await readRawBodyCapped(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    if (!bytes.length) {
      sendJson(res, 400, { ok: false, error: "request body is empty" });
      return;
    }

    const relPath = `workspace/intake/uploads/${Date.now()}-${sanitizeUploadFilename(name)}`;
    const absPath = userPath({ repoRoot, env }, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, bytes);

    let captured;
    try {
      captured = intakeCapture({ repoRoot, env, inputKind: "file", sourceFilePath: relPath });
    } catch (err) {
      respondError(res, err);
      return;
    }

    const finalItem = intakeUpdate({
      repoRoot,
      env,
      id: captured.id,
      patch: {
        status: "needs_you",
        kind: "other",
        classification: {
          kind: "other",
          entities: {
            company: null,
            role: null,
            url: null,
            statusTo: null,
            statusNote: null,
            contactName: null,
            contactEmail: null,
            interviewDate: null,
          },
          proposedAction: "File captured. Review it in Inbox and route it manually.",
          confidence: 0,
          needsUser: true,
          needsUserReason:
            "binary file was captured, but automatic file text extraction is not available for intake yet",
        },
        trackerMatch: null,
        dispatch: null,
      },
    }).item;

    sendJson(res, 200, { ok: true, item: withDispatchSummary(finalItem) });
  });

  addRoute("GET", "/api/intake/list", (req, res) => {
    try {
      const status = queryParam(req, "status") || undefined;
      const limitParam = queryParam(req, "limit");
      const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
      const items = intakeList({ repoRoot, env, status, limit });
      sendJson(res, 200, { ok: true, items: items.map(withDispatchSummary) });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("GET", "/api/intake/one", (req, res) => {
    const id = queryParam(req, "id");
    if (!id) {
      sendJson(res, 400, { ok: false, error: "?id= is required" });
      return;
    }
    try {
      const item = intakeOne({ repoRoot, env, id });
      if (!item) {
        sendJson(res, 404, { ok: false, error: `no intake item with id "${id}"` });
        return;
      }
      sendJson(res, 200, { ok: true, item: withDispatchSummary(item) });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/intake/classify", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    const id = body?.id;
    if (!id) {
      sendJson(res, 400, { ok: false, error: "body.id is required" });
      return;
    }

    let existing;
    try {
      existing = intakeOne({ repoRoot, env, id });
    } catch (err) {
      respondError(res, err);
      return;
    }
    if (!existing) {
      sendJson(res, 404, { ok: false, error: `no intake item with id "${id}"` });
      return;
    }
    if (!RECLASSIFIABLE_STATUSES.has(existing.status)) {
      respondError(
        res,
        new InvalidTransitionError(
          `intake item "${id}" cannot be re-classified from status "${existing.status}"`
        )
      );
      return;
    }

    const finalItem = await classifyAndPropose({
      repoRoot,
      env,
      id,
      inputKind: existing.inputKind,
      rawInput: existing.rawInput,
      fetchImpl,
      loadSdk,
    });
    sendJson(res, 200, { ok: true, item: withDispatchSummary(finalItem) });
  });

  addRoute("POST", "/api/intake/confirm", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    const id = body?.id;
    if (!id) {
      sendJson(res, 400, { ok: false, error: "body.id is required" });
      return;
    }

    let existing;
    try {
      existing = intakeOne({ repoRoot, env, id });
    } catch (err) {
      respondError(res, err);
      return;
    }
    if (!existing) {
      sendJson(res, 404, { ok: false, error: `no intake item with id "${id}"` });
      return;
    }

    let decided;
    try {
      decided = intakeDecide({
        repoRoot,
        env,
        id,
        decision: "confirm",
        dispatchSummary: summarizeDispatch(existing.dispatch),
      });
    } catch (err) {
      respondError(res, err);
      return;
    }

    const dispatch = existing.dispatch;
    let finalItem = decided.item;
    try {
      if (dispatch?.lane === "A") {
        finalItem = executeLaneA({ repoRoot, env, id, dispatch });
      } else if (dispatch?.lane === "B") {
        finalItem = executeLaneB({ repoRoot, env, id, item: existing, dispatch, runSkillStream });
      } else if (dispatch?.lane === "C") {
        finalItem = await executeLaneC({
          repoRoot,
          env,
          id,
          item: existing,
          dispatch,
          chatRuntime,
        });
      } else {
        // Defensive only: dispatch.mjs never returns a lane-less action
        // except "needs_you", and intakeDecide's CONFIRMABLE_STATUSES
        // already excludes needs_you items from ever reaching here.
        throw new Error(
          `intake item "${id}" has an unrecognized dispatch lane "${dispatch?.lane}"`
        );
      }
    } catch (err) {
      finalItem = intakeUpdate({
        repoRoot,
        env,
        id,
        patch: { status: "error", error: err.message },
      }).item;
    }

    sendJson(res, 200, { ok: true, item: finalItem });
  });

  addRoute("POST", "/api/intake/dismiss", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    const id = body?.id;
    if (!id) {
      sendJson(res, 400, { ok: false, error: "body.id is required" });
      return;
    }
    try {
      const decided = intakeDecide({ repoRoot, env, id, decision: "dismiss" });
      sendJson(res, 200, { ok: true, item: decided.item });
    } catch (err) {
      respondError(res, err);
    }
  });
}
