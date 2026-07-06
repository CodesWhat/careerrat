// skill-run-route.mjs — the HTTP surface for P0-4's embedded skill runtime.
// Split out of tracker-dev.mjs (per its own header comment: `addRoute` is the
// mount point for exactly this) so the SSE framing/body-cap/abort mechanics
// are unit-testable with `runSkillStream` fully stubbed — no real
// @anthropic-ai/claude-agent-sdk devDependency needed to test the route.
//
// mountSkillRunRoute() is a pure factory: it takes `addRoute` (from
// createDevServer) and a `runSkillStream` implementation (defaults to the
// real one, dependency-injected by tests) and registers exactly one route:
//
//   POST /api/skill/run   body: { skill, input } (JSON, 1MB cap)
//                          responds as an SSE stream of runSkillStream's
//                          mapped events; 15s heartbeat comments; aborts the
//                          underlying query on client disconnect.
//
// Status-code contract: validation failures (unknown/disallowed skill, no AI
// route configured, the SDK devDependency missing) must produce a real HTTP
// status — 400 or 501 — not a 200 with an in-band SSE error. runSkillStream()
// is written so every one of those checks happens *before* it calls onEvent
// even once, so this route can tell "failed before streaming started" apart
// from "failed mid-stream" by whether any event has been emitted yet, and
// only open the SSE response (writeHead 200) on the first real event.
//
// mountSkillRunRoute() also registers GET /api/runtime/config (P0-5) — the
// small read-only route the evaluate-page.mjs client polls on load to learn
// which skills are actually runnable via this runtime, so it can decide
// whether to enable the Apply/Save/Pass decision buttons (which POST
// track-outcomes) rather than guessing or hardcoding the allowlist into the
// static page.

import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { resolveAllowedChatSkills } from "../core/ai/chat-runtime.mjs";
import {
  APP_SAFE_RUNTIME_TOOLS,
  DEFAULT_RUNTIME_TOOL_PROFILE,
  isToolHeavyProfile,
  RUNTIME_TOOL_PROFILES,
} from "../core/ai/runtime-tools.mjs";
import { resolveAllowedSkills } from "../core/ai/skill-runtime.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB cap per the P0-4 spec.
const HEARTBEAT_MS = 15000;
const DISCOVERY_CHAT_HANDOFF_SKILLS = new Set([
  "research-boards",
  "discover-companies",
  "search-jobs",
]);
const TOOL_HEAVY_RUNTIME_SKILLS = new Set([
  "apply-job",
  "sync-status",
  "interview-prep",
  "ingest-mail",
  "ingest-messages",
  "relationship-sourcing",
  "calendar-sync",
]);

function allowedToolHeavySkills(skills) {
  return skills.filter((skill) => TOOL_HEAVY_RUNTIME_SKILLS.has(skill));
}

// Exported so other route mounters (src/cli/onboard-route.mjs) reuse the
// exact same JSON-response and capped-body-read primitives instead of
// duplicating them — see that file's header comment.
export function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

// Read the request body up to `maxBytes`, rejecting (with a `.status`) on
// overflow or malformed JSON rather than throwing an unlabeled error.
//
// Deliberately does NOT req.destroy() on overflow: destroying the request
// tears down the shared socket before this handler ever gets a chance to
// write the 413 response, so the client sees a raw connection reset instead
// of a clean error body. Instead, stop accumulating bytes once over the cap
// (so memory stays bounded) but let the stream keep draining to 'end', then
// reject there — the socket stays intact for the response.
export function readJsonBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) {
        const err = new Error("request body exceeds 1MB limit");
        err.status = 413;
        reject(err);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        const err = new Error("invalid JSON body");
        err.status = 400;
        reject(err);
      }
    });
    req.on("error", (err) => reject(err));
  });
}

// Read a raw binary request body up to `maxBytes` — same overflow/no-destroy
// semantics as readJsonBodyCapped above, but resolves the raw Buffer instead
// of parsing JSON. Used by onboard-route.mjs's POST /api/onboard/resume-ai
// (a PDF/image upload is the request body itself, not a JSON envelope).
export function readRawBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) {
        const err = new Error(`request body exceeds ${maxBytes} byte limit`);
        err.status = 413;
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => reject(err));
  });
}

