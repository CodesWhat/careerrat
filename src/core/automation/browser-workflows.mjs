import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { runBoundedAI } from "../ai/bounded-ai.mjs";
import { callAI } from "../ai/call-ai.mjs";
import { hostnameToPortal } from "../apply/form-fill.mjs";
import { appApplySyncedStatus } from "../db/verbs/app.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { commCaptureInbound } from "../db/verbs/comm.mjs";
import { linkedinProposalBatchPut } from "../db/verbs/linkedin-proposals.mjs";
import { relationshipLeadUpsertBatch } from "../db/verbs/relationship.mjs";
import { sourceWatermarkUpsert } from "../db/verbs/source.mjs";
import { userPath } from "../paths/workspace.mjs";
import {
  readAtsStatus,
  readLinkedinPeople,
  readLinkedinProfile,
  readPlatformMessageThreads,
  readWebmailThreads,
  readWellfoundPeople,
} from "./browser-adapters.mjs";
import { createConfiguredBrowserSession } from "./browser-session.mjs";
import { mayRun } from "./consent.mjs";
import { statusTransition, toTrackOutcomeStatus } from "./status-map.mjs";

const LINKEDIN_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["surfaces"],
  properties: {
    surfaces: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["surfaceId", "surface", "current", "proposed", "rationale", "evidenceRef"],
        properties: {
          surfaceId: { type: "string", minLength: 1, maxLength: 80 },
          surface: { type: "string", minLength: 1, maxLength: 120 },
          current: { type: "string", maxLength: 4_000 },
          proposed: { type: "string", minLength: 1, maxLength: 4_000 },
          rationale: { type: "string", minLength: 1, maxLength: 500 },
          evidenceRef: { type: "string", minLength: 1, maxLength: 240 },
        },
      },
    },
  },
};

