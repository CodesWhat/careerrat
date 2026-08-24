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
  required: [
    "gate",
    "fitScore",
    "fitSummary",
    "compensation",
    "action",
    "fitReasons",
    "fitRisks",
    "confidence",
  ],
  additionalProperties: false,
  properties: {
    gate: { type: "string", enum: ["keep", "review", "cut", "KEEP", "REVIEW", "CUT"] },
    fitScore: { type: "number", minimum: 0, maximum: 100 },
    fitSummary: { type: "string", maxLength: 160 },
    compensation: {
      type: "object",
      additionalProperties: false,
      required: ["status", "currency", "minBase", "maxBase", "source", "summary"],
      properties: {
        status: {
          type: "string",
          enum: ["clears-floor", "below-floor", "unknown"],
        },
        currency: stringOrNull,
        minBase: { type: ["number", "null"], minimum: 0 },
        maxBase: { type: ["number", "null"], minimum: 0 },
        source: {
          type: "string",
          enum: ["job-description", "market", "unknown"],
        },
        summary: { type: "string", maxLength: 140 },
      },
    },
    action: { type: "string" },
    fitReasons: { type: "array", maxItems: 3, items: { type: "string", maxLength: 80 } },
    fitRisks: { type: "array", maxItems: 3, items: { type: "string", maxLength: 80 } },
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
        answersDocx: workspacePath,
        packetManifest: workspacePath,
        // Plain keys the read path (GET /api/packet, isGatedIn) and the
        // older appRegisterArtifact write path key off — generate/export
        // stamp these alongside the finer-grained <kind>Source/Pdf/Docx keys
        // above so both write paths land on artifacts the read path finds.
        resume: workspacePath,
        coverLetter: workspacePath,
        answers: workspacePath,
        resumeGeneratedAt: { type: "string" },
        coverLetterGeneratedAt: { type: "string" },
        answersGeneratedAt: { type: "string" },
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
    confirmedAnswers: {
      type: "array",
      items: {
        type: "object",
        required: ["questionId", "question", "answer", "confirmedAt"],
        additionalProperties: false,
        properties: {
          questionId: stringOrNull,
          question: { type: "string" },
          answer: { type: "string" },
          confirmedAt: { type: "string" },
        },
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
    warnings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          kind: { type: "string" },
          code: { type: "string" },
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

export const packetCoverLetterProposalSchema = {
  type: "object",
  required: ["blocks"],
  additionalProperties: false,
  properties: {
    blocks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["text", "evidenceIds"],
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const packetResumeProposalSchema = {
  type: "object",
  required: ["experience"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    experience: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["company", "roles"],
        additionalProperties: false,
        properties: {
          company: { type: "string" },
          location: { type: "string" },
          dates: { type: "string" },
          roles: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["title", "bullets"],
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                dates: { type: "string" },
                bullets: { type: "array", minItems: 1, items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        required: ["heading", "bullets"],
        additionalProperties: false,
        properties: {
          heading: { type: "string" },
          bullets: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
    skillGroups: {
      type: "array",
      items: {
        type: "object",
        required: ["label", "items"],
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          items: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
    education: { type: "array", items: { type: "string" } },
  },
};

export const packetGenerateRequestSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    appId: { type: "string" },
    applicationId: { type: "string" },
    applyIntent: { type: "boolean" },
    formats: { type: "array", items: { type: "string", enum: ["pdf", "docx"] } },
  },
};

export const packetExportRequestSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    appId: { type: "string" },
    applicationId: { type: "string" },
    formats: { type: "array", items: { type: "string", enum: ["pdf", "docx"] } },
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
