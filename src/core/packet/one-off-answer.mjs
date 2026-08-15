import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import {
  activityAppend,
  appRegisterArtifact,
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

function upsertAnswerBlock(markdown, answer) {
  const key = normalizeScreeningQuestionKey(answer.question);
  const start = `<!-- careerrat-screening:${key} -->`;
  const end = `<!-- /careerrat-screening:${key} -->`;
  const block = answerMarkdownBlock(answer);
  const pattern = new RegExp(`${regexEscape(start)}[\\s\\S]*?${regexEscape(end)}`, "g");
  if (pattern.test(markdown)) return markdown.replace(pattern, block);
  return `${markdown.trimEnd()}\n\n${block}\n`;
}

function appendToTrackedAnswers({ repoRoot, env, application, answers }) {
  const storedPath = application?.artifacts?.answersSource || application?.artifacts?.answers;
  if (typeof storedPath !== "string" || !storedPath.trim()) return null;
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const fullPath = safeWorkspaceArtifactPath(workspaceDir, storedPath);
  if (!fullPath || !existsSync(fullPath)) {
    const error = new Error("the tracked answers artifact is missing or outside the workspace");
    error.code = "BAD_PACKET_ARTIFACT";
    throw error;
  }
  let markdown = readFileSync(fullPath, "utf8");
  for (const answer of answers) markdown = upsertAnswerBlock(markdown, answer);
  writeFileSync(fullPath, markdown, "utf8");
  appRegisterArtifact({
    repoRoot,
    env,
    id: application.id,
    kind: "answers",
    path: storedPath,
    note: "Added a reviewed one-off screening answer.",
  });
  return storedPath;
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
  const capture = await captureQuestionsImpl({
    repoRoot,
    env,
    source: "paste",
    manualText: text,
  });
  const context = application
    ? buildContextImpl({ repoRoot, env, applicationId: application.id })
    : candidateAnswerContext({ repoRoot, env });
  const drafted = await draftAnswersImpl({
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
    return {
      key: normalizeScreeningQuestionKey(question),
      question,
      answer: cleanText(answer.answer),
      source: answerSource(answer),
      durable: uploadReady && isDurableScreeningQuestion(question),
      uploadReady,
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
