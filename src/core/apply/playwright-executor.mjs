import { loadAutomation, mayRun } from "../automation/consent.mjs";
import { profilePath, resolveSession } from "../automation/session.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { capturePacketQuestions } from "../packet/questions.mjs";
import {
  createApplyDriver,
  loadAnswerMap,
  renderedFieldsFromSnapshot,
  screenshotPath,
  uploadTargetsFromSnapshot,
} from "./apply-driver.mjs";
import { createPlaywrightOps } from "./playwright-ops.mjs";

export { renderedFieldsFromSnapshot, uploadTargetsFromSnapshot };

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
    data = loadAutomationImpl({ root: repoRoot }).data;
  } catch {
    data = {};
  }
  const { profileRoot } = resolveSession({ data, env });
  const profileDir = profilePath(PROFILE_PLATFORM, { profileRoot });

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
