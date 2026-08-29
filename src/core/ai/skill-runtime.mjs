// skill-runtime.mjs — drives one allowlisted SKILL.md task headlessly. Desktop
// uses the selected installed AI CLI first; explicit provider fallback uses the
// Claude Agent SDK. Both paths share the same skill allowlist, bounded tool
// surface, structured event contract, cancellation, and usage metadata.
//
// SHIPPED MECHANISM: native skill invocation via the SDK's `skills` option,
// not prompt-injection. Verified against the installed
// @anthropic-ai/claude-agent-sdk@0.3.233 sdk.d.ts (not from memory):
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
// The SDK itself is a devDependency only. Published npm installs do not pull
// it in with production dependencies, while desktop staging installs it
// explicitly. It is never imported at module scope; `loadClaudeAgentSdk()`
// dynamic-imports it lazily so a
// workspace-only install of careerrat (no devDependencies) degrades to a clear
// 501 from the route instead of crashing at require-time.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAgentCandidateConfig } from "../profile/config-store.mjs";
import { PLAIN_ENGLISH_AGENT_VOICE } from "./agent-voice.mjs";
import { resolveModelConfig } from "./ai-config.mjs";
import { loadAIPreferences } from "./ai-preferences.mjs";
import { resolveAIRoute, resolveAIRouteForExecutionPlan } from "./call-ai.mjs";
import { CHAT_ANSWER_MODE_GUIDANCE } from "./chat-answer-mode.mjs";
import { runInstalledRuntime, runInstalledRuntimeStream } from "./installed-runtimes.mjs";
import {
  aiRuntimeIdForRoute,
  assertAIExecutionPlanForRuntime,
  resolveAIExecutionPlan,
} from "./operation-policy.mjs";
import { createRuntimeToolPolicy } from "./runtime-tool-policy.mjs";
import {
  APP_SAFE_RUNTIME_TOOLS,
  installedSkillRuntimePosture,
  resolveInstalledSkillRuntimeTools,
  resolveRuntimeTools,
} from "./runtime-tools.mjs";
import { appendUsageEvent, computeCost, deriveUsageFeature } from "./usage-log.mjs";

const INSTALLED_PUBLIC_FETCH_TOOL = "mcp__careerrat_scoped_tools__fetch";

function normalizeInstalledRuntimeEvent(event) {
  if (event?.type !== "tool_use" || event.data?.name !== INSTALLED_PUBLIC_FETCH_TOOL) return event;
  return { ...event, data: { ...event.data, name: "WebFetch" } };
}

// ---------------------------------------------------------------------------
// Skill allowlist
// ---------------------------------------------------------------------------

