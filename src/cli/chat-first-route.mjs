import { createHash } from "node:crypto";
import { executeWorkspaceIntent } from "../core/agent/workspace-agent.mjs";
import { loadAIPreferences } from "../core/ai/ai-preferences.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { aiRuntimeIdForRoute, resolveAIExecutionPlan } from "../core/ai/operation-policy.mjs";
import {
  chatFirstChoiceResolve,
  deepIngestPromptDismiss,
  deepIngestThreadOpen,
  jobThreadMessageAppend,
  jobThreadSetArchived,
  jobThreadSetPinned,
  jobThreadTurn,
  missionCreateForJobs,
  missionResume,
  missionRun,
  missionSetStatus,
  mockInterviewEnd,
  mockInterviewFeedbackAppend,
  mockInterviewMessageAppend,
  mockInterviewStartWithAI,
  mockInterviewTurn,
  sourcedDecisionSet,
  touchDueDismiss,
} from "../core/db/verbs.mjs";
import { exportInterviewDossierPdf } from "../core/documents/dossier-pdf.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
export const JOB_THREAD_TURN_OPERATION_KIND = "job-thread.turn";

function selectedMissionExecutionPlan({ repoRoot, env, operation }) {
  const route = resolveAIRoute(env, { repoRoot });
  const runtimeId = aiRuntimeIdForRoute(route);
  if (!runtimeId) {
    const error = new Error(route.error || "Select a ready AI CLI before starting this mission.");
    error.code = "NO_AI_ROUTE";
    throw error;
  }
  return resolveAIExecutionPlan({
    operation,
    runtimeId,
    preferences: loadAIPreferences({ repoRoot, env }),
    ...(route.type === "installed" ? { installedRuntime: route.runtime } : {}),
  });
}

function statusForError(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (error?.code === "NO_DATABASE") return 409;
  if (error?.code === "NOT_FOUND") return 404;
  if (error?.code === "CONFLICT") return 409;
  if (["STALE_CHOICE_PROMPT", "CHOICE_ALREADY_RESOLVED"].includes(error?.code)) return 409;
  if (error?.code === "TEXT_TOO_LONG") return 400;
  return 400;
}

function sendError(res, error) {
  sendJson(res, statusForError(error), {
    ok: false,
    code: error?.code || "BAD_REQUEST",
    error: error?.message || String(error),
    ...(error?.persistedMessage ? { data: { message: error.persistedMessage } } : {}),
  });
}

function sendResult(res, status, result) {
  const {
    ok: operationOk = true,
    meta = null,
    event: _event,
    exported: _exported,
    ...data
  } = result || {};
  sendJson(res, status, { ok: operationOk, meta, data });
}

function operationView(operation) {
  if (!operation) return null;
  const { request: _request, ownerId: _ownerId, fence: _fence, ...visible } = operation;
  return visible;
}

function jobThreadRequestId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._:-]{7,159}$/i.test(id)) {
    const error = new Error("requestId must identify one job-thread submission");
    error.code = "BAD_REQUEST";
    throw error;
  }
  return id;
}

function parseJobThreadTurnRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("job-thread turn must be an object");
    error.code = "BAD_REQUEST";
    throw error;
  }
  if (
    Object.keys(input).some(
      (key) => !["applicationId", "text", "choice", "requestId"].includes(key)
    )
  ) {
    const error = new Error("job-thread turn contains unsupported fields");
    error.code = "BAD_REQUEST";
    throw error;
  }
  const applicationId = String(input.applicationId || "").trim();
  const text = String(input.text || "").trim();
  if (!applicationId || !text) {
    const error = new Error("applicationId and text are required");
    error.code = "BAD_REQUEST";
    throw error;
  }
  const requestId = jobThreadRequestId(input.requestId);
  let choice;
  if (input.choice !== undefined) {
    try {
      choice = JSON.parse(JSON.stringify(input.choice));
    } catch {
      const error = new Error("choice must be valid JSON");
      error.code = "BAD_REQUEST";
      throw error;
    }
  }
  const digest = createHash("sha256")
    .update(`job-thread.turn:${requestId}`)
    .digest("hex")
    .slice(0, 32);
  return {
    requestId,
    applicationId,
    text,
    ...(choice === undefined ? {} : { choice }),
    userMessageId: `job-thread-operation-user-${digest}`,
    assistantMessageId: `job-thread-operation-assistant-${digest}`,
  };
}

