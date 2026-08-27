import { createHash } from "node:crypto";

import {
  captureWorkspaceIntake,
  executeWorkspaceIntent,
  previewWorkspaceIntent,
  runWorkspaceAgentTurn,
} from "../core/agent/workspace-agent.mjs";
import {
  normalizeWorkspaceIntent,
  WORKSPACE_THREAD_ID,
  workspaceThreadOpen,
} from "../core/agent/workspace-thread.mjs";
import { loadAIPreferences } from "../core/ai/ai-preferences.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { aiRuntimeIdForRoute, resolveAIExecutionPlan } from "../core/ai/operation-policy.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const CONFLICT_CODES = new Set([
  "COMMUNICATION_DRAFT_PLACEHOLDER",
  "STRATEGY_APPLY_STALE",
  "JOB_BODY_REQUIRES_BROWSER",
  "JOB_CAPTURE_FAILED",
  "JOB_REFERENCE_AMBIGUOUS",
  "COMMUNICATION_REFERENCE_AMBIGUOUS",
  "APPLICATION_NOT_VERIFIED",
  "COMPANY_AMBIGUOUS",
  "COMPANY_NOT_TRACKED",
  "COMMUNICATION_DRAFT_REQUIRED",
  "COMMUNICATION_EXECUTOR_UNAVAILABLE",
  "COMMUNICATION_NOT_DRAFTABLE",
  "COMMUNICATION_NOT_VERIFIED",
  "COMMUNICATION_CHANNEL_UNSUPPORTED",
  "INTAKE_CONFIRMATION_REQUIRED",
  "EVALUATION_APPLICATION_REQUIRED",
  "BAD_PACKET_ARTIFACT",
  "NEEDS_USER",
  "ANSWER_CONFIRMATION_NOT_FOUND",
  "ANSWER_CONFIRMATION_AMBIGUOUS",
  "STATUS_TRANSITION_STALE",
  "APPLICATION_MISSION_ATTEMPT_REQUIRED",
  "APPLICATION_MISSION_ATTEMPT_STALE",
]);

function statusForError(error) {
  const explicitStatus = Number(error?.status);
  if (new Set([400, 404, 409, 422, 501, 502]).has(explicitStatus)) return explicitStatus;
  if (error?.code === "APP_OPERATION_MANAGER_STOPPED") return 503;
  if (error?.code === "NO_DATABASE") return 409;
  if (error?.code === "NOT_FOUND") return 404;
  if (error?.code === "JOB_REFERENCE_NOT_FOUND") return 404;
  if (error?.code === "COMMUNICATION_REFERENCE_NOT_FOUND") return 404;
  if (error?.code === "COMPANY_NOT_FOUND") return 404;
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
      "BAD_LINKEDIN_PROPOSAL_ACTION",
      "LINKEDIN_PROPOSAL_COMP_LEAK",
      "EMPTY_COMMUNICATION_NOTE",
      "INTERVIEW_APPLICATION_REQUIRED",
      "TEXT_TOO_LONG",
      "BAD_REQUESTED_ACTION",
      "BAD_REQUEST",
      "QUESTION_REQUIRED",
      "NON_DURABLE_ANSWER",
      "UNSUPPORTED_INTENT",
      "RESEARCH_COMP_INPUT_REQUIRED",
      "RESEARCH_RECORD_TYPE_REQUIRED",
      "RESEARCH_RECORD_MARKDOWN_REQUIRED",
      "RESEARCH_RECORD_NAME_REQUIRED",
      "RESEARCH_RECORD_INVALID",
      "BAD_COMPANY_HEALTH",
      "BAD_HEALTH_RATING",
      "BAD_HEALTH_PROVENANCE",
      "BAD_HEALTH_FUNCTION",
      "BAD_HEALTH_AS_OF",
      "BAD_HEALTH_RATIONALE",
      "BAD_HEALTH_DIMENSIONS",
      "BAD_HEALTH_CROSS_CUT",
      "BAD_HEALTH_SIGNALS",
      "BAD_HEALTH_FIT_DELTA",
      "HEALTH_COMP_LEAK",
      "COMMUNICATION_COMP_LEAK",
      "HEALTH_RECORD_INVALID",
      "STRATEGY_APPLY_UNSUPPORTED",
      "STRATEGY_APPLY_INVALID",
      "SETTINGS_CHANGE_UNSUPPORTED",
      "SETTINGS_CHANGE_INVALID",
      "ISSUE_REPORT_COMP_LEAK",
      "ISSUE_URL_INVALID",
      "CALENDAR_WRITE_PROVIDER_INVALID",
      "CALENDAR_WRITE_EVENT_UNRESOLVED",
      "CALENDAR_WRITE_NOT_ALLOWED",
      "RELATIONSHIP_LEAD_INVALID",
      "RELATIONSHIP_LEAD_COMP_LEAK",
      "RELATIONSHIP_LEAD_COMPANY_UNTRACKED",
      "RELATIONSHIP_SOURCING_COMPANY_REQUIRED",
      "RELATIONSHIP_SOURCING_NOT_ALLOWED",
      "STATUS_SYNC_NOT_ALLOWED",
      "STATUS_PORTAL_URL_INVALID",
      "STATUS_PORTAL_UNSUPPORTED",
      "MAIL_SYNC_NOT_ALLOWED",
      "MESSAGES_SYNC_NOT_ALLOWED",
      "STATUS_UPDATE_INVALID",
      "STATUS_UPDATE_COMP_LEAK",
      "STATUS_APPLY_INVALID",
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

function jsonObject(value, field) {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    const error = new Error(`${field} must be an object`);
    error.code = "BAD_REQUEST";
    throw error;
  }
  return JSON.parse(JSON.stringify(value));
}

