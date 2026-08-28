import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import {
  appRegisterArtifact,
  candidateArtifactGet,
  candidateConfigGet,
  deepIngestConfirmedForGeneration,
} from "../db/verbs.mjs";
import { resolveRoleFamily } from "../deep-ingest/role-signal-overlay.mjs";
import { parseSavedJob } from "../evaluate/gate.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import {
  composePacketWritingVoice,
  filterClaimableStories,
  selectPacketRoleSignals,
} from "./deep-ingest-sources.mjs";

const JOB_BODY_MIN_CHARS = 40;

function cleanText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function slugPart(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "application";
}

function workspaceDisplayPath(relPath) {
  return `workspace/${relPath.replaceAll(sep, "/")}`;
}

function safeWorkspacePath(workspaceDir, storedPath) {
  const raw = String(storedPath || "").trim();
  if (!raw || raw.includes("\0") || isAbsolute(raw)) return null;
  const withoutPrefix = raw.startsWith("workspace/") ? raw.slice("workspace/".length) : raw;
  const normalized = normalize(withoutPrefix);
  if (!normalized || normalized === "." || normalized.startsWith("..")) return null;
  const full = join(workspaceDir, normalized);
  if (full !== workspaceDir && !full.startsWith(`${workspaceDir}${sep}`)) return null;
  return full;
}

function readSavedJobBody(workspaceDir, storedPath) {
  const full = safeWorkspacePath(workspaceDir, storedPath);
  if (!full || !existsSync(full)) return null;
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSavedJob(text);
  if (parsed.frontmatter?.partial === true) return null;
  const body = cleanText(parsed.body || text);
  if (body.length < JOB_BODY_MIN_CHARS) return null;
  return { body, path: storedPath };
}

function withoutCurrentComp(value) {
  if (Array.isArray(value)) return value.map(withoutCurrentComp);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "current_base") continue;
    out[key] = withoutCurrentComp(child);
  }
  return out;
}

function findApplication(tracker, applicationId) {
  const apps = Array.isArray(tracker.applications) ? tracker.applications : [];
  return apps.find((app) => String(app?.id) === String(applicationId)) || null;
}

