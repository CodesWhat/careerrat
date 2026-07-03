// skill-runtime.mjs — Productization Phase 0, P0-4: runs a SKILL.md loop
// *inside the server process* via the Claude Agent SDK, so POST /api/skill/run
// never needs the user's own Claude Code session or their own API key. This is
// the "one hard new build" of the Phase 0 spine — everything else (tracker-dev
// as an app server, the metering proxy) already existed; this file is what
// actually drives a skill headlessly.
//
// SHIPPED MECHANISM: native skill invocation via the SDK's `skills` option,
// not prompt-injection. Verified against the installed
// @anthropic-ai/claude-agent-sdk@0.3.199 sdk.d.ts (not from memory):
//   - `Options.skills: string[]` is documented as "the single place to turn
//     skills on" and auto-enables the Skill tool.
//   - `Options.settingSources: ['project']` loads this repo's own CLAUDE.md
//     (which points at AGENTS.md), and `.claude/skills/` — a symlink to
//     `.agents/skills/` in this repo — resolves independently of settings
//     (the SDK's own docs note bundled-skills-disable leaves ".claude/skills/"
//     unaffected, i.e. it's cwd-relative discovery, not settings-gated).
//   - `SDKSystemMessage` (the `init` system frame) carries a `skills: string[]`
//     field listing what actually loaded — the empirical way to confirm this
//     worked, once a real key/network is available to run it live.
// A prompt-injected fallback (reading SKILL.md text into the prompt) was
// considered per the roadmap note but NOT shipped: this sandbox has no
// ANTHROPIC_API_KEY / network egress to run a real query(), so there is no way
// to empirically prove the native path is "flaky" here. Shipping the
// documented, product-correct mechanism (engine parity — the same SKILL.md
// Claude Code reads) and flagging live verification as an open item is more
// honest than guessing at a fallback with no evidence it's needed.
//
// The SDK itself is a devDependency only (Phase 0 spike posture — the
// published npm package stays zero runtime deps). It is never imported at
// module scope; `loadClaudeAgentSdk()` dynamic-imports it lazily so a
// workspace-only install of rolester (no devDependencies) degrades to a clear
// 501 from the route instead of crashing at require-time.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveModelConfig } from "./ai-config.mjs";
import { resolveAIRoute } from "./call-ai.mjs";
import { appendUsageEvent, computeCost } from "./usage-log.mjs";

// ---------------------------------------------------------------------------
// Skill allowlist
// ---------------------------------------------------------------------------

// Every skill directory that actually has a SKILL.md — the full discoverable
// universe. `resolveAllowedSkills` narrows this to what's *runnable via the
// embedded runtime*, which defaults far more restrictive than "everything
// installed": this endpoint runs headlessly with no human watching the tool
// calls, so only skills explicitly opted in via ROLESTER_RUNTIME_SKILLS may
// run this way.
export function discoverSkillDirs(repoRoot) {
  const skillsRoot = join(repoRoot, ".agents/skills");
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

// Default-restricted to evaluate-job (P0-5's target). Empty string explicitly
// set in env means "nothing is allowed" — only an *unset* env var falls back
// to the default, so an operator can deliberately lock the runtime down.
const DEFAULT_RUNTIME_SKILLS = "evaluate-job";

export function resolveAllowedSkills({ repoRoot, env = process.env } = {}) {
  const discovered = new Set(discoverSkillDirs(repoRoot));
  const raw = String(env.ROLESTER_RUNTIME_SKILLS ?? DEFAULT_RUNTIME_SKILLS);
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return requested.filter((name) => discovered.has(name));
}

// ---------------------------------------------------------------------------
// AI routing — mirrors call-ai.mjs's callAI() BYOK-first priority exactly
// (same resolveAIRoute()), but here the "call" is the Agent SDK's own child
// process rather than a fetch() we make ourselves, so the routing decision
// has to land as env vars for that child, not request headers.
// ---------------------------------------------------------------------------

// The model-selection knobs the Agent SDK's own CLI reads directly (verified
// against the installed @anthropic-ai/claude-agent-sdk, not assumed) — the
// no-code model-swap seam (see ai-config.mjs). `shared = { ...baseEnv }` below
// already carries every one of these when the server operator set them
// directly; this list is kept explicit/self-documenting rather than relying
// on that incidental blanket copy, and is what actually applies the
// config/ai.json fallback for the two model-id vars when neither is set.
const MODEL_SELECTION_ENV_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
];

