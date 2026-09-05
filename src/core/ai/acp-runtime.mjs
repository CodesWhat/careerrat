import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { validatePublicHttpUrl } from "../net/public-http-fetch.mjs";
import { runtimeProcessInvocation, scheduleRuntimeProcessKill } from "./runtime-process.mjs";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 4096;

function runtimeError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function diagnostic(value) {
  return String(value || "")
    .replace(/(api[_-]?key|authorization|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_CHARS);
}

function toolIdentity(toolCall) {
  return String(toolCall?.name || toolCall?.title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isScopedReadCall(toolCall) {
  return ["read_staged_input", "careerrat_scoped_tools_read_staged_input"].includes(
    toolIdentity(toolCall)
  );
}

function isScopedPublicFetchCall(toolCall) {
  return ["careerrat_scoped_tools_fetch", "mcp_careerrat_scoped_tools_fetch"].includes(
    toolIdentity(toolCall)
  );
}

function hasToolArguments(toolCall) {
  const raw = toolCall?.rawInput;
  return Boolean(
    raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0
  );
}

// ACP tells a client which auth methods an agent offers, but not which of them
// can finish without a person at the keyboard. A headless CareerRat run has no
// channel for a browser sign-in, so picking one strands the handshake until the
// request timeout. These patterns classify from what the agent advertised, so
// every ACP runtime is read the same way and none is special-cased by id.
const INTERACTIVE_AUTH_PATTERN =
  /\b(oauth|openid|sso|browser)\b|\bdevice[\s_-]?code\b|\b(sign|log)[\s_-]?in\b/i;
const CREDENTIAL_AUTH_PATTERN =
  /\b(api[\s_-]?keys?|apikeys?|access[\s_-]?keys?|secrets?|credentials?)\b/i;
const ENV_NAME_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

function authMethodText(method) {
  return [method?.id, method?.name, method?.description].filter(Boolean).join(" ");
}

// The protocol reserves terminal methods for a client that can run the agent's
// own TUI, and forbids passing them to authenticate.
function isTerminalAuthMethod(method) {
  return method?.type === "terminal";
}

function isCredentialAuthMethod(method) {
  const meta = method?._meta;
  if (meta && typeof meta === "object" && meta["api-key"]) return true;
  return CREDENTIAL_AUTH_PATTERN.test(authMethodText(method));
}

function isInteractiveAuthMethod(method) {
  return INTERACTIVE_AUTH_PATTERN.test(authMethodText(method));
}

function environmentName(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function credentialSuffixed(base) {
  if (!base) return null;
  return /_(KEY|SECRET|CREDENTIAL|CREDENTIALS)$/.test(base) ? base : `${base}_API_KEY`;
}

function environmentKeySet(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() !== "";
}

// Registry-owned per-method requirements, not inferred from a provider name:
// the exact variables an ACP method's own CLI reads. A provider-name guess
// previously mapped Gemini's `_meta['api-key'].provider === 'google'` to
// GOOGLE_API_KEY for `gemini-api-key`, but Gemini CLI 0.58 reserves
// GOOGLE_API_KEY for `vertex-ai` and reads GEMINI_API_KEY for
// `gemini-api-key`; a valid Vertex setup was selecting the wrong method and
// failing. Each entry lists alternative requirement groups (OR of ANDs): the
// method is satisfied once every variable in at least one group is set.
const ACP_METHOD_CREDENTIAL_REQUIREMENTS = Object.freeze({
  "gemini-api-key": Object.freeze([Object.freeze(["GEMINI_API_KEY"])]),
  "vertex-ai": Object.freeze([
    Object.freeze(["GOOGLE_API_KEY"]),
    Object.freeze(["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]),
  ]),
});

// Candidate requirement groups for a credential method. A method with a
// registry entry above uses it exactly; anything else falls back to
// evidence-derived single-variable groups, most specific first: any name the
// agent spelled out, then the method id, then the runtime id. `fixture-api-key`
// resolves to FIXTURE_API_KEY this way, which is the variable a CLI without a
// registry entry is most likely to read.
function credentialRequirementGroups(method, runtimeId) {
  const explicit = ACP_METHOD_CREDENTIAL_REQUIREMENTS[method?.id];
  if (explicit) return explicit;
  const spelled = [...authMethodText(method).matchAll(ENV_NAME_PATTERN)].map(([name]) => name);
  const derived = [environmentName(method?.id), environmentName(runtimeId)].map(credentialSuffixed);
  return [...new Set([...spelled, ...derived].filter(Boolean))].map((name) => [name]);
}

function credentialEnvironmentKeys(method, runtimeId) {
  return [...new Set(credentialRequirementGroups(method, runtimeId).flat())];
}

function credentialSatisfied(env, method, runtimeId) {
  return credentialRequirementGroups(method, runtimeId).some((group) =>
    group.every((name) => environmentKeySet(env, name))
  );
}

// Preference order: a credential method the environment already satisfies, then
// any other non-interactive method, then an interactive one. Interactive rises
// above the unsatisfied non-interactive methods only when the caller really has
// a channel for it. A runtime that advertises nothing but interactive methods
// still gets its first method tried, because a cached sign-in is invisible to
// the protocol and refusing it would break runtimes that work today.
export function selectAcpAuthMethod({
  authMethods = [],
  env = process.env,
  runtimeId = null,
  runtimeName = null,
  interactive = false,
} = {}) {
  const label = runtimeName || runtimeId || "This AI tool";
  const advertised = (Array.isArray(authMethods) ? authMethods : []).filter(
    (method) => method && typeof method.id === "string" && method.id.trim()
  );
  const usable = advertised.filter((method) => !isTerminalAuthMethod(method));
  if (!usable.length) {
    return {
      error: runtimeError(
        `${label} needs provider setup before CareerRat can use it.`,
        "RUNTIME_AUTH_REQUIRED",
        { runtimeId }
      ),
    };
  }
  const classified = usable.map((method) => {
    const credential = isCredentialAuthMethod(method);
    const environmentKeys = credential ? credentialEnvironmentKeys(method, runtimeId) : [];
    return {
      method,
      credential,
      environmentKeys,
      satisfied: credential && credentialSatisfied(env, method, runtimeId),
      interactive: isInteractiveAuthMethod(method),
    };
  });
  // A set variable is hard evidence and outranks the wording either way. Short
  // of that, a method that reads like a sign-in is treated as one, so a method
  // describing itself as both never earns API-key advice it cannot act on.
  const satisfied = classified.filter((entry) => entry.satisfied);
  const interactiveEntries = classified.filter((entry) => !entry.satisfied && entry.interactive);
  const remaining = classified.filter((entry) => !entry.satisfied && !entry.interactive);
  const ordered = interactive
    ? [...satisfied, ...interactiveEntries, ...remaining]
    : [...satisfied, ...remaining, ...interactiveEntries];
  const chosen = ordered[0];
  const advisable = chosen.credential && !chosen.satisfied && !chosen.interactive;
  return {
    method: chosen.method,
    credentialEnvironmentKeys: advisable ? chosen.environmentKeys : [],
  };
}

export function buildAcpRuntimeInvocation({
  runtimeId,
  executablePath,
  args,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some((argument) => typeof argument !== "string" || !argument.trim())
  ) {
    throw runtimeError(
      `${runtimeId || "Unknown runtime"} does not expose a verified ACP entry point.`,
      "RUNTIME_ACP_UNSUPPORTED",
      { runtimeId: runtimeId || null }
    );
  }
  const invocation = runtimeProcessInvocation(executablePath, args, { env, platform });
  return {
    command: invocation.command,
    args: invocation.args,
    options: { shell: false, windowsHide: true, ...invocation.options },
  };
}

export function acpPermissionDecision({ tools = [], request } = {}) {
  const requested = new Set(Array.isArray(tools) ? tools.filter(Boolean) : []);
  const kind = String(request?.toolCall?.kind || "other");
  const reads = requested.has("Read") && isScopedReadCall(request?.toolCall);
  const web =
    (requested.has("WebSearch") || requested.has("WebFetch")) &&
    kind === "fetch" &&
    isScopedPublicFetchCall(request?.toolCall);
  const webInput = web ? inferredToolInput(request?.toolCall) : {};
  const webAllowed = web && Boolean(webInput.url) && validatePublicHttpUrl(webInput.url).ok;
  const allowed = (reads && !hasToolArguments(request?.toolCall)) || webAllowed || kind === "think";
  const wantedKind = allowed ? "allow_once" : "reject_once";
  const option = request?.options?.find(({ kind: optionKind }) => optionKind === wantedKind);
  if (!option) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

function normalizedToolName(tool) {
  const title = String(tool.title || "").toLowerCase();
  if (title.startsWith("web search:")) return "WebSearch";
  if (tool.kind === "search") return "WebSearch";
  if (tool.kind === "fetch") return "WebFetch";
  if (tool.kind === "read") return "Read";
  return String(tool.name || tool.title || "AgentTool").trim() || "AgentTool";
}

function inferredToolInput(update) {
  if (update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)) {
    return update.rawInput;
  }
  const location = Array.isArray(update.locations)
    ? update.locations.find(({ path }) => typeof path === "string" && path.trim())
    : null;
  if (location?.path) return { file_path: location.path };
  const title = String(update.title || "").trim();
  const query = /^web search:\s*(.+)$/i.exec(title)?.[1]?.trim();
  if (query && query !== "?") return { query };
  const url = /^(?:navigate|extract):\s*(https?:\/\/\S+)/i.exec(title)?.[1]?.trim();
  if (url) return { url };
  return {};
}

function acpToolCallAllowed({ tools = [], update } = {}) {
  const requested = new Set(Array.isArray(tools) ? tools.filter(Boolean) : []);
  const kind = String(update?.kind || "other");
  const title = String(update?.title || "").toLowerCase();
  if (kind === "think" || (kind === "other" && title.startsWith("todo"))) return true;
  if (requested.has("Read") && isScopedReadCall(update)) {
    return !hasToolArguments(update);
  }
  const webRequested = requested.has("WebSearch") || requested.has("WebFetch");
  if (webRequested && kind === "fetch" && isScopedPublicFetchCall(update)) {
    const { url } = inferredToolInput(update);
    return Boolean(url) && validatePublicHttpUrl(url).ok;
  }
  return false;
}

function normalizeAcpUpdate(update, { sessionId, toolCalls } = {}) {
  if (!update || typeof update !== "object") return [];
  if (update.sessionUpdate === "tool_call" && update.toolCallId) {
    const tool = {
      id: update.toolCallId,
      kind: update.kind || "other",
      name: update.name || null,
      title: String(update.title || "Agent tool").trim() || "Agent tool",
      input: inferredToolInput(update),
    };
    toolCalls.set(tool.id, tool);
    return [
      {
        type: "assistant",
        session_id: sessionId || null,
        message: {
          content: [
            {
              type: "tool_use",
              id: tool.id,
              name: normalizedToolName(tool),
              input: tool.input,
            },
          ],
        },
      },
    ];
  }
  if (update.sessionUpdate === "tool_call_update" && update.toolCallId) {
    const tool = toolCalls.get(update.toolCallId) || {
      id: update.toolCallId,
      title: "Agent tool",
    };
    if (update.status && !["completed", "failed"].includes(update.status)) return [];
    const failed = update.status === "failed";
    toolCalls.delete(update.toolCallId);
    return [
      {
        type: "user",
        session_id: sessionId || null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: tool.id,
              content: `${tool.title} ${failed ? "failed" : "completed"}`,
              is_error: failed,
            },
          ],
        },
      },
    ];
  }
  return [];
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.inputTokens ?? usage.input_tokens;
  const output = usage.outputTokens ?? usage.output_tokens;
  const total = usage.totalTokens ?? usage.total_tokens;
  return {
    ...(Number.isFinite(input) ? { input_tokens: input } : {}),
    ...(Number.isFinite(output) ? { output_tokens: output } : {}),
    ...(Number.isFinite(total) ? { total_tokens: total } : {}),
  };
}

async function executeAcpRuntime({
  runtime,
  prompt,
  cwd,
  tools = [],
  env = process.env,
  signal,
  timeoutMs = 120000,
  onMessage,
  spawnImpl = spawn,
  probeOnly = false,
  mcpServers = [],
  platform = process.platform,
  beforeSpawn,
  interactiveAuth = false,
} = {}) {
  if (!runtime?.id || !runtime?.path) {
    throw runtimeError("No ACP runtime is selected.", "RUNTIME_NOT_SELECTED");
  }
  if (signal?.aborted) {
    throw runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED");
  }
  const invocation = buildAcpRuntimeInvocation({
    runtimeId: runtime.id,
    executablePath: runtime.path,
    args: runtime.acpArgs,
    env,
    platform,
  });
  beforeSpawn?.();
  let child;
  try {
    child = spawnImpl(invocation.command, invocation.args, {
      ...invocation.options,
      cwd,
      env,
      detached: platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw runtimeError("Could not start the selected ACP runtime.", "RUNTIME_SPAWN", {
      cause: error,
    });
  }
  if (!child?.stdin || !child?.stdout) {
    scheduleRuntimeProcessKill(child, undefined, { platform });
    throw runtimeError("The selected ACP runtime did not expose stdio.", "RUNTIME_SPAWN");
  }

  let stderr = "";
  let outputBytes = 0;
  let finished = false;
  let clientContext = null;
  let sessionId = null;
  let stopError = null;
  let forceKillTimer = null;
  let processClosed = false;
  let initialization = null;
  let text = "";
  const toolCalls = new Map();
  const emitMessage = (message) => {
    try {
      onMessage?.(message);
    } catch {
      // UI activity callbacks do not own the provider process.
    }
  };
  let fail;
  const failure = new Promise((_, reject) => {
    fail = reject;
  });
  const rejectOnce = (error) => {
    if (finished) return;
    finished = true;
    fail(error);
  };
  const stop = (error) => {
    if (finished) return;
    stopError ||= error;
    if (forceKillTimer) return;
    forceKillTimer = scheduleRuntimeProcessKill(child, () => rejectOnce(stopError), { platform });
  };

  child.stdout.on("data", (chunk) => {
    if (stopError) return;
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      stop(runtimeError("Installed AI output exceeded the 10MB limit.", "RUNTIME_OUTPUT_LIMIT"));
    }
  });
  child.stderr?.on("data", (chunk) => {
    if (stopError) return;
    outputBytes += chunk.length;
    if (stderr.length < MAX_DIAGNOSTIC_CHARS) stderr += chunk.toString("utf8");
    if (outputBytes > MAX_OUTPUT_BYTES) {
      stop(runtimeError("Installed AI output exceeded the 10MB limit.", "RUNTIME_OUTPUT_LIMIT"));
    }
  });
  child.on("error", (error) => {
    processClosed = true;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (stopError) {
      rejectOnce(stopError);
      return;
    }
    rejectOnce(
      runtimeError("Could not start the selected ACP runtime.", "RUNTIME_SPAWN", { cause: error })
    );
  });
  child.on("close", (status, closeSignal) => {
    processClosed = true;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (finished) return;
    if (stopError) {
      rejectOnce(stopError);
      return;
    }
    const detail = diagnostic(stderr);
    rejectOnce(
      runtimeError(
        `Installed ACP runtime exited with status ${status}${detail ? `: ${detail}` : "."}`,
        "RUNTIME_EXIT",
        { exitStatus: status, signal: closeSignal || null }
      )
    );
  });

  const abort = () => {
    if (clientContext && sessionId) {
      void clientContext.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
    }
    stop(runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => {
      if (clientContext && sessionId) {
        void clientContext.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
      }
      stop(runtimeError("Installed AI request timed out.", "RUNTIME_TIMEOUT"));
    },
    Math.max(1, timeoutMs)
  );
  timer.unref?.();

  const client = acp
    .client({ name: "CareerRat" })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      if (stopError) return { outcome: { outcome: "cancelled" } };
      return acpPermissionDecision({ tools, request: params, cwd });
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (stopError) return;
      const update = params.update;
      if (update?.sessionUpdate === "tool_call" && !acpToolCallAllowed({ tools, update, cwd })) {
        if (clientContext && sessionId) {
          void clientContext
            .notify(acp.methods.agent.session.cancel, { sessionId })
            .catch(() => {});
        }
        stop(
          runtimeError(
            "The installed ACP runtime attempted a tool outside this CareerRat request.",
            "RUNTIME_TOOL_BOUNDARY",
            { runtimeId: runtime.id, toolKind: update.kind || "other" }
          )
        );
        return;
      }
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        text += String(update.content.text || "");
      }
      for (const message of normalizeAcpUpdate(update, { sessionId, toolCalls })) {
        emitMessage(message);
      }
    });

  try {
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const response = await Promise.race([
      client.connectWith(stream, async (context) => {
        clientContext = context;
        const initialized = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        initialization = initialized;
        const authMethods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
        // An agent can hold its key on disk, in the environment, or in a
        // cached sign-in the protocol never exposes, so the first session is
        // requested with whatever state the runtime already has. Only the
        // agent's own -32000 (auth required) response means CareerRat has to
        // pick a method and authenticate; a probe that would already succeed
        // on a cached login never calls authenticate at all, so a working
        // sign-in is never swapped out from under a headless run.
        let credentialKeys = [];
        const withCredentialAdvice = async (run) => {
          try {
            return await run();
          } catch (error) {
            // A rejected ACP request carries the numeric JSON-RPC code; only
            // -32000 means authentication is required. Every other failure
            // (bad params, an internal error, cancellation, ...) passes
            // through unchanged, with its own code and message, so it is
            // never masked as a credential problem.
            if (error?.code !== -32000) throw error;
            const message = credentialKeys.length
              ? `${runtime.name || runtime.id} needs an API key before CareerRat can use it. Set ${credentialKeys[0]}, then check again.`
              : `${runtime.name || runtime.id} needs authentication before CareerRat can use it. Check its sign-in status, then try again.`;
            throw runtimeError(message, "RUNTIME_AUTH_REQUIRED", {
              runtimeId: runtime.id,
              authEnvironmentKeys: credentialKeys,
              cause: error,
            });
          }
        };
        const requestSession = () =>
          context.request(acp.methods.agent.session.new, {
            cwd,
            mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
          });
        let session;
        try {
          session = await requestSession();
        } catch (error) {
          if (error?.code !== -32000) throw error;
          const selection = selectAcpAuthMethod({
            authMethods,
            env,
            runtimeId: runtime.id,
            runtimeName: runtime.name,
            interactive: interactiveAuth,
          });
          if (selection.error) throw selection.error;
          credentialKeys = selection.credentialEnvironmentKeys;
          const authenticated = await withCredentialAdvice(() =>
            context.request(acp.methods.agent.authenticate, { methodId: selection.method.id })
          );
          if (authenticated == null) {
            throw runtimeError(
              `${runtime.name || runtime.id} could not confirm its provider sign-in.`,
              "RUNTIME_AUTH_REQUIRED",
              { runtimeId: runtime.id }
            );
          }
          session = await withCredentialAdvice(requestSession);
        }
        sessionId = session.sessionId;
        if (probeOnly) return { stopReason: "probe_complete" };
        return context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: String(prompt || "") }],
        });
      }),
      failure,
    ]);
    if (stopError) throw stopError;
    if (probeOnly) {
      finished = true;
      return {
        ready: true,
        agentCapabilities: initialization?.agentCapabilities || {},
        agentInfo: initialization?.agentInfo || null,
      };
    }
    if (response?.stopReason === "cancelled") {
      throw runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED");
    }
    for (const tool of toolCalls.values()) {
      emitMessage({
        type: "user",
        session_id: sessionId || null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: tool.id,
              content: `${tool.title} completed`,
              is_error: false,
            },
          ],
        },
      });
    }
    if (stopError) throw stopError;
    toolCalls.clear();
    finished = true;
    return {
      text: text.trim(),
      usage: normalizeUsage(response?.usage),
      model: null,
      sessionId,
      runtimeId: runtime.id,
    };
  } catch (error) {
    if (stopError) throw stopError;
    if (error?.code) throw error;
    throw runtimeError(
      diagnostic(error?.message) || "The selected ACP runtime failed.",
      "RUNTIME_RESULT_ERROR",
      { cause: error }
    );
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (forceKillTimer) {
      if (processClosed) clearTimeout(forceKillTimer);
    } else if (!processClosed) {
      forceKillTimer = scheduleRuntimeProcessKill(child, undefined, { platform });
    }
  }
}

export function probeAcpRuntime(options = {}) {
  return executeAcpRuntime({ ...options, probeOnly: true });
}

export function runAcpRuntime(options = {}) {
  return executeAcpRuntime(options);
}
