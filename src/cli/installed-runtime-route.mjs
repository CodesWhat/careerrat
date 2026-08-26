import {
  CLAUDE_NATIVE_INSTALL_COMMAND,
  detectInstalledRuntimes,
  hasCompleteCareerRatCapabilities,
  installedRuntimeCapabilities,
  installedRuntimeSignInCommand,
  isSupportedInstalledRuntime,
  probeCustomRuntimeCommand,
  probeInstalledRuntime,
  startInstalledRuntimeGuidedSetup,
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
    supported: false,
    commandShape: command || null,
    path: command || null,
    available: Boolean(command),
    warning: null,
    status: command ? "ready_unverified" : "not_installed",
    ready: Boolean(command),
    action: null,
    capabilities: {
      completion: false,
      structuredOutput: false,
      appWorkflows: false,
      exactRead: false,
      publicWeb: false,
      liveActivity: false,
      resumable: false,
      taskTools: false,
      research: false,
    },
    capabilityTier: command ? "detected_unverified" : "unavailable",
    selectable: false,
    capabilityReason: "Detected, but custom commands cannot safely run CareerRat tools yet.",
    selected: selection.runtimeId === "custom" && !selection.providerFallback,
  };
}

function withProbeReadiness(runtime, probe) {
  const capabilityState = installedRuntimeCapabilities(runtime.id, {
    available: runtime.available === true,
    capabilityEvidence: probe?.capabilities,
  });
  const supported = isSupportedInstalledRuntime(runtime.id);
  const complete = hasCompleteCareerRatCapabilities(capabilityState.capabilities, runtime.id);
  const capabilityReason = !supported
    ? "Detected for diagnostics. This runtime has not passed complete CareerRat acceptance yet."
    : complete
      ? null
      : probe?.capabilityReason || "Update or reconnect this runtime before using CareerRat.";
  return {
    ...runtime,
    ...probe,
    supported,
    capabilities: capabilityState.capabilities,
    capabilitiesVerified: probe?.capabilities !== null && typeof probe?.capabilities === "object",
    capabilityTier: capabilityState.capabilityTier,
    selectable: supported && runtime.available === true && probe?.ready === true && complete,
    capabilityReason,
  };
}

function runtimeVerification(runtime) {
  if (!runtime?.path || runtime.capabilities?.completion !== true) return null;
  return {
    path: runtime.path,
    capabilities: runtime.capabilities,
    checkedAt: new Date().toISOString(),
  };
}

function sameRuntimeSelectionIdentity(left, right) {
  return left?.runtimeId === right?.runtimeId && left?.providerFallback === right?.providerFallback;
}