// Pure + exported so the routing decision is unit-testable without spawning
// the SDK: given a resolved route, what env does the child process get?
// route.type === "none" returns null — callers must have already rejected
// that case (see runSkillStream). `repoRoot` locates config/ai.json (the
// no-code model-swap file) — optional; ai-config.mjs falls back to its own
// repo-root default when omitted (unit tests exercise it that way).
export function buildChildEnv({ route, skill, baseEnv = process.env, repoRoot } = {}) {
  if (!route || route.type === "none") return null;

  const shared = { ...baseEnv };
  for (const key of MODEL_SELECTION_ENV_VARS) {
    if (baseEnv[key] !== undefined) shared[key] = baseEnv[key];
  }

  // config/ai.json fallback: only fills ANTHROPIC_MODEL/ANTHROPIC_SMALL_FAST_MODEL
  // when the server env didn't already set them — resolveModelConfig() applies
  // that precedence (env > config file > unset) itself.
  const { model, smallFastModel } = resolveModelConfig({ root: repoRoot, env: baseEnv });
  if (model) shared.ANTHROPIC_MODEL = model;
  if (smallFastModel) shared.ANTHROPIC_SMALL_FAST_MODEL = smallFastModel;

  if (route.type === "byok") {
    // Direct to Anthropic (or a ROLESTER_ANTHROPIC_BASE_URL override) with the
    // user's own key. No x-rolester-* labels here — call-ai.mjs's own BYOK
    // path doesn't send them to the real Anthropic API either; they're a
    // proxy-metering label, not something Anthropic's API consumes.
    return {
      ...shared,
      ANTHROPIC_API_KEY: route.apiKey,
      ANTHROPIC_BASE_URL: route.baseUrl,
    };
  }

  // route.type === "proxy": point the SDK's own outbound Anthropic client at
  // our metering proxy instead of api.anthropic.com. IMPORTANT: the real
  // Anthropic SDK client (bundled inside the Agent SDK's CLI) authenticates
  // with `x-api-key: <ANTHROPIC_API_KEY>`, never `Authorization: Bearer` — so
  // the proxy token has to travel as ANTHROPIC_API_KEY here, and
  // ai-proxy.mjs's requireAuth() has been patched to accept it that way (see
  // ai-proxy.mjs). ANTHROPIC_CUSTOM_HEADERS is a real env var the bundled
  // Anthropic client parses (newline-separated "Header: value" pairs, merged
  // into defaultHeaders) — verified by reading sdk.mjs, not assumed — so the
  // proxy's meter rows can carry which skill produced them.
  return {
    ...shared,
    ANTHROPIC_API_KEY: route.token,
    ANTHROPIC_BASE_URL: route.baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: `x-rolester-skill: ${skill}`,
  };
}

// ---------------------------------------------------------------------------
// SDK message -> structured event mapping (pure, no I/O)
// ---------------------------------------------------------------------------

// One raw SDK message can produce more than one structured event (an
// assistant turn with two tool calls yields one "assistant" event plus two
// "tool_use" events) — always returns an array.
export function mapSdkMessage(msg, { env = process.env } = {}) {
  if (!msg || typeof msg !== "object") return [];

  switch (msg.type) {
    case "assistant": {
      const events = [{ type: "assistant", data: msg }];
      if (msg.error) {
        events.push({ type: "error", data: { error: msg.error, sessionId: msg.session_id } });
      }
      for (const block of msg.message?.content ?? []) {
        if (block?.type === "tool_use") {
          events.push({
            type: "tool_use",
            data: {
              id: block.id,
              name: block.name,
              input: block.input,
              parentToolUseId: msg.parent_tool_use_id ?? null,
              sessionId: msg.session_id,
            },
          });
        }
      }
      return events;
    }

    case "user": {
      const events = [];
      for (const block of msg.message?.content ?? []) {
        if (block?.type === "tool_result") {
          events.push({
            type: "tool_result",
            data: {
              toolUseId: block.tool_use_id,
              content: block.content,
              isError: block.is_error ?? false,
              sessionId: msg.session_id,
            },
          });
        }
      }
      return events;
    }

    case "result":
      return [{ type: "result", data: buildResultData(msg, { env }) }];

    case "system":
      return [{ type: "system", data: msg }];

    // Every other frame type the SDK can emit (stream_event, tool_progress,
    // tool_use_summary, prompt_suggestion, …) — still surface it rather than
    // silently dropping, bucketed under "system" so the event schema stays
    // fixed at the six documented types.
    default:
      return [{ type: "system", data: msg }];
  }
}

