// public-scanner-ai.mjs — bounded AI fallback for ambiguous public careers pages.

import { createHash } from "node:crypto";

import { runBoundedAI } from "../ai/bounded-ai.mjs";
import { scrubPublicIntelPayload } from "./public-intel-scrub.mjs";

export const PUBLIC_CAREERS_EXTRACT_SCHEMA = Object.freeze({
  type: "object",
  required: ["status", "candidates"],
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["candidate_found", "ambiguous", "no_result"],
    },
    candidates: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["url", "providerHint", "confidence"],
        additionalProperties: false,
        properties: {
          url: { type: "string", minLength: 1, maxLength: 2048 },
          providerHint: {
            type: "string",
            enum: [
              "ashby",
              "greenhouse",
              "lever",
              "workable",
              "smartrecruiters",
              "custom",
              "unknown",
            ],
          },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    reviewReason: { type: "string", maxLength: 240 },
  },
});

const LABELS = Object.freeze({
  skill: "discover-companies",
  action: "scanner-cascade",
  operation: "public-careers-extract",
});

const MANUAL = Object.freeze({
  available: true,
  reason: "public-careers-ai-unavailable",
  action: "Keep public metadata and review the ambiguous careers page manually.",
});

function hashText(text) {
  return `sha256-${createHash("sha256")
    .update(String(text || ""))
    .digest("hex")}`;
}

function sanitizePublicText(text, limit = 8000) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function buildMessages({ pageUrl, pageText, inputHash }) {
  return [
    {
      role: "user",
      content: [
        "Extract public careers-page structure from the text below.",
        "Use only the provided public text. Do not infer missing URLs.",
        "Return candidate_found only when a concrete public jobs URL is present.",
        "Return ambiguous when multiple plausible public boards remain.",
        "Return no_result when the text has no public jobs signal.",
        `URL: ${pageUrl}`,
        `Input hash: ${inputHash}`,
        "Public text:",
        pageText,
      ].join("\n"),
    },
  ];
}

function failureResult(outcome, status = "review_needed") {
  return {
    ok: false,
    status,
    writeApproved: false,
    ai: outcome.body.ai,
    manual: outcome.body.manual,
    code: outcome.body.code,
    error: outcome.body.error,
  };
}

export async function extractAmbiguousPublicCareersPage({
  pageUrl,
  pageText,
  root,
  env,
  call,
  now,
  signal,
} = {}) {
  const sanitizedText = sanitizePublicText(pageText);
  const inputHash = hashText(sanitizedText);
  if (!sanitizedText || sanitizedText.length < 40) {
    return {
      ok: false,
      status: "review_needed",
      writeApproved: false,
      ai: { used: false },
      manual: MANUAL,
      code: "NO_USABLE_PUBLIC_TEXT",
      error: { message: "No usable public text for bounded AI extraction." },
    };
  }

  const outcome = await runBoundedAI({
    labels: LABELS,
    schema: PUBLIC_CAREERS_EXTRACT_SCHEMA,
    manual: MANUAL,
    structuredMode: "native-preferred",
    maxRetries: 1,
    call,
    messages: buildMessages({ pageUrl, pageText: sanitizedText, inputHash }),
    system: "Return only structured JSON for public careers-page extraction.",
    maxTokens: 512,
    outputName: "public_careers_extract_response",
    root,
    env,
    signal,
  });

  if (!outcome.body.ok) return failureResult(outcome);

  const data = scrubPublicIntelPayload({
    ...outcome.body.data,
    inputHash,
    observedAt:
      now instanceof Date
        ? now.toISOString()
        : typeof now === "string" || typeof now === "number"
          ? new Date(now).toISOString()
          : new Date().toISOString(),
  });

  return {
    ok: true,
    status: data.status,
    writeApproved: false,
    ai: outcome.body.ai,
    manual: outcome.body.manual,
    data,
  };
}
