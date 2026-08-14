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
    fitScore: null,
    fitBucket: null,
    fitSummary: "Needs manual review.",
    compensation: {
      status: "unknown",
      currency: null,
      minBase: null,
      maxBase: null,
      source: "unknown",
      summary: "Compensation needs manual review.",
    },
    action: "manual",
    fitReasons: [],
    fitRisks: [String(reason).slice(0, 80)],
    confidence: "low",
    manual: {
      required: true,
      code,
      reason,
      action: "Review the job body and packet gate manually.",
    },
    ai,
    source,
    evaluatedAt: new Date().toISOString(),
  };
}

function normalizeVerdict(verdict, { applicationId, ai, source }) {
  const gate = String(verdict?.gate || "review").toLowerCase();
  const safeGate = gate === "keep" || gate === "cut" ? gate : "review";
  const rawScore = Number(verdict?.fitScore);
  const fitScore = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  const fitBucket = fitScore >= 85 ? "high" : fitScore >= 65 ? "med" : "stretch";
  const rawComp = verdict?.compensation || {};
  const minBase = optionalNumber(rawComp.minBase);
  const maxBase = optionalNumber(rawComp.maxBase);
  const compensation = {
    status: ["clears-floor", "below-floor"].includes(rawComp.status) ? rawComp.status : "unknown",
    currency: rawComp.currency ? String(rawComp.currency).slice(0, 12) : null,
    minBase,
    maxBase,
    source: ["job-description", "market"].includes(rawComp.source) ? rawComp.source : "unknown",
    summary: String(rawComp.summary || "Compensation needs review.").slice(0, 140),
  };
  return {
    appId: applicationId,
    applicationId,
    gate: safeGate,
    fitScore,
    fitBucket,
    fitSummary: String(verdict?.fitSummary || "Fit needs review.").slice(0, 160),
    compensation,
    action: String(verdict?.action || (safeGate === "keep" ? "generate-packet" : "manual")),
    fitReasons: (Array.isArray(verdict?.fitReasons) ? verdict.fitReasons : [])
      .map((value) => String(value).slice(0, 80))
      .slice(0, 3),
    fitRisks: (Array.isArray(verdict?.fitRisks) ? verdict.fitRisks : [])
      .map((value) => String(value).slice(0, 80))
      .slice(0, 3),
    confidence: String(verdict?.confidence || "medium").toLowerCase(),
    manual: { required: safeGate === "review" },
    ai,
    source,
    evaluatedAt: new Date().toISOString(),
  };
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