// Sum cost across every model actually used (a subagent turn can use a
// different model than the main thread) via usage-log's own pricing table —
// deliberately NOT the SDK's own reported cost, so this stays priced
// identically to the proxy/BYOK ledger rather than drifting on a second
// pricing source.
function aggregateModelCost(modelUsage, env) {
  const entries = Object.entries(modelUsage || {});
  if (!entries.length) return { cost_usd: null, priced: false };
  let total = 0;
  let allPriced = true;
  for (const [model, mu] of entries) {
    const { cost_usd, priced } = computeCost(
      model,
      {
        tokens_in: mu?.inputTokens,
        tokens_out: mu?.outputTokens,
        cache_read_tokens: mu?.cacheReadInputTokens,
        cache_creation_tokens: mu?.cacheCreationInputTokens,
      },
      { env }
    );
    if (!priced) {
      allPriced = false;
      continue;
    }
    total += cost_usd;
  }
  return allPriced ? { cost_usd: total, priced: true } : { cost_usd: null, priced: false };
}

function buildResultData(msg, { env }) {
  const usage = msg.usage || {};
  const { cost_usd } = aggregateModelCost(msg.modelUsage, env);
  return {
    ok: msg.subtype === "success" && !msg.is_error,
    durationMs: msg.duration_ms,
    usage: {
      tokensIn: usage.input_tokens || 0,
      tokensOut: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    },
    costUsd: cost_usd,
    sessionId: msg.session_id,
    numTurns: msg.num_turns,
    subtype: msg.subtype,
    errors: msg.errors,
  };
}

// ---------------------------------------------------------------------------
// SDK loader — isolated so both the runtime and the route can share one
// well-labeled failure mode (501, "install the devDependency").
// ---------------------------------------------------------------------------

export async function loadClaudeAgentSdk() {
  try {
    return await import("@anthropic-ai/claude-agent-sdk");
  } catch (importErr) {
    const err = new Error(
      "@anthropic-ai/claude-agent-sdk is not installed. It's a devDependency (Phase 0 spike " +
        "posture) — run `npm install` in this checkout to enable the embedded skill runtime, or " +
        "`npm install @anthropic-ai/claude-agent-sdk` standalone."
    );
    err.code = "SDK_NOT_INSTALLED";
    err.cause = importErr;
    throw err;
  }
}

// The tool surface this P0-4 spike restricts every run to, scoped to what
// evaluate-job's SKILL.md actually calls: Read/Glob/Grep/WebFetch to fetch and
// read a JD + candidate config, Write/Edit to save the JD body and patch
// tracker.json/frontmatter, Bash because the skill's STEP 9/10 shell out to
// `rolester evaluate|tracker|activity|learnings|research` CLIs, and Skill so
// the model can invoke evaluate-job itself. If ROLESTER_RUNTIME_SKILLS ever
// grows beyond evaluate-job, this list needs revisiting per-skill.
const RUNTIME_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "Write", "Edit", "Bash", "Skill"];

function buildPrompt({ skill, input }) {
  const body = typeof input === "string" ? input : JSON.stringify(input ?? {});
  return (
    `Run the \`${skill}\` skill against the following input, following its SKILL.md exactly. ` +
    "This is a non-interactive, headless run with nobody available to answer questions — make the " +
    "best defensible call yourself and state what you assumed rather than asking.\n\n" +
    body
  );
}

// ---------------------------------------------------------------------------
// runSkillStream — the driver
// ---------------------------------------------------------------------------