function exactInput(input, allowed, label) {
  const value = jsonObject(input, label);
  if (!value) {
    const error = new Error(`${label} is required`);
    error.code = "BAD_REQUEST";
    throw error;
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    const error = new Error(`${label} contains unsupported fields`);
    error.code = "BAD_REQUEST";
    throw error;
  }
  return value;
}

function requestId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._:-]{7,159}$/i.test(id)) {
    const error = new Error("requestId must identify one composer submission");
    error.code = "BAD_REQUEST";
    throw error;
  }
  return id;
}

function operationMessageIds(kind, id) {
  const digest = createHash("sha256").update(`${kind}:${id}`).digest("hex").slice(0, 32);
  return {
    userMessageId: `workspace-operation-user-${digest}`,
    resultMessageId: `workspace-operation-result-${digest}`,
  };
}

function parseWorkspaceMessageRequest(input) {
  const body = exactInput(input, ["text", "context", "choice", "requestId"], "workspace message");
  const text = String(body.text || "").trim();
  if (!text) {
    const error = new Error("message text is required");
    error.code = "EMPTY_TEXT";
    throw error;
  }
  const id = requestId(body.requestId);
  return {
    requestId: id,
    text,
    ...(body.context ? { context: jsonObject(body.context, "context") } : {}),
    ...(body.choice ? { choice: jsonObject(body.choice, "choice") } : {}),
    ...operationMessageIds("workspace.message", id),
  };
}

function parseWorkspaceIntentRequest(input) {
  const body = exactInput(input, ["intent", "requestId"], "workspace intent");
  const id = requestId(body.requestId);
  return {
    requestId: id,
    intent: normalizeWorkspaceIntent(body.intent),
    ...operationMessageIds("workspace.intent", id),
  };
}

function workspaceIntentPlanOperations(type) {
  if (new Set(["source.discover", "company.discover"]).has(type)) return [];
  if (new Set(["job.evaluate", "job.evaluate-request"]).has(type)) {
    return ["application.judgment"];
  }
  if (new Set(["job.generate-documents", "job.tailor-request", "screening.answer"]).has(type)) {
    return ["application.drafting"];
  }
  if (new Set(["job.prepare-request", "job.prepare-submit", "job.apply"]).has(type)) {
    return ["application.judgment", "application.drafting"];
  }
  if (new Set(["communication.draft", "scheduling.prepare"]).has(type)) {
    return ["communication.drafting"];
  }
  if (new Set(["coaching.plan", "strategy.review"]).has(type)) return ["coach.deep"];
  if (
    /^(?:research\.|company\.health|relationship\.|status\.|mail\.|messages\.|linkedin\.)/.test(
      type
    )
  ) {
    return ["research.web"];
  }
  return [];
}

