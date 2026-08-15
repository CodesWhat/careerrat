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

function boundedDisplayText(value, maxLength, fallback = "") {
  const raw = String(value ?? "").trim();
  const text = raw || String(fallback).trim();
  if (!text) return "";
  const looksBudgetClipped = text.length >= maxLength && !/[.!?…)}\]"']$/u.test(text);
  const danglingConnector = /\b(?:a|an|and|but|for|or|the|to|with)$/iu.test(text);
  if (text.length <= maxLength && !looksBudgetClipped && !danglingConnector) return text;

  const withoutDanglingConnector = danglingConnector
    ? text.replace(/\s+\b(?:a|an|and|but|for|or|the|to|with)$/iu, "")
    : text;
  let prefix = withoutDanglingConnector.slice(0, Math.max(1, maxLength - 1)).trimEnd();
  const comma = prefix.lastIndexOf(",");
  const commaBoundary =
    comma >= 0 &&
    /[A-Za-z]/u.test(prefix[comma - 1] || "") &&
    /[A-Za-z]/u.test(prefix[comma + 1] || "")
      ? comma
      : -1;
  const boundary = Math.max(
    prefix.lastIndexOf(" "),
    commaBoundary,
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf(":")
  );
  if (boundary >= Math.floor(maxLength * 0.6)) {
    prefix = prefix.slice(0, boundary).trimEnd();
  }
  prefix = prefix.replace(/[,:;–—-]+$/u, "").trimEnd();
  return `${prefix || text.slice(0, maxLength - 1)}…`;
}

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
    fitRisks: [boundedDisplayText(reason, 72)],
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
    summary: boundedDisplayText(rawComp.summary, 130, "Compensation needs review."),
  };
  return {
    appId: applicationId,
    applicationId,
    gate: safeGate,
    fitScore,
    fitBucket,
    fitSummary: boundedDisplayText(verdict?.fitSummary, 150, "Fit needs review."),
    compensation,
    action: String(verdict?.action || (safeGate === "keep" ? "generate-packet" : "manual")),
    fitReasons: (Array.isArray(verdict?.fitReasons) ? verdict.fitReasons : [])
      .map((value) => boundedDisplayText(value, 72))
      .slice(0, 3),
    fitRisks: (Array.isArray(verdict?.fitRisks) ? verdict.fitRisks : [])
      .map((value) => boundedDisplayText(value, 72))
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
            maxTokens: 4096,
            effort: "low",
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
