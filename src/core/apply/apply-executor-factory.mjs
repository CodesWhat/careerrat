import { loadAutomation } from "../automation/consent.mjs";
import { PROVIDERS, resolveSession } from "../automation/session.mjs";
import { createOrcaApplyExecutor } from "./orca-executor.mjs";
import { createPlaywrightApplyExecutor } from "./playwright-executor.mjs";

// The extension provider is agent-driven, turn-by-turn (session.mjs "deliberately
// drives NOTHING") — it has no callable surface for a headless script, so it stays
// a null/manual-handoff path here on purpose rather than a third executor.
const EXECUTOR_FACTORIES = {
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
