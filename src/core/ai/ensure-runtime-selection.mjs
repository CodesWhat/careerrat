import { resolveAIRoute } from "./call-ai.mjs";
import { loadInstalledRuntimeSelection } from "./runtime-selection.mjs";

// A search started from the terminal never visits the app's AI Settings, so no
// installed AI program was ever selected and every AI step quietly found "no
// route". If nothing else gives this workspace an AI route, look for an
// installed, signed-in CLI and select it the way the app does (exactly one
// ready CLI is selected; two or more still need a person to choose).
// Returns { selected, reason }: `selected` is the runtime id now in use or null,
// `reason` says in plain words why there isn't one.
export async function ensureInstalledRuntimeSelection({
  repoRoot,
  env = process.env,
  inspectImpl,
} = {}) {
  const selection = loadInstalledRuntimeSelection({ repoRoot, env });
  if (selection.runtimeId) return { selected: selection.runtimeId, reason: null };
  if (selection.providerFallback) return { selected: null, reason: null };
  if (resolveAIRoute(env, { repoRoot }).type !== "none") return { selected: null, reason: null };

  const inspect =
    inspectImpl ??
    (await import("../../cli/installed-runtime-route.mjs")).inspectInstalledRuntimeState;
  let state;
  try {
    state = await inspect({ repoRoot, env });
  } catch (error) {
    return {
      selected: null,
      reason: `Could not check for an installed AI program: ${error?.message || "unknown error"}`,
    };
  }
  if (state.selectedId) return { selected: state.selectedId, reason: null };
  const ready = (state.runtimes || []).filter((runtime) => runtime.selectable);
  if (ready.length > 1) {
    return {
      selected: null,
      reason: `More than one AI program is ready (${ready.map((runtime) => runtime.id).join(", ")}). Pick one in the CareerRat app's AI settings.`,
    };
  }
  return {
    selected: null,
    reason:
      "No signed-in Claude or Codex was found. Sign in to one of them, then run the search again.",
  };
}
