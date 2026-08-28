import { loadAutomation } from "../automation/consent.mjs";
import { automaticApplyGap, PROVIDERS, resolveSession } from "../automation/session.mjs";
import { throwIfAborted } from "./cancellation.mjs";
import { createPlaywrightApplyExecutor } from "./playwright-executor.mjs";

// Providers without a trustworthy scripted-apply surface fail immediately and
// honestly here: the extension is agent-driven only, while Orca cannot intercept
// each outbound browser request before it leaves. The reason text comes from the
// same core verdict the CLI uses (session.mjs#automaticApplyGap), so the two
// surfaces can't drift onto different explanations of the same gap.
function createUnavailableApplyExecutor(provider) {
  const reason =
    automaticApplyGap(provider)?.reason ??
    `The ${PROVIDERS[provider]?.label || provider} provider doesn't support automatic apply yet.`;
  return async () => ({
    available: false,
    verified: false,
    state: "unavailable",
    reason,
  });
}

function createExtensionApplyExecutor() {
  return createUnavailableApplyExecutor("extension");
}

function createOrcaApplyExecutor() {
  return createUnavailableApplyExecutor("orca");
}

const EXECUTOR_FACTORIES = {
  extension: createExtensionApplyExecutor,
  orca: createOrcaApplyExecutor,
  playwright: createPlaywrightApplyExecutor,
};

function browserFailureReason(provider, error) {
  const providerLabel = PROVIDERS[provider]?.label || provider;
  const detail = String(error?.message || "browser command failed").slice(0, 300);
  const exposesInternals =
    /command failed|careerrat automation|authenticated_[a-z_]+|(?:^|\s)--[a-z]|(?:^|\s)@[a-z0-9]|(?:^|\s)spawn\s|node_modules|\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+/i.test(
      detail
    );
  if (exposesInternals) {
    return `The ${providerLabel} couldn't open the application. Check Browser automation in Settings and try again.`;
  }
  return `The ${providerLabel} is unavailable: ${detail}`;
}

export function createConfiguredApplyExecutor({
  repoRoot,
  env = process.env,
  loadAutomationImpl = loadAutomation,
  ...options
} = {}) {
  let provider = "extension";
  try {
    const data = loadAutomationImpl({ root: repoRoot, env }).data;
    provider = resolveSession({ data, repoRoot, env }).provider;
  } catch {
    return null;
  }
  const createExecutor = EXECUTOR_FACTORIES[provider];
  if (!createExecutor) return null;

  const execute = createExecutor({ repoRoot, env, loadAutomationImpl, ...options });
  return async (input) => {
    throwIfAborted(input?.signal);
    try {
      const result = await execute(input);
      throwIfAborted(input?.signal);
      return result;
    } catch (error) {
      throwIfAborted(input?.signal);
      return {
        available: false,
        verified: false,
        state: "unavailable",
        reason: browserFailureReason(provider, error),
      };
    }
  };
}
