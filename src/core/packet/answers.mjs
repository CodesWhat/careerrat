import { runBoundedAI } from "../ai/bounded-ai.mjs";
import { buildShortAnswer, forbiddenWordingFor } from "../documents/tailor.mjs";
import { buildPromptVisibleSources } from "./generate.mjs";
import { loadPacketQuestionCapture } from "./questions.mjs";
import { packetAnswerProposalSchema } from "./schemas/packet-schemas.mjs";

const LABELS = Object.freeze({
  skill: "packet-engine",
  action: "draft-answers",
  operation: "packet:answers",
});

function cleanText(value) {
  return String(value || "").trim();
}

function withoutPrivateFields(value) {
  if (Array.isArray(value)) return value.map(withoutPrivateFields);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "current_base") continue;
    out[key] = withoutPrivateFields(child);
  }
  return out;
}

function normalizeQuestions(input) {
  if (Array.isArray(input?.answerable)) {
    return {
      answerable: input.answerable,
      excluded: Array.isArray(input.excluded) ? input.excluded : [],
    };
  }
  return {
    answerable: Array.isArray(input?.questions) ? input.questions : [],
    excluded: Array.isArray(input?.excluded) ? input.excluded : [],
  };
}

function evidenceIds(context) {
  const claims = Array.isArray(context?.evidence?.claims) ? context.evidence.claims : [];
  return new Set(claims.map((claim) => String(claim.id)));
}

function forbiddenForContext(context) {
  const claims = Array.isArray(context?.evidence?.claims) ? context.evidence.claims : [];
  return forbiddenWordingFor(claims, context?.honesty || {});
}

function promptFor({ context, questions }) {
  const safeContext = withoutPrivateFields(buildPromptVisibleSources(context));
  return [
    "Draft application form answers using only confirmed local evidence.",
    "Return JSON matching packetAnswerProposalSchema.",
    "",
    "Questions:",
    JSON.stringify(questions, null, 2),
    "",
    "Context:",
    JSON.stringify(safeContext, null, 2),
  ].join("\n");
}

function needsYouAnswer(question, reason) {
  return {
    questionId: String(question.id),
    question: question.label,
    answer: `NEEDS YOU: ${reason}`,
    evidenceIds: [],
    uploadReady: false,
    gap: reason,
  };
}

function normalizeAnswer({ proposal, question, context, allowedEvidenceIds, forbidden }) {
  const answer = cleanText(proposal?.answer);
  const ids = Array.isArray(proposal?.evidenceIds) ? proposal.evidenceIds.map(String) : [];
  const gap = cleanText(proposal?.gap);
  if (!answer) return needsYouAnswer(question, "draft an answer for this question");
  if (/^NEEDS YOU:/.test(answer) || gap) {
    return {
      questionId: String(question.id),
      question: question.label,
      answer,
      evidenceIds: ids.filter((id) => allowedEvidenceIds.has(id)),
      uploadReady: false,
      gap: gap || "needs-user-input",
    };
  }
  const invalidEvidence = ids.filter((id) => !allowedEvidenceIds.has(id));
  if (!ids.length || invalidEvidence.length) {
    return needsYouAnswer(question, "confirm evidence for this answer");
  }
  try {
    return {
      questionId: String(question.id),
      question: question.label,
      answer: buildShortAnswer({
        question: question.label,
        answer,
        honesty: context?.honesty || {},
        forbidden,
      }),
      evidenceIds: ids,
      uploadReady: true,
      gap: null,
    };
  } catch (err) {
    return needsYouAnswer(question, err?.message || "revise this answer");
  }
}

function manualAnswers(questions, reason) {
  return questions.map((question) => needsYouAnswer(question, reason));
}

export async function draftPacketAnswers({
  repoRoot,
  env = process.env,
  appId,
  applicationId,
  context = {},
  questions,
  call,
  runAI = runBoundedAI,
} = {}) {
  let capture = questions ? normalizeQuestions(questions) : null;
  const id = cleanText(applicationId || appId);
  if (!capture && repoRoot && id) {
    capture = normalizeQuestions(await loadPacketQuestionCapture({ repoRoot, env, appId: id }));
  }
  capture = capture || { answerable: [], excluded: [] };
  const answerable = capture.answerable;
  const excludedQuestionIds = capture.excluded.map((q) => String(q.id));
  const prompt = promptFor({ context, questions: answerable });

  const aiResult = await runAI({
    labels: LABELS,
    schema: packetAnswerProposalSchema,
    manual: {
      available: true,
      reason: "packet-answer-review",
      action: "Review and complete the answers manually.",
    },
    structuredMode: "native-preferred",
    call,
    messages: [{ role: "user", content: prompt }],
    system:
      "Draft short application answers. Use NEEDS YOU when evidence is missing. Do not answer demographic or EEO prompts.",
    outputName: "packet_answer_proposals",
    maxTokens: 1600,
    root: repoRoot,
    env,
  });

  if (!aiResult.body?.ok) {
    const answers = manualAnswers(
      answerable,
      aiResult.body?.error?.message || "AI unavailable; answer manually"
    );
    return {
      answers,
      excludedQuestionIds,
      uploadReady: false,
      ai: aiResult.body?.ai || { used: false },
      manual: { required: true, code: aiResult.body?.code || "PACKET_ANSWERS_REVIEW" },
    };
  }

  const proposals = new Map(
    (aiResult.body.data?.answers || []).map((proposal) => [String(proposal.questionId), proposal])
  );
  const allowedEvidenceIds = evidenceIds(context);
  const forbidden = forbiddenForContext(context);
  const answers = answerable.map((question) =>
    normalizeAnswer({
      proposal: proposals.get(String(question.id)),
      question,
      context,
      allowedEvidenceIds,
      forbidden,
    })
  );
  return {
    answers,
    excludedQuestionIds,
    uploadReady: answers.every((answer) => answer.uploadReady),
    ai: aiResult.body.ai,
    manual: { required: answers.some((answer) => !answer.uploadReady) },
  };
}
