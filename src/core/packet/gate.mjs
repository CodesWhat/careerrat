import { BOUNDED_AI_CODES, runBoundedAI } from "../ai/bounded-ai.mjs";
import {
  buildPacketContext,
  capturePacketJobBody,
  hasReadableJobBody,
  packetPromptFromContext,
} from "./context.mjs";
import { packetGateAiVerdictSchema, validatePacketGateRequest } from "./schemas/packet-schemas.mjs";

const LABELS = Object.freeze({
  skill: "packet-engine",
  action: "gate",
  operation: "packet:gate",
});

function reviewData({ applicationId, code, reason, ai = { used: false }, source = null }) {
  return {
    appId: applicationId,
    applicationId,
    gate: "review",
    fit: "review",
    comp: "review",
    action: "manual",
    reasons: [reason],
    confidence: "low",
    manual: {
      required: true,
      code,
      reason,
      action: "Review the job body and packet gate manually.",
    },
    ai,
    source,
  };
}

function normalizeVerdict(verdict, { applicationId, ai, source }) {
  const gate = String(verdict?.gate || "review").toLowerCase();
  const safeGate = gate === "keep" || gate === "cut" ? gate : "review";
  return {
    appId: applicationId,
    applicationId,
    gate: safeGate,
    fit: String(verdict?.fit || "review"),
    comp: String(verdict?.comp || "review"),
    action: String(verdict?.action || (safeGate === "keep" ? "generate-packet" : "manual")),
    reasons: Array.isArray(verdict?.reasons) ? verdict.reasons.map(String) : [],
    confidence: String(verdict?.confidence || "medium").toLowerCase(),
    manual: { required: safeGate === "review" },
    ai,
    source,
  };
}

function statusCodeForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  if (err?.code === "NOT_FOUND") return 404;
  if (err?.code === "BAD_REQUEST") return 400;
  return 500;
}

export async function evaluatePacketGate({
  repoRoot,
  env = process.env,
  body,
  invoke,
  runAI = runBoundedAI,
} = {}) {
  let request;
  try {
    request = validatePacketGateRequest(body || {});
  } catch (err) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "BAD_REQUEST",
        error: { message: err?.message || "invalid packet gate request" },
      },
    };
  }

  try {
    let captured = null;
    if (request.jobBody) {
      captured = capturePacketJobBody({
        repoRoot,
        env,
        applicationId: request.applicationId,
        body: request.jobBody,
        sourceUrl: request.jobUrl,
      });
    }

    const context = buildPacketContext({
      repoRoot,
      env,
      applicationId: request.applicationId,
      capturedJobBody: captured?.body,
      capturedJobPath: captured?.path,
    });
    const source = {
      jd: context.job.path || captured?.path || null,
      captured: Boolean(captured),
    };

    if (!hasReadableJobBody(context)) {
      return {
        status: 200,
        body: {
          ok: true,
          data: reviewData({
            applicationId: request.applicationId,
            code: "MISSING_JOB_BODY",
            reason: "A readable full job description is required before packet gate evaluation.",
            source,
          }),
        },
      };
    }

    const prompt = packetPromptFromContext(context);
    const aiResult = await runAI({
      labels: LABELS,
      schema: packetGateAiVerdictSchema,
      manual: {
        available: true,
        reason: "packet-gate-review",
        action: "Review this application before generating a packet.",
      },
      maxRetries: 1,
      ...(typeof invoke === "function"
        ? {
            invoke: async ({ attempt, correction, labels }) =>
              invoke({ attempt, correction, labels, prompt, context }),
          }
        : {
            structuredMode: "native-preferred",
            messages: [{ role: "user", content: prompt }],
            system:
              "Return only JSON for a local application packet gate. Do not include raw prompt text.",
            outputName: "packet_gate_verdict",
            maxTokens: 700,
            root: repoRoot,
            env,
          }),
    });

    if (aiResult.body?.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          data: normalizeVerdict(aiResult.body.data, {
            applicationId: request.applicationId,
            ai: aiResult.body.ai,
            source,
          }),
        },
      };
    }

    const code =
      aiResult.body?.code === BOUNDED_AI_CODES.NO_AI_ROUTE
        ? "NO_AI_ROUTE"
        : aiResult.body?.code || "PACKET_GATE_REVIEW";
    return {
      status: 200,
      body: {
        ok: true,
        data: reviewData({
          applicationId: request.applicationId,
          code,
          reason:
            aiResult.body?.error?.message ||
            "Packet gate output needs manual review before packet generation.",
          ai: aiResult.body?.ai || { used: false },
          source,
        }),
      },
    };
  } catch (err) {
    return {
      status: statusCodeForError(err),
      body: {
        ok: false,
        code: err?.code || "PACKET_GATE_ERROR",
        error: { message: err?.message || "packet gate failed" },
      },
    };
  }
}
