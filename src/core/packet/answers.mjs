import { runBoundedAI } from "../ai/bounded-ai.mjs";
import { buildFillPlan, hostnameToPortal } from "../apply/form-fill.mjs";
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

function needsUser(text) {
  return /^NEEDS YOU\b/i.test(cleanText(text));
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

// Allowed citation set for an answer's evidenceIds: confirmed evidence claim
// ids unioned with `story:<id>` ids for the stories actually selected into
// THIS answers batch's own prompt (storyHints) — a story absent from that
// selection is not citable here, matching the cover-letter grounding rule.
function evidenceIds(context, storyHints = []) {
  const claims = Array.isArray(context?.evidence?.claims) ? context.evidence.claims : [];
  const claimIds = claims.map((claim) => String(claim.id));
  const storyIds = (Array.isArray(storyHints) ? storyHints : []).map(
    (story) => `story:${story.id}`
  );
  return new Set([...claimIds, ...storyIds]);
}

function forbiddenForContext(context) {
  const claims = Array.isArray(context?.evidence?.claims) ? context.evidence.claims : [];
  const boundaryRows = Array.isArray(context?.honestyBoundariesConfirmed)
    ? context.honestyBoundariesConfirmed
    : [];
  return forbiddenWordingFor(claims, context?.honesty || {}, boundaryRows);
}

function promptFor({ visibleSources, questions }) {
  return [
    "Draft application form answers using only confirmed local evidence.",
    "Return JSON matching packetAnswerProposalSchema.",
    "",
    "Questions:",
    JSON.stringify(questions, null, 2),
    "",
    "Context:",
    JSON.stringify(visibleSources, null, 2),
  ].join("\n");
}

function needsYouAnswer(question, reason) {
  return {
    questionId: String(question.id),
    question: question.label,
    answer: `NEEDS YOU: ${reason}`,
    evidenceIds: [],
    required: question.required !== false,
    uploadReady: false,
    gap: reason,
  };
}

function optionalSkippedAnswer(question) {
  return {
    questionId: String(question.id),
    question: question.label,
    answer: "Leave blank (optional).",
    evidenceIds: [],
    required: false,
    uploadReady: true,
    gap: null,
    skipped: true,
  };
}

function generatedResumeAnswer(question) {
  return {
    questionId: String(question.id),
    question: question.label,
    answer: "Attach the generated resume file.",
    evidenceIds: [],
    required: question.required !== false,
    uploadReady: true,
    gap: null,
    deterministic: true,
    source: "packet.resume",
  };
}

function isResumeUpload(question) {
  return (
    String(question?.type || "").toLowerCase() === "file" &&
    /\b(resume|résumé|cv)\b/i.test(String(question?.label || question?.id || ""))
  );
}

function configuredAnswerEntry(question, plan, { honesty, forbidden } = {}) {
  try {
    const answer = buildShortAnswer({
      question: question.label,
      answer: String(plan.value),
      honesty,
      forbidden,
    });
    return {
      questionId: String(question.id),
      question: question.label,
      answer,
      evidenceIds: [],
      required: question.required !== false,
      uploadReady: true,
      gap: null,
      deterministic: true,
      source: plan.source || plan.canonicalField || "candidate setup",
    };
  } catch (err) {
    return question.required === false
      ? optionalSkippedAnswer(question)
      : needsYouAnswer(question, err?.message || "confirm this answer");
  }
}

function normalizeAnswer({ proposal, question, context, allowedEvidenceIds, forbidden }) {
  const answer = cleanText(proposal?.answer);
  const ids = Array.isArray(proposal?.evidenceIds) ? proposal.evidenceIds.map(String) : [];
  const gap = cleanText(proposal?.gap);
  if (!answer) {
    return question.required === false
      ? optionalSkippedAnswer(question)
      : needsYouAnswer(question, "draft an answer for this question");
  }
  if (needsUser(answer) || gap) {
    if (question.required === false) return optionalSkippedAnswer(question);
    return {
      questionId: String(question.id),
      question: question.label,
      answer,
      evidenceIds: ids.filter((id) => allowedEvidenceIds.has(id)),
      required: true,
      uploadReady: false,
      gap: gap || "needs-user-input",
    };
  }
  const invalidEvidence = ids.filter((id) => !allowedEvidenceIds.has(id));
  if (!ids.length || invalidEvidence.length) {
    return question.required === false
      ? optionalSkippedAnswer(question)
      : needsYouAnswer(question, "confirm evidence for this answer");
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
      required: question.required !== false,
      uploadReady: true,
      gap: null,
    };
  } catch (err) {
    return question.required === false
      ? optionalSkippedAnswer(question)
      : needsYouAnswer(question, err?.message || "revise this answer");
  }
}

