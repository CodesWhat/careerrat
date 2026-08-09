import {
  detectInstalledRuntimes,
  installedRuntimeSignInCommand,
  openInstalledRuntimeTerminal,
  probeInstalledRuntime,
} from "../core/ai/installed-runtimes.mjs";
import {
  loadInstalledRuntimeSelection,
  writeInstalledRuntimeSelection,
} from "../core/ai/runtime-selection.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 16 * 1024;

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

  let selectedId = selection.runtimeId;
  if (!selectedId && !selection.providerFallback && autoSelect) {
    selectedId = runtimes.find(({ ready }) => ready)?.id || null;
    if (selectedId) {
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
    runtimes: runtimes.map((runtime) => ({
      ...runtime,
      selected: runtime.id === selectedId && !selection.providerFallback,
    })),
  };
}

export function mountInstalledRuntimeRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  detectImpl = detectInstalledRuntimes,
  probeImpl = probeInstalledRuntime,
  openTerminalImpl = openInstalledRuntimeTerminal,
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
}