// Every skill directory that actually has a SKILL.md — the full discoverable
// universe. `resolveAllowedSkills` narrows this to what's *runnable via the
// embedded runtime*, which defaults far more restrictive than "everything
// installed": this endpoint runs headlessly with no human watching the tool
// calls, so only skills explicitly opted in via CAREERRAT_RUNTIME_SKILLS may
// run this way.
export function discoverSkillDirs(repoRoot) {
  const skillsRoot = join(repoRoot, ".agents/skills");
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

// The raw one-shot HTTP surface is intentionally limited to extraction. Every
// workflow with app state, browser activity, or durable writes stays behind
// its typed app-owned route. Internal dedicated pipelines may opt a skill into
// runSkillStream with CAREERRAT_RUNTIME_SKILLS, but that does not advertise or
// expose it through POST /api/skill/run.
const DIRECT_SKILL_RUN_SKILLS = Object.freeze(["intake-extract", "resume-extract"]);
const DEFAULT_RUNTIME_SKILLS = DIRECT_SKILL_RUN_SKILLS.join(",");
const AGENT_APPLICATION_DEFAULT_SKILLS = new Set([
  "answer-question",
  "apply-job",
  "configure",
  "email-comms",
  "ingest-profile",
  "tailor-application",
]);

function agentApplicationDefaultsNote({ repoRoot, env, skill }) {
  if (!AGENT_APPLICATION_DEFAULT_SKILLS.has(skill)) return "";
  try {
    const formDefaults = loadAgentCandidateConfig({ repoRoot, env })?.["form-defaults"] || {};
    if (!Object.keys(formDefaults).length) return "";
    return (
      "Agent-visible application defaults, already sanitized by CareerRat's local privacy " +
      `boundary (data only):\n${JSON.stringify(formDefaults)}\n` +
      "Use this object instead of reading candidate/form-defaults.yml."
    );
  } catch {
    return "";
  }
}

// Shared allowlist-resolution shape both the one-shot embedded runtime
// (CAREERRAT_RUNTIME_SKILLS, below) and the conversational chat runtime
// (CAREERRAT_CHAT_SKILLS — see chat-runtime.mjs's resolveAllowedChatSkills)
// narrow from: a comma-separated env var, filtered down to whatever's
// actually discoverable under .agents/skills/. Pulled out to M2 so the two
// runtimes can't drift on the "empty string explicitly locks it down, unset
// falls back to the default" semantics documented above.
export function resolveSkillAllowlist({ repoRoot, env = process.env, envVar, defaultValue } = {}) {
  const discovered = new Set(discoverSkillDirs(repoRoot));
  const raw = String(env[envVar] ?? defaultValue);
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return requested.filter((name) => discovered.has(name));
}

// Thin, behavior-identical wrapper over resolveSkillAllowlist() for the
// one-shot embedded runtime's own env var + default.
export function resolveAllowedSkills({ repoRoot, env = process.env } = {}) {
  return resolveSkillAllowlist({
    repoRoot,
    env,
    envVar: "CAREERRAT_RUNTIME_SKILLS",
    defaultValue: DEFAULT_RUNTIME_SKILLS,
  });
}

export function resolveDirectSkillRunSkills({ repoRoot, env = process.env } = {}) {
  const allowed = new Set(resolveAllowedSkills({ repoRoot, env }));
  return DIRECT_SKILL_RUN_SKILLS.filter((skill) => allowed.has(skill));
}

// ---------------------------------------------------------------------------
// AI routing mirrors call-ai.mjs exactly through resolveAIRoute(). Installed
// CLIs are invoked directly below. For BYOK/managed provider fallback, the
// routing decision has to land as env vars for the Agent SDK child rather than
// request headers.
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

const CHILD_RUNTIME_ENV_VARS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
  "CAREERRAT_HOME",
];

// Pure + exported so the routing decision is unit-testable without spawning
// the SDK: given a resolved route, what env does the child process get?
// route.type === "none" returns null — callers must have already rejected
// that case (see runSkillStream). `repoRoot` locates config/ai.json (the
// no-code model-swap file) — optional; ai-config.mjs falls back to its own
// repo-root default when omitted (unit tests exercise it that way).
function customHeaderLines({ feature, skill, action, operation } = {}) {
  const resolvedFeature = feature || deriveUsageFeature({ skill, action, operation });
  return [
    resolvedFeature ? `x-careerrat-feature: ${resolvedFeature}` : null,
    skill ? `x-careerrat-skill: ${skill}` : null,
    action ? `x-careerrat-action: ${action}` : null,
    operation ? `x-careerrat-operation: ${operation}` : null,
  ].filter(Boolean);
}

