// chat-runtime.mjs — M2 of the paid-POC journey: the conversational (multi-turn)
// skill runtime so ingest-profile's interview can run from the browser, not
// just a terminal session. This is the sibling of skill-runtime.mjs's
// one-shot runSkillStream(), but structurally different in one load-bearing
// way: a chat is a long-lived Agent SDK query() held open across many HTTP
// requests, not one request that streams a single result and returns.
//
// DECISION (verified against the installed @anthropic-ai/claude-agent-sdk
// @0.3.199 — both sdk.d.ts and the compiled sdk.mjs, not from memory): a
// single long-lived query() with a push-queue AsyncIterable<SDKUserMessage>
// passed as `prompt` on the FIRST call. Reading sdk.mjs's own query-instance
// constructor confirms only `typeof prompt === "string"` sets
// isSingleUserTurn — and isSingleUserTurn is what makes the transport call
// `endInput()` (close stdin) the moment the first `result` message lands.
// Passing an AsyncIterable from the start avoids that: the child CLI process
// stays alive, reading new turns off our queue, for the life of the chat.
//
// Per-turn `options.resume` (spawn a fresh CLI process per turn, replaying
// the prior transcript) was independently evaluated and REJECTED as the
// primary path: a 40-80 turn interview would mean 40-80 process respawns,
// each replaying an ever-longer transcript — O(n^2) token cost and
// per-question latency — and a respawn mid-turn would abort whatever the
// model was doing (e.g. STEP 2b's project-folder scan). `resume` stays a
// deferred v1.1 cost optimization (e.g. resuming a chat that survived a
// server restart); correctness for "did setup actually finish" rides on
// `workspace/setup-state.json`, which ingest-profile's own SKILL.md already
// owns as the resumability record — not on SDK session continuity.
//
// The push-queue below is a minimal hand-rolled async channel — push(value),
// close(), a pending-resolver-parked next()/[Symbol.asyncIterator] — that
// deliberately mirrors the shape of the SDK's own internal input channel
// (sdk.mjs's queue class backing Query#inputStream): enqueue when a reader is
// waiting, buffer otherwise; done() flushes a pending read with {done:true}.
//
// PRIVACY NOTE: the Agent SDK's `persistSession` option defaults to true,
// which writes full transcripts to `~/.claude/projects/` — the SAME local
// trust boundary this codebase already extends to plaintext `candidate/*.yml`
// (see AGENTS.md's Privacy Invariant), not a new one. `deleteSession()`
// hardening (scrubbing that transcript on chat close) is deferred — this is
// a documented gap, not a silent one, and should land before this route is
// ever exposed off 127.0.0.1.
//
// Everything here is pure/testable against a hand-rolled fake `query()` (see
// tests/chat-runtime.test.mjs) — the real devDependency is loaded lazily via
// the same `loadSdk` sender skill-runtime.mjs's runSkillStream uses, dependency-
// injected so these tests never spawn a real CLI subprocess.

import { randomUUID } from "node:crypto";
import { resolveAIRoute } from "./call-ai.mjs";
import {
  buildChildEnv,
  buildPrompt,
  loadClaudeAgentSdk,
  mapSdkMessage,
  RUNTIME_TOOLS,
  resolveSkillAllowlist,
  writeByokUsage,
} from "./skill-runtime.mjs";

// Default-restricted to ingest-profile — the only skill M2 ships a
// conversational front end for. Same "empty string explicitly locks it down,
// unset falls back to the default" semantics as ROLESTER_RUNTIME_SKILLS (see
// skill-runtime.mjs's resolveSkillAllowlist header comment) — deliberately
// shared logic, not a re-derived copy.
const DEFAULT_CHAT_SKILLS = "ingest-profile";

export function resolveAllowedChatSkills({ repoRoot, env = process.env } = {}) {
  return resolveSkillAllowlist({
    repoRoot,
    env,
    envVar: "ROLESTER_CHAT_SKILLS",
    defaultValue: DEFAULT_CHAT_SKILLS,
  });
}

// ---------------------------------------------------------------------------
// buildChatKickoffPrompt — the first message pushed onto a new session's
// queue. Reuses skill-runtime.mjs's buildPrompt with mode: "conversational"
// so the posture text (Postures section, chat-runtime.mjs's design doc) is
// never hand-duplicated.
// ---------------------------------------------------------------------------