export function createChatFirstOperationKinds({
  repoRoot,
  env = process.env,
  resolveExecutionPlan = selectedMissionExecutionPlan,
  callAIImpl,
} = {}) {
  return {
    [JOB_THREAD_TURN_OPERATION_KIND]: {
      parseRequest: parseJobThreadTurnRequest,
      resumeOnRestart: true,
      resolveExecutionPlan: ({ request }) =>
        resolveExecutionPlan({ repoRoot, env, operation: "paul.conversation", request }),
      normalizeError(error) {
        return {
          code: String(error?.code || "JOB_THREAD_TURN_FAILED"),
          message:
            error?.code === "NO_AI_ROUTE"
              ? "Choose a ready AI provider in Settings, then try again."
              : "CareerRat couldn't finish that reply. Your message is saved, so you can try again.",
          retryable: error?.retryable !== false,
        };
      },
      async execute({ operation, request, executionPlan, signal }) {
        const result = await jobThreadTurn({
          repoRoot,
          env,
          applicationId: request.applicationId,
          text: request.text,
          choice: request.choice,
          userMessageId: request.userMessageId,
          assistantMessageId: request.assistantMessageId,
          executionPlan,
          call: callAIImpl,
          signal,
          operationAttempt: {
            id: operation.id,
            ownerId: operation.ownerId,
            fence: operation.fence,
          },
        });
        return {
          resultRef: {
            type: "job-thread-message",
            id: result.assistantMessage.id,
            threadId: result.thread.id,
          },
        };
      },
    },
  };
}