// Map a runSkillStream() rejection code to the HTTP status to use *when it
// failed before any streaming began*. Anything unrecognized is a 500 — an
// unexpected internal failure, not a client mistake.
function statusForRunError(err) {
  if (err?.code === "SDK_NOT_INSTALLED") return 501;
  if (
    err?.code === "SKILL_NOT_ALLOWED" ||
    err?.code === "NO_AI_ROUTE" ||
    err?.code === "RUNTIME_TOOL_PROFILE_INVALID"
  ) {
    return 400;
  }
  return 500;
}

function validateToolProfileRequest({ skill, toolProfile }) {
  if (toolProfile === undefined || toolProfile === null || toolProfile === "") {
    return undefined;
  }
  const normalizedProfile = String(toolProfile).trim();
  if (!Object.hasOwn(RUNTIME_TOOL_PROFILES, normalizedProfile)) {
    const err = new Error(
      `unsupported runtime tool profile "${normalizedProfile}" (expected: ${Object.keys(
        RUNTIME_TOOL_PROFILES
      ).join(", ")})`
    );
    err.status = 400;
    throw err;
  }
  if (isToolHeavyProfile(normalizedProfile) && !TOOL_HEAVY_RUNTIME_SKILLS.has(skill)) {
    const err = new Error(
      `skill "${skill}" is not classified for tool-heavy runtime profile "${normalizedProfile}"`
    );
    err.status = 400;
    throw err;
  }
  return normalizedProfile;
}

export function mountSkillRunRoute({ addRoute, repoRoot, runSkillStream, env = process.env }) {
  addRoute("GET", "/api/runtime/config", (_req, res) => {
    const skills = resolveAllowedSkills({ repoRoot, env });
    const chatSkills = resolveAllowedChatSkills({ repoRoot, env });
    const route = resolveAIRoute(env);
    const toolHeavySkills = allowedToolHeavySkills(skills);
    sendJson(res, 200, {
      skills,
      chatSkills,
      ai: {
        available: route.type !== "none",
        route: route.type,
      },
      runtime: {
        defaultToolProfile: DEFAULT_RUNTIME_TOOL_PROFILE,
        defaultTools: [...APP_SAFE_RUNTIME_TOOLS],
        toolHeavy: {
          available: toolHeavySkills.length > 0,
          skills: toolHeavySkills,
        },
      },
      discovery: {
        companyProposals: true,
        manualCompanySeeds: true,
        chatHandoffs: chatSkills.some((skill) => DISCOVERY_CHAT_HANDOFF_SKILLS.has(skill)),
      },
    });
  });

  addRoute("POST", "/api/skill/run", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const skill = String(body?.skill || "").trim();
    if (!skill) {
      sendJson(res, 400, { error: "body.skill is required" });
      return;
    }
    const input = body?.input;
    let toolProfile;
    try {
      toolProfile = validateToolProfileRequest({ skill, toolProfile: body?.toolProfile });
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    // Client-disconnect -> abort. Deliberately `res.on("close")`, not
    // `req.on("close")`: for a request WITH a body, Node's IncomingMessage
    // emits its own "close" as soon as the request body finishes being read
    // (ordinary readable-stream teardown) — completely unrelated to whether
    // the client is still connected — so it fires immediately on every
    // request, aborting the run before it even starts. `res.on("close")`
    // correlates with the underlying socket actually closing, which is what
    // "the client disconnected" means for a streaming response. Wired before
    // any streaming starts so an early disconnect is still honored.
    const controller = new AbortController();
    res.on("close", () => controller.abort());

    let started = false;
    let heartbeat = null;

    function ensureStarted() {
      if (started) return;
      started = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      heartbeat = setInterval(() => {
        try {
          res.write(": heartbeat\n\n");
        } catch {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_MS);
    }

    function emit(evt) {
      ensureStarted();
      try {
        res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } catch {
        // client already gone — nothing to do, the 'close' listener above
        // has already (or will) fire the abort.
      }
    }

    try {
      await runSkillStream({
        skill,
        input,
        repoRoot,
        onEvent: emit,
        signal: controller.signal,
        toolProfile,
      });
    } catch (err) {
      if (!started) {
        sendJson(res, statusForRunError(err), { error: err.message });
        return;
      }
      // Failed after streaming had already begun (headers committed to a
      // 200) — the only honest way to report it now is in-band.
      emit({ type: "error", data: { message: err.message } });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (started) {
        try {
          res.end();
        } catch {
          // ignore — connection already gone
        }
      }
    }
  });
}