export function buildChatKickoffPrompt({ skill, input } = {}) {
  return buildPrompt({ skill, input, mode: "conversational" });
}

function buildKickoffMessage({ skill, input }) {
  return {
    type: "user",
    message: { role: "user", content: buildChatKickoffPrompt({ skill, input }) },
    parent_tool_use_id: null,
  };
}

// ---------------------------------------------------------------------------
// classifyChatEvent — pure state-machine lookup from one mapped event
// (skill-runtime.mjs's mapSdkMessage output shape: {type, data}) to the
// session's next lifecycle state, or null for "no transition". Deliberately
// narrow: a `result` event (any subtype — success or error, the pump doesn't
// care) always means the turn is over and the session is waiting on the
// human again. A `system`/`session_state_changed` frame is the SDK's own
// authoritative turn-over signal (see sdk.d.ts's SDKSessionStateChangedMessage
// doc comment) and is treated the same way for idle/running; its third
// possible state, `requires_action`, has no UI meaning here yet and falls
// through to null (no transition) rather than being guessed at.
//
// NEVER sniff a result's `subtype` for "closed" — closed is a pump lifecycle
// decision (the generator returning or throwing), not something any single
// SDK message declares on its own.
// ---------------------------------------------------------------------------

export function classifyChatEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (evt.type === "result") return "idle";
  if (evt.type === "system" && evt.data?.subtype === "session_state_changed") {
    if (evt.data.state === "idle") return "idle";
    if (evt.data.state === "running") return "running";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Push-queue — a minimal async channel implementing exactly what
// AsyncIterable<SDKUserMessage> needs: push a value in, read it out via
// next(), park the reader when nothing is queued yet. See this file's header
// comment for why this mirrors the SDK's own internal channel shape.
// ---------------------------------------------------------------------------

function createPushQueue() {
  const buffered = [];
  let pendingResolve = null;
  let pendingReject = null;
  let done = false;
  let failure = null;
  let started = false;

  return {
    push(value) {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        resolve({ done: false, value });
        return;
      }
      buffered.push(value);
    },
    close() {
      done = true;
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        resolve({ done: true, value: undefined });
      }
    },
    error(err) {
      failure = err;
      if (pendingReject) {
        const reject = pendingReject;
        pendingResolve = null;
        pendingReject = null;
        reject(err);
      }
    },
    next() {
      if (buffered.length) return Promise.resolve({ done: false, value: buffered.shift() });
      if (done) return Promise.resolve({ done: true, value: undefined });
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
    },
    return() {
      done = true;
      return Promise.resolve({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      if (started) throw new Error("chat push-queue can only be iterated once");
      started = true;
      return this;
    },
  };
}

// ---------------------------------------------------------------------------
// Small env-number helper — ROLESTER_CHAT_IDLE_TTL_MS / ROLESTER_CHAT_MAX_TURNS
// override the factory defaults below when set to a positive number; any
// other value (unset, blank, non-numeric, zero/negative) falls back silently
// rather than producing a broken runtime.
// ---------------------------------------------------------------------------

function envNumber(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// createChatRuntime — the session registry + pump driver.
// ---------------------------------------------------------------------------

export function createChatRuntime({
  repoRoot,
  env = process.env,
  loadSdk = loadClaudeAgentSdk,
  now = () => Date.now(),
  idleTtlMs = envNumber(env, "ROLESTER_CHAT_IDLE_TTL_MS", 30 * 60 * 1000),
  closedTtlMs = 5 * 60 * 1000,
  maxSessions = 4,
  maxTurns = envNumber(env, "ROLESTER_CHAT_MAX_TURNS", 200),
} = {}) {
  // id -> session record. See this file's header + the M2 design doc for the
  // exact record shape: {id, skill, sdkSessionId, state, closeReason, query,
  // pushQueue, events, nextEventId, listeners, abortController, createdAt,
  // lastActivityAt, pumpDone}.
  const sessions = new Map();
  let sweepTimer = null;

  function summarize(session) {
    return {
      chatId: session.id,
      skill: session.skill,
      state: session.state,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    };
  }

  function findLiveSessionRecord(skill) {
    for (const session of sessions.values()) {
      if (session.skill === skill && (session.state === "running" || session.state === "idle")) {
        return session;
      }
    }
    return null;
  }

  function countLiveSessions() {
    let n = 0;
    for (const session of sessions.values()) {
      if (session.state === "running" || session.state === "idle") n++;
    }
    return n;
  }

  function writeSseFrame(res, record) {
    try {
      res.write(
        `event: ${record.type}\ndata: ${JSON.stringify(record.data)}\nid: ${record.id}\n\n`
      );
    } catch {
      // The listener's own res.on("close") handler (wired in subscribe())
      // is what removes it from session.listeners — nothing to do here.
    }
  }

  // Appends `evt` to the session's full event buffer (assigning the next
  // monotonic id) and fans it out to every currently-subscribed SSE
  // listener. The buffer is what makes GET /api/chat/events's Last-Event-ID
  // replay possible — see subscribe() below.
  function recordAndBroadcast(session, evt) {
    const record = { id: session.nextEventId++, type: evt.type, data: evt.data };
    session.events.push(record);
    for (const res of session.listeners) {
      writeSseFrame(res, record);
    }
    return record;
  }

  // Idempotent: marks a session closed, flushes a synthetic `chat_state`
  // "closed" event, ends every subscribed SSE response, and closes the
  // push-queue so nothing further can be written to a dead child process.
  // Deliberately does NOT touch session.query/abortController — callers that
  // actually need to terminate the underlying process call those themselves
  // (closeSession() below) before delegating here for the bookkeeping.
  function closeSessionInternal(session, reason) {
    if (session.state === "closed") return;
    session.state = "closed";
    session.closeReason = reason;
    session.lastActivityAt = now();
    try {
      session.pushQueue.close();
    } catch {
      // best-effort only
    }
    recordAndBroadcast(session, {
      type: "chat_state",
      data: { chatId: session.id, state: "closed", reason },
    });
    for (const res of session.listeners) {
      try {
        res.end();
      } catch {
        // ignore — connection already gone
      }
    }
    session.listeners.clear();
  }

  // The per-session pump: request-independent, started once by startSession
  // and left running until the query's async generator returns or throws.
  // No request handler ever touches this loop directly.
  async function pump(session, route) {
    try {
      for await (const msg of session.query) {
        if (msg?.type === "system" && msg.subtype === "init" && msg.session_id) {
          session.sdkSessionId = msg.session_id;
        }

        const events = mapSdkMessage(msg, { env });
        for (const evt of events) {
          recordAndBroadcast(session, evt);
          const nextState = classifyChatEvent(evt);
          if (nextState && nextState !== session.state) {
            session.state = nextState;
            recordAndBroadcast(session, {
              type: "chat_state",
              data: { chatId: session.id, state: nextState },
            });
          }
        }

        if (msg?.type === "result") {
          session.lastActivityAt = now();
          // Mirrors runSkillStream's own "proxy already meters its own
          // traffic server-side" comment — only BYOK needs a usage_event
          // written here, once per turn (per result), not once per session.
          if (route.type === "byok") {
            writeByokUsage({ msg, skill: session.skill, repoRoot, env });
          }
        }
      }
      // The generator returned on its own — the child process exited.
      closeSessionInternal(session, "process_exited");
    } catch (err) {
      if (session.abortController.signal.aborted) {
        closeSessionInternal(session, "aborted");
      } else {
        recordAndBroadcast(session, { type: "error", data: { message: err.message } });
        closeSessionInternal(session, "error");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  // Validation order is load-bearing (see this file's design doc): empty
  // skill -> not-allowed -> duplicate-live-session -> capacity -> no AI
  // route -> SDK import. Every check before "SDK import" runs with zero I/O
  // so a bad request never spawns a process.
  async function startSession({ skill, input } = {}) {
    const trimmedSkill = String(skill || "").trim();
    if (!trimmedSkill) {
      const err = new Error("skill is required");
      err.code = "SKILL_REQUIRED";
      throw err;
    }

    const allowed = resolveAllowedChatSkills({ repoRoot, env });
    if (!allowed.includes(trimmedSkill)) {
      const err = new Error(
        `skill "${trimmedSkill}" is not allowed to run via the chat runtime (allowed: ` +
          `${allowed.join(", ") || "none"}) — set ROLESTER_CHAT_SKILLS to opt more in`
      );
      err.code = "SKILL_NOT_ALLOWED";
      err.allowed = allowed;
      throw err;
    }

    // One live session per skill — ingest-profile writes candidate/*.yml
    // directly, so two concurrent sessions for the same skill would race on
    // the same files.
    const existing = findLiveSessionRecord(trimmedSkill);
    if (existing) {
      const err = new Error(`a live chat session already exists for skill "${trimmedSkill}"`);
      err.code = "DUPLICATE_SESSION";
      err.chatId = existing.id;
      throw err;
    }

    if (countLiveSessions() >= maxSessions) {
      const err = new Error(`maximum concurrent chat sessions (${maxSessions}) reached`);
      err.code = "MAX_SESSIONS";
      throw err;
    }

    const route = resolveAIRoute(env);
    if (route.type === "none") {
      const err = new Error(route.error);
      err.code = "NO_AI_ROUTE";
      throw err;
    }

    // Validate the SDK devDependency is importable before creating any
    // session state — a missing install is a clean 501 from the route, never
    // a half-registered session sitting in the map.
    const { query } = await loadSdk();

    const childEnv = buildChildEnv({ route, skill: trimmedSkill, baseEnv: env, repoRoot });
    const abortController = new AbortController();
    const pushQueue = createPushQueue();
    const id = randomUUID();
    const createdAt = now();

    const session = {
      id,
      skill: trimmedSkill,
      sdkSessionId: null,
      state: "running",
      closeReason: null,
      query: null,
      pushQueue,
      events: [],
      nextEventId: 1,
      listeners: new Set(),
      abortController,
      createdAt,
      lastActivityAt: createdAt,
      pumpDone: null,
    };
    sessions.set(id, session);

    // The push-queue is passed as `prompt` on this FIRST call — see this
    // file's header comment for why that (not a string prompt + later
    // options.resume) is what keeps the child process alive across turns.
    const q = query({
      prompt: pushQueue,
      options: {
        cwd: repoRoot,
        env: childEnv,
        abortController,
        settingSources: ["project"],
        skills: [trimmedSkill],
        tools: RUNTIME_TOOLS,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns,
        title: `rolester chat: ${trimmedSkill}`,
      },
    });
    session.query = q;

    pushQueue.push(buildKickoffMessage({ skill: trimmedSkill, input }));

    // Fire-and-forget: pump() never rejects (every error path inside it
    // closes the session instead), so there's nothing to await or attach a
    // .catch to here.
    session.pumpDone = pump(session, route);

    return { chatId: id, skill: trimmedSkill, state: session.state };
  }

  function getSession(chatId) {
    const session = sessions.get(chatId);
    return session ? summarize(session) : null;
  }

  function findBySkill(skill) {
    const session = findLiveSessionRecord(skill);
    return session ? summarize(session) : null;
  }

  function listSessions() {
    return Array.from(sessions.values()).map(summarize);
  }

  // Fire-and-forget: pushes the user's text onto the queue and returns
  // immediately (the model's reply arrives later as SSE events). Emits a
  // `chat_state` "running" event synchronously — before the model has done
  // anything — purely so the client's typing indicator can flip instantly;
  // the pump's own session_state_changed frame is an idempotent confirmation
  // when it lands a moment later.
  function postMessage(chatId, text) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) {
      const err = new Error("text is required");
      err.code = "EMPTY_TEXT";
      throw err;
    }
    const session = sessions.get(chatId);
    if (!session) {
      const err = new Error(`unknown chat session: ${chatId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    if (session.state === "closed") {
      const err = new Error(`chat session ${chatId} is closed`);
      err.code = "SESSION_CLOSED";
      throw err;
    }

    session.lastActivityAt = now();
    session.pushQueue.push({
      type: "user",
      message: { role: "user", content: trimmed },
      parent_tool_use_id: null,
    });

    if (session.state !== "running") {
      session.state = "running";
      recordAndBroadcast(session, {
        type: "chat_state",
        data: { chatId: session.id, state: "running" },
      });
    }

    return { accepted: true };
  }

  async function interrupt(chatId) {
    const session = sessions.get(chatId);
    if (!session) {
      const err = new Error(`unknown chat session: ${chatId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    if (session.state !== "running") {
      const err = new Error(`chat session ${chatId} is not running`);
      err.code = "NOT_RUNNING";
      throw err;
    }
    await session.query.interrupt();
    return summarize(session);
  }

  // The only place that actually terminates the underlying child process
  // (query.close() + abort) — request handlers never call this directly on
  // the query/pushQueue themselves, only through here, sweepOnce, or
  // shutdown(), per this file's header comment.
  function closeSession(chatId, reason = "closed") {
    const session = sessions.get(chatId);
    if (!session) {
      const err = new Error(`unknown chat session: ${chatId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    if (session.state === "closed") return summarize(session);

    try {
      session.query?.close?.();
    } catch {
      // best-effort only
    }
    try {
      session.abortController.abort();
    } catch {
      // best-effort only
    }
    closeSessionInternal(session, reason);
    return summarize(session);
  }

  // Subscribes `res` (an http.ServerResponse) to a session's SSE stream:
  // replays the backlog (full buffer, or only events after `lastEventId` on
  // a reconnect), then leaves `res` registered for live broadcast. Writes
  // its own 15s heartbeat comment so idle connections aren't reaped by an
  // intermediary proxy/load balancer.
  //
  // res.on("close") ONLY removes this listener from the session's listener
  // set — it must NEVER abort the session itself. A dropped tab/reload is
  // not "the interview is over"; the KEY REGRESSION this guards against is a
  // destroyed events response silently killing an in-progress chat.
  function subscribe(chatId, res, { lastEventId } = {}) {
    const session = sessions.get(chatId);
    if (!session) {
      const err = new Error(`unknown chat session: ${chatId}`);
      err.code = "NOT_FOUND";
      throw err;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Force an immediate byte onto the wire before anything else. When the
    // replay backlog below is empty (a Last-Event-ID reconnect that's fully
    // caught up), subscribe() would otherwise send headers and then NOTHING
    // until the next broadcast or the 15s heartbeat — and headers-with-no-body
    // is exactly the shape some intermediaries (reverse proxies, corporate
    // TLS-inspecting network tools, even some HTTP client/connection-pool
    // implementations) sit on rather than deliver promptly, alongside
    // "X-Accel-Buffering: no" above. A leading comment line is invisible to
    // EventSource/our own frame parser but guarantees a flush every time.
    res.write(": connected\n\n");

    const afterId = lastEventId === undefined || lastEventId === null ? null : Number(lastEventId);
    const replay =
      afterId !== null && Number.isFinite(afterId)
        ? session.events.filter((evt) => evt.id > afterId)
        : session.events;
    for (const record of replay) {
      writeSseFrame(res, record);
    }

    session.listeners.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);
    if (heartbeat.unref) heartbeat.unref();

    res.on("close", () => {
      clearInterval(heartbeat);
      session.listeners.delete(res);
    });
  }

  // Evicts live sessions idle past idleTtlMs (via the real closeSession() —
  // so an idle-timeout eviction terminates the child process exactly like a
  // user-initiated close does) and prunes closed records past closedTtlMs so
  // the session map doesn't grow forever across a long-running server.
  function sweepOnce() {
    const t = now();
    for (const session of Array.from(sessions.values())) {
      if (
        (session.state === "running" || session.state === "idle") &&
        t - session.lastActivityAt > idleTtlMs
      ) {
        closeSession(session.id, "idle_timeout");
      }
    }
    for (const [id, session] of Array.from(sessions)) {
      if (session.state === "closed" && t - session.lastActivityAt > closedTtlMs) {
        sessions.delete(id);
      }
    }
  }

  function startSweep(intervalMs = 60000) {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweepOnce, intervalMs);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  function stopSweep() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  // Closes every non-closed session (query.close() + abort, same as a
  // user-initiated close) and stops the sweep timer — orphan-subprocess
  // prevention on server shutdown.
  function shutdown() {
    stopSweep();
    for (const id of Array.from(sessions.keys())) {
      const session = sessions.get(id);
      if (session && session.state !== "closed") {
        closeSession(id, "shutdown");
      }
    }
  }

  return {
    startSession,
    getSession,
    findBySkill,
    listSessions,
    postMessage,
    interrupt,
    closeSession,
    subscribe,
    sweepOnce,
    startSweep,
    stopSweep,
    shutdown,
  };
}
