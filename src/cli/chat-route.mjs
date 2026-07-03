// chat-route.mjs — M2 of the paid-POC journey: the HTTP surface for the
// conversational (multi-turn) skill runtime (src/core/ai/chat-runtime.mjs).
// Split out the same way P0-4's skill-run-route.mjs and M1's onboard-route.mjs
// were: `addRoute` is the mount point, `readJsonBodyCapped`/`sendJson` are
// imported from skill-run-route.mjs rather than duplicated (that file already
// exports them for exactly this reuse — see its own header comment).
//
// mountChatRoute({addRoute, repoRoot, chatRuntime, env}) registers:
//
//   POST /api/chat/start     { skill, input } -> 201 {chatId, skill, state}
//   GET  /api/chat/events    ?id=<chatId>     -> SSE (event/data/id frames)
//   POST /api/chat/message   { chatId, text } -> 202 {accepted:true} (fire-and-forget)
//   POST /api/chat/interrupt { chatId }       -> 202
//   POST /api/chat/close     { chatId }       -> 204
//   GET  /api/chat/by-skill  ?skill=<name>    -> 200 {chatId, skill, state, ...} / 404
//   GET  /api/chat/list                       -> 200 [{chatId, skill, state, ...}]
//
// Unlike POST /api/skill/run (skill-run-route.mjs), a chat session outlives
// any single request — the SSE response here is just ONE listener attached
// to a session that the runtime keeps running independently (see
// chat-runtime.mjs's pump()). That's why GET /api/chat/events's client
// disconnect (res.on("close"), wired inside chatRuntime.subscribe()) only
// unsubscribes this listener rather than aborting anything: the session
// keeps running so a reconnect (browser tab reopened, network blip) can pick
// the transcript back up mid-interview via Last-Event-ID replay.
//
// addRoute is tracker-dev.mjs's exact-string method+path Map (no :params),
// so the two routes that need an id (`events`, `by-skill`) read it off the
// query string themselves rather than the dispatcher parsing it.

import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB cap — same as skill-run-route.mjs.

// Maps a startSession() rejection's `.code` to the HTTP status to report
// *before* any 201 body would have gone out — mirrors skill-run-route.mjs's
// own statusForRunError() shape exactly.
function statusForStartError(err) {
  switch (err?.code) {
    case "SKILL_REQUIRED":
    case "SKILL_NOT_ALLOWED":
    case "NO_AI_ROUTE":
      return 400;
    case "DUPLICATE_SESSION":
      return 409;
    case "MAX_SESSIONS":
      return 429;
    case "SDK_NOT_INSTALLED":
      return 501;
    default:
      return 500;
  }
}

function statusForMessageError(err) {
  switch (err?.code) {
    case "EMPTY_TEXT":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "SESSION_CLOSED":
      return 410;
    default:
      return 500;
  }
}

function statusForInterruptError(err) {
  switch (err?.code) {
    case "NOT_FOUND":
      return 404;
    case "NOT_RUNNING":
      return 409;
    default:
      return 500;
  }
}

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

// `repoRoot`/`env` are accepted (not just `chatRuntime`) to keep this
// mount function's signature symmetric with mountSkillRunRoute()/
// mountOnboardRoutes() at the tracker-dev.mjs call site — every route needed
// by the seven handlers below is already fully resolvable from `chatRuntime`
// itself, so neither is read directly here.
export function mountChatRoute({ addRoute, repoRoot, chatRuntime, env = process.env }) {
  void repoRoot;
  void env;
  addRoute("POST", "/api/chat/start", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    try {
      const session = await chatRuntime.startSession({ skill: body?.skill, input: body?.input });
      sendJson(res, 201, session);
    } catch (err) {
      const payload = { error: err.message };
      if (err.code === "DUPLICATE_SESSION") payload.chatId = err.chatId;
      sendJson(res, statusForStartError(err), payload);
    }
  });

  addRoute("GET", "/api/chat/events", (req, res) => {
    const chatId = queryParam(req, "id");
    const lastEventId = req.headers["last-event-id"];
    try {
      chatRuntime.subscribe(chatId, res, { lastEventId });
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 500, { error: err.message });
    }
  });

  addRoute("POST", "/api/chat/message", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    try {
      const result = chatRuntime.postMessage(body?.chatId, body?.text);
      sendJson(res, 202, result);
    } catch (err) {
      sendJson(res, statusForMessageError(err), { error: err.message });
    }
  });

  addRoute("POST", "/api/chat/interrupt", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    try {
      await chatRuntime.interrupt(body?.chatId);
      sendJson(res, 202, { accepted: true });
    } catch (err) {
      sendJson(res, statusForInterruptError(err), { error: err.message });
    }
  });

  addRoute("POST", "/api/chat/close", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    try {
      chatRuntime.closeSession(body?.chatId);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 500, { error: err.message });
    }
  });

  addRoute("GET", "/api/chat/by-skill", (req, res) => {
    const skill = String(queryParam(req, "skill") || "").trim();
    const session = skill ? chatRuntime.findBySkill(skill) : null;
    if (!session) {
      sendJson(res, 404, { error: "no live session for that skill" });
      return;
    }
    sendJson(res, 200, session);
  });

  addRoute("GET", "/api/chat/list", (_req, res) => {
    sendJson(res, 200, chatRuntime.listSessions());
  });
}
