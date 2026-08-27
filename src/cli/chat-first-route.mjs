import { executeWorkspaceIntent } from "../core/agent/workspace-agent.mjs";
import { loadAIPreferences } from "../core/ai/ai-preferences.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { aiRuntimeIdForRoute, resolveAIExecutionPlan } from "../core/ai/operation-policy.mjs";
import {
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
    withBody(req, res, (body) =>
      jobThreadTurn({
        ...pathCtx,
        applicationId: body.applicationId,
        text: body.text,
        choice: body.choice,
        resolveExecutionPlan: resolveMissionExecutionPlan,
        call: callAIImpl,
      })
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
