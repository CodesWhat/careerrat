import {
  detectInstalledRuntimes,
  installedRuntimeSignInCommand,
  installedRuntimeToolExecutionCapability,
  openInstalledRuntimeTerminal,
  probeCustomRuntimeCommand,
  probeInstalledRuntime,
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
  const capabilityReason = supported
    ? null
    : probe?.capabilityReason || declared.reason || "Cannot safely run CareerRat tools.";
  return {
    ...runtime,
    ...probe,
    toolExecutionSupported: supported,
    selectable: runtime.available === true && probe?.ready === true && supported,
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
  if (selectedId && !selection.providerFallback) {
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
  if (!selectedId && !selection.providerFallback && autoSelect) {
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
  openTerminalImpl = openInstalledRuntimeTerminal,
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
      writeInstalledRuntimeSelection({
        repoRoot,
        env,
        runtimeId: null,
        providerFallback: true,
      });
      sendJson(res, 200, { ok: true, selectedId: null, providerFallback: true });
      return;
    }

    const runtimeId = String(body?.runtimeId || "").trim();
    const state = inspect(false);
    const runtime = state.runtimes.find(({ id }) => id === runtimeId);
    if (!runtime?.available) {
      sendJson(res, 400, { ok: false, code: "RUNTIME_NOT_AVAILABLE" });
      return;
    }
    if (!runtime.toolExecutionSupported) {
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
        action: runtime.action || "open_terminal",
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

  addRoute("POST", "/api/settings/ai-runtime/open-terminal", async (req, res) => {
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
      const opened = openTerminalImpl(runtime) || {};
      sendJson(res, 200, {
        ok: true,
        signInCommand: opened.signInCommand || installedRuntimeSignInCommand(runtimeId),
      });
    } catch {
      sendJson(res, 500, { ok: false, code: "TERMINAL_OPEN_FAILED" });
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

  // POST /api/settings/ai-runtime/custom/select — retained so old clients get
  // an explicit capability error instead of a 404. It never persists.
  addRoute("POST", "/api/settings/ai-runtime/custom/select", async (req, res) => {
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
    sendJson(res, 409, {
      ok: false,
      code: "RUNTIME_CAPABILITY_UNSUPPORTED",
      error: "Custom commands cannot safely run CareerRat tools yet.",
    });
  });
}