// Runs `skill` (a directory name under .agents/skills/) against `input`
// inside a Claude Agent SDK query(), streaming every mapped event to
// `onEvent`. Throws (before calling onEvent even once) on any validation
// failure — allowlist miss, no AI route configured, SDK devDependency
// missing — so a caller (the route) can turn that into the right HTTP status
// before any SSE bytes go out. `signal`, if given, aborts the underlying SDK
// query when triggered (client-disconnect passthrough).
export async function runSkillStream({
  skill,
  input,
  repoRoot,
  env = process.env,
  onEvent,
  signal,
  // Overridable so tests can drive the real for-await/mapSdkMessage/abort/
  // BYOK-usage-write loop below against a hand-rolled fake query() — a
  // hermetic, deterministic stand-in for a live CLI subprocess — without
  // touching the actual @anthropic-ai/claude-agent-sdk devDependency.
  loadSdk = loadClaudeAgentSdk,
} = {}) {
  if (typeof onEvent !== "function") {
    throw new TypeError("runSkillStream: onEvent callback is required");
  }
  if (!repoRoot) {
    throw new TypeError("runSkillStream: repoRoot is required");
  }

  const allowed = resolveAllowedSkills({ repoRoot, env });
  if (!allowed.includes(skill)) {
    const err = new Error(
      `skill "${skill}" is not allowed to run via the embedded runtime (allowed: ` +
        `${allowed.join(", ") || "none"}) — set ROLESTER_RUNTIME_SKILLS to opt more in`
    );
    err.code = "SKILL_NOT_ALLOWED";
    err.allowed = allowed;
    throw err;
  }

  const route = resolveAIRoute(env);
  if (route.type === "none") {
    const err = new Error(route.error);
    err.code = "NO_AI_ROUTE";
    throw err;
  }

  // Validate before touching the SDK so a missing devDependency is a clean
  // 501, not a crash mid-stream.
  const { query } = await loadSdk();

  const childEnv = buildChildEnv({ route, skill, baseEnv: env, repoRoot });

  const controller = new AbortController();
  let externallyAborted = false;
  if (signal) {
    if (signal.aborted) {
      externallyAborted = true;
      controller.abort();
    } else {
      signal.addEventListener(
        "abort",
        () => {
          externallyAborted = true;
          controller.abort();
        },
        { once: true }
      );
    }
  }

  const q = query({
    prompt: buildPrompt({ skill, input }),
    options: {
      cwd: repoRoot,
      env: childEnv,
      abortController: controller,
      settingSources: ["project"],
      skills: [skill],
      tools: RUNTIME_TOOLS,
      // Headless posture: nobody is watching a permission prompt in a
      // server process, so a prompt would just hang the loop forever. The
      // real safety boundary is `tools` above (what CAN be invoked at all);
      // this only removes the interactive gate on invoking it, which the
      // SDK requires an explicit ack for (allowDangerouslySkipPermissions).
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  let resultData = null;
  try {
    for await (const msg of q) {
      const events = mapSdkMessage(msg, { env });
      for (const evt of events) onEvent(evt);

      if (msg.type === "result") {
        resultData = events.find((e) => e.type === "result")?.data ?? null;
        if (route.type === "byok") writeByokUsage({ msg, skill, repoRoot, env });
        break;
      }
    }
  } catch (err) {
    if (externallyAborted || controller.signal.aborted) {
      resultData = { ok: false, aborted: true };
    } else {
      onEvent({ type: "error", data: { message: err.message } });
      resultData = { ok: false, error: err.message };
      onEvent({ type: "result", data: resultData });
    }
  } finally {
    try {
      await q.return?.();
    } catch {
      // best-effort cleanup only
    }
  }

  return resultData;
}

// The proxy meters its own traffic server-side (ai-proxy.mjs's
// appendUsageEvent call on every /v1/messages it forwards) — so only the BYOK
// path needs a write here, exactly mirroring call-ai.mjs's own "nothing else
// is watching on BYOK" comment. One row per model actually used.
function writeByokUsage({ msg, skill, repoRoot, env }) {
  for (const [model, mu] of Object.entries(msg.modelUsage || {})) {
    appendUsageEvent(
      {
        source: "byok",
        skill,
        action: "skill-run",
        model,
        tokens_in: mu?.inputTokens,
        tokens_out: mu?.outputTokens,
        cache_read_tokens: mu?.cacheReadInputTokens,
        cache_creation_tokens: mu?.cacheCreationInputTokens,
      },
      { root: repoRoot, env }
    );
  }
}
