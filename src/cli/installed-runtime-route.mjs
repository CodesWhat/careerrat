import {
  detectInstalledRuntimes,
  installedRuntimeSignInCommand,
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
// alongside claude/codex/etc without a separate request. It is intentionally
// excluded from inspect()'s below-autoSelect fallback: a saved custom command
// only becomes "selected" through an explicit
// POST /api/settings/ai-runtime/custom/select, matching the design's "ADD →"
// affordance rather than silently taking over.
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
    selected: selection.runtimeId === "custom" && !selection.providerFallback,
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
    return { ...runtime, ...probe };
  });

  // Landing rule: auto-select only ever fires for an unambiguous exactly-one
  // ready CLI (the OnboardingPage.jsx gate/picker/interview state machine
  // then skips straight to the interview). Two or more ready CLIs is no
  // longer auto-resolved here — selectedId stays null so the caller's own
  // readyCount check lands on the picker screen instead, and the user picks.
  let selectedId = selection.runtimeId;
  if (!selectedId && !selection.providerFallback && autoSelect) {
    const readyRuntimes = runtimes.filter(({ ready }) => ready);
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
    providerFallback: selection.providerFallback,
    runtimes: [
      ...runtimes.map((runtime) => ({
        ...runtime,
        selected: runtime.id === selectedId && !selection.providerFallback,
      })),
      customRuntimeEntry(selection),
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
  // the command once (15s timeout) and reports latency; never persists
  // anything — see /custom/select below for that.
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

  // POST /api/settings/ai-runtime/custom/select — persists the custom
  // command as the selected runtime (runtimeId "custom"). Does not re-test
  // it first: the 3d/3f UI is expected to have already run /custom/test, but
  // a stale/untested command is still allowed to be selected (same trust
  // level as picking a detected-but-unverified CLI below).
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
    writeInstalledRuntimeSelection({
      repoRoot,
      env,
      runtimeId: "custom",
      providerFallback: false,
      customCommand: command,
    });
    sendJson(res, 200, { ok: true, selectedId: "custom", customCommand: command });
  });
}
