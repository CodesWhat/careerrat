import { loadAutomation } from "../automation/consent.mjs";
import { PROVIDERS, resolveSession } from "../automation/session.mjs";
import { createOrcaApplyExecutor } from "./orca-executor.mjs";
import { createPlaywrightApplyExecutor } from "./playwright-executor.mjs";

// The extension provider is agent-driven, turn-by-turn (session.mjs "deliberately
// drives NOTHING") — it has no callable surface for a headless script to run a
// form-fill against. Rather than leaving that gap to surface as a silent no-op or
// a raw error further up the stack, this factory hands back an executor that fails
// immediately and honestly, naming the real state and the working alternative.
const EXTENSION_NOT_AVAILABLE_REASON =
  "The browser extension provider doesn't support automatic apply yet. Switch to the Playwright provider (`careerrat automation session playwright --write`) for supervised apply.";

function createExtensionApplyExecutor() {
  return async () => ({
    available: false,
    verified: false,
    state: "unavailable",
    reason: EXTENSION_NOT_AVAILABLE_REASON,
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
    const data = loadAutomationImpl({ root: repoRoot }).data;
    provider = resolveSession({ data, env }).provider;
  } catch {
    return null;
  }
  const createExecutor = EXECUTOR_FACTORIES[provider];
  if (!createExecutor) return null;

  const execute = createExecutor({ repoRoot, env, ...options });
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
