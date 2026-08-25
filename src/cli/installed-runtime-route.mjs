import {
  detectInstalledRuntimes,
  installedRuntimeCapabilities,
  installedRuntimeSignInCommand,
  installedRuntimeToolExecutionCapability,
  probeCustomRuntimeCommand,
  probeInstalledRuntime,
  startInstalledRuntimeSignIn,
} from "../core/ai/installed-runtimes.mjs";
import {
  loadInstalledRuntimeSelection,
  writeInstalledRuntimeSelection,
} from "../core/ai/runtime-selection.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 16 * 1024;

// The W4 onboarding 3d/3f custom-command entry, appended to the fixed
// registry's own runtimes array so callers (the engine picker) can render it
// alongside claude/codex/etc without a separate request. A command can be
// probed for diagnostics, but it remains unselectable until a real per-call
// tool boundary exists.
function customRuntimeEntry(selection) {
  const command = selection.customCommand;
  return {
    id: "custom",
    name: "Custom command",
    commandShape: command || null,
    path: command || null,
    available: Boolean(command),
    warning: null,
    status: command ? "ready_unverified" : "not_installed",
    ready: Boolean(command),
    action: null,
    toolExecutionSupported: false,
    capabilities: { completion: false, taskTools: false, research: false },
    capabilityTier: command ? "detected_unverified" : "unavailable",
    selectable: false,
    capabilityReason: "Detected, but custom commands cannot safely run CareerRat tools yet.",
    selected: selection.runtimeId === "custom" && !selection.providerFallback,
  };
}

function withToolExecutionCapability(runtime, probe) {
  const declared = installedRuntimeToolExecutionCapability(runtime.id);
  const supported =
    probe?.toolExecutionSupported === undefined
      ? declared.supported
      : probe.toolExecutionSupported === true;
  const declaredCapabilities = installedRuntimeCapabilities(runtime.id, {
    available: runtime.available === true,
    completion: probe?.completionSupported === false ? false : undefined,
    taskTools: supported,
  });
  const capabilityReason = supported
    ? null
    : probe?.capabilityReason ||
      (declaredCapabilities.capabilities.completion
        ? "Ready for chat and drafting. Task tools and research are not verified for this CLI yet."
        : declared.reason || "Cannot safely run CareerRat tools.");
  return {
    ...runtime,
    ...probe,
    toolExecutionSupported: supported,
    capabilities: declaredCapabilities.capabilities,
    capabilityTier: declaredCapabilities.capabilityTier,
    selectable:
      runtime.available === true &&
      probe?.ready === true &&
      declaredCapabilities.capabilities.completion === true,
    capabilityReason,
  };
}

export function inspectInstalledRuntimeState({
  repoRoot,
  env = process.env,
  detectImpl = detectInstalledRuntimes,
  probeImpl = probeInstalledRuntime,
  autoSelect = true,
} = {}) {
  const selection = loadInstalledRuntimeSelection({ repoRoot, env });
  const runtimes = detectImpl({ env }).map((runtime) => {
    const probe = runtime.available
      ? probeImpl(runtime, { env })
      : { status: "not_installed", ready: false, action: null };
    return withToolExecutionCapability(runtime, probe);
  });

  // Landing rule: auto-select only ever fires for an unambiguous exactly-one
  // ready CLI (the OnboardingPage.jsx gate/picker/interview state machine
  // then skips straight to the interview). Two or more ready CLIs is no
  // longer auto-resolved here — selectedId stays null so the caller's own
  // readyCount check lands on the picker screen instead, and the user picks.
  let selectedId = selection.runtimeId;
  let effectiveSelection = selection;
  const providerFallbackAllowed = env.CAREERRAT_DESKTOP_CLI_ONLY !== "1";
  if (selection.providerFallback && !providerFallbackAllowed) {
    selectedId = null;
    effectiveSelection = {
      runtimeId: null,
      providerFallback: false,
      customCommand: null,
    };
    writeInstalledRuntimeSelection({
      repoRoot,
      env,
      runtimeId: null,
      providerFallback: false,
    });
  }
  if (selectedId && !effectiveSelection.providerFallback) {
    const selectedRuntime = runtimes.find(({ id }) => id === selectedId);
    if (!selectedRuntime?.selectable) {
      selectedId = null;
      effectiveSelection = {
        runtimeId: null,
        providerFallback: false,
        customCommand: null,
      };
      writeInstalledRuntimeSelection({
        repoRoot,
        env,
        runtimeId: null,
        providerFallback: false,
      });
    }
  }
  if (!selectedId && !effectiveSelection.providerFallback && autoSelect) {
    const readyRuntimes = runtimes.filter(({ selectable }) => selectable);
    if (readyRuntimes.length === 1) {
      selectedId = readyRuntimes[0].id;
      writeInstalledRuntimeSelection({
        repoRoot,
        env,
        runtimeId: selectedId,
        providerFallback: false,
      });
    }
  }

  return {
    selectedId,
    providerFallback: effectiveSelection.providerFallback,
    providerFallbackAllowed,
    runtimes: [
      ...runtimes.map((runtime) => ({
        ...runtime,
        selected: runtime.id === selectedId && !effectiveSelection.providerFallback,
      })),
      customRuntimeEntry(effectiveSelection),
    ],
  };
}

