import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { appRegisterInterviewDossier } from "../db/verbs.mjs";
import { buildPacketContext, hasReadableJobBody } from "../packet/context.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import { renderInterviewPacket } from "./packet.mjs";

const AUDIENCES = new Set(["recruiter", "hiring-manager", "technical", "panel"]);

function clean(value) {
  return String(value || "").trim();
}

function normalizedWords(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugPart(value) {
  return (
    clean(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "application"
  );
}

function displayPath(workspaceDir, fullPath) {
  return `workspace/${relative(workspaceDir, fullPath).replaceAll(sep, "/")}`;
}

function dedupeStrings(values, limit = 12) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = clean(value);
    const key = normalizedWords(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function appearsInJob(signal, normalizedBody) {
  const phrase = normalizedWords(signal);
  return phrase.length >= 2 && normalizedBody.includes(phrase);
}

// Only phrases actually present in the captured JD are promoted as job
// signals. Candidate evidence/targeting tells us what phrases are meaningful;
// it never licenses inventing a requirement the posting did not state.
export function deriveInterviewJobSignals(context, requestedSignals = []) {
  const body = normalizedWords(context?.job?.body);
  if (!body) return [];

  const candidates = [];
  candidates.push(...(Array.isArray(requestedSignals) ? requestedSignals : []));
  for (const claim of context?.evidence?.claims || []) {
    candidates.push(...(Array.isArray(claim?.role_signals) ? claim.role_signals : []));
  }
  candidates.push(
    ...(Array.isArray(context?.targeting?.keep_signals) ? context.targeting.keep_signals : [])
  );
  for (const row of context?.roleSignals || []) {
    if (row?.signalType === "keep") candidates.push(row.text);
  }

  return dedupeStrings(candidates.filter((signal) => appearsInJob(signal, body)));
}

function latestConversation(app) {
  const conversations = Array.isArray(app?.conversations) ? app.conversations : [];
  return conversations.length ? conversations[conversations.length - 1] : null;
}

function roundFromApp(app) {
  const note = clean(app?.interviewNote);
  if (note) {
    const first = note.split(/\s+[—–-]\s+/, 1)[0].trim();
    if (first) return first;
  }
  const kind = clean(latestConversation(app)?.kind);
  return kind ? kind.replace(/\b\w/g, (character) => character.toUpperCase()) : "Interview";
}

function inferAudience(app, requestedAudience) {
  const requested = clean(requestedAudience).toLowerCase();
  if (AUDIENCES.has(requested)) return requested;
  const roundText = normalizedWords(
    `${app?.interviewNote || ""} ${latestConversation(app)?.kind || ""}`
  );
  if (/recruiter|screen|phone|human resources|\bhr\b/.test(roundText)) return "recruiter";
  if (/hiring manager|manager|director|leadership/.test(roundText)) return "hiring-manager";
  if (/technical|coding|system design|assessment|pair programming/.test(roundText)) {
    return "technical";
  }
  if (/onsite|panel|loop|final/.test(roundText)) return "panel";
  return null;
}

function interviewStories(stories) {
  return (Array.isArray(stories) ? stories : []).map((story) => ({
    ...story,
    role_signals: Array.isArray(story.role_signals)
      ? story.role_signals
      : Array.isArray(story.roleSignals)
        ? story.roleSignals
        : [],
    evidence_ids: Array.isArray(story.evidence_ids)
      ? story.evidence_ids
      : Array.isArray(story.evidenceIds)
        ? story.evidenceIds
        : [],
    prompts: Array.isArray(story.prompts) ? story.prompts : [],
  }));
}

export function buildInterviewDossier({
  repoRoot,
  env = process.env,
  applicationId,
  audience,
  inviteNotes,
  jobSignals = [],
  now = new Date(),
} = {}) {
  const id = clean(applicationId);
  if (!id) {
    const err = new Error("applicationId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const context = buildPacketContext({ repoRoot, env, applicationId: id });
  if (!hasReadableJobBody(context)) {
    const err = new Error(
      "Capture the job description before preparing this interview so the dossier can stay role-specific and evidence-grounded."
    );
    err.code = "MISSING_JOB_BODY";
    throw err;
  }

  const signals = deriveInterviewJobSignals(context, jobSignals);
  const inferredAudience = inferAudience(context.app, audience);
  const round = roundFromApp(context.app);
  const markdown = renderInterviewPacket({
    job: { ...context.job, signals },
    profile: context.profile,
    evidence: context.evidence,
    honesty: context.honesty || {},
    application: context.app,
    inviteNotes: clean(inviteNotes) || clean(context.app.interviewNote) || undefined,
    audience: inferredAudience || undefined,
    stories: interviewStories(context.storiesLearnings),
  }).trim();

  const generatedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const outputDir = join(workspaceDir, "interview-prep");
  const fullPath = join(
    outputDir,
    `${slugPart(context.app.company)}-${slugPart(context.app.role)}-${slugPart(id)}.md`
  );
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(fullPath, markdown, "utf8");

  const dossier = {
    title: `${context.app.company || "Unknown company"}, ${context.app.role || "Open role"}`,
    round,
    path: displayPath(workspaceDir, fullPath),
    generatedAt,
    markdown,
  };
  const persisted = appRegisterInterviewDossier({ repoRoot, env, id, dossier });
  return {
    applicationId: id,
    company: context.app.company,
    role: context.app.role,
    dossier: persisted.dossier,
    audience: inferredAudience,
    jobSignals: signals,
    persisted,
  };
}