export function buildChildEnv({
  route,
  feature,
  skill,
  action,
  operation,
  baseEnv = process.env,
  repoRoot,
} = {}) {
  if (!route || route.type === "none") return null;

  // Start from an allowlist so unrelated credentials in the server process
  // are never inherited by the Agent SDK child or any tool it launches.
  const shared = {};
  for (const key of [...CHILD_RUNTIME_ENV_VARS, ...MODEL_SELECTION_ENV_VARS]) {
    if (baseEnv[key] !== undefined) shared[key] = baseEnv[key];
  }

  // config/ai.json fallback: only fills ANTHROPIC_MODEL/ANTHROPIC_SMALL_FAST_MODEL
  // when the server env didn't already set them — resolveModelConfig() applies
  // that precedence (env > config file > unset) itself.
  const { model, smallFastModel } = resolveModelConfig({ root: repoRoot, env: baseEnv });
  if (model) shared.ANTHROPIC_MODEL = model;
  if (smallFastModel) shared.ANTHROPIC_SMALL_FAST_MODEL = smallFastModel;

  // ELECTRON_RUN_AS_NODE: no-op under plain node. Under an Electron host (see
  // apps/desktop/main.mjs) this SDK query() spawns its own CLI child (and
  // that child can spawn further descendants) — process.execPath is the
  // Electron binary, so the child needs an explicit Node runtime. Checked the installed
  // @anthropic-ai/claude-agent-sdk@0.3.233's sdk.d.ts/sdk.mjs rather than
  // assuming: `Options.executable` ("JavaScript runtime to use … Auto-detected
  // if not specified") defaults to the literal string `"node"` and is
  // resolved via the SDK's own bundled execa-style PATH lookup — NOT via
  // `process.execPath` — UNLESS a prebuilt native CLI binary exists for the
  // current platform/arch (this install ships one for darwin-arm64, in which
  // case neither "node" nor process.execPath is used at all; it execs that
  // native binary directly). So on most real installs this env var is
  // belt-and-braces, not a live fix — but it's free, and it's the one thing
  // standing between "correct" and "silently spawns a second GUI" on
  // whichever platform/path combination DOES fall back to spawning "node".
  const electronGuard = { ELECTRON_RUN_AS_NODE: "1" };

  if (route.type === "byok") {
    // Direct to Anthropic (or a CAREERRAT_ANTHROPIC_BASE_URL override) with the
    // user's own key. No x-careerrat-* labels here — call-ai.mjs's own BYOK
    // path doesn't send them to the real Anthropic API either; they're a
    // proxy-metering label, not something Anthropic's API consumes.
    return {
      ...shared,
      ...electronGuard,
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
    ...electronGuard,
    ANTHROPIC_API_KEY: route.token,
    ANTHROPIC_BASE_URL: route.baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: customHeaderLines({ feature, skill, action, operation }).join("\n"),
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
        "posture). Run `npm install` in this checkout to enable the embedded skill runtime, or " +
        "`npm install @anthropic-ai/claude-agent-sdk` standalone."
    );
    err.code = "SDK_NOT_INSTALLED";
    err.cause = importErr;
    throw err;
  }
}

// Backward-compatible public constant for callers/tests that import the
// one-shot default. Mutation and shell tools are intentionally unavailable
// until an OS-level sandbox exists for the embedded runtime.
export const RUNTIME_TOOLS = APP_SAFE_RUNTIME_TOOLS;

// Posture text injected into the run's opening instruction — the one place
// the one-shot embedded runtime and the M2 conversational chat runtime
// (src/core/ai/chat-runtime.mjs) differ. Exported as part of buildPrompt so
// buildChatKickoffPrompt() there reuses this exact wording for its kickoff
// message instead of hand-duplicating a second copy that could drift.
const ONESHOT_POSTURE =
  "This is a non-interactive, headless run with nobody available to answer questions — make the " +
  "best defensible call yourself and state what you assumed rather than asking.";
const CONVERSATIONAL_POSTURE =
  "This is a conversational, multi-turn session — a real user will answer turn by turn. Ask ONE " +
  "question about one decision at a time exactly as the skill's steps specify. Do not combine two " +
  "decisions with 'and' or 'or' just to use one question mark. Wait for the reply, never invent an " +
  "answer on the user's behalf. Confirm what you already know before asking again (skill's own " +
  "STEP 0 guidance).";

