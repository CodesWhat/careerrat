import {
  detectInstalledRuntimes,
  hasCompleteCareerRatCapabilities,
  hasInstalledRuntimeCompletion,
  installedRuntimeCapabilities,
  isSupportedInstalledRuntime,
  probeInstalledRuntime,
  runtimeExecutionChainDigests,
} from "./installed-runtimes.mjs";
import {
  loadInstalledRuntimeSelection,
  writeInstalledRuntimeSelection,
} from "./runtime-selection.mjs";

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

// Exported so callers outside this route (e.g. scripts/qa-live-runtime-search.mjs)
// write the exact same cached-verification shape this route does, instead of
// hand-assembling a subset that omits fields the cache matcher requires
// (installedRuntimeCachedVerification and installedRuntimeBoundaryEvidenceCurrent
// both read versionBoundaryState/testedMinimumVersion — a verification missing
// them reads back as an untested boundary probe).
export function runtimeVerification(runtime) {
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
    // Best-effort, additive breakdown behind binaryFingerprint — see
    // runtime-selection.mjs's sanitizeChainFiles. Never gates anything
    // itself; it only lets a later mismatch name the specific launcher-chain
    // role that changed (Doctor's installedRuntimeExecutionMismatchRole)
    // instead of just reporting that the aggregate digest no longer
    // matches. null (never persisted) when the chain can't be re-resolved
    // right now, which the aggregate binaryFingerprint check above already
    // covers on its own.
    chainFiles: runtimeExecutionChainDigests(runtime.realPath) || null,
    capabilities: runtime.capabilities,
    versionBoundaryState: runtime.versionBoundaryState || "indeterminate",
    // The policy floor this boundary state was actually tested against, so a
    // reader can tell a cached "at_or_above" apart from one tested before
    // CareerRat raised the minimum. null for a runtime with no boundary
    // policy (e.g. codex).
    testedMinimumVersion: runtime.minimumVersion || null,
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
