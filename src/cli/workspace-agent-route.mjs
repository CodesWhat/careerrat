import {
  captureWorkspaceIntake,
  executeWorkspaceIntent,
  previewWorkspaceIntent,
  runWorkspaceAgentTurn,
} from "../core/agent/workspace-agent.mjs";
import { workspaceThreadOpen } from "../core/agent/workspace-thread.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const CONFLICT_CODES = new Set([
  "JOB_BODY_REQUIRES_BROWSER",
  "JOB_CAPTURE_FAILED",
  "JOB_REFERENCE_AMBIGUOUS",
  "COMMUNICATION_REFERENCE_AMBIGUOUS",
  "APPLICATION_NOT_VERIFIED",
  "COMMUNICATION_DRAFT_REQUIRED",
  "COMMUNICATION_EXECUTOR_UNAVAILABLE",
  "COMMUNICATION_NOT_DRAFTABLE",
  "COMMUNICATION_NOT_VERIFIED",
  "INTAKE_CONFIRMATION_REQUIRED",
  "EVALUATION_APPLICATION_REQUIRED",
  "BAD_PACKET_ARTIFACT",
  "NEEDS_USER",
]);

function statusForError(error) {
  const explicitStatus = Number(error?.status);
  if (new Set([400, 404, 409, 422, 501, 502]).has(explicitStatus)) return explicitStatus;
  if (error?.code === "NO_DATABASE") return 409;
  if (error?.code === "NOT_FOUND") return 404;
  if (error?.code === "JOB_REFERENCE_NOT_FOUND") return 404;
  if (error?.code === "COMMUNICATION_REFERENCE_NOT_FOUND") return 404;
  if (error?.code === "MISSING_JOB_BODY") return 409;
  if (CONFLICT_CODES.has(error?.code)) return 409;
  if (error?.code === "CONFLICT") return 409;
  if (error?.code === "VALIDATION_FAILED") return 422;
  if (new Set(["NO_AI_ROUTE", "SDK_NOT_INSTALLED"]).has(error?.code)) return 501;
  if (
    [
      "BAD_DATE",
      "BAD_APPLIED_AT",
      "BAD_SENT_AT",
      "BAD_JSON",
      "BAD_KIND",
      "BAD_ROLE",
      "BAD_INTENT_ENTITY",
      "JOB_URL_REQUIRED",
      "JOB_IDENTITY_REQUIRED",
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
      "BAD_QUESTION_CAPTURE",
      "BAD_COMPANY_PROPOSAL_ACTION",
      "EMPTY_COMMUNICATION_NOTE",
      "INTERVIEW_APPLICATION_REQUIRED",
      "TEXT_TOO_LONG",
      "BAD_REQUESTED_ACTION",
      "BAD_REQUEST",
      "QUESTION_REQUIRED",
      "NON_DURABLE_ANSWER",
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
    ...(error?.details ? { details: error.details } : {}),
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
      const data = previewIntentImpl({ repoRoot, env, text: body?.text, context: body?.context });
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
        requestedAction: body?.requestedAction,
      });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      sendError(res, error);
    }
  });
}