// Lane A / R1, R4, R6 — the confirm-block mechanism InterviewSurface.jsx's
// parser looks for. No new runtime tool: the agent still just writes text,
// but a fenced ```careerrat:confirm block containing one closed-kind JSON
// object renders as a clickable pill the user saves or declines, instead of
// the skill trying to write candidate config itself. Conversational mode only
// — the one-shot embedded runtime has nobody to click a pill, so this stays
// out of ONESHOT_POSTURE entirely.
const CONFIRM_BLOCK_GUIDANCE =
  "When you have a specific, structured fact ready to record — work authorization, an automation " +
  "consent decision, or a company to track — emit a fenced confirm block instead of writing the " +
  "value into prose, so the user can review it and click to save. Syntax (exact fence, valid JSON, " +
  "nothing else on those lines):\n" +
  "```careerrat:confirm\n" +
  '{"kind":"authorization","summary":"Authorized to work in your country, no sponsorship needed","patch":{"work_authorized":true,"requires_sponsorship":false}}\n' +
  "```\n" +
  "Only these kinds are recognized — anything else is silently dropped, never rendered: " +
  "`authorization` (patch: {work_authorized, requires_sponsorship}), `consent_capability` " +
  "(payload: {capability, platform}), `companies_suggest` " +
  "(no payload), `company_add` (payload: {name}), `candidate_patch` (payload: {doc, patch} where doc " +
  'is exactly one of "profile", "targeting", "honesty", "form-defaults" and patch is the partial ' +
  "document to merge), `evidence_claim` (payload: {claim, evidence}, both non-empty strings, for " +
  "banking one piece of work history). Examples:\n" +
  "```careerrat:confirm\n" +
  '{"kind":"candidate_patch","summary":"Your name and contact details","payload":{"doc":"profile","patch":{"candidate":{"full_name":"Ada Lovelace","email":"ada@example.com"}}}}\n' +
  "```\n" +
  "```careerrat:confirm\n" +
  '{"kind":"evidence_claim","summary":"Ran a 12-person kitchen","payload":{"claim":"Ran a 12-person kitchen","evidence":"Candidate-stated during setup interview"}}\n' +
  "```\n" +
  "Do not ask the user to choose Basic or Advanced mode. Offer a consent_capability only when that " +
  "specific capability is needed for the task they are doing; confirming it enables the internal " +
  "automation mode and that one platform together. Never use consent_capability for saved job-source " +
  "search. That flow uses the site's plain, site-specific Yes/No login question and keeps searching " +
  "other sources after No. For candidate_patch, follow the stored schemas " +
  "exactly: profile.candidate.location is a string, while profile.location is an object whose home " +
  "field is a string. profile.location.relocation is always an array of market names; for no " +
  "relocation, save an empty array (`[]`), never `false`. Save a hybrid office-day " +
  "limit at profile.location.max_commute_days_per_week as an integer from 0 through 7. " +
  "targeting.role_buckets is an array where every item contains non-empty name, " +
  "priority, and titles fields. An optional role-bucket seniority_ladder is an array of " +
  "{rank, titles} levels where every rank is an explicit integer; never infer seniority from " +
  "array order or bucket priority. Keep " +
  "these blocks fully closed and out of prose otherwise; never describe the JSON to the user in words. " +
  "A candidate's notice period belongs at profile.authorization.notice_period, never " +
  "form-defaults.notice_period. Do not collect an earliest start date during initial setup. " +
  "Final application submission always requires a separate user action. form-defaults contains " +
  "ATS answers only and has no submission setting; never propose or persist one. " +
  "Voluntary self-identification belongs only to local Application defaults. Never ask for or " +
  "read it. Never include it in a candidate_patch; CareerRat keeps it out of agent context. " +
  "Emit a confirm block as soon as a fact is settled, not at the end of a topic: if the user gives " +
  "their name and email, send a candidate_patch for those two fields right away rather than waiting " +
  "to also collect phone, city, and links, so an interrupted conversation never loses everything " +
  "already answered. Group one coherent set of facts per block: name plus email plus phone together " +
  "is right, a separate pill for each is wrong. Never say a new fact is noted or saved unless it " +
  "is already in canonical state or the same response contains the confirmation block that can " +
  "save it. Never re-propose a fact the user already saved or " +
  "declined. `current_base` (what the candidate currently earns) is private: whenever a patch sets " +
  "it, include `current_comp_shareable: false` in the same patch, and it must never appear in any " +
  "outbound artifact. Do not invent kinds outside this closed list; anything not in it is silently " +
  "dropped and the user never sees it.";

