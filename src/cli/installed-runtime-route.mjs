import { loadAIPreferences, writeAIPreferences } from "../core/ai/ai-preferences.mjs";
import {
  clearGuidedSetupOwnership,
  confirmGuidedSetupOwnershipPid,
  reserveGuidedSetupOwnership,
} from "../core/ai/guided-setup-ownership.mjs";
import {
  CLAUDE_NATIVE_INSTALL_COMMAND,
  detectInstalledRuntimes,
  hasCompleteCareerRatCapabilities,
  hasInstalledRuntimeCompletion,
  installedRuntimeCapabilities,
  installedRuntimeSignInCommand,
  isInstalledRuntimeBelowVersionBoundary,
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

const GUIDED_SETUP_SHUTDOWN_TIMEOUT_MS = 5000;

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
  const completionReady = hasInstalledRuntimeCompletion(capabilityState.capabilities, runtime.id);
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
    selectable: supported && runtime.available === true && probe?.ready === true && completionReady,
    capabilityReason,
  };
}

function runtimeVerification(runtime) {
  if (
    !runtime?.path ||
    !runtime.realPath ||
    !runtime.version ||
    !/^[a-f0-9]{64}$/i.test(String(runtime.binaryFingerprint || "")) ||
    runtime.capabilities?.completion !== true
  ) {
    return null;
  }
  return {
    path: runtime.path,
    realPath: runtime.realPath,
    version: runtime.version,
    binaryFingerprint: String(runtime.binaryFingerprint).toLowerCase(),
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
  forceCompletionProbeFor = null,
  platform = process.platform,
} = {}) {
  const runtimes = await Promise.all(
    detectImpl({ env }).map(async (runtime) => {
      const supported = isSupportedInstalledRuntime(runtime.id);
      const probe =
        runtime.available && supported
          ? await probeImpl(runtime, {
              env,
              cwd: repoRoot,
              forceCompletionProbe: runtime.id === forceCompletionProbeFor,
            })
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
    // Mirrors the exact gate the guided-setup route itself enforces
    // (env.CAREERRAT_DESKTOP_CLI_ONLY === "1" && platform === "darwin"), so
    // the picker can decide up front whether to show the in-app Update
    // button or the external install link instead of discovering it only
    // after a 409 from a click.
    guidedSetupAvailable: env.CAREERRAT_DESKTOP_CLI_ONLY === "1" && platform === "darwin",
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
  belowBoundaryImpl = isInstalledRuntimeBelowVersionBoundary,
  platform = process.platform,
} = {}) {
  const inspect = (autoSelect = true, { forceCompletionProbeFor = null } = {}) =>
    inspectInstalledRuntimeState({
      repoRoot,
      env,
      detectImpl,
      probeImpl,
      autoSelect,
      forceCompletionProbeFor,
      platform,
    });

  // Scoped to this mount, not module-level: each mountInstalledRuntimeRoutes
  // call (one per server/test) gets its own in-flight registry, so parallel
  // tests never see each other's locks. Keyed by runtimeId and held from the
  // moment a guided-setup request is admitted until its process tree has
  // fully terminated (the finally block below), so two concurrent requests
  // for the same runtime can never both reach the native installer. This is
  // only the same-mount fast path, though: it's in-memory, so it can't see a
  // guided setup a *previous* mount started (a crash, or a normal relaunch).
  // The durable ownership record in guided-setup-ownership.mjs is the
  // fallback that survives that gap.
  const activeGuidedSetups = new Set();
  // Tracks the AbortController for every in-flight guided-setup request on
  // this mount, purely so graceful shutdown (shutdownGuidedSetups below) can
  // abort and await them; unrelated to the admission lock above, and always
  // cleaned up when a request's own promise settles regardless of how it
  // settled.
  const activeGuidedSetupControllers = new Map();
  // Permanent once set (shutdown never reverses): the guided-setup route
  // checks this both right after body parsing and again immediately before
  // admission, so a request that was still reading its body, or that races
  // shutdownGuidedSetups on the same tick, is refused instead of being
  // admitted after the snapshot below is taken. Without this, such a
  // request would register in activeGuidedSetupControllers after
  // shutdownGuidedSetups has already returned, and the caller's own
  // server.close() would then have to wait out that missed request's full
  // installer timeout (up to 10 minutes) instead of the bound below.
  let shuttingDown = false;

  async function shutdownGuidedSetups({ timeoutMs = GUIDED_SETUP_SHUTDOWN_TIMEOUT_MS } = {}) {
    shuttingDown = true;
    const pending = [...activeGuidedSetupControllers.values()];
    if (pending.length === 0) return;
    for (const { controller } of pending) controller.abort();
    await Promise.race([
      Promise.all(pending.map((entry) => entry.done)),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  addRoute("GET", "/api/settings/ai-preferences", (_req, res) => {
    sendJson(res, 200, loadAIPreferences({ repoRoot, env }));
  });

  addRoute("POST", "/api/settings/ai-preferences", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, error: error.message });
      return;
    }
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (keys.length !== 2 || !keys.includes("quality") || !keys.includes("reasoning")) {
      sendJson(res, 400, {
        ok: false,
        code: "AI_PREFERENCES_INVALID",
        error: "Only Paul quality and thinking depth can be changed here.",
      });
      return;
    }
    try {
      sendJson(
        res,
        200,
        writeAIPreferences({
          repoRoot,
          env,
          quality: body.quality,
          reasoning: body.reasoning,
        })
      );
    } catch (error) {
      if (error?.code === "AI_PREFERENCES_INVALID") {
        sendJson(res, 400, { ok: false, code: error.code, error: error.message });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        code: "AI_PREFERENCES_SAVE_FAILED",
        error: "CareerRat couldn't save those AI settings. Try again.",
      });
    }
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
    const state = await inspect(false, { forceCompletionProbeFor: runtimeId });
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
    if (!runtime.ready && runtime.status === "completion_probe_failed") {
      sendJson(res, 409, {
        ok: false,
        code: "RUNTIME_PROBE_FAILED",
        error: runtime.probeMessage || "This AI tool did not finish its connection check.",
        action: runtime.action || "retry",
        actionLabel: runtime.actionLabel || "Try again",
      });
      return;
    }
    if (!hasInstalledRuntimeCompletion(runtime.capabilities, runtime.id)) {
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
        code: "RUNTIME_PROBE_FAILED",
        error: runtime.probeMessage || "This AI tool did not finish its connection check.",
        action: runtime.action || "retry",
        actionLabel: runtime.actionLabel || "Try again",
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
    // Checked immediately after the async body read, since shutdown can
    // start while this request was still parsing: a request admitted after
    // that point would never be aborted by shutdownGuidedSetups's own
    // snapshot and could stall the caller's server.close() behind its full
    // installer timeout.
    if (shuttingDown) {
      sendJson(res, 503, {
        ok: false,
        code: "RUNTIME_GUIDED_SETUP_SHUTTING_DOWN",
        error: "CareerRat is shutting down. Try Claude Code setup again after it restarts.",
      });
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
    // Only one guided setup per runtime at a time: two tabs or local clients
    // racing this route could otherwise both pass the version-boundary check
    // before either installation finishes and concurrently run the native
    // installer against the same Claude install. The lock is acquired here,
    // before any probing starts, and released in the finally block below
    // only after startGuidedSetupImpl's promise has settled, which, per its
    // own process-tree cleanup, only happens once the installer's process
    // group has actually terminated.
    if (activeGuidedSetups.has(runtimeId)) {
      sendJson(res, 409, {
        ok: false,
        code: "RUNTIME_GUIDED_SETUP_IN_PROGRESS",
        error: "Claude Code setup is already running. Wait for it to finish.",
      });
      return;
    }
    // Checked again immediately before admission: shutdown could have
    // started while the checks above were running.
    if (shuttingDown) {
      sendJson(res, 503, {
        ok: false,
        code: "RUNTIME_GUIDED_SETUP_SHUTTING_DOWN",
        error: "CareerRat is shutting down. Try Claude Code setup again after it restarts.",
      });
      return;
    }
    // The Set above only ever sees this mount's own requests. A previous
    // mount's installer (crashed, or a normal app relaunch) can still be
    // alive underneath a fresh, empty Set. The durable ownership record is
    // what catches that case: reserved exclusively right here, before any
    // probing or spawn, so a crash after this point but before the pid is
    // confirmed still leaves a durable (if pid-less) claim behind instead of
    // nothing, and reclaimed once the recorded process group (or a pid-less
    // reservation) is confirmed dead or stale.
    const reservation = reserveGuidedSetupOwnership({ repoRoot, env, platform, runtimeId });
    if (reservation.error) {
      sendJson(res, 409, {
        ok: false,
        code: reservation.error.code,
        error: reservation.error.message,
      });
      return;
    }
    const ownedGeneration = reservation.generation;
    activeGuidedSetups.add(runtimeId);
    // `lockRetained` governs the finally block at the very bottom: a settle
    // that couldn't confirm the installer's process group actually died
    // must keep both the in-memory Set entry and the durable ownership
    // record, rather than releasing a lock over a group that may still be
    // running.
    let lockRetained = false;
    const controller = new AbortController();
    let resolveControllerDone;
    const controllerDone = new Promise((resolve) => {
      resolveControllerDone = resolve;
    });
    activeGuidedSetupControllers.set(runtimeId, { controller, done: controllerDone });
    try {
      // The abort controller and close handler are registered before any
      // probing or installer launch, not after: a disconnect that lands while
      // the version-boundary probe is still in flight must be observed before
      // the code below ever decides whether to run the native installer.
      let closed = false;
      let started = false;
      let heartbeat = null;
      const pendingOutput = [];
      res.on?.("close", () => {
        closed = true;
        controller.abort();
      });

      const runtime = detectImpl({ env }).find(({ id }) => id === runtimeId);
      if (runtime?.available) {
        const versionBoundaryState = await belowBoundaryImpl(runtime, {
          env,
          platform,
          signal: controller.signal,
        });
        if (closed || controller.signal.aborted) return;
        if (versionBoundaryState === "at_or_above") {
          sendJson(res, 409, {
            ok: false,
            code: "RUNTIME_ALREADY_INSTALLED",
            error: "Claude Code is already installed. Sign in instead.",
          });
          return;
        }
        if (versionBoundaryState !== "below") {
          sendJson(res, 409, {
            ok: false,
            code: "RUNTIME_VERSION_INDETERMINATE",
            error:
              "CareerRat couldn't tell what version of Claude Code is installed. Check the install and try again.",
          });
          return;
        }
      }
      // Authorization only ever reaches here for a conclusive below-boundary
      // probe (or no existing installation at all). Still refuse to launch the
      // installer if the request already disconnected while we were deciding.
      if (closed || controller.signal.aborted) return;

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
          onStart(info) {
            startStream();
            // Real installer runs report the process-group leader's pid;
            // fakes/doubles used elsewhere in tests call onStart with no
            // argument, which correctly skips confirming a pid for a
            // process that was never actually spawned. The reservation
            // already exists (from before startGuidedSetupImpl was called
            // above); this only ever rewrites it, keyed to the same
            // generation, from pid-less to running.
            if (Number.isSafeInteger(info?.pid) && info.pid > 0) {
              confirmGuidedSetupOwnershipPid({
                repoRoot,
                env,
                platform,
                generation: ownedGeneration,
                pid: info.pid,
              });
            }
          },
          onOutput(message) {
            if (started) emit({ type: "output", message });
            else pendingOutput.push(message);
          },
        });
        startStream();
        emit({ type: "done", runtimeId });
      } catch (error) {
        if (error?.code === "RUNTIME_GUIDED_SETUP_STOP_UNCONFIRMED") lockRetained = true;
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
            error?.code === "RUNTIME_GUIDED_SETUP_STOP_UNCONFIRMED"
              ? "CareerRat could not confirm the Claude Code installer stopped. It may still be running."
              : error?.code === "RUNTIME_GUIDED_SETUP_CANCELLED"
                ? "Claude Code setup was cancelled."
                : "Claude Code did not finish installing. Check your connection and try again.",
        });
      } finally {
        clearInterval(heartbeat);
        if (started && !closed) res.end();
      }
    } finally {
      if (!lockRetained) {
        activeGuidedSetups.delete(runtimeId);
        clearGuidedSetupOwnership({ repoRoot, env, generation: ownedGeneration });
      }
      const tracked = activeGuidedSetupControllers.get(runtimeId);
      if (tracked?.controller === controller) activeGuidedSetupControllers.delete(runtimeId);
      resolveControllerDone();
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

  return { shutdownGuidedSetups };
}
