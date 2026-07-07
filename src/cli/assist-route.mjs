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
// runSkillStream's skill-allowlist/tools machinery entirely and drives the
// Agent SDK's query() directly with a bare string prompt, `tools: []`, no
// `skills` option, no `settingSources`: the smallest, cheapest possible call.
// Reuses resolveAIRoute/buildChildEnv/loadClaudeAgentSdk/mapSdkMessage/
// writeByokUsage (already pure/exported by call-ai.mjs and skill-runtime.mjs)
// rather than re-deriving the routing/event-mapping/usage-accounting logic.
//
// Buffer→parse→validate→retry-once via the same shared
// src/core/ai/structured-oneshot.mjs helper POST /api/onboard/resume-ai uses
// — both are small, bounded, structured-output-only calls where a live token
// stream adds UX complexity for no benefit (see that route's own comment).
//
// mountAssistRoutes({addRoute, repoRoot, env, loadSdk}) registers:
//
//   POST /api/assist/suggest   { kind: "titles"|"keywords", input: {...} }
//                              → shared bounded AI envelope with
//                              { ok, data: { suggestions, rationale? }, ai, manual }
//                              501 NO_AI_ROUTE when no AI route is configured
//                              (or the SDK devDependency is missing) — the standing
//                              "no key → assists degrade, never hard-block"
//                              rule. 400 bad kind. 422 AI_SCHEMA_INVALID if
//                              the model never produces valid structured
//                              output after one retry.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOUNDED_AI_CODES, runBoundedAI } from "../core/ai/bounded-ai.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import {
  buildChildEnv,
  loadClaudeAgentSdk,
  mapSdkMessage,
  writeByokUsage,
} from "../core/ai/skill-runtime.mjs";
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

export async function runBareOneshot({ prompt, repoRoot, env, labels, skillLabel, loadSdk }) {
  const route = resolveAIRoute(env);
  if (route.type === "none") {
    const err = new Error(route.error);
    err.code = "NO_AI_ROUTE";
    throw err;
  }

  const { query } = await loadSdk();
  const usageLabels = labels || { skill: skillLabel };
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
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
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

export function mountAssistRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  loadSdk = loadClaudeAgentSdk,
}) {
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
    const skillLabel = `assist-${kind}`;
    const labels = assistLabels(kind);

    async function invoke({ correction }) {
      const basePrompt = buildAssistPrompt(kind, input);
      const prompt = correction ? `${basePrompt}\n\n${correction}` : basePrompt;
      try {
        return await runBareOneshot({ prompt, repoRoot, env, labels, skillLabel, loadSdk });
      } catch (err) {
        if (err?.code === "SDK_NOT_INSTALLED") {
          err.code = BOUNDED_AI_CODES.NO_AI_ROUTE;
        }
        throw err;
      }
    }

    const result = await runBoundedAI({
      labels,
      schema,
      manual: ASSIST_MANUAL,
      maxRetries: 1,
      invoke,
    });
    sendJson(res, result.status, result.body);
  });
}
