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

const packetQuestionSchema = {
  type: "object",
  required: ["id", "label", "type", "required"],
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    type: { type: "string" },
    required: { type: "boolean" },
    options: { type: ["array", "null"], items: { type: "string" } },
  },
};

const packetExcludedQuestionSchema = {
  type: "object",
  required: ["id", "label", "reason"],
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    reason: { type: "string" },
  },
};

const workspacePath = {
  type: "string",
  pattern: "^workspace/[^\\0]+$",
};

export const packetManifestSchema = {
  type: "object",
  required: ["applicationId", "generatedAt", "artifacts", "uploadReady"],
  additionalProperties: true,
  properties: {
    applicationId: { type: "string" },
    generatedAt: { type: "string" },
    uploadReady: { type: "boolean" },
    status: { type: "string" },
    gapCount: { type: "integer", minimum: 0 },
    artifacts: {
      type: "object",
      additionalProperties: false,
      properties: {
        resumeSource: workspacePath,
        coverLetterSource: workspacePath,
        answersSource: workspacePath,
        resumePdf: workspacePath,
        coverLetterPdf: workspacePath,
        answersPdf: workspacePath,
        resumeDocx: workspacePath,
        coverLetterDocx: workspacePath,
        packetManifest: workspacePath,
      },
    },
    questions: {
      type: "object",
      additionalProperties: true,
      properties: {
        source: workspacePath,
        capturedAt: { type: "string" },
        answerableCount: { type: "integer", minimum: 0 },
        excludedCount: { type: "integer", minimum: 0 },
        answerableIds: { type: "array", items: { type: "string" } },
        excludedIds: { type: "array", items: { type: "string" } },
        demographicSectionPresent: { type: "boolean" },
      },
    },
    answerLineage: {
      type: "object",
      additionalProperties: true,
      properties: {
        answeredQuestionIds: { type: "array", items: { type: "string" } },
        excludedQuestionIds: { type: "array", items: { type: "string" } },
        source: workspacePath,
      },
    },
    sources: {
      type: "object",
      additionalProperties: true,
    },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          kind: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
};

export const packetQuestionCaptureRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    appId: { type: "string" },
    applicationId: { type: "string" },
    source: { type: "string", enum: ["url", "paste", "manual", "greenhouse", "ashby"] },
    url: stringOrNull,
    manualText: { type: "string" },
    text: { type: "string" },
  },
};

export const packetQuestionCaptureArtifactSchema = {
  type: "object",
  required: [
    "source",
    "capturedAt",
    "questions",
    "excluded",
    "answerableIds",
    "excludedIds",
    "demographicSectionPresent",
  ],
  additionalProperties: false,
  properties: {
    source: { type: "string" },
    url: stringOrNull,
    capturedAt: { type: "string" },
    questions: { type: "array", items: packetQuestionSchema },
    excluded: { type: "array", items: packetExcludedQuestionSchema },
    answerableIds: { type: "array", items: { type: "string" } },
    excludedIds: { type: "array", items: { type: "string" } },
    demographicSectionPresent: { type: "boolean" },
  },
};

export const packetAnswerProposalSchema = {
  type: "object",
  required: ["answers"],
  additionalProperties: false,
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        required: ["questionId", "answer", "evidenceIds"],
        additionalProperties: false,
        properties: {
          questionId: { type: "string" },
          answer: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          gap: stringOrNull,
        },
      },
    },
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