function clean(value, max = 20_000) {
  return String(value || "")
    .replaceAll("\0", "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 18);
}

function workflowResult(skill, state, details = {}) {
  return {
    kind: "browser_workflow_result",
    skill,
    state,
    title: details.title || skill,
    summary: details.summary || "Workflow updated.",
    ...details,
  };
}

function blockerSummary(prefix, results) {
  const messages = results.map((result) => clean(result?.blocker?.message, 500)).filter(Boolean);
  if (!messages.length) return prefix;
  const remaining = messages.length - 1;
  return `${prefix} ${messages[0]}${remaining ? ` ${remaining} other source${remaining === 1 ? "" : "s"} also need attention.` : ""}`;
}

function artifactPath(kind, record) {
  return `workspace/comms/${kind}-${digest(
    `${record.id || record.href || "record"}\0${record.receivedAt || ""}\0${record.subject || ""}`
  )}.md`;
}

function writeCommunicationArtifact({ repoRoot, env, kind, record }) {
  const relativePath = artifactPath(kind, record);
  const absolutePath = userPath({ repoRoot, env }, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(
    absolutePath,
    [
      `# ${clean(record.subject || record.participant || "Job-search message", 500)}`,
      "",
      record.sender ? `From: ${clean(record.sender, 500)}` : null,
      record.participant ? `Participant: ${clean(record.participant, 500)}` : null,
      record.receivedAt ? `Received: ${clean(record.receivedAt, 100)}` : null,
      record.href ? `Source: ${clean(record.href, 1_000)}` : null,
      "",
      clean(record.body || record.preview),
      "",
    ]
      .filter((line) => line !== null)
      .join("\n"),
    { encoding: "utf8", mode: 0o600 }
  );
  return relativePath;
}

function matchApplication(record, applications) {
  const haystack = clean(
    `${record.subject || ""} ${record.sender || ""} ${record.company || ""} ${record.role || ""}`
  ).toLowerCase();
  let best = null;
  let score = 0;
  for (const app of Array.isArray(applications) ? applications : []) {
    const company = clean(app?.company, 200).toLowerCase();
    const role = clean(app?.role, 200).toLowerCase();
    const next =
      (company && haystack.includes(company) ? 3 : 0) + (role && haystack.includes(role) ? 2 : 0);
    if (next > score) {
      best = app;
      score = next;
    }
  }
  return score ? best : null;
}

function participantFromRecord(record) {
  const raw = clean(record.sender || record.participant, 500);
  const email = raw.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || raw.match(/[^\s<>]+@[^\s<>]+/)?.[0];
  const name = raw.replace(/<[^<>]+>/g, "").trim();
  return {
    ...(name && name !== email ? { name } : {}),
    ...(email ? { email } : {}),
  };
}

function fallbackCompany(record) {
  const explicit = clean(record.company, 120);
  if (explicit) return explicit;
  const participant = participantFromRecord(record);
  if (participant.name) return participant.name;
  const domain = participant.email?.split("@")[1]?.split(".")[0];
  return domain ? domain.replace(/[-_]+/g, " ") : "Recruiting contact";
}

function sessionFactory(createSessionImpl, base, platform) {
  return createSessionImpl({ ...base, platform });
}

async function readWithOwnedSession({ createSessionImpl, base, platform, read }) {
  const session = sessionFactory(createSessionImpl, base, platform);
  try {
    const result = await read(session);
    const keepOpen =
      !result?.ok &&
      ["auth_required", "verification_required", "challenge_required"].includes(result?.state);
    if (!keepOpen) await session.close?.();
    return result;
  } catch (error) {
    await session.close?.();
    throw error;
  }
}

function allowed(capability, platform, repoRoot, env) {
  return mayRun({ capability, platform, root: repoRoot, env }).allowed;
}

function sourceLastRun(sources, id) {
  return (
    (Array.isArray(sources) ? sources : []).find((source) => source.id === id)?.lastRunAt || null
  );
}

export async function ingestWebmailInApp({
  repoRoot,
  env = process.env,
  applications = [],
  sources = [],
  urls = {},
  now = () => new Date(),
  createSessionImpl = createConfiguredBrowserSession,
  readThreadsImpl = readWebmailThreads,
  captureInboundImpl = commCaptureInbound,
  watermarkImpl = sourceWatermarkUpsert,
} = {}) {
  const completedAt = now().toISOString();
  const results = [];
  let captured = 0;
  for (const platform of ["gmail", "outlook"]) {
    if (!allowed("mail_access", platform, repoRoot, env)) continue;
    const sourceId = `${platform}-webmail`;
    const read = await readWithOwnedSession({
      createSessionImpl,
      base: { repoRoot, env },
      platform,
      read: (session) =>
        readThreadsImpl({
          session,
          platform,
          url: urls[platform],
          since: sourceLastRun(sources, sourceId),
        }),
    });
    if (!read.ok) {
      results.push({ platform, state: read.state, blocker: read.blocker });
      continue;
    }
    let platformCaptured = 0;
    for (const record of read.records) {
      const application = matchApplication(record, applications);
      const artifact = writeCommunicationArtifact({
        repoRoot,
        env,
        kind: platform,
        record,
      });
      const write = captureInboundImpl({
        repoRoot,
        env,
        applicationId: application?.id,
        company: application?.company || fallbackCompany(record),
        role: application?.role || "Job-search correspondence",
        channel: "email",
        subject: clean(record.subject, 500),
        participant: participantFromRecord(record),
        summary: clean(record.preview || record.body || record.subject, 240),
        artifactPath: artifact,
        sourceId: clean(record.id || record.href, 500) || digest(JSON.stringify(record)),
        at: record.receivedAt || completedAt,
      });
      if (!write?.duplicate) {
        platformCaptured += 1;
        captured += 1;
      }
    }
    watermarkImpl({
      repoRoot,
      env,
      source: {
        id: sourceId,
        kind: "mail",
        name: `${platform} webmail`,
        lastRunAt: completedAt,
      },
      at: completedAt,
    });
    results.push({
      platform,
      state: "completed",
      scanned: read.records.length,
      captured: platformCaptured,
    });
  }
  const blockers = results.filter((result) => result.blocker);
  return workflowResult("ingest-mail", blockers.length ? "needs-user" : "completed", {
    title: "Webmail check",
    summary: blockers.length
      ? blockerSummary(`${captured} messages captured.`, blockers)
      : `${captured} new job-search message${captured === 1 ? "" : "s"} captured.`,
    captured,
    sources: results,
    blockers: blockers.map((result) => ({
      platform: result.platform,
      ...result.blocker,
    })),
    at: completedAt,
  });
}

export async function ingestPlatformMessagesInApp({
  repoRoot,
  env = process.env,
  applications = [],
  sources = [],
  urls = {},
  now = () => new Date(),
  createSessionImpl = createConfiguredBrowserSession,
  readThreadsImpl = readPlatformMessageThreads,
  captureInboundImpl = commCaptureInbound,
  watermarkImpl = sourceWatermarkUpsert,
} = {}) {
  const completedAt = now().toISOString();
  const results = [];
  let captured = 0;
  for (const platform of ["linkedin", "wellfound"]) {
    if (!allowed("messaging", platform, repoRoot, env)) continue;
    const sourceId = `${platform}-messages`;
    const read = await readWithOwnedSession({
      createSessionImpl,
      base: { repoRoot, env },
      platform,
      read: (session) =>
        readThreadsImpl({
          session,
          platform,
          url: urls[platform],
          since: sourceLastRun(sources, sourceId),
        }),
    });
    if (!read.ok) {
      results.push({ platform, state: read.state, blocker: read.blocker });
      continue;
    }
    let platformCaptured = 0;
    for (const record of read.records) {
      const application = matchApplication(record, applications);
      const artifact = writeCommunicationArtifact({
        repoRoot,
        env,
        kind: `${platform}-message`,
        record,
      });
      const write = captureInboundImpl({
        repoRoot,
        env,
        applicationId: application?.id,
        company: application?.company || fallbackCompany(record),
        role: application?.role || clean(record.role, 200) || "Job-search correspondence",
        channel: platform === "linkedin" ? "linkedin" : "portal",
        participant: participantFromRecord(record),
        summary: clean(record.preview || record.body, 240) || "New recruiting message",
        artifactPath: artifact,
        sourceId: clean(record.id || record.href, 500) || digest(JSON.stringify(record)),
        at: record.receivedAt || completedAt,
      });
      if (!write?.duplicate) {
        platformCaptured += 1;
        captured += 1;
      }
    }
    watermarkImpl({
      repoRoot,
      env,
      source: {
        id: sourceId,
        kind: "messages",
        name: `${platform} messages`,
        lastRunAt: completedAt,
      },
      at: completedAt,
    });
    results.push({
      platform,
      state: "completed",
      scanned: read.records.length,
      captured: platformCaptured,
    });
  }
  const blockers = results.filter((result) => result.blocker);
  return workflowResult("ingest-messages", blockers.length ? "needs-user" : "completed", {
    title: "Recruiting message check",
    summary: blockers.length
      ? blockerSummary(`${captured} messages captured.`, blockers)
      : `${captured} new recruiting message${captured === 1 ? "" : "s"} captured.`,
    captured,
    sources: results,
    blockers: blockers.map((result) => ({
      platform: result.platform,
      ...result.blocker,
    })),
    at: completedAt,
  });
}

export async function sourceRelationshipsInApp({
  repoRoot,
  env = process.env,
  company,
  applicationId = null,
  role = null,
  urls = {},
  now = () => new Date(),
  createSessionImpl = createConfiguredBrowserSession,
  readLinkedinImpl = readLinkedinPeople,
  readWellfoundImpl = readWellfoundPeople,
  writeLeadsImpl = relationshipLeadUpsertBatch,
} = {}) {
  const foundAt = now().toISOString();
  const results = [];
  const leads = [];
  for (const platform of ["linkedin", "wellfound"]) {
    if (!allowed("relationship_sourcing", platform, repoRoot, env)) continue;
    const read = await readWithOwnedSession({
      createSessionImpl,
      base: { repoRoot, env },
      platform,
      read: (session) =>
        (platform === "linkedin" ? readLinkedinImpl : readWellfoundImpl)({
          session,
          company,
          url: urls[platform],
        }),
    });
    if (!read.ok) {
      results.push({ platform, state: read.state, blocker: read.blocker });
      continue;
    }
    const platformLeads = read.records.map((record) => ({
      applicationId,
      company,
      role,
      name: clean(record.name, 160),
      title: clean(record.title, 200) || null,
      type: /recruit/i.test(record.title)
        ? "Recruiter"
        : /hiring/i.test(record.title)
          ? "Hiring team"
          : "Contact",
      platform,
      url: record.url,
      basis: clean(record.basis, 300) || `Found in ${platform} people search for ${company}.`,
      status: "review",
      foundAt,
    }));
    leads.push(...platformLeads);
    results.push({ platform, state: "completed", found: platformLeads.length });
  }
  if (leads.length) writeLeadsImpl({ repoRoot, env, leads });
  const blockers = results.filter((result) => result.blocker);
  return workflowResult("relationship-sourcing", blockers.length ? "needs-user" : "completed", {
    title: `Relationship sourcing at ${company}`,
    summary: blockers.length
      ? blockerSummary(
          `${leads.length} lead${leads.length === 1 ? "" : "s"} captured for review.`,
          blockers
        )
      : `${leads.length} lead${leads.length === 1 ? "" : "s"} captured for review.`,
    found: leads.length,
    sources: results,
    blockers: blockers.map((result) => ({
      platform: result.platform,
      ...result.blocker,
    })),
    at: foundAt,
  });
}

async function defaultLinkedinProposals({ repoRoot, env, surfaces }) {
  const context = {};
  for (const name of ["profile", "targeting", "evidence"]) {
    try {
      context[name] = candidateConfigGet({ repoRoot, env, name });
    } catch {
      context[name] = null;
    }
  }
  const result = await runBoundedAI({
    labels: {
      skill: "optimize-linkedin",
      action: "proposal-create",
      operation: "linkedin:profile-propose",
    },
    schema: LINKEDIN_PROPOSAL_SCHEMA,
    structuredMode: "native-preferred",
    outputName: "linkedin_profile_proposals",
    maxTokens: 4_000,
    root: repoRoot,
    env,
    call: callAI,
    system:
      "Draft honest LinkedIn profile improvements. Use only supplied candidate evidence. Return JSON matching the schema. Never invent experience or compensation.",
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          currentProfile: surfaces,
          candidateContext: context,
        }),
      },
    ],
  });
  if (!result.body?.ok) {
    const error = new Error(result.body?.error?.message || "LinkedIn proposal generation failed.");
    error.code = result.body?.code || "LINKEDIN_PROPOSAL_FAILED";
    throw error;
  }
  return result.body.data.surfaces;
}