export function mountInstalledRuntimeRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  detectImpl = detectInstalledRuntimes,
  probeImpl = probeInstalledRuntime,
  startSignInImpl = startInstalledRuntimeSignIn,
  probeCustomImpl = probeCustomRuntimeCommand,
} = {}) {
  const inspect = (autoSelect = true) =>
    inspectInstalledRuntimeState({
      repoRoot,
      env,
      detectImpl,
      probeImpl,
      autoSelect,
    });

  addRoute("GET", "/api/settings/ai-runtimes", (_req, res) => {
    sendJson(res, 200, inspect(true));
  });

  addRoute("POST", "/api/settings/ai-runtime/probe", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, error: error.message });
      return;
    }
    const runtimeId = String(body?.runtimeId || "").trim();
    const state = inspect(false);
    const runtime = state.runtimes.find(({ id }) => id === runtimeId);
    if (!runtime) {
      sendJson(res, 400, { ok: false, code: "RUNTIME_UNKNOWN" });
      return;
    }
    sendJson(res, 200, { ok: true, runtime });
  });

  addRoute("POST", "/api/settings/ai-runtime/select", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, error: error.message });
      return;
    }

    if (body?.providerFallback === true) {
      if (env.CAREERRAT_DESKTOP_CLI_ONLY === "1") {
        sendJson(res, 409, {
          ok: false,
          code: "PROVIDER_FALLBACK_UNAVAILABLE",
          error: "The packaged app requires a ready installed AI CLI.",
        });
        return;
      }
      writeInstalledRuntimeSelection({
        repoRoot,
        env,
        runtimeId: null,
        providerFallback: true,
      });
      sendJson(res, 200, {
        ok: true,
        selectedId: null,
        providerFallback: true,
        providerFallbackAllowed: true,
      });
      return;
    }

    const runtimeId = String(body?.runtimeId || "").trim();
    const state = inspect(false);
    const runtime = state.runtimes.find(({ id }) => id === runtimeId);
    if (!runtime?.available) {
      sendJson(res, 400, { ok: false, code: "RUNTIME_NOT_AVAILABLE" });
      return;
    }
    if (!runtime.capabilities?.completion) {
      sendJson(res, 409, {
        ok: false,
        code: "RUNTIME_CAPABILITY_UNSUPPORTED",
        error: runtime.capabilityReason,
      });
      return;
    }
    if (!runtime.ready) {
      sendJson(res, 409, {
        ok: false,
        code: "RUNTIME_AUTH_REQUIRED",
        action: runtime.action || "start_sign_in",
      });
      return;
    }

    writeInstalledRuntimeSelection({
      repoRoot,
      env,
      runtimeId,
      providerFallback: false,
    });
    sendJson(res, 200, { ok: true, selectedId: runtimeId, providerFallback: false });
  });

  addRoute("POST", "/api/settings/ai-runtime/sign-in", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, error: error.message });
      return;
    }
    const runtimeId = String(body?.runtimeId || "").trim();
    const runtime = detectImpl({ env }).find(({ id }) => id === runtimeId);
    if (!runtime?.available) {
      sendJson(res, 400, { ok: false, code: "RUNTIME_NOT_AVAILABLE" });
      return;
    }
    try {
      const started = startSignInImpl(runtime) || {};
      sendJson(res, 202, {
        ok: true,
        runtimeId,
        signInCommand: started.signInCommand || installedRuntimeSignInCommand(runtimeId),
        reused: started.reused === true,
      });
    } catch {
      sendJson(res, 500, { ok: false, code: "RUNTIME_SIGN_IN_FAILED" });
    }
  });

  // POST /api/settings/ai-runtime/custom/test — 3d/3f's "Test" button. Runs
  // the command once (15s timeout) and reports latency; never persists it or
  // grants CareerRat tool execution.
  addRoute("POST", "/api/settings/ai-runtime/custom/test", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, error: error.message });
      return;
    }
    const command = String(body?.command || "").trim();
    if (!command) {
      sendJson(res, 400, { ok: false, error: "command is required" });
      return;
    }
    const result = await probeCustomImpl({ command, env });
    sendJson(res, 200, result);
  });
}
