import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fetchFormQuestions, parseManualQuestions } from "../apply/form-questions.mjs";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { appRegisterPacketQuestionCapture } from "../db/verbs.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import { validate } from "../profile/schema-validator.mjs";
import { packetQuestionCaptureArtifactSchema } from "./schemas/packet-schemas.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function slugPart(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "application"
  );
}

function workspaceDisplayPath(relPath) {
  return `workspace/${relPath.replaceAll(sep, "/")}`;
}

function readApplication({ repoRoot, env, appId }) {
  const db = requireDb({ repoRoot, env });
  const tracker = assembleTrackerObject(db);
  const apps = Array.isArray(tracker.applications) ? tracker.applications : [];
  const app = apps.find((row) => String(row?.id) === String(appId));
  if (!app) {
    const err = new Error(`no application with id "${appId}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return app;
}

function normalizeQuestion(question, fallbackId) {
  const label = cleanText(question?.label);
  if (!label) return null;
  return {
    id: cleanText(question?.id) || fallbackId,
    label,
    type: cleanText(question?.type) || "text",
    required: question?.required !== false,
    options: Array.isArray(question?.options) ? question.options.map(String) : null,
  };
}

export function classifySelfIdentificationQuestion(label) {
  const text = cleanText(label).toLowerCase();
  const patterns = [
    ["disability", /\b(disability|disabled|reasonable accommodation)\b/],
    ["veteran", /\b(veteran|armed forces|military status)\b/],
    ["gender", /\b(gender|sex assigned|sexual orientation|pronouns?)\b/],
    ["race_ethnicity", /\b(race|ethnicity|hispanic|latino|indigenous|asian|black|white)\b/],
    ["demographic", /\b(voluntary self-identification|self identification|demographic)\b/],
    ["eeo", /\b(eeo|equal employment|affirmative action)\b/],
  ];
  for (const [reason, pattern] of patterns) {
    if (pattern.test(text)) return { excluded: true, reason };
  }
  return { excluded: false, reason: null };
}

export function filterAnswerableQuestions({ captures } = {}) {
  const list = Array.isArray(captures) ? captures : captures ? [captures] : [];
  const answerable = [];
  const excluded = [];
  let demographicSectionPresent = false;

  for (const capture of list) {
    if (capture?.demographicSectionPresent) demographicSectionPresent = true;
    const questions = Array.isArray(capture?.questions) ? capture.questions : [];
    for (let i = 0; i < questions.length; i++) {
      const q = normalizeQuestion(questions[i], `q${answerable.length + excluded.length + 1}`);
      if (!q) continue;
      const selfId = classifySelfIdentificationQuestion(q.label);
      if (selfId.excluded) {
        excluded.push({ ...q, reason: selfId.reason });
      } else {
        answerable.push(q);
      }
    }
  }

  return { answerable, excluded, demographicSectionPresent };
}

async function captureFromInput({ source, url, manualText, text, questions, fetchImpl }) {
  if (source === "url" || source === "greenhouse" || source === "ashby") {
    if (!url) throw new Error("capturePacketQuestions: url is required for url source");
    return fetchFormQuestions(url, { fetchImpl });
  }
  if (source === "rendered") {
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("capturePacketQuestions: questions are required for rendered source");
    }
    return {
      source: "rendered",
      url: url || null,
      questions,
      demographicSectionPresent: questions.some(
        (question) => classifySelfIdentificationQuestion(question?.label).excluded
      ),
    };
  }
  const pasted = cleanText(manualText || text);
  if (!pasted) throw new Error("capturePacketQuestions: manualText is required for paste source");
  return parseManualQuestions(pasted, { url });
}

function artifactPayload({ capture, filtered, capturedAt }) {
  return {
    source: capture.source || "manual",
    url: capture.url || null,
    capturedAt,
    questions: filtered.answerable,
    excluded: filtered.excluded,
    answerableIds: filtered.answerable.map((q) => q.id),
    excludedIds: filtered.excluded.map((q) => q.id),
    demographicSectionPresent: Boolean(filtered.demographicSectionPresent),
  };
}

function validateArtifact(payload) {
  const result = validate(payload, packetQuestionCaptureArtifactSchema);
  if (!result.valid) {
    const err = new Error("packet question capture artifact is invalid");
    err.code = "BAD_PACKET_QUESTIONS";
    err.details = result.errors;
    throw err;
  }
}

function artifactPathFor({ repoRoot, env, appId, app }) {
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const rel = join(
    "jobs",
    `${slugPart(app?.company)}-${slugPart(app?.role)}-${slugPart(appId)}.questions.json`
  );
  return { workspaceDir, full: join(workspaceDir, rel) };
}

export async function capturePacketQuestions({
  repoRoot,
  env = process.env,
  appId,
  applicationId,
  source = "paste",
  url = "",
  manualText = "",
  text = "",
  questions,
  fetchImpl,
} = {}) {
  const id = cleanText(applicationId || appId);
  const capture = await captureFromInput({
    source,
    url,
    manualText,
    text,
    questions,
    fetchImpl,
  });
  const filtered = filterAnswerableQuestions({ captures: [capture] });
  const capturedAt = new Date().toISOString();
  const payload = artifactPayload({ capture, filtered, capturedAt });
  validateArtifact(payload);

  let artifacts = null;
  let packetManifest = null;
  if (repoRoot && id) {
    const app = readApplication({ repoRoot, env, appId: id });
    const { workspaceDir, full } = artifactPathFor({ repoRoot, env, appId: id, app });
    mkdirSync(join(workspaceDir, "jobs"), { recursive: true });
    writeFileSync(full, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const displayPath = workspaceDisplayPath(relative(workspaceDir, full));
    const result = appRegisterPacketQuestionCapture({
      repoRoot,
      env,
      id,
      path: displayPath,
      capturedAt,
      questions: filtered.answerable,
      excluded: filtered.excluded,
      demographicSectionPresent: filtered.demographicSectionPresent,
    });
    const updated = readApplication({ repoRoot, env, appId: id });
    artifacts = {
      packetQuestionsSource: displayPath,
      packetQuestionsCapturedAt: capturedAt,
      packetQuestionCount: filtered.answerable.length,
      packetQuestionExcludedCount: filtered.excluded.length,
    };
    packetManifest = updated.packetManifest || { questions: result.packetManifest };
  }

  return {
    appId: id || null,
    source: payload.source,
    capturedAt,
    questions: filtered.answerable,
    excluded: filtered.excluded,
    demographicSectionPresent: filtered.demographicSectionPresent,
    artifacts,
    packetManifest,
  };
}

export async function loadPacketQuestionCapture({
  repoRoot,
  env = process.env,
  appId,
  applicationId,
} = {}) {
  const id = cleanText(applicationId || appId);
  const app = readApplication({ repoRoot, env, appId: id });
  const source = app?.artifacts?.packetQuestionsSource;
  if (!source) {
    const err = new Error(`no packet question capture for application "${id}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const rel = source.startsWith("workspace/") ? source.slice("workspace/".length) : source;
  const full = join(workspaceDir, rel);
  if (!existsSync(full)) {
    const err = new Error(`packet question capture artifact is missing for application "${id}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const payload = JSON.parse(readFileSync(full, "utf8"));
  validateArtifact(payload);
  return payload;
}