export async function optimizeLinkedinInApp({
  repoRoot,
  env = process.env,
  profileUrl,
  now = () => new Date(),
  createSessionImpl = createConfiguredBrowserSession,
  readProfileImpl = readLinkedinProfile,
  proposeImpl = defaultLinkedinProposals,
  saveBatch = linkedinProposalBatchPut,
} = {}) {
  const at = now().toISOString();
  if (!allowed("profile_optimize", "linkedin", repoRoot, env)) {
    return workflowResult("optimize-linkedin", "needs-user", {
      title: "LinkedIn profile review",
      summary: "LinkedIn profile review consent is required.",
      blockers: [
        {
          code: "CONSENT_REQUIRED",
          message: "Turn on LinkedIn profile review in Settings.",
        },
      ],
      at,
    });
  }
  const read = await readWithOwnedSession({
    createSessionImpl,
    base: { repoRoot, env },
    platform: "linkedin",
    read: (session) => readProfileImpl({ session, url: profileUrl }),
  });
  if (!read.ok) {
    return workflowResult("optimize-linkedin", "needs-user", {
      title: "LinkedIn profile review",
      summary: read.blocker.message,
      blockers: [read.blocker],
      at,
    });
  }
  let proposals;
  try {
    proposals = await proposeImpl({ repoRoot, env, surfaces: read.records });
  } catch (error) {
    return workflowResult("optimize-linkedin", "needs-user", {
      title: "LinkedIn profile review",
      summary: clean(error.message, 500),
      blockers: [
        {
          code: error.code || "PROPOSAL_FAILED",
          message: clean(error.message, 500),
        },
      ],
      at,
    });
  }
  const saved = saveBatch({
    repoRoot,
    env,
    batch: { surfaces: proposals },
  });
  return workflowResult("optimize-linkedin", "completed", {
    title: "LinkedIn suggestions ready",
    summary: `${proposals.length} profile suggestion${proposals.length === 1 ? "" : "s"} ready for review. No profile edits were applied.`,
    batchId: saved.id,
    proposed: proposals.length,
    at,
  });
}

