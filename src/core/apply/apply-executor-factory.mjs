import { loadAutomation } from "../automation/consent.mjs";
import { resolveSession } from "../automation/session.mjs";
import { createOrcaApplyExecutor } from "./orca-executor.mjs";

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
  if (provider !== "orca") return null;

  const execute = createOrcaApplyExecutor({ repoRoot, env, ...options });
  return async (input) => {
    try {
      return await execute(input);
    } catch (error) {
      return {
        available: false,
        verified: false,
        state: "unavailable",
        reason: `The Orca supervised browser is unavailable: ${String(
          error?.message || "browser command failed"
        ).slice(0, 300)}`,
      };
    }
  };
}
