import { mayRun } from "../automation/consent.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { capturePacketQuestions } from "../packet/questions.mjs";
import {
  createApplyDriver,
  loadAnswerMap,
  renderedFieldsFromSnapshot,
  screenshotPath,
  uploadTargetsFromSnapshot,
} from "./apply-driver.mjs";
import { createOrcaOps, runOrcaCommand } from "./orca-ops.mjs";

export { renderedFieldsFromSnapshot, uploadTargetsFromSnapshot };

export function createOrcaApplyExecutor({
  repoRoot,
  env = process.env,
  runOrcaImpl = (args, { signal } = {}) => runOrcaCommand(args, { env, cwd: repoRoot, signal }),
  captureQuestionsImpl = capturePacketQuestions,
  candidateConfigGetImpl = candidateConfigGet,
  loadAnswerMapImpl = loadAnswerMap,
  mayRunImpl = mayRun,
  saveScreenshotImpl = screenshotPath,
} = {}) {
  const ops = createOrcaOps({ runOrcaImpl });
  return createApplyDriver({
    ops,
    providerLabel: "orca",
    repoRoot,
    env,
    captureQuestionsImpl,
    candidateConfigGetImpl,
    loadAnswerMapImpl,
    mayRunImpl,
    saveScreenshotImpl,
  });
}
