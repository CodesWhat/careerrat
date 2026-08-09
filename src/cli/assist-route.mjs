// assist-route.mjs — M8's onboarding-wizard "Roland-suggest" endpoint:
// POST /api/assist/suggest, the titles/keywords chip suggestions on the
// Targeting step. Split out the same way search-route.mjs/logo-route.mjs
// were: `addRoute` is the mount point, `readJsonBodyCapped`/`sendJson` are
// imported from skill-run-route.mjs rather than duplicated.
//
// DELIBERATELY NOT a skill invocation (contrast with resume-ai in
// onboard-route.mjs, which runs the resume-extract SKILL.md via
// runSkillStream): titles/keywords suggestions need nothing a tool would
// fetch — the wizard already has the candidate's current titles/keywords/
// summary client-side (loaded via GET /api/onboard/state) — so this bypasses
// runSkillStream's skill-allowlist/tools machinery, and skips the Agent SDK
// subprocess entirely: the route drives bounded-ai.mjs's native-preferred
// mode straight through callAI() (a plain fetch) on the `smallFast` model
// tier — the smallest, cheapest possible call. BYOK usage logging is
// callAI()'s own job (it writes the usage_event whenever `root` is given),
// so this route never calls writeByokUsage() itself.
//
// runBareOneshot() below still drives the Agent SDK subprocess directly —
// it's kept exported because src/core/intake/classify.mjs calls it for its
// own bare one-shot classification; this route no longer uses it.
//
// Buffer→parse→validate→retry-once via the same shared
// src/core/ai/structured-oneshot.mjs helper (through bounded-ai.mjs's
// native-preferred mode) POST /api/onboard/resume-ai uses — both are small,
// bounded, structured-output-only calls where a live token stream adds UX
// complexity for no benefit (see that route's own comment).
//
// mountAssistRoutes({addRoute, repoRoot, env, call}) registers:
//
//   POST /api/assist/suggest   { kind: "titles"|"keywords", input: {...} }
//                              → shared bounded AI envelope with
//                              { ok, data: { suggestions, rationale? }, ai, manual }
//                              501 NO_AI_ROUTE when no AI route is configured
//                              — the standing "no key → assists degrade,
//                              never hard-block" rule. 400 bad kind.
//                              422 AI_SCHEMA_INVALID if the model never
//                              produces valid structured output after one
//                              retry.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runBoundedAI } from "../core/ai/bounded-ai.mjs";
import { callAI, resolveAIRoute } from "../core/ai/call-ai.mjs";
import { buildChildEnv, mapSdkMessage, writeByokUsage } from "../core/ai/skill-runtime.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap the other route modules use.
const ASSIST_SCHEMA_PATH = "config/assist-suggest.schema.json";
const ASSIST_MANUAL = Object.freeze({
  available: true,
  reason: "manual-entry",
  action: "Edit targeting fields manually.",
});

function assistLabels(kind) {
  return {
    skill: "assist",
    action: `suggest-${kind}`,
    operation: `assist.suggest.${kind}`,
  };
}

// ---------------------------------------------------------------------------
// Server-side prompt templates — one per kind. Kept small on purpose ("the
// user pays per call" — the frozen contract's own cost-hygiene note): each
// embeds only what the caller sent, no extra grounding context fetched.
// ---------------------------------------------------------------------------

const SCHEMA_HINT =
  "Reply with ONLY one fenced ```json code block: " +
  '{"suggestions": ["...", ...], "rationale": "optional one-sentence why"} — ' +
  "no prose outside the fence, no markdown headers.";

export function buildAssistPrompt(kind, input = {}) {
  const summary = String(input?.profileSummary || "").trim();

  if (kind === "titles") {
    const existing = Array.isArray(input?.titles) ? input.titles.filter(Boolean) : [];
    return (
      "You are helping a job seeker refine the job titles they are targeting in their search.\n" +
      (summary ? `Candidate summary: ${summary}\n` : "") +
      (existing.length ? `Current target titles: ${existing.join(", ")}\n` : "") +
      "Suggest 5-8 alternative or additional job titles at the same experience level and domain " +
      "— real titles employers actually post, never invented ones. Don't repeat a title already " +
      "listed.\n\n" +
      SCHEMA_HINT
    );
  }

  // kind === "keywords"
  const current = Array.isArray(input?.currentKeywords)
    ? input.currentKeywords.filter(Boolean)
    : [];
  return (
    "You are helping a job seeker refine the search keywords/skills that describe what they do.\n" +
    (summary ? `Candidate summary: ${summary}\n` : "") +
    (current.length ? `Current keywords: ${current.join(", ")}\n` : "") +
    "Suggest 5-10 additional keywords or skill terms that would help their search surface the " +
    "right postings — real, commonly-used industry terms, never invented ones. Don't repeat a " +
    "keyword already listed.\n\n" +
    SCHEMA_HINT
  );
}

