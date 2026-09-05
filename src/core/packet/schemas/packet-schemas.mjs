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
    "requirements",
  ],
  additionalProperties: false,
  properties: {
    gate: { type: "string", enum: ["keep", "review", "cut", "KEEP", "REVIEW", "CUT"] },
    fitScore: { type: "number", minimum: 0, maximum: 100 },
    fitSummary: { type: "string", maxLength: 160 },
    compensation: {
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "currency",
        "minBase",
        "maxBase",
        "minAnnualEarnings",
        "maxAnnualEarnings",
        "basis",
        "source",
        "summary",
      ],
      properties: {
        status: {
          type: "string",
          enum: ["clears-floor", "below-floor", "unknown"],
        },
        currency: stringOrNull,
        minBase: { type: ["number", "null"], minimum: 0 },
        maxBase: { type: ["number", "null"], minimum: 0 },
        minAnnualEarnings: { type: ["number", "null"], minimum: 0 },
        maxAnnualEarnings: { type: ["number", "null"], minimum: 0 },
        basis: {
          type: ["string", "null"],
          enum: ["base", "annual-earnings", null],
        },
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
    // Required on every live completion so a legacy-shaped model reply can't
    // silently validate with an empty table (an explicit `[]` is fine; an
    // absent key is not). Persisted verdicts from before this field existed
    // still read fine — config/tracker.schema.json keeps `requirements`
    // optional on the read path, only this live-completion schema requires
    // it. Evidence-tiered requirements table; fitRisks is derived from it
    // (see deriveFitRisks in ../requirements.mjs).
    requirements: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirement", "importance", "evidence", "jdSignal", "match", "note"],
        properties: {
          requirement: { type: "string", maxLength: 120 },
          importance: {
            type: "string",
            enum: ["critical", "high", "meaningful", "preferred", "low_signal"],
          },
          evidence: { type: "string", enum: ["stated", "structural", "inferred"] },
          jdSignal: { type: "string", maxLength: 160 },
          match: { type: "string", enum: ["strong", "partial", "missing", "na"] },
          note: { type: "string", maxLength: 200 },
        },
      },
    },
  },
};

const DRAFTING_RESIDUE =
  /\?|```|\b(?:oops|typo|scratch that|ignore (?:that|this)|let me (?:fix|rephrase|rewrite)|i mean|correction)\b|\bwait(?=\s*(?:[,;:—-]\s*)?(?:no|sorry|typo|scratch that|i mean|correction)\b)/iu;

export function validatePacketGateVerdictQuality(verdict = {}) {
  const entries = [
    ["fitSummary", verdict.fitSummary],
    ["compensation.summary", verdict.compensation?.summary],
    ["action", verdict.action],
    ...(Array.isArray(verdict.fitReasons)
      ? verdict.fitReasons.map((value, index) => [`fitReasons[${index}]`, value])
      : []),
    ...(Array.isArray(verdict.fitRisks)
      ? verdict.fitRisks.map((value, index) => [`fitRisks[${index}]`, value])
      : []),
    // requirement and jdSignal are excluded here: both are supposed to be
    // verbatim JD text, which routinely contains a "?" (a JD question like
    // "Do you hold an active X certification?") or an ordinary word the
    // residue pattern also flags (e.g. "correction"). Checking the model's
    // own drafting copy for residue makes sense; checking a quoted source
    // phrase for the same pattern produces false positives that burn a
    // retry. jdSignal's authenticity is enforced separately, by verifying it
    // actually occurs in the saved JD (see verifyJdSignal in
    // ../requirements.mjs), not by this residue check. note is the model's
    // own commentary, so it stays in scope.
    ...(Array.isArray(verdict.requirements)
      ? verdict.requirements.flatMap((row, index) => [[`requirements[${index}].note`, row?.note]])
      : []),
  ];
  return entries
    .filter(([, value]) => DRAFTING_RESIDUE.test(String(value || "")))
    .map(([path]) => ({
      path,
      message:
        "must be final user-facing copy without questions, drafting notes, or self-corrections",
    }));
}

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
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["jd", "evaluation"],
      properties: {
        jd: {
          type: "object",
          additionalProperties: false,
          required: ["path", "sha256"],
          properties: {
            path: workspacePath,
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
        evaluation: {
          type: "object",
          additionalProperties: false,
          required: ["evaluatedAt", "sha256"],
          properties: {
            evaluatedAt: { type: "string" },
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
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
        resumeText: workspacePath,
        coverLetterText: workspacePath,
        answersText: workspacePath,
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
        answerable: { type: "array", items: packetQuestionSchema },
      },
    },
    answerLineage: {
      type: "object",
      additionalProperties: true,
      properties: {
        answeredQuestionIds: { type: "array", items: { type: "string" } },
        skippedQuestionIds: { type: "array", items: { type: "string" } },
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