function selectedExecutionPlans({ repoRoot, env, operations }) {
  if (!operations.length) return null;
  const route = resolveAIRoute(env, { repoRoot });
  const runtimeId = aiRuntimeIdForRoute(route);
  if (!runtimeId) {
    const error = new Error(route.error || "Select a ready AI CLI before starting this work.");
    error.code = "NO_AI_ROUTE";
    throw error;
  }
  const preferences = loadAIPreferences({ repoRoot, env });
  const plans = Object.fromEntries(
    operations.map((operation) => [
      operation,
      resolveAIExecutionPlan({ operation, runtimeId, preferences }),
    ])
  );
  return operations.length === 1
    ? plans[operations[0]]
    : { version: 1, runtimeId, operations: plans };
}

function resultReference(result, request) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const message = messages.find((candidate) => candidate?.id === request.resultMessageId);
  return {
    type: "workspace-message",
    id: message?.id || request.resultMessageId,
    threadId: WORKSPACE_THREAD_ID,
    ...(result?.operationResult === undefined ? {} : { data: result.operationResult }),
    ...(message
      ? {
          message: {
            text: message.text || "",
            artifacts: Array.isArray(message.artifacts) ? message.artifacts : [],
            metadata: message.metadata || {},
          },
        }
      : {}),
  };
}

export const WORKSPACE_MESSAGE_OPERATION_KIND = "workspace.message";
export const WORKSPACE_INTENT_OPERATION_KIND = "workspace.intent";

export async function executeDurableWorkspaceIntent({ appOperations, requestId, intent } = {}) {
  if (!appOperations?.start) {
    const error = new Error("Workspace operations are not available yet. Restart CareerRat.");
    error.code = "APP_OPERATION_MANAGER_STOPPED";
    throw error;
  }
  const started = await appOperations.start({
    kind: WORKSPACE_INTENT_OPERATION_KIND,
    input: { requestId, intent },
  });
  const operation = ["queued", "running"].includes(started.operation.status)
    ? await appOperations.wait(started.operation.id)
    : started.operation;
  if (operation.status === "failed") {
    const error = new Error(
      operation.error?.message || "CareerRat couldn't finish that action. Try again."
    );
    error.code = operation.error?.code || "APP_OPERATION_FAILED";
    error.retryable = operation.error?.retryable !== false;
    throw error;
  }
  if (operation.status !== "completed") {
    const error = new Error("CareerRat could not confirm that action finished.");
    error.code = "APP_OPERATION_INCOMPLETE";
    error.retryable = false;
    throw error;
  }
  return operation;
}

function workspaceOperationError(error, kind) {
  const code = String(error?.code || "WORKSPACE_AGENT_ERROR").slice(0, 128);
  const messages = {
    JOB_REFERENCE_AMBIGUOUS:
      "I found more than one matching job. Open the job you mean and try that action again.",
    JOB_REFERENCE_NOT_FOUND:
      "I couldn't find that job. Open it in Jobs or paste its link, then try again.",
    COMMUNICATION_REFERENCE_AMBIGUOUS:
      "I found more than one matching conversation. Open the one you mean and try again.",
    COMMUNICATION_REFERENCE_NOT_FOUND:
      "I couldn't find that conversation. Open it from the job first, then try again.",
    COMPANY_AMBIGUOUS:
      "I found more than one matching company. Open the company or job you mean and try again.",
    COMPANY_NOT_FOUND: "I couldn't identify that company. Name it directly and try again.",
    APPLICATION_MISSION_ATTEMPT_REQUIRED:
      "This application must continue through its supervised application run. Resume it from Needs You.",
    APPLICATION_MISSION_ATTEMPT_STALE:
      "That application run is no longer current. Resume the latest run from Needs You.",
    NO_AI_ROUTE: "Choose a ready AI provider in Settings, then try again.",
    SDK_NOT_INSTALLED:
      "The selected AI provider isn't ready yet. Finish its setup, then try again.",
  };
  return {
    code,
    message:
      messages[code] ||
      (kind === WORKSPACE_MESSAGE_OPERATION_KIND
        ? "CareerRat couldn't finish that reply. Your message is saved, so you can try again."
        : "CareerRat couldn't finish that action. Nothing else was changed, so you can try again."),
    retryable: error?.retryable !== false,
  };
}