export function capturePacketJobBody({
  repoRoot,
  env = process.env,
  applicationId,
  body,
  sourceUrl,
} = {}) {
  const normalized = cleanText(body);
  if (normalized.length < JOB_BODY_MIN_CHARS) {
    const err = new Error("readable job body is required");
    err.code = "MISSING_JOB_BODY";
    throw err;
  }

  const db = requireDb({ repoRoot, env });
  const tracker = assembleTrackerObject(db);
  const app = findApplication(tracker, applicationId);
  if (!app) {
    const err = new Error(`no application with id "${applicationId}"`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const rel = join(
    "jobs",
    `${slugPart(app.company)}-${slugPart(app.role)}-${slugPart(applicationId)}.md`
  );
  const full = join(workspaceDir, rel);
  mkdirSync(join(workspaceDir, "jobs"), { recursive: true });
  const markdown = [
    "---",
    `company: ${JSON.stringify(app.company || "")}`,
    `role: ${JSON.stringify(app.role || "")}`,
    `applicationId: ${JSON.stringify(String(applicationId))}`,
    sourceUrl ? `sourceUrl: ${JSON.stringify(sourceUrl)}` : null,
    "---",
    "",
    "# Job Description",
    "",
    normalized,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
  writeFileSync(full, markdown, "utf8");

  const displayPath = workspaceDisplayPath(relative(workspaceDir, full));
  appRegisterArtifact({
    repoRoot,
    env,
    id: applicationId,
    kind: "jd",
    path: displayPath,
    note: sourceUrl || "captured for packet gate",
  });

  return { body: normalized, path: displayPath };
}

export function buildPacketContext({
  repoRoot,
  env = process.env,
  applicationId,
  capturedJobBody = null,
  capturedJobPath = null,
} = {}) {
  const db = requireDb({ repoRoot, env });
  const tracker = assembleTrackerObject(db);
  const app = findApplication(tracker, applicationId);
  if (!app) {
    const err = new Error(`no application with id "${applicationId}"`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const applicationAnswers = Array.isArray(app.packetManifest?.confirmedAnswers)
    ? app.packetManifest.confirmedAnswers.map((answer) => ({
        ...answer,
        source: "application-confirmed",
      }))
    : [];
  let jobBody = cleanText(capturedJobBody);
  let jdPath = capturedJobPath || null;
  if (!jobBody) {
    const saved = readSavedJobBody(workspaceDir, app.artifacts?.jd);
    if (saved) {
      jobBody = saved.body;
      jdPath = saved.path;
    }
  }

  const config = candidateConfigGet({ repoRoot, env });
  const candidate = withoutCurrentComp(config.profile || {});
  const sourceResume = candidateArtifactGet({
    repoRoot,
    env,
    id: "source-resume",
    kind: "source-resume",
  });

  // Promotion-pipeline read-time wiring (promotion-pipeline-design-2026-07-19.md):
  // the four confirmed Library lanes, read fresh on every packet build, never
  // materialized elsewhere. With all four lanes empty, every field added below
  // degrades to today's dead defaults ([]/"") — zero behavior change for
  // existing installs. Honesty fails closed (Decision 9): a read/parse failure
  // there throws out of buildPacketContext entirely, same as any other error
  // in this function.
  const deepIngest = deepIngestConfirmedForGeneration({ repoRoot, env });
  const roleFamily = resolveRoleFamily({ roleTitle: app.role, targeting: config.targeting });
  const forbiddenVoicePhrases = deepIngest.honestyBoundaries
    .map((boundary) => boundary.forbiddenWording)
    .filter(Boolean);

  return {
    applicationId,
    app: {
      id: app.id,
      company: app.company ?? null,
      role: app.role ?? null,
      status: app.status ?? null,
      interviewAt: app.interviewAt ?? null,
      nextInterviewAt: app.nextInterviewAt ?? null,
      interviewNote: app.interviewNote ?? null,
      conversations: Array.isArray(app.conversations) ? app.conversations : [],
      artifacts: { ...(app.artifacts || {}) },
      evaluation: app.evaluation ? { ...app.evaluation } : null,
      packetManifest: app.packetManifest || null,
    },
    job: {
      body: jobBody,
      path: jdPath,
      frontmatter: {
        company: app.company ?? "",
        role: app.role ?? "",
        location: app.location ?? "",
        mode: app.mode ?? "",
        comp: app.compNote ?? "",
      },
    },
    candidate,
    profile: candidate,
    targeting: withoutCurrentComp(config.targeting || {}),
    evidence: { claims: config.evidence?.claims || [] },
    ...(config.honesty ? { honesty: config.honesty } : {}),
    ...(sourceResume ? { sourceResume } : {}),
    // Full claimable set — purpose-specific scoring/caps happen later, at
    // prompt-build time, via selectPacketStories (see generate.mjs).
    storiesLearnings: filterClaimableStories(deepIngest.storyBank),
    writingVoice: composePacketWritingVoice({
      writingVoice: deepIngest.writingVoice,
      forbiddenPhrases: forbiddenVoicePhrases,
    }),
    // Uncapped — enforcement (forbiddenWordingFor) needs completeness; the
    // capped/stripped prompt-display projection happens downstream.
    honestyBoundariesConfirmed: deepIngest.honestyBoundaries,
    roleSignals: selectPacketRoleSignals({
      roleSignals: deepIngest.roleSignals,
      family: roleFamily,
    }),
    deepIngestDiagnostics: deepIngest.skipped,
    applicationAnswers,
  };
}

export function hasReadableJobBody(context) {
  return cleanText(context?.job?.body).length >= JOB_BODY_MIN_CHARS;
}

export function packetPromptFromContext(context) {
  const candidateContext = {
    profile: context.profile || {},
    targeting: context.targeting || {},
    evidence: context.evidence || { claims: [] },
    honesty: context.honesty || {},
  };
  return [
    `Company: ${context.app.company || ""}`,
    `Role: ${context.app.role || ""}`,
    "",
    "Job Description:",
    cleanText(context.job.body),
    "",
    "Candidate context (private, local, current compensation removed):",
    JSON.stringify(candidateContext, null, 2),
    "",
    "Return one typed packet-gate verdict. Base fit only on the candidate context and saved job description. Parse guaranteed base pay into numeric minBase/maxBase. Parse expected annual cash earnings, including wages, tips, commissions, and recurring cash bonuses but excluding equity and benefits, into minAnnualEarnings/maxAnnualEarnings. Never copy annual earnings into base pay. Set basis to base or annual-earnings for the candidate floor being evaluated, or null when no comparable band exists. An explicit comparable maximum below the floor is below-floor, an overlapping range stays unknown for review, and an unposted range stays unknown. Guaranteed base pay may clear an annual-earnings floor. Never invent compensation or evidence.",
    "Use complete plain-English sentences. Keep fitSummary within 150 characters, compensation.summary within 130 characters, and every fitReasons/fitRisks item within 72 characters. Never shorten copy by switching languages, clipping words, or appending fragments.",
    "Every display string must be final user-facing copy. Do not include questions, drafting notes, self-corrections, editing chatter, or markdown fences inside a field.",
  ].join("\n");
}