export async function inspectInstalledRuntimeState({
  repoRoot,
  env = process.env,
  detectImpl = detectInstalledRuntimes,
  probeImpl = probeInstalledRuntime,
  autoSelect = true,
} = {}) {
  const runtimes = await Promise.all(
    detectImpl({ env }).map(async (runtime) => {
      const supported = isSupportedInstalledRuntime(runtime.id);
      const probe =
        runtime.available && supported
          ? await probeImpl(runtime, { env, cwd: repoRoot })
          : runtime.available
            ? { status: "detected_unverified", ready: false, action: null, capabilities: null }
            : { status: "not_installed", ready: false, action: null, capabilities: null };
      return withProbeReadiness(runtime, probe);
    })
  );
  const selection = loadInstalledRuntimeSelection({ repoRoot, env });

  // Landing rule: auto-select only ever fires for an unambiguous exactly-one
  // ready CLI (the OnboardingPage.jsx gate/picker/interview state machine
  // then skips straight to the interview). Two or more ready CLIs is no
  // longer auto-resolved here — selectedId stays null so the caller's own
  // readyCount check lands on the picker screen instead, and the user picks.
  let selectedId = selection.runtimeId;
  let effectiveSelection = selection;
  let expectedSelection = selection;
  const persistInspectedSelection = (nextSelection) => {
    const currentSelection = loadInstalledRuntimeSelection({ repoRoot, env });
    if (!sameRuntimeSelectionIdentity(currentSelection, expectedSelection)) {
      expectedSelection = currentSelection;
      effectiveSelection = currentSelection;
      selectedId = currentSelection.runtimeId;
      return false;
    }
    writeInstalledRuntimeSelection({ repoRoot, env, ...nextSelection });
    expectedSelection = loadInstalledRuntimeSelection({ repoRoot, env });
    effectiveSelection = expectedSelection;
    selectedId = expectedSelection.runtimeId;
    return true;
  };
  const providerFallbackAllowed = env.CAREERRAT_DESKTOP_CLI_ONLY !== "1";
  if (selection.providerFallback && !providerFallbackAllowed) {
    selectedId = null;
    effectiveSelection = {
      runtimeId: null,
      providerFallback: false,
      customCommand: null,
    };
    persistInspectedSelection({
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
      persistInspectedSelection({
        runtimeId: null,
        providerFallback: false,
      });
    }
  }
  if (!selectedId && !effectiveSelection.providerFallback && autoSelect) {
    const readyRuntimes = runtimes.filter(({ selectable }) => selectable);
    if (readyRuntimes.length === 1) {
      selectedId = readyRuntimes[0].id;
      persistInspectedSelection({
        runtimeId: selectedId,
        providerFallback: false,
        verification: runtimeVerification(readyRuntimes[0]),
      });
    }
  }

  if (selectedId && !effectiveSelection.providerFallback) {
    const selectedRuntime = runtimes.find(({ id }) => id === selectedId);
    if (selectedRuntime?.selectable) {
      persistInspectedSelection({
        runtimeId: selectedId,
        providerFallback: false,
        verification: runtimeVerification(selectedRuntime),
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
  startGuidedSetupImpl = startInstalledRuntimeGuidedSetup,
  probeCustomImpl = probeCustomRuntimeCommand,
  platform = process.platform,
} = {}) {
  const inspect = (autoSelect = true) =>
    inspectInstalledRuntimeState({
      repoRoot,
      env,
      detectImpl,
      probeImpl,
      autoSelect,
    });

  addRoute("GET", "/api/settings/ai-runtimes", async (_req, res) => {
    sendJson(res, 200, await inspect(true));
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
    const state = await inspect(false);
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
    const state = await inspect(false);
    const runtime = state.runtimes.find(({ id }) => id === runtimeId);
    if (!runtime?.available) {
      sendJson(res, 400, { ok: false, code: "RUNTIME_NOT_AVAILABLE" });
      return;
    }
    if (!runtime.supported) {
      sendJson(res, 409, {
        ok: false,
        code: "RUNTIME_NOT_SUPPORTED",
        error: runtime.capabilityReason,
      });
      return;
    }
    if (!runtime.ready && runtime.action === "start_sign_in") {
      sendJson(res, 409, {
        ok: false,
        code: "RUNTIME_AUTH_REQUIRED",
        action: "start_sign_in",
      });
      return;
    }
    if (!hasCompleteCareerRatCapabilities(runtime.capabilities, runtime.id)) {
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
      verification: runtimeVerification(runtime),
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
    if (!isSupportedInstalledRuntime(runtimeId)) {
      sendJson(res, 409, { ok: false, code: "RUNTIME_NOT_SUPPORTED" });
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

  addRoute("POST", "/api/settings/ai-runtime/guided-setup", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, error: error.message });
      return;
    }
    if (env.CAREERRAT_DESKTOP_CLI_ONLY !== "1" || platform !== "darwin") {
      sendJson(res, 409, {
        ok: false,
        code: "RUNTIME_GUIDED_SETUP_UNAVAILABLE",
        error: "Guided setup is available in the CareerRat app on macOS.",
      });
      return;
    }
    const runtimeId = String(body?.runtimeId || "").trim();
    if (runtimeId !== "claude") {
      sendJson(res, 409, {
        ok: false,
        code: "RUNTIME_GUIDED_SETUP_UNSUPPORTED",
        error: "Guided setup is currently available for Claude Code.",
      });
      return;
    }
    const runtime = detectImpl({ env }).find(({ id }) => id === runtimeId);
    if (runtime?.available) {
      sendJson(res, 409, {
        ok: false,
        code: "RUNTIME_ALREADY_INSTALLED",
        error: "Claude Code is already installed. Sign in instead.",
      });
      return;
    }
    let closed = false;
    let started = false;
    let heartbeat = null;
    const pendingOutput = [];
    const controller = new AbortController();
    res.on?.("close", () => {
      closed = true;
      controller.abort();
    });

    function emit(payload) {
      if (closed || !started) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        closed = true;
        controller.abort();
      }
    }

    function startStream() {
      if (started || closed) return;
      started = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      emit({
        type: "started",
        runtimeId,
        installCommand: CLAUDE_NATIVE_INSTALL_COMMAND,
      });
      for (const message of pendingOutput.splice(0)) emit({ type: "output", message });
      heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      heartbeat.unref?.();
    }

    try {
      await startGuidedSetupImpl(runtimeId, {
        platform,
        signal: controller.signal,
        onStart: startStream,
        onOutput(message) {
          if (started) emit({ type: "output", message });
          else pendingOutput.push(message);
        },
      });
      startStream();
      emit({ type: "done", runtimeId });
    } catch (error) {
      if (!started) {
        sendJson(res, 500, {
          ok: false,
          code: error?.code || "RUNTIME_GUIDED_SETUP_FAILED",
          error: "CareerRat could not start the in-app Claude installer.",
        });
        return;
      }
      emit({
        type: "error",
        code: error?.code || "RUNTIME_GUIDED_SETUP_FAILED",
        message:
          error?.code === "RUNTIME_GUIDED_SETUP_CANCELLED"
            ? "Claude Code setup was cancelled."
            : "Claude Code did not finish installing. Check your connection and try again.",
      });
    } finally {
      clearInterval(heartbeat);
      if (started && !closed) res.end();
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