export function createWorkspaceOperationKinds({
  repoRoot,
  env = process.env,
  runTurnImpl = runWorkspaceAgentTurn,
  executeIntentImpl = executeWorkspaceIntent,
  resolveExecutionPlanImpl,
  startCompanyDiscoveryOperationImpl,
} = {}) {
  const resolvePlans =
    resolveExecutionPlanImpl ||
    (({ operations }) => selectedExecutionPlans({ repoRoot, env, operations }));
  return {
    [WORKSPACE_MESSAGE_OPERATION_KIND]: {
      parseRequest: parseWorkspaceMessageRequest,
      resumeOnRestart: true,
      normalizeError: (error) => workspaceOperationError(error, WORKSPACE_MESSAGE_OPERATION_KIND),
      resolveExecutionPlan: ({ request }) =>
        resolvePlans({ operations: ["paul.conversation"], request }),
      async execute({ operation, request, executionPlan, signal }) {
        const result = await runTurnImpl({
          repoRoot,
          env,
          text: request.text,
          context: request.context,
          choice: request.choice,
          userMessageId: request.userMessageId,
          resultMessageId: request.resultMessageId,
          operationAttempt: {
            id: operation.id,
            ownerId: operation.ownerId,
            fence: operation.fence,
          },
          executionPlan,
          signal,
          startCompanyDiscoveryOperationImpl,
        });
        return { resultRef: resultReference(result, request) };
      },
    },
    [WORKSPACE_INTENT_OPERATION_KIND]: {
      parseRequest: parseWorkspaceIntentRequest,
      normalizeError: (error) => workspaceOperationError(error, WORKSPACE_INTENT_OPERATION_KIND),
      resolveExecutionPlan: ({ request }) =>
        resolvePlans({ operations: workspaceIntentPlanOperations(request.intent.type), request }),
      recoveryError: {
        code: "APP_OPERATION_OUTCOME_UNCERTAIN",
        message:
          "CareerRat restarted while that action was running. Check whether it finished before trying it again.",
        retryable: false,
      },
      async execute({ operation, request, executionPlan, signal }) {
        const result = await executeIntentImpl({
          repoRoot,
          env,
          intent: request.intent,
          intentMessageId: request.userMessageId,
          resultMessageId: request.resultMessageId,
          operationAttempt: {
            id: operation.id,
            ownerId: operation.ownerId,
            fence: operation.fence,
          },
          executionPlan,
          signal,
          startCompanyDiscoveryOperationImpl,
        });
        return { resultRef: resultReference(result, request) };
      },
    },
  };
}

function operationView(operation) {
  if (!operation) return null;
  const { request: _request, ownerId: _ownerId, fence: _fence, ...visible } = operation;
  return visible;
}

export function mountWorkspaceAgentRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  captureIntakeImpl = captureWorkspaceIntake,
  previewIntentImpl = previewWorkspaceIntent,
  appOperations,
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
      if (!appOperations?.start) {
        const error = new Error("Workspace operations are not available yet. Restart CareerRat.");
        error.code = "APP_OPERATION_MANAGER_STOPPED";
        throw error;
      }
      const started = await appOperations.start({
        kind: WORKSPACE_MESSAGE_OPERATION_KIND,
        input: body,
      });
      const active = ["queued", "running"].includes(started.operation.status);
      sendJson(res, active ? 202 : 200, {
        ok: true,
        reused: started.reused,
        operation: operationView(started.operation),
      });
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
      if (!appOperations?.start) {
        const error = new Error("Workspace operations are not available yet. Restart CareerRat.");
        error.code = "APP_OPERATION_MANAGER_STOPPED";
        throw error;
      }
      const started = await appOperations.start({
        kind: WORKSPACE_INTENT_OPERATION_KIND,
        input: body,
      });
      const active = ["queued", "running"].includes(started.operation.status);
      sendJson(res, active ? 202 : 200, {
        ok: true,
        reused: started.reused,
        operation: operationView(started.operation),
      });
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