function statusPlatform(application) {
  const declared = clean(application.statusPlatform, 40).toLowerCase();
  if (["greenhouse", "ashby", "lever", "workday"].includes(declared)) return declared;
  const url = application.statusUrl || application.portalUrl || application.applicationUrl;
  if (!url) return null;
  const portal = hostnameToPortal(url);
  if (["greenhouse", "ashby", "lever"].includes(portal)) return portal;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("workday")) return "workday";
  } catch {
    return null;
  }
  return null;
}

export async function syncStatusesInApp({
  repoRoot,
  env = process.env,
  applications = [],
  urls = {},
  now = () => new Date(),
  createSessionImpl = createConfiguredBrowserSession,
  readStatusImpl = readAtsStatus,
  applyStatusImpl = appApplySyncedStatus,
  watermarkImpl = sourceWatermarkUpsert,
} = {}) {
  const at = now().toISOString();
  const results = [];
  for (const application of applications) {
    const platform = statusPlatform(application);
    const url =
      urls[application.id] ||
      application.statusUrl ||
      application.portalUrl ||
      application.applicationUrl;
    if (!platform || !url) {
      results.push({
        applicationId: application.id,
        company: application.company || null,
        state: "status_url_required",
        blocker: {
          code: "STATUS_URL_REQUIRED",
          message: `Save the signed-in application dashboard URL for ${application.company || application.id}, then retry.`,
        },
      });
      continue;
    }
    if (!allowed("status_polling", platform, repoRoot, env)) continue;
    const read = await readWithOwnedSession({
      createSessionImpl,
      base: { repoRoot, env },
      platform,
      read: (session) => readStatusImpl({ session, platform, url }),
    });
    if (!read.ok) {
      results.push({
        applicationId: application.id,
        company: application.company || null,
        platform,
        state: read.state,
        blocker: read.blocker,
      });
      continue;
    }
    const transition = statusTransition(application.status, read.rawStatus);
    if (transition.autoApplicable) {
      const to = toTrackOutcomeStatus(transition.canonical);
      applyStatusImpl({
        repoRoot,
        env,
        id: application.id,
        to,
        rawStatus: read.rawStatus,
        round: transition.norm.round || null,
        at,
      });
      results.push({
        applicationId: application.id,
        company: application.company || null,
        platform,
        state: "updated",
        from: application.status,
        to,
        rawStatus: read.rawStatus,
      });
    } else {
      results.push({
        applicationId: application.id,
        company: application.company || null,
        platform,
        state: transition.changed ? "review" : "unchanged",
        rawStatus: read.rawStatus,
        proposal: transition.changed ? transition : null,
      });
    }
    watermarkImpl({
      repoRoot,
      env,
      source: {
        id: `${platform}-status`,
        kind: "status",
        name: `${platform} application status`,
        lastRunAt: at,
      },
      at,
    });
  }
  const updated = results.filter((result) => result.state === "updated").length;
  const review = results.filter((result) => result.state === "review").length;
  const blockers = results.filter((result) => result.blocker);
  const firstReview = results.find((result) => result.state === "review");
  return workflowResult(
    "sync-status",
    blockers.length ? "needs-user" : review ? "needs-review" : "completed",
    {
      title: "Application status check",
      summary: blockers.length
        ? blockerSummary(
            `${updated} status${updated === 1 ? "" : "es"} updated${review ? `; ${review} need review.` : "."}`,
            blockers
          )
        : firstReview
          ? `${updated} status${updated === 1 ? "" : "es"} updated. ${firstReview.company || "One application"} needs review because the portal says “${clean(firstReview.rawStatus, 160)}”.`
          : `${updated} status${updated === 1 ? "" : "es"} updated${review ? `; ${review} need review` : ""}.`,
      updated,
      review,
      applications: results,
      blockers: blockers.map((result) => ({
        applicationId: result.applicationId,
        ...result.blocker,
      })),
      at,
    }
  );
}
