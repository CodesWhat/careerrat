import { loadAutomation, mayRun } from "../automation/consent.mjs";
import { profilePath } from "../automation/session.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { capturePacketQuestions } from "../packet/questions.mjs";
import { createApplyDriver, loadAnswerMap, screenshotPath } from "./apply-driver.mjs";
import { createPlaywrightOps } from "./playwright-ops.mjs";

// The bundled-Playwright persistent profile isn't platform-specific the way
// scripts/capture-board-snapshot.mjs's per-board profiles are — one apply run
// can visit any ATS the candidate targets — so supervised apply sessions share
// a single persistent profile under this platform key.
const PROFILE_PLATFORM = "apply";

export function createPlaywrightApplyExecutor({
  repoRoot,
  env = process.env,
  loadAutomationImpl = loadAutomation,
  captureQuestionsImpl = capturePacketQuestions,
  candidateConfigGetImpl = candidateConfigGet,
  loadAnswerMapImpl = loadAnswerMap,
  mayRunImpl = mayRun,
  saveScreenshotImpl = screenshotPath,
  launchImpl,
  headless = false,
} = {}) {
  let data = {};
  try {
    data = loadAutomationImpl({ root: repoRoot, env }).data;
  } catch {
    data = {};
  }
  // This executor can be constructed regardless of which provider the automation
  // config names (createConfiguredApplyExecutor dispatches by provider, but this
  // factory is also called directly). resolveSession()'s profileRoot is only
  // populated when the configured provider is "playwright", so relying on it
  // would silently drop a custom session.profile_root under any other provider.
  // Read it straight off the loaded config instead; profilePath() already falls
  // back to the default root when given null.
  const profileDir = profilePath(PROFILE_PLATFORM, {
    profileRoot: data?.session?.profile_root || null,
  });

  const ops = createPlaywrightOps({ launchImpl, profileDir, headless });
  return createApplyDriver({
    ops,
    providerLabel: "playwright",
    repoRoot,
    env,
    captureQuestionsImpl,
    candidateConfigGetImpl,
    loadAnswerMapImpl,
    mayRunImpl,
    saveScreenshotImpl,
  });
}