function manualAnswers(questions, reason) {
  return questions.map((question) =>
    question.required === false ? optionalSkippedAnswer(question) : needsYouAnswer(question, reason)
  );
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

// Deterministic disclosure answers still run through the same honesty-
// boundary enforcement as AI-drafted answers (buildShortAnswer +
// combined forbidden wording) — a resolved disclosure answer that conflicts
// with a confirmed boundary converts to the literal NEEDS YOU marker rather
// than silently bypassing enforcement just because it wasn't AI-drafted.
function disclosureAnswerEntry(question, resolved, { honesty, forbidden } = {}) {
  try {
    const answer = buildShortAnswer({
      question: question.label,
      answer: resolved.answer,
      honesty,
      forbidden,
    });
    return {
      questionId: String(question.id),
      question: question.label,
      answer,
      evidenceIds: [],
      required: question.required !== false,
      uploadReady: true,
      gap: null,
      disclosure: true,
      source: resolved.source,
    };
  } catch (err) {
    return needsYouAnswer(question, err?.message || "confirm this disclosure answer");
  }
}

// Split captured questions into ones answerable deterministically from setup
// and everything else, which still goes to AI. Standard identity/contact/link
// fields use the same form-fill map as the supervised apply path, disclosure
// answers keep their richer wording, and the generated resume satisfies a
// resume upload without asking the user to answer a file field in prose.
function partitionDeterministicAnswers({
  questions,
  formDefaults,
  profile,
  honesty,
  forbidden,
  applicationUrl,
}) {
  const deterministic = [];
  const aiBatch = [];
  const portal = hostnameToPortal(applicationUrl);
  const plans = buildFillPlan({ fields: questions, formDefaults, profile, honesty, portal });
  for (const [index, question] of questions.entries()) {
    const resolved = resolveDisclosureAnswer(question, { formDefaults, profile });
    if (resolved) {
      deterministic.push(disclosureAnswerEntry(question, resolved, { honesty, forbidden }));
    } else if (isResumeUpload(question)) {
      deterministic.push(generatedResumeAnswer(question));
    } else if (plans[index]?.action === "fill") {
      deterministic.push(
        configuredAnswerEntry(question, plans[index], {
          honesty,
          forbidden,
        })
      );
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
  const application = context?.application || context?.app || {};
  // Computed once, ahead of the deterministic/AI split, so deterministic
  // disclosure answers enforce the exact same combined forbidden wording
  // (evidence + honesty + confirmed boundaries) the AI batch does below.
  const honesty = context?.honesty || {};
  const forbidden = forbiddenForContext(context);
  const { deterministic, aiBatch } = partitionDeterministicAnswers({
    questions: answerable,
    formDefaults,
    profile,
    honesty,
    forbidden,
    applicationUrl:
      application.link ||
      application.url ||
      application.sourceUrl ||
      context?.job?.frontmatter?.url,
  });
  const deterministicMap = new Map(deterministic.map((answer) => [answer.questionId, answer]));

  if (aiBatch.length === 0) {
    const answers = answerable.map((question) => deterministicMap.get(String(question.id)));
    return {
      answers,
      excludedQuestionIds,
      uploadReady: answers.every((answer) => answer.uploadReady || answer.required === false),
      ai: { used: false },
      manual: {
        required: answers.some((answer) => !answer.uploadReady && answer.required !== false),
      },
    };
  }

  // Built once so the same storyHints selection both goes into the prompt
  // and scopes this batch's allowed `story:<id>` citation set below — a
  // story absent from THIS answers prompt is never citable in an answer.
  const visibleSources = withoutPrivateFields(
    buildPromptVisibleSources(context, null, { purpose: "answers" })
  );
  const prompt = promptFor({ visibleSources, questions: aiBatch });

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
      'Draft short application answers. Every answer must cite at least one id from confirmedEvidence.claims or storyHints (cite a story as "story:<id>") in evidenceIds, and only ids from those lists — never a story id outside the storyHints provided here. Use NEEDS YOU when evidence is missing. roleSignals are the candidate\'s confirmed framing preferences (keep = emphasize, cut = de-emphasize) and never license stating anything not already grounded in confirmedEvidence.claims or storyHints. Do not answer demographic or EEO prompts.',
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
  const allowedEvidenceIds = evidenceIds(context, visibleSources.storyHints);
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
    uploadReady: answers.every((answer) => answer.uploadReady || answer.required === false),
    ai: aiResult.body.ai,
    manual: {
      required: answers.some((answer) => !answer.uploadReady && answer.required !== false),
    },
  };
}
