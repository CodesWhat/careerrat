import { loadAutomation } from "../automation/consent.mjs";
import { automaticApplyGap, PROVIDERS, resolveSession } from "../automation/session.mjs";
import { createOrcaApplyExecutor } from "./orca-executor.mjs";
import { createPlaywrightApplyExecutor } from "./playwright-executor.mjs";

// The extension provider is agent-driven, turn-by-turn (session.mjs "deliberately
// drives NOTHING") — it has no callable surface for a headless script to run a
// form-fill against. Rather than leaving that gap to surface as a silent no-op or
// a raw error further up the stack, this factory hands back an executor that fails
// immediately and honestly. The reason text comes from the same core verdict the
// CLI uses (session.mjs#automaticApplyGap), so the two surfaces can't drift onto
// different explanations of the same gap.
function createExtensionApplyExecutor() {
  const reason =
    automaticApplyGap("extension")?.reason ??
    "The browser extension provider doesn't support automatic apply yet.";
  return async () => ({
    available: false,
    verified: false,
    state: "unavailable",
    reason,
  });
}

const EXECUTOR_FACTORIES = {
  extension: createExtensionApplyExecutor,
  orca: createOrcaApplyExecutor,
  playwright: createPlaywrightApplyExecutor,
};

export function createConfiguredApplyExecutor({
  repoRoot,
  env = process.env,
  loadAutomationImpl = loadAutomation,
  ...options
} = {}) {
  let provider = "extension";
  try {
    const data = loadAutomationImpl({ root: repoRoot, env }).data;
    provider = resolveSession({ data, env }).provider;
  } catch {
    return null;
  }
  const createExecutor = EXECUTOR_FACTORIES[provider];
  if (!createExecutor) return null;

  const execute = createExecutor({ repoRoot, env, loadAutomationImpl, ...options });
  return async (input) => {
    try {
      return await execute(input);
    } catch (error) {
      return {
        available: false,
        verified: false,
        state: "unavailable",
        reason: `The ${PROVIDERS[provider]?.label || provider} is unavailable: ${String(
          error?.message || "browser command failed"
        ).slice(0, 300)}`,
      };
    }
  };
}
