import {
  captureWorkspaceIntake,
  executeWorkspaceIntent,
  previewWorkspaceIntent,
  runWorkspaceAgentTurn,
} from "../core/agent/workspace-agent.mjs";
import { workspaceThreadOpen } from "../core/agent/workspace-thread.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

function statusForError(error) {
  if (error?.code === "NO_DATABASE") return 409;
  if (error?.code === "NOT_FOUND") return 404;
  if (error?.code === "MISSING_JOB_BODY") return 409;
  if (
    error?.code === "APPLICATION_EXECUTOR_UNAVAILABLE" ||
    error?.code === "APPLICATION_NOT_VERIFIED" ||
    error?.code === "COMMUNICATION_DRAFT_REQUIRED" ||
    error?.code === "COMMUNICATION_EXECUTOR_UNAVAILABLE" ||
    error?.code === "COMMUNICATION_NOT_DRAFTABLE" ||
    error?.code === "COMMUNICATION_NOT_VERIFIED" ||
    error?.code === "INTAKE_CONFIRMATION_REQUIRED" ||
    error?.code === "EVALUATION_APPLICATION_REQUIRED"
  )
    return 409;
  if (
    [
      "BAD_DATE",
      "BAD_APPLIED_AT",
      "BAD_SENT_AT",
      "BAD_JSON",
      "BAD_KIND",
      "BAD_ROLE",
      "BAD_INTENT_ENTITY",
      "EMPTY_TEXT",
      "INTENT_NOT_IMPLEMENTED",
      "EMPTY_AI_RESPONSE",
      "EMPTY_INTAKE",
      "BAD_INTAKE_KIND",
      "BAD_COMMUNICATION_INTAKE",
      "BAD_INTERVIEW_INTAKE",
      "BAD_COMM_ARTIFACT",
      "BAD_COMM_CHANNEL",
      "COMMUNICATION_IDENTITY_REQUIRED",
      "BAD_OUTCOME_STATUS",
      "BAD_INTERVIEW_AT",
      "BAD_INTERVIEW_ARTIFACT",
      "EMPTY_COMMUNICATION_NOTE",
      "INTERVIEW_APPLICATION_REQUIRED",
      "TEXT_TOO_LONG",
      "UNSUPPORTED_INTENT",
    ].includes(error?.code)
  ) {
    return 400;
  }
  return 500;
}

function sendError(res, error) {
  sendJson(res, statusForError(error), {
    ok: false,
    code: error?.code || "WORKSPACE_AGENT_ERROR",
    error: { message: error?.message || "Workspace agent request failed" },
    threadId: error?.workspaceThreadId,
  });
}

export function mountWorkspaceAgentRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  executeIntentImpl = executeWorkspaceIntent,
  runTurnImpl = runWorkspaceAgentTurn,
  captureIntakeImpl = captureWorkspaceIntake,
  previewIntentImpl = previewWorkspaceIntent,
} = {}) {
  addRoute("GET", "/api/workspace/thread", (_req, res) => {
    try {
      sendJson(res, 200, { ok: true, data: workspaceThreadOpen({ repoRoot, env }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  addRoute("POST", "/api/workspace/message", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const data = await runTurnImpl({ repoRoot, env, text: body?.text });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Ask bar preview — classify only, never executes and never writes to the
  // thread (see previewWorkspaceIntent's own header comment). Synchronous and
  // side-effect free, so this never awaits anything the way every other
  // handler here does.
  addRoute("POST", "/api/workspace/preview", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const data = previewIntentImpl({ repoRoot, env, text: body?.text });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      sendError(res, error);
    }
  });

  addRoute("POST", "/api/workspace/intent", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const data = await executeIntentImpl({ repoRoot, env, intent: body?.intent });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      sendError(res, error);
    }
  });

  addRoute("POST", "/api/workspace/intake", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const data = await captureIntakeImpl({
        repoRoot,
        env,
        text: body?.text,
        inputKind: body?.inputKind,
      });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      sendError(res, error);
    }
  });
}