// ---------------------------------------------------------------------------
// The bare one-shot driver — no skill, no tools, maxTurns 1. Buffers every
// `assistant` event's text blocks in order (same convention as
// onboard-route.mjs's resume-ai invoke callback / skill-runtime.mjs's own
// "buffer, don't stream" rationale).
// ---------------------------------------------------------------------------

export async function runBareOneshot({
  prompt,
  repoRoot,
  env,
  labels,
  skillLabel,
  loadSdk,
  call = callAI,
}) {
  const route = resolveAIRoute(env, { repoRoot });
  if (route.type === "none") {
    const err = new Error(route.error);
    err.code = "NO_AI_ROUTE";
    throw err;
  }

  const usageLabels = labels || { skill: skillLabel };
  if (route.type === "installed") {
    const response = await call({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
      skill: usageLabels.skill,
      action: usageLabels.action,
      operation: usageLabels.operation,
      root: repoRoot,
      env,
    });
    return (response?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("");
  }

  const { query } = await loadSdk();
  const childEnv = buildChildEnv({
    route,
    skill: usageLabels.skill,
    action: usageLabels.action,
    operation: usageLabels.operation,
    baseEnv: env,
    repoRoot,
  });
  const controller = new AbortController();

  const q = query({
    prompt,
    options: {
      cwd: repoRoot,
      env: childEnv,
      abortController: controller,
      tools: [],
      maxTurns: 1,
      permissionMode: "default",
    },
  });

  let rawText = "";
  try {
    for await (const msg of q) {
      const events = mapSdkMessage(msg, { env });
      for (const evt of events) {
        if (evt.type === "assistant") {
          for (const block of evt.data?.message?.content ?? []) {
            if (block?.type === "text" && typeof block.text === "string") {
              rawText += block.text;
            }
          }
        }
      }
      if (msg.type === "result") {
        if (route.type === "byok") {
          writeByokUsage({
            msg,
            skill: usageLabels.skill,
            action: usageLabels.action,
            operation: usageLabels.operation,
            repoRoot,
            env,
          });
        }
        break;
      }
    }
  } finally {
    try {
      await q.return?.();
    } catch {
      // best-effort cleanup only
    }
  }

  return rawText;
}

// ---------------------------------------------------------------------------
// mountAssistRoutes
// ---------------------------------------------------------------------------

export function mountAssistRoutes({ addRoute, repoRoot, env = process.env, call }) {
  addRoute("POST", "/api/assist/suggest", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const kind = String(body?.kind || "");
    if (kind !== "titles" && kind !== "keywords") {
      sendJson(res, 400, { error: 'body.kind must be "titles" or "keywords"' });
      return;
    }

    // Read at request time, not mount time — mirrors onboard-route.mjs's
    // readSchema()/RESUME_EXTRACT_SCHEMA_PATH convention: mounting this route
    // must never crash createDevServer() for a fixture repoRoot that happens
    // not to carry this checked-in config file (e.g. a minimal test temp repo
    // that never actually exercises this route).
    const schema = JSON.parse(readFileSync(join(repoRoot, ASSIST_SCHEMA_PATH), "utf8"));

    const input = body?.input && typeof body.input === "object" ? body.input : {};
    const labels = assistLabels(kind);

    const result = await runBoundedAI({
      labels,
      schema,
      manual: ASSIST_MANUAL,
      maxRetries: 1,
      structuredMode: "native-preferred",
      call,
      messages: [{ role: "user", content: buildAssistPrompt(kind, input) }],
      system: "Return only JSON matching the requested schema. No prose outside the JSON.",
      tier: "smallFast",
      maxTokens: 300,
      outputName: `assist_${kind}_suggestions`,
      root: repoRoot,
      env,
    });
    sendJson(res, result.status, result.body);
  });
}
