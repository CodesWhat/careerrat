import { runBoundedAI } from "../ai/bounded-ai.mjs";
import { candidateConfigGet } from "../db/verbs.mjs";
import { buildShortAnswer, forbiddenWordingFor } from "../documents/tailor.mjs";
import { resolveDisclosureAnswer } from "./disclosure.mjs";
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

// Best-effort persisted screening-answer lookup — screening_answers lives in
// candidate form-defaults (DB-backed), not on the packet context, so this
// needs its own repoRoot-scoped read. Callers that pass context only (no
// repoRoot, e.g. unit tests) simply get no screening-answer match and fall
// through to profile facts / the AI batch.
function loadFormDefaults({ repoRoot, env }) {
  if (!repoRoot) return null;
  try {
    return candidateConfigGet({ repoRoot, env })["form-defaults"] || null;
  } catch {
    return null;
  }
}

function disclosureAnswerEntry(question, resolved) {
  return {
    questionId: String(question.id),
    question: question.label,
    answer: resolved.answer,
    evidenceIds: [],
    uploadReady: true,
    gap: null,
    disclosure: true,
    source: resolved.source,
  };
}

// Split captured questions into ones answerable deterministically (work
// authorization / sponsorship / salary floor / notice period, resolved from
// persisted screening answers or profile facts) and everything else, which
// still goes to the AI exactly as before.
function partitionDisclosureQuestions({ questions, formDefaults, profile }) {
  const deterministic = [];
  const aiBatch = [];
  for (const question of questions) {
    const resolved = resolveDisclosureAnswer(question, { formDefaults, profile });
    if (resolved) {
      deterministic.push(disclosureAnswerEntry(question, resolved));
    } else {
      aiBatch.push(question);
    }
  }
  return { deterministic, aiBatch };
}

function mergeAnswersInOrder(answerable, deterministicMap, resolvedMap) {
  return answerable.map((question) => {
    const id = String(question.id);
    return deterministicMap.get(id) || resolvedMap.get(id);
  });
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

  const formDefaults = loadFormDefaults({ repoRoot, env });
  const profile = context?.profile || context?.candidate || {};
  const { deterministic, aiBatch } = partitionDisclosureQuestions({
    questions: answerable,
    formDefaults,
    profile,
  });
  const deterministicMap = new Map(deterministic.map((answer) => [answer.questionId, answer]));

  if (aiBatch.length === 0) {
    const answers = answerable.map((question) => deterministicMap.get(String(question.id)));
    return {
      answers,
      excludedQuestionIds,
      uploadReady: answers.every((answer) => answer.uploadReady),
      ai: { used: false },
      manual: { required: answers.some((answer) => !answer.uploadReady) },
    };
  }

  const prompt = promptFor({ context, questions: aiBatch });

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
    // Sized for many-question forms: a mid-JSON max_tokens truncation parses
    // as failure and every answer degrades to NEEDS YOU.
    maxTokens: 3600,
    root: repoRoot,
    env,
  });

  if (!aiResult.body?.ok) {
    const resolvedMap = new Map(
      manualAnswers(
        aiBatch,
        aiResult.body?.error?.message || "AI unavailable; answer manually"
      ).map((answer) => [answer.questionId, answer])
    );
    const answers = mergeAnswersInOrder(answerable, deterministicMap, resolvedMap);
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
  const resolvedMap = new Map(
    aiBatch.map((question) => [
      String(question.id),
      normalizeAnswer({
        proposal: proposals.get(String(question.id)),
        question,
        context,
        allowedEvidenceIds,
        forbidden,
      }),
    ])
  );
  const answers = mergeAnswersInOrder(answerable, deterministicMap, resolvedMap);
  return {
    answers,
    excludedQuestionIds,
    uploadReady: answers.every((answer) => answer.uploadReady),
    ai: aiResult.body.ai,
    manual: { required: answers.some((answer) => !answer.uploadReady) },
  };
}
