import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import {
  activityAppend,
  appRegisterArtifact,
  appRegisterPacketArtifacts,
  candidateConfigGet,
  candidateConfigPatch,
} from "../db/verbs.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import { draftPacketAnswers } from "./answers.mjs";
import { buildPacketContext } from "./context.mjs";
import { capturePacketQuestions } from "./questions.mjs";

const DURABLE_QUESTION_PATTERNS = [
  /\b(authori[sz](?:ed|ation)|eligible)\b.{0,40}\bwork\b|\bwork\s+authori[sz]ation\b/i,
  /\b(sponsor(?:ship)?|visa\s+status)\b/i,
  /\b(relocat(?:e|ion)|willing\s+to\s+move)\b/i,
  /\bnotice\s+period\b/i,
  /\b(security\s+clearance|clearance\s+status|active\s+clearance)\b/i,
  /\b(start\s+date|when\s+can\s+you\s+start|availability\s+to\s+start|earliest.{0,30}\bstart)\b/i,
];

function cleanText(value) {
  return String(value || "").trim();
}

function needsUser(value) {
  return /^NEEDS YOU\b/i.test(cleanText(value));
}

export function normalizeScreeningQuestionKey(question) {
  return cleanText(question)
    .replace(/^(?:q(?:uestion)?\s*[:.#-]?\s*|\d+[.)-]\s*)/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isDurableScreeningQuestion(question) {
  const text = cleanText(question);
  return Boolean(text && DURABLE_QUESTION_PATTERNS.some((pattern) => pattern.test(text)));
}

function readApplication({ repoRoot, env, applicationId }) {
  if (!applicationId) return null;
  const tracker = assembleTrackerObject(requireDb({ repoRoot, env }));
  const application = (tracker.applications || []).find(
    (row) => String(row?.id) === String(applicationId)
  );
  if (!application) {
    const error = new Error(`no application with id "${applicationId}"`);
    error.code = "NOT_FOUND";
    throw error;
  }
  return application;
}

function candidateAnswerContext({ repoRoot, env }) {
  const config = candidateConfigGet({ repoRoot, env });
  return {
    candidate: config.profile || {},
    profile: config.profile || {},
    targeting: config.targeting || {},
    evidence: config.evidence || { claims: [] },
    honesty: config.honesty || {},
  };
}

function answerSource(answer) {
  if (needsUser(answer?.answer)) return "needs-you";
  const source = cleanText(answer?.source).toLowerCase();
  if (source.includes("screening_answers") || source.includes("screening answers")) {
    return "screening_answers";
  }
  if (source.includes("profile") || source.includes("candidate setup")) return "profile";
  if (source === "mixed") return "mixed";
  if (Array.isArray(answer?.evidenceIds) && answer.evidenceIds.length > 0) return "evidence";
  return source || "profile";
}

function safeWorkspaceArtifactPath(workspaceDir, storedPath) {
  const raw = cleanText(storedPath);
  if (!raw || raw.includes("\0") || isAbsolute(raw)) return null;
  const relativePath = raw.startsWith("workspace/") ? raw.slice("workspace/".length) : raw;
  const normalizedPath = normalize(relativePath);
  if (!normalizedPath || normalizedPath === "." || normalizedPath.startsWith("..")) return null;
  const fullPath = join(workspaceDir, normalizedPath);
  if (fullPath !== workspaceDir && !fullPath.startsWith(`${workspaceDir}${sep}`)) return null;
  return fullPath;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function answerMarkdownBlock(answer) {
  const marker = normalizeScreeningQuestionKey(answer.question);
  return [
    `<!-- careerrat-screening:${marker} -->`,
    `**Q:** ${answer.question}`,
    "",
    `**A:** ${answer.answer}`,
    `<!-- /careerrat-screening:${marker} -->`,
  ].join("\n");
}

function answerBlockPattern(answer) {
  const key = normalizeScreeningQuestionKey(answer.question);
  const start = `<!-- careerrat-screening:${key} -->`;
  const end = `<!-- /careerrat-screening:${key} -->`;
  return new RegExp(`${regexEscape(start)}[\\s\\S]*?${regexEscape(end)}`, "g");
}

function replaceRenderedAnswerSection(markdown, answer) {
  const target = normalizeScreeningQuestionKey(answer.question);
  const lines = String(markdown || "").split("\n");
  const headingIndex = lines.findIndex((line) => {
    const match = line.match(/^##\s+(.+)$/);
    return match && normalizeScreeningQuestionKey(match[1]) === target;
  });
  if (headingIndex < 0) return null;

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index]) || /^<!-- careerrat-screening:/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  const updated = [
    ...lines.slice(0, headingIndex + 1),
    "",
    answer.answer,
    "",
    ...lines.slice(endIndex),
  ].join("\n");
  return `${updated.replace(answerBlockPattern(answer), "").trimEnd()}\n`;
}

function upsertAnswerBlock(markdown, answer, { replaceRendered = false } = {}) {
  const rendered = replaceRendered ? replaceRenderedAnswerSection(markdown, answer) : null;
  if (rendered) return rendered;
  const block = answerMarkdownBlock(answer);
  const pattern = answerBlockPattern(answer);
  if (pattern.test(markdown)) return markdown.replace(pattern, block);
  return `${markdown.trimEnd()}\n\n${block}\n`;
}

function appendToTrackedAnswers({
  repoRoot,
  env,
  application,
  answers,
  register = true,
  requireArtifact = false,
  replaceRendered = false,
}) {
  const storedPath = application?.artifacts?.answersSource || application?.artifacts?.answers;
  if (typeof storedPath !== "string" || !storedPath.trim()) {
    if (!requireArtifact) return null;
    const error = new Error("the tracked answers artifact is missing or outside the workspace");
    error.code = "BAD_PACKET_ARTIFACT";
    throw error;
  }
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const fullPath = safeWorkspaceArtifactPath(workspaceDir, storedPath);
  if (!fullPath || !existsSync(fullPath)) {
    const error = new Error("the tracked answers artifact is missing or outside the workspace");
    error.code = "BAD_PACKET_ARTIFACT";
    throw error;
  }
  let markdown = readFileSync(fullPath, "utf8");
  for (const answer of answers) {
    markdown = upsertAnswerBlock(markdown, answer, { replaceRendered });
  }
  writeFileSync(fullPath, markdown, "utf8");
  if (register) {
    appRegisterArtifact({
      repoRoot,
      env,
      id: application.id,
      kind: "answers",
      path: storedPath,
      note: "Added a reviewed one-off screening answer.",
    });
  }
  return storedPath;
}

function questionFromConfirmationGap(gap) {
  const message = cleanText(gap?.message);
  const quoted = message.match(/^Answer\s+[“"](.+?)[”"]\.?$/i);
  return quoted ? quoted[1] : "";
}

function suppliedQuestionAnswerPairs(text) {
  return cleanText(text)
    .split(/\s*(?:;|\r?\n)\s*/)
    .flatMap((segment) => {
      const delimiter = segment.match(/:\s+/);
      if (!delimiter || delimiter.index == null) return [];
      const question = cleanText(segment.slice(0, delimiter.index));
      const answer = cleanText(segment.slice(delimiter.index + delimiter[0].length));
      return question && answer ? [{ question, answer }] : [];
    });
}

function nonBlockingPacketGap(gap) {
  const kind = String(gap?.kind || "").toLowerCase();
  const code = String(gap?.code || "").toUpperCase();
  return (
    (kind === "answers" && code === "QUESTION_CAPTURE_DEFERRED") ||
    (kind === "coverletter" && code === "COVER_LETTER_CONFIRMATION")
  );
}

function matchingAnswerConfirmationGaps(
  gaps,
  { questionId, question },
  { allowQuestionFallback = false } = {}
) {
  const expectedId = cleanText(questionId);
  const expectedQuestion = normalizeScreeningQuestionKey(question);
  const openGaps = gaps
    .map((gap, index) => ({ gap, index }))
    .filter(({ gap }) => {
      return (
        String(gap?.code || "").toUpperCase() === "ANSWER_CONFIRMATION_REQUIRED" &&
        String(gap?.kind || "").toLowerCase() === "answers"
      );
    });
  if (expectedId) {
    const exact = openGaps.filter(({ gap }) => cleanText(gap?.questionId) === expectedId);
    if (exact.length > 0 || !allowQuestionFallback) return exact;
  }
  return openGaps.filter(({ gap }) => {
    const gapQuestion = normalizeScreeningQuestionKey(questionFromConfirmationGap(gap));
    return Boolean(expectedQuestion && gapQuestion && expectedQuestion === gapQuestion);
  });
}

function resolveAnswerConfirmationGap(gaps, answer, options) {
  const matches = matchingAnswerConfirmationGaps(gaps, answer, options);
  if (matches.length === 1) return { ...matches[0], ambiguous: false };
  return { gap: null, index: -1, ambiguous: matches.length > 1 };
}

export async function confirmOneOffScreeningAnswer({
  repoRoot,
  env = process.env,
  applicationId,
  questionId,
  question,
  answer,
  answers,
  now = () => new Date(),
} = {}) {
  const requested =
    Array.isArray(answers) && answers.length > 0 ? answers : [{ questionId, question, answer }];
  const reviewedAnswers = requested.map((entry) => ({
    questionId: cleanText(entry?.questionId) || null,
    question: cleanText(entry?.question),
    answer: cleanText(entry?.answer),
  }));
  if (
    !applicationId ||
    reviewedAnswers.length === 0 ||
    reviewedAnswers.some((entry) => !entry.question || !entry.answer)
  ) {
    const error = new Error("applicationId and complete reviewed answers are required");
    error.code = "BAD_REQUEST";
    throw error;
  }
  if (reviewedAnswers.some((entry) => needsUser(entry.answer))) {
    const error = new Error("an unanswered screening question cannot be confirmed");
    error.code = "NEEDS_USER";
    throw error;
  }

  const application = readApplication({ repoRoot, env, applicationId });
  const manifest = application.packetManifest;
  const gaps = Array.isArray(manifest?.gaps) ? manifest.gaps : [];
  const resolved = reviewedAnswers.map((entry) => resolveAnswerConfirmationGap(gaps, entry));
  if (resolved.some((match) => match.ambiguous)) {
    const error = new Error("the packet has more than one open confirmation for this question");
    error.code = "ANSWER_CONFIRMATION_AMBIGUOUS";
    throw error;
  }
  if (resolved.some((match) => match.index < 0)) {
    const error = new Error("the matching packet answer confirmation is no longer open");
    error.code = "ANSWER_CONFIRMATION_NOT_FOUND";
    throw error;
  }
  const canonicalQuestions = resolved.map((match) => questionFromConfirmationGap(match.gap));
  if (
    canonicalQuestions.some(
      (canonicalQuestion, index) =>
        !canonicalQuestion ||
        normalizeScreeningQuestionKey(canonicalQuestion) !==
          normalizeScreeningQuestionKey(reviewedAnswers[index].question)
    )
  ) {
    const error = new Error("the reviewed question does not match its open packet confirmation");
    error.code = "ANSWER_CONFIRMATION_MISMATCH";
    throw error;
  }
  const gapIndexes = new Set(resolved.map((match) => match.index));
  if (gapIndexes.size !== resolved.length) {
    const error = new Error("each reviewed answer must match a different open packet confirmation");
    error.code = "ANSWER_CONFIRMATION_AMBIGUOUS";
    throw error;
  }
  const confirmedAnswers = reviewedAnswers.map((entry, index) => ({
    ...entry,
    question: canonicalQuestions[index],
    questionId: cleanText(resolved[index].gap?.questionId) || entry.questionId,
  }));

  const artifactPath = appendToTrackedAnswers({
    repoRoot,
    env,
    application,
    answers: confirmedAnswers,
    register: false,
    requireArtifact: true,
    replaceRendered: true,
  });
  const remainingGaps = gaps.filter((_, index) => !gapIndexes.has(index));
  const uploadReady = remainingGaps.every(nonBlockingPacketGap);
  const confirmedAt = now().toISOString();
  const confirmedAnswerMap = new Map(
    (Array.isArray(manifest.confirmedAnswers) ? manifest.confirmedAnswers : []).map((entry) => [
      cleanText(entry?.questionId) || normalizeScreeningQuestionKey(entry?.question),
      entry,
    ])
  );
  for (const entry of confirmedAnswers) {
    confirmedAnswerMap.set(
      cleanText(entry.questionId) || normalizeScreeningQuestionKey(entry.question),
      { ...entry, confirmedAt }
    );
  }
  const artifacts = {
    answers: artifactPath,
    answersSource: artifactPath,
    answersGeneratedAt: confirmedAt,
  };
  const registered = appRegisterPacketArtifacts({
    repoRoot,
    env,
    id: application.id,
    artifacts,
    manifest: {
      ...manifest,
      gaps: remainingGaps,
      gapCount: remainingGaps.length,
      uploadReady,
      status: uploadReady ? "upload-ready" : "reviewable",
      confirmedAnswers: [...confirmedAnswerMap.values()],
      artifacts: { ...(manifest.artifacts || {}), ...artifacts },
    },
    note: "Confirmed a reviewed one-off screening answer.",
  });

  const first = confirmedAnswers[0];
  return {
    persisted: true,
    applicationId: application.id,
    questionId: first.questionId,
    question: first.question,
    answer: first.answer,
    answers: confirmedAnswers,
    artifactPath,
    packetManifest: registered.packetManifest,
  };
}

function activityEvent({ application, questionText }) {
  const summary = cleanText(questionText).replace(/\s+/g, " ").slice(0, 140);
  return {
    type: "system",
    actor: "agent",
    title: "Answered a screening question",
    summary,
    ...(application
      ? {
          refs: {
            applicationId: application.id,
            company: application.company,
            role: application.role,
          },
        }
      : {}),
    tags: ["skill:answer-question", "operation:screening:answer"],
  };
}

export async function draftOneOffScreeningAnswers({
  repoRoot,
  env = process.env,
  questionText,
  applicationId = null,
  captureQuestionsImpl = capturePacketQuestions,
  draftAnswersImpl = draftPacketAnswers,
  buildContextImpl = buildPacketContext,
  activityAppendImpl = activityAppend,
} = {}) {
  const text = cleanText(questionText);
  if (!text) {
    const error = new Error("questionText is required");
    error.code = "BAD_REQUEST";
    throw error;
  }

  const application = readApplication({ repoRoot, env, applicationId });
  const suppliedPairs = application ? suppliedQuestionAnswerPairs(text) : [];
  const capture = suppliedPairs.length
    ? {
        questions: suppliedPairs.map((pair, index) => ({
          id: `user-supplied-${index + 1}`,
          label: pair.question,
          type: "text",
          required: true,
        })),
        excluded: [],
      }
    : await captureQuestionsImpl({
        repoRoot,
        env,
        source: "paste",
        manualText: text,
      });
  const context = application
    ? buildContextImpl({ repoRoot, env, applicationId: application.id })
    : candidateAnswerContext({ repoRoot, env });
  const drafted = suppliedPairs.length
    ? {
        answers: suppliedPairs.map((pair, index) => ({
          questionId: capture.questions[index].id,
          question: pair.question,
          answer: pair.answer,
          source: "user",
          uploadReady: !needsUser(pair.answer),
          gap: null,
        })),
        ai: { used: false },
      }
    : await draftAnswersImpl({
        repoRoot,
        env,
        applicationId: application?.id,
        context,
        questions: {
          answerable: capture.questions || [],
          excluded: capture.excluded || [],
        },
      });
  const answers = (drafted.answers || []).map((answer) => {
    const question = cleanText(answer.question);
    const uploadReady = answer.uploadReady === true && !needsUser(answer.answer);
    const capturedMatches = (capture.questions || []).filter(
      (captured) =>
        normalizeScreeningQuestionKey(captured?.label) === normalizeScreeningQuestionKey(question)
    );
    const proposedQuestionId =
      cleanText(answer.questionId) ||
      (capturedMatches.length === 1 ? cleanText(capturedMatches[0]?.id) : "");
    const confirmation = application
      ? resolveAnswerConfirmationGap(
          application.packetManifest?.gaps || [],
          {
            questionId: proposedQuestionId,
            question,
          },
          { allowQuestionFallback: true }
        )
      : { gap: null, ambiguous: false };
    const canonicalQuestion = questionFromConfirmationGap(confirmation.gap) || question;
    return {
      key: normalizeScreeningQuestionKey(canonicalQuestion),
      questionId: cleanText(confirmation.gap?.questionId) || proposedQuestionId || null,
      question: canonicalQuestion,
      answer: cleanText(answer.answer),
      source: answerSource(answer),
      durable: uploadReady && isDurableScreeningQuestion(question),
      uploadReady,
      confirmationRequired: uploadReady && Boolean(confirmation.gap) && !confirmation.ambiguous,
      gap: answer.gap || null,
    };
  });
  const artifactPath = application
    ? appendToTrackedAnswers({ repoRoot, env, application, answers })
    : null;

  activityAppendImpl({
    repoRoot,
    env,
    event: activityEvent({ application, questionText: text }),
  });

  return {
    applicationId: application?.id || null,
    company: application?.company || null,
    role: application?.role || null,
    answers,
    excluded: capture.excluded || [],
    needsUser: answers.some((answer) => !answer.uploadReady),
    persisted: false,
    artifactPath,
    ai: drafted.ai || { used: false },
  };
}

export async function saveOneOffScreeningAnswer({
  repoRoot,
  env = process.env,
  question,
  answer,
  candidateConfigPatchImpl = candidateConfigPatch,
} = {}) {
  const cleanQuestion = cleanText(question);
  const cleanAnswer = cleanText(answer);
  if (!cleanQuestion || !cleanAnswer) {
    const error = new Error("question and answer are required");
    error.code = "BAD_REQUEST";
    throw error;
  }
  if (needsUser(cleanAnswer)) {
    const error = new Error("an unanswered screening question cannot be saved");
    error.code = "NEEDS_USER";
    throw error;
  }
  if (!isDurableScreeningQuestion(cleanQuestion)) {
    const error = new Error("job-specific screening answers are not reusable defaults");
    error.code = "NON_DURABLE_ANSWER";
    throw error;
  }

  const key = normalizeScreeningQuestionKey(cleanQuestion);
  await candidateConfigPatchImpl({
    repoRoot,
    env,
    name: "form-defaults",
    patch: { screening_answers: { [key]: cleanAnswer } },
  });
  return { persisted: true, key, question: cleanQuestion, answer: cleanAnswer };
}