function safeDownloadName(value) {
  const name = String(value || "interview-dossier.pdf")
    .replace(/["\r\n\\/]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 180);
  return name.toLowerCase().endsWith(".pdf") ? name : "interview-dossier.pdf";
}

async function withBody(req, res, run, { status = 200 } = {}) {
  let body;
  try {
    body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
  } catch (error) {
    sendJson(res, error.status || 400, { ok: false, code: "BAD_JSON", error: error.message });
    return;
  }
  try {
    const result = await run(body || {});
    sendResult(res, status, result);
  } catch (error) {
    sendError(res, error);
  }
}

export function mountChatFirstRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  workspaceAgentRuntime,
  executeMissionIntent,
  resolveMissionExecutionPlan = selectedMissionExecutionPlan,
  callAIImpl,
  appOperations,
  exportInterviewDossierPdfImpl = exportInterviewDossierPdf,
} = {}) {
  const pathCtx = { repoRoot, env };
  const executeIntent =
    executeMissionIntent || workspaceAgentRuntime?.executeIntent || executeWorkspaceIntent;
  const activeMissionRuns = new Map();
  async function executeMission(id, { resume = false, focusApplicationId = null } = {}) {
    const missionId = String(id ?? "").trim();
    if (activeMissionRuns.has(missionId)) return activeMissionRuns.get(missionId);
    const execution = Promise.resolve().then(() =>
      (resume ? missionResume : missionRun)({
        ...pathCtx,
        id,
        resolveExecutionPlan: resolveMissionExecutionPlan,
        ...(focusApplicationId ? { focusApplicationId } : {}),
        executeIntent: (attempt) => executeIntent({ repoRoot, env, ...attempt }),
      })
    );
    activeMissionRuns.set(missionId, execution);
    try {
      return await execution;
    } finally {
      if (activeMissionRuns.get(missionId) === execution) activeMissionRuns.delete(missionId);
    }
  }

  async function resolveControlChoice(body) {
    const resolved = chatFirstChoiceResolve({ ...pathCtx, ...body });
    const mission = resolved?.result?.mission;
    if (!resolved.reused && resolved.handled && mission?.status === "running") {
      const { mission: executedMission, ...execution } = await executeMission(mission.id);
      return {
        ...resolved,
        ...execution,
        result: { ...resolved.result, mission: executedMission },
      };
    }
    return resolved;
  }

  addRoute("POST", "/api/chat-first/job-thread/pin", (req, res) =>
    withBody(req, res, (body) =>
      jobThreadSetPinned({
        ...pathCtx,
        applicationId: body.applicationId,
        pinned: body.pinned === undefined ? true : body.pinned,
      })
    )
  );

  addRoute("POST", "/api/chat-first/job-thread/archive", (req, res) =>
    withBody(req, res, (body) =>
      jobThreadSetArchived({
        ...pathCtx,
        applicationId: body.applicationId,
        archived: body.archived === undefined ? true : body.archived,
      })
    )
  );

  addRoute("POST", "/api/chat-first/job-thread/message", (req, res) =>
    withBody(req, res, (body) => jobThreadMessageAppend({ ...pathCtx, ...body }))
  );

  addRoute("POST", "/api/chat-first/job-thread/turn", (req, res) =>
    withBody(
      req,
      res,
      async (body) => {
        if (appOperations?.start && body.requestId) {
          const started = await appOperations.start({
            kind: JOB_THREAD_TURN_OPERATION_KIND,
            input: body,
          });
          return {
            reused: started.reused,
            operation: operationView(started.operation),
          };
        }
        return jobThreadTurn({
          ...pathCtx,
          applicationId: body.applicationId,
          text: body.text,
          choice: body.choice,
          resolveExecutionPlan: resolveMissionExecutionPlan,
          call: callAIImpl,
        });
      },
      { status: appOperations ? 202 : 200 }
    )
  );

  addRoute("POST", "/api/chat-first/dossier/pdf", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, code: "BAD_JSON", error: error.message });
      return;
    }
    try {
      const result = await exportInterviewDossierPdfImpl({
        ...pathCtx,
        applicationId: body?.applicationId,
        artifactPath: body?.artifactPath,
      });
      if (
        !Buffer.isBuffer(result?.buffer) ||
        !result.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))
      ) {
        const error = new Error("interview dossier exporter returned invalid PDF bytes");
        error.code = "INVALID_DOSSIER_PDF";
        throw error;
      }
      const filename = safeDownloadName(result.filename);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": String(result.buffer.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Careerrat-Artifact-Path": encodeURIComponent(String(result.path || "")),
      });
      res.end(result.buffer);
    } catch (error) {
      sendError(res, error);
    }
  });

  addRoute("POST", "/api/chat-first/missions", (req, res) =>
    withBody(
      req,
      res,
      (body) =>
        missionCreateForJobs({
          ...pathCtx,
          id: body.id,
          title: body.title,
          jobs: body.jobs,
          mode: body.mode,
        }),
      { status: 201 }
    )
  );

  addRoute("POST", "/api/chat-first/missions/status", (req, res) =>
    withBody(req, res, (body) => missionSetStatus({ ...pathCtx, ...body }))
  );

  addRoute("POST", "/api/chat-first/missions/run", (req, res) =>
    withBody(req, res, (body) => executeMission(body.id))
  );

  addRoute("POST", "/api/chat-first/missions/resume", (req, res) =>
    withBody(req, res, (body) =>
      executeMission(body.id, {
        resume: true,
        focusApplicationId: body.focusApplicationId,
      })
    )
  );

  addRoute("POST", "/api/chat-first/choice/resolve", (req, res) =>
    withBody(req, res, resolveControlChoice)
  );

  addRoute("POST", "/api/chat-first/mock/start", (req, res) =>
    withBody(
      req,
      res,
      (body) =>
        mockInterviewStartWithAI({
          ...pathCtx,
          ...body,
          questionTotal: body.questionTotal ?? body.questionCount,
          resolveExecutionPlan: resolveMissionExecutionPlan,
          call: callAIImpl,
        }),
      { status: 201 }
    )
  );

  addRoute("POST", "/api/chat-first/mock/message", (req, res) =>
    withBody(req, res, (body) =>
      mockInterviewMessageAppend({
        ...pathCtx,
        ...body,
        role: body.role || "user",
        kind: body.kind || (body.role === "assistant" ? "question" : "answer"),
      })
    )
  );

  addRoute("POST", "/api/chat-first/mock/turn", (req, res) =>
    withBody(req, res, (body) =>
      mockInterviewTurn({
        ...pathCtx,
        sessionId: body.sessionId,
        text: body.text,
        resolveExecutionPlan: resolveMissionExecutionPlan,
        call: callAIImpl,
      })
    )
  );

  addRoute("POST", "/api/chat-first/mock/feedback", (req, res) =>
    withBody(req, res, (body) => mockInterviewFeedbackAppend({ ...pathCtx, ...body }))
  );

  addRoute("POST", "/api/chat-first/mock/end", (req, res) =>
    withBody(req, res, (body) => mockInterviewEnd({ ...pathCtx, ...body }))
  );

  addRoute("POST", "/api/chat-first/sourced/decision", (req, res) =>
    withBody(req, res, (body) =>
      sourcedDecisionSet({
        ...pathCtx,
        id: body.id,
        decision: body.decision,
        mode: body.mode,
      })
    )
  );

  addRoute("POST", "/api/chat-first/deep-ingest-prompt/dismiss", (req, res) =>
    withBody(req, res, () => deepIngestPromptDismiss(pathCtx))
  );

  addRoute("POST", "/api/chat-first/deep-ingest/open", (req, res) =>
    withBody(req, res, () => deepIngestThreadOpen(pathCtx))
  );

  addRoute("POST", "/api/chat-first/touch-due/dismiss", (req, res) =>
    withBody(req, res, (body) => touchDueDismiss({ ...pathCtx, id: body.id, source: body.source }))
  );
}
