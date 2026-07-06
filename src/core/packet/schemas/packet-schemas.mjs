import { validate } from "../../profile/schema-validator.mjs";

const stringOrNull = { type: ["string", "null"] };

export const packetGateRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    appId: { type: "string" },
    applicationId: { type: "string" },
    jobBody: { type: "string" },
    jobDescription: { type: "string" },
    jobUrl: stringOrNull,
    sourceUrl: stringOrNull,
  },
};

export const packetGateAiVerdictSchema = {
  type: "object",
  required: ["gate", "fit", "comp", "action", "reasons", "confidence"],
  additionalProperties: false,
  properties: {
    gate: { type: "string", enum: ["keep", "review", "cut", "KEEP", "REVIEW", "CUT"] },
    fit: { type: "string" },
    comp: { type: "string" },
    action: { type: "string" },
    reasons: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
};

export function validatePacketGateRequest(input) {
  const result = validate(input, packetGateRequestSchema);
  if (!result.valid) {
    const err = new Error("packet gate request is invalid");
    err.code = "BAD_REQUEST";
    err.details = result.errors;
    throw err;
  }
  const applicationId = String(input?.applicationId || input?.appId || "").trim();
  if (!applicationId) {
    const err = new Error("body.applicationId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  return {
    applicationId,
    jobBody: String(input?.jobBody || input?.jobDescription || "").trim(),
    jobUrl: String(input?.jobUrl || input?.sourceUrl || "").trim(),
  };
}