function declinedFieldsNote(declinedFields) {
  const fields = Array.isArray(declinedFields) ? declinedFields.filter(Boolean) : [];
  if (!fields.length) return "";
  return (
    ` The user already declined to answer: ${fields.join(", ")} — never ask about ` +
    `${fields.length === 1 ? "it" : "these"} again.`
  );
}

function conversationalPosture(declinedFields) {
  return `${CONVERSATIONAL_POSTURE} ${PLAIN_ENGLISH_AGENT_VOICE} ${CONFIRM_BLOCK_GUIDANCE} ${CHAT_ANSWER_MODE_GUIDANCE}${declinedFieldsNote(declinedFields)}`;
}

// `mode` defaults to "oneshot" so every existing call site (runSkillStream,
// below) is byte-identical to the pre-M2 text; "conversational" is the only
// other value and swaps in conversationalPosture() above. `declinedFields`
// (conversational mode only) is the current form-defaults.declined_fields key
// list — see chat-runtime.mjs's two buildPrompt call sites, which read it off
// the candidate config once per session/turn so this stays a pure function.
export function buildPrompt({ skill, input, mode = "oneshot", skillMdPath, declinedFields = [] }) {
  const body = typeof input === "string" ? input : JSON.stringify(input ?? {});
  const posture =
    mode === "conversational" ? conversationalPosture(declinedFields) : ONESHOT_POSTURE;
  // Smaller/faster models guess wrong filenames for the spec (e.g. a literal
  // `resume-extract.SKILL.md`) and burn their whole run failing to find it, so
  // when the caller knows the resolved path, state it outright.
  const spec = skillMdPath
    ? `following its SKILL.md exactly — the spec file is at \`${skillMdPath}\`; Read that exact path first. `
    : "following its SKILL.md exactly. ";
  return `Run the \`${skill}\` skill against the following input, ${spec}${posture}\n\n${body}`;
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
  feature,
  action = "skill-run",
  operation,
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
  // Optional per-call tool-surface override. Explicit `tools` arrays are
  // copied only when every tool belongs to a sandboxed profile; otherwise
  // app-safe is the default.
  tools,
  toolProfile,
  approvedReadPaths,
  outputSchema,
  timeoutMs,
  model,
  effort,
  aiOperation,
  quality = null,
  reasoning = null,
  aiCapabilities = null,
  executionPlan = null,
  useExecutionPlanRoute = false,
  runtimeInventory = null,
  runInstalledRuntimeImpl = runInstalledRuntime,
  runInstalledRuntimeStreamImpl = runInstalledRuntimeStream,
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
        `${allowed.join(", ") || "none"}), set CAREERRAT_RUNTIME_SKILLS to opt more in`
    );
    err.code = "SKILL_NOT_ALLOWED";
    err.allowed = allowed;
    throw err;
  }

  const route =
    executionPlan && useExecutionPlanRoute
      ? resolveAIRouteForExecutionPlan(executionPlan, env, { runtimeInventory })
      : resolveAIRoute(env, { repoRoot, runtimeInventory });
  if (route.type === "none") {
    const err = new Error(route.error);
    err.code = "NO_AI_ROUTE";
    throw err;
  }

  const routeRuntimeId = aiRuntimeIdForRoute(route);
  const resolvedExecutionPlan = executionPlan
    ? assertAIExecutionPlanForRuntime(executionPlan, routeRuntimeId)
    : aiOperation
      ? resolveAIExecutionPlan({
          operation: aiOperation,
          runtimeId: routeRuntimeId,
          quality,
          reasoning,
          preferences: loadAIPreferences({ repoRoot, env }),
          capabilities: aiCapabilities,
          ...(route.type === "installed" ? { installedRuntime: route.runtime } : {}),
          modelOverride: model,
          effortOverride: effort,
        })
      : null;
  const requestModel = resolvedExecutionPlan?.resolved?.model ?? model;
  const requestEffort = resolvedExecutionPlan?.resolved?.effort ?? effort;

  const runtimeTools = resolveRuntimeTools({ tools, toolProfile });
  const candidateNote = agentApplicationDefaultsNote({ repoRoot, env, skill });

  if (route.type === "installed") {
    const requestedRuntimeTools = new Set(runtimeTools);
    const installedRuntimeTools = resolveInstalledSkillRuntimeTools({ skill }).filter(
      (tool) => tool === "Skill" || requestedRuntimeTools.has(tool)
    );
    const installedPosture = installedSkillRuntimePosture({ skill });
    const streamPublicWebActivity = installedRuntimeTools.some(
      (tool) => tool === "WebSearch" || tool === "WebFetch"
    );
    const prompt = [
      buildPrompt({ skill, input }),
      candidateNote,
      `This app-authorized run is limited to these capabilities: ${installedRuntimeTools.join(", ") || "none"}. Do not exceed that scope. ${installedPosture}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    onEvent({
      type: "system",
      data: {
        subtype: "init",
        runtime: route.runtime.id,
        tools: installedRuntimeTools,
      },
    });
    try {
      const runtimeInput = {
        runtime: route.runtime,
        prompt,
        cwd: repoRoot,
        skill,
        repoRoot,
        env,
        signal,
        // ANTHROPIC_MODEL is also used for route-specific fast-model
        // overrides such as résumé extraction. Passing that Claude model id
        // to Codex/Gemini/etc. makes an otherwise healthy installed CLI fail
        // at provider selection. The generic installed-runtime override is
        // cross-provider; the Anthropic override is Claude-only.
        model:
          String(
            requestModel ||
              env.CAREERRAT_INSTALLED_AI_MODEL ||
              (route.runtime.id === "claude" ? env.ANTHROPIC_MODEL : "") ||
              ""
          ).trim() || undefined,
        effort: requestEffort || undefined,
        tools: installedRuntimeTools,
        approvedReadPaths,
        outputSchema,
        timeoutMs,
      };
      const result = streamPublicWebActivity
        ? await runInstalledRuntimeStreamImpl({
            ...runtimeInput,
            onMessage(message) {
              for (const rawEvent of mapSdkMessage(message, { env })) {
                const event = normalizeInstalledRuntimeEvent(rawEvent);
                if (event.type === "tool_use" || event.type === "tool_result") onEvent(event);
              }
            },
          })
        : await runInstalledRuntimeImpl(runtimeInput);
      if (signal?.aborted) return { ok: false, aborted: true };
      onEvent({
        type: "assistant",
        data: { message: { content: [{ type: "text", text: result.text }] } },
      });
      const resultData = {
        ok: true,
        aborted: false,
        ...(resolvedExecutionPlan ? { executionPlan: resolvedExecutionPlan } : {}),
      };
      onEvent({ type: "result", data: resultData });
      if (result.usage) {
        appendUsageEvent(
          {
            source: "installed",
            feature,
            skill,
            action,
            operation,
            model: result.model || `installed:${route.runtime.id}`,
            upstream: `local-cli:${route.runtime.id}`,
            tokens_in: result.usage.input_tokens,
            tokens_out: result.usage.output_tokens,
          },
          { root: repoRoot, env }
        );
      }
      return resultData;
    } catch (error) {
      if (signal?.aborted || error?.code === "RUNTIME_CANCELLED") {
        return { ok: false, aborted: true };
      }
      const resultData = { ok: false, error: error.message, code: error.code || undefined };
      onEvent({ type: "error", data: { message: error.message, code: error.code || undefined } });
      onEvent({ type: "result", data: resultData });
      return resultData;
    }
  }

  const toolPolicy = createRuntimeToolPolicy({ repoRoot, skill, tools: runtimeTools });

  // Validate before touching the SDK so a missing devDependency is a clean
  // 501, not a crash mid-stream.
  const { query } = await loadSdk();

  const childEnv = buildChildEnv({
    route,
    feature,
    skill,
    action,
    operation,
    baseEnv: env,
    repoRoot,
  });

  const controller = new AbortController();
  let abortCause = null;
  const abortFromExternalSignal = () => {
    abortCause ||= "external";
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) {
      abortFromExternalSignal();
    } else {
      signal.addEventListener("abort", abortFromExternalSignal, { once: true });
    }
  }

  const q = query({
    prompt: [
      buildPrompt({
        skill,
        input,
        skillMdPath: join(repoRoot, ".agents", "skills", skill, "SKILL.md"),
      }),
      candidateNote,
    ]
      .filter(Boolean)
      .join("\n\n"),
    options: {
      cwd: repoRoot,
      env: childEnv,
      ...(requestModel ? { model: requestModel } : {}),
      ...(requestEffort ? { effort: requestEffort } : {}),
      abortController: controller,
      settingSources: ["project"],
      skills: [skill],
      tools: runtimeTools,
      // Headless calls use a programmatic fail-closed policy rather than
      // bypassing permissions. The PreToolUse hook is defense-in-depth: SDK
      // docs guarantee its denials apply even if permission behavior changes.
      permissionMode: "default",
      canUseTool: toolPolicy.canUseTool,
      hooks: toolPolicy.hooks,
    },
  });
  const runtimeTimeout = Number.isFinite(timeoutMs)
    ? setTimeout(
        () => {
          abortCause ||= "timeout";
          controller.abort();
        },
        Math.max(1, timeoutMs)
      )
    : null;
  runtimeTimeout?.unref?.();

  let resultData = null;
  try {
    for await (const msg of q) {
      const events = mapSdkMessage(msg, { env });
      for (const evt of events) onEvent(evt);

      if (msg.type === "result") {
        resultData = events.find((e) => e.type === "result")?.data ?? null;
        if (route.type === "byok") {
          writeByokUsage({ msg, feature, skill, action, operation, repoRoot, env });
        }
        break;
      }
    }
  } catch (err) {
    if (abortCause === "timeout") {
      resultData = {
        ok: false,
        error: "AI request timed out.",
        code: "RUNTIME_TIMEOUT",
      };
      onEvent({ type: "error", data: { message: resultData.error, code: resultData.code } });
      onEvent({ type: "result", data: resultData });
    } else if (abortCause === "external" || controller.signal.aborted) {
      resultData = { ok: false, aborted: true };
    } else {
      onEvent({ type: "error", data: { message: err.message } });
      resultData = { ok: false, error: err.message };
      onEvent({ type: "result", data: resultData });
    }
  } finally {
    if (runtimeTimeout) clearTimeout(runtimeTimeout);
    signal?.removeEventListener?.("abort", abortFromExternalSignal);
    try {
      await q.return?.();
    } catch {
      // best-effort cleanup only
    }
  }

  return resolvedExecutionPlan && resultData
    ? { ...resultData, executionPlan: resolvedExecutionPlan }
    : resultData;
}

// The proxy meters its own traffic server-side (ai-proxy.mjs's
// appendUsageEvent call on every /v1/messages it forwards) — so only the BYOK
// path needs a write here, exactly mirroring call-ai.mjs's own "nothing else
// is watching on BYOK" comment. One row per model actually used.
export function writeByokUsage({
  msg,
  feature,
  skill,
  action = "skill-run",
  operation,
  repoRoot,
  env,
}) {
  for (const [model, mu] of Object.entries(msg.modelUsage || {})) {
    appendUsageEvent(
      {
        source: "byok",
        feature,
        skill,
        action,
        operation,
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
