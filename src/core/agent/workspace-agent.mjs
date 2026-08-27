import { closeSync, openSync, readSync } from "node:fs";

import { PLAIN_ENGLISH_AGENT_VOICE } from "../ai/agent-voice.mjs";
import { callAI, resolveAIRoute } from "../ai/call-ai.mjs";
import { CHAT_ANSWER_MODE_GUIDANCE, parseChatAnswerMode } from "../ai/chat-answer-mode.mjs";
import { TRACK_OUTCOME_STATUSES } from "../ai/track-outcome-bounded.mjs";
import { hostnameToPortal } from "../apply/form-fill.mjs";
import { buildQuestionsRequest } from "../apply/form-questions.mjs";
import {
  automationStatus,
  CAPABILITIES,
  CAPABILITY_KEYS,
  isCapability,
  loadAutomation,
  mayRun,
  mergeAutomationDefaults,
  PLATFORMS,
} from "../automation/consent.mjs";
import {
  MAIL_ACCESS_CAPABILITY,
  MAIL_ACCESS_INGEST_PLATFORMS,
} from "../automation/mail-access.mjs";
import { PROVIDERS } from "../automation/session.mjs";
import { statusTransition, toTrackOutcomeStatus } from "../automation/status-map.mjs";
import { buildCoachingPlan } from "../coaching/plan.mjs";
import { buildSendLinks, resolveRecipient } from "../comms/recipient.mjs";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { activityAppend } from "../db/verbs/activity.mjs";
import {
  appApproveReview,
  appCaptureInterviewIntake,
  appScheduleInterview,
  appSetFields,
  appSetStatus,
} from "../db/verbs/app.mjs";
import {
  WRITE_PROVIDERS as CALENDAR_WRITE_PROVIDERS,
  calendarWriteAppend,
} from "../db/verbs/calendar.mjs";
import {
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
} from "../db/verbs/candidate.mjs";
import {
  commAppendMessage,
  commCaptureInbound,
  commMarkSent,
  commSetDraft,
} from "../db/verbs/comm.mjs";
import { companyProposalBatchGet } from "../db/verbs/company-discovery.mjs";
import { companyHealthSet } from "../db/verbs/company-health.mjs";
import { deepIngestConfirmedItemUpsert, deepIngestStateGet } from "../db/verbs/deep-ingest.mjs";
import { intakeOne } from "../db/verbs/intake.mjs";
import {
  linkedinProposalBatchLatest,
  linkedinProposalDecide,
} from "../db/verbs/linkedin-proposals.mjs";
import { relationshipLeadUpsertBatch } from "../db/verbs/relationship.mjs";
import { sourcedPromote, sourcedSetStatus, sourcedUpsertBatch } from "../db/verbs/sourced.mjs";
import { sourcingRunFail, sourcingRunLatest } from "../db/verbs/sourcing-runs.mjs";
import { companyDiscoveryCadenceState } from "../discovery/company-discovery-cadence.mjs";
import { applyCompanyProposalDecision } from "../discovery/company-proposal-decisions.mjs";
import { createCompanyProposalBatch } from "../discovery/company-proposals.mjs";
import { lintArtifact } from "../documents/placeholder-lint.mjs";
import { matchTrackerRecord } from "../intake/match.mjs";
import { normalizeIntakeRequestedAction } from "../intake/requested-action.mjs";
import { resolveJobUrl } from "../intake/resolve.mjs";
import { buildInterviewDossier } from "../interview/dossier.mjs";
import {
  runFirstSearchInBackground,
  startFirstSearchRun,
  startManualSearchRun,
} from "../onboarding/first-search-run.mjs";
import { evaluateAndPersistPacketGate } from "../packet/evaluate.mjs";
import { exportPacketArtifacts } from "../packet/exports.mjs";
import {
  applicationPacketGatePasses,
  generateApplicationPacket,
} from "../packet/generate-operation.mjs";
import {
  confirmOneOffScreeningAnswer,
  draftOneOffScreeningAnswers,
  matchSuppliedScreeningAnswers,
  saveOneOffScreeningAnswer,
} from "../packet/one-off-answer.mjs";
import { capturePacketQuestions } from "../packet/questions.mjs";
import { userPath } from "../paths/workspace.mjs";
import { findCompLeak, findCurrentBaseToken } from "../profile/comp-guard.mjs";
import { computeEvidenceWrite, loadEvidence } from "../profile/evidence-writer.mjs";
import { applyGateWrite, GATE_APPLY_SUMMARIES } from "../profile/gate-apply.mjs";
import { GATE_ROUTES } from "../profile/gate-writer.mjs";
import { platformForHost } from "../providers/search-sources.mjs";
import {
  isStale,
  listResearch,
  readCompanyResearch,
  readResearch,
  researchRelPath,
  slugifyCompany,
  splitFrontmatter,
  writeResearch,
} from "../research/research-store.mjs";
import { planSchedulingReply } from "../scheduling/plan.mjs";
import {
  offersWithCapturedJobs,
  sourcedRowsFromScanOffers,
} from "../scoring/sourced-persistence.mjs";
import { inferProvider } from "../scoring/sourced-scanner.mjs";
import {
  applyStrategyRecommendation,
  draftStrategyReview,
  stampStrategyReview,
} from "../strategy/review.mjs";
import { classifyStage } from "../tracker/dashboard.mjs";
import { readVersion } from "../version.mjs";
import {
  buildIssueReport,
  buildIssueUrl,
  FILED_ISSUE_URL_RE,
  ISSUE_REPORT_COMP_LEAK_MARKER,
} from "./issue-report.mjs";
import {
  normalizeWorkspaceIntent,
  WORKSPACE_THREAD_ID,
  workspaceIntentAppend,
  workspaceMessageAppend,
  workspaceThreadRead,
} from "./workspace-thread.mjs";

export const EXECUTABLE_INTENTS = new Set([
  "interview.prepare",
  "interview.prepare-request",
  "interview.schedule",
  "interview.capture-context",
  "scheduling.prepare",
  "scheduling.prepare-request",
  "job.evaluate",
  "job.evaluate-request",
  "job.prepare-request",
  "job.tailor-request",
  "job.generate-documents",
  "job.export-documents",
  "screening.answer",
  "screening.answer-confirm",
  "screening.answer-save",
  "search.run",
  "sourced.promote",
  "sourced.skip",
  "application.record-external",
  "application.record-external-request",
  "source.add",
  "source.query-add",
  "source.set-enabled",
  "source.discover",
  "company.discover",
  "company.proposal-decide",
  "research.company",
  "research.company-request",
  "research.comp",
  "research.record",
  "company.health",
  "company.health-request",
  "company.health-record",
  "coaching.plan",
  "coaching.evidence-save",
  "strategy.review",
  "strategy.apply",
  "strategy.stamp",
  "settings.explain",
  "settings.apply",
  "job.prepare-submit",
  "job.apply",
  "communication.draft",
  "communication.draft-request",
  "communication.send",
  "communication.add-note",
  "communication.note-request",
  "communication.record-external",
  "communication.record-external-request",
  "communication.handoff",
  "communication.handoff-request",
  "communication.capture-inbound",
  "outcome.record",
  "outcome.record-request",
  "issue.report",
  "issue.record-filed",
  "calendar.record-write",
  "relationship.record-lead",
  "relationship.source-request",
  "status.connect-portal-request",
  "status.connect-portal",
  "status.sync-request",
  "mail.sync-request",
  "messages.sync-request",
  "linkedin.optimize-request",
  "linkedin.proposal-decide",
  "status.record-portal-request",
  "status.record-portal",
  "status.apply-transition",
]);

function compactCandidateSnapshot({ repoRoot, env }) {
  const config = candidateConfigGet({ repoRoot, env });
  const profile = config.profile || {};
  const candidate = profile.candidate || {};
  const compensation = profile.compensation || {};
  const db = requireDb({ repoRoot, env });
  const applications = db
    .prepare("SELECT data FROM applications ORDER BY rowid ASC")
    .all()
    .map((row) => JSON.parse(row.data))
    .map((app) => ({
      id: app.id,
      company: app.company,
      role: app.role,
      status: app.status,
      fitScore: app.fitScore ?? app.roleFit?.score ?? null,
      interviewAt: app.interviewAt || null,
      nextInterviewAt: app.nextInterviewAt || null,
      nextAction: app.nextAction || null,
    }));

  return {
    candidate: {
      full_name: candidate.full_name || "",
      preferred_name: candidate.preferred_name || "",
      headline: candidate.headline || "",
      location: candidate.location || profile.location?.home || "",
    },
    location: profile.location || {},
    compensation: {
      currency: compensation.currency || "USD",
      target_base: compensation.target_base ?? null,
      minimum_base: compensation.minimum_base ?? null,
      target_total_comp: compensation.target_total_comp ?? null,
    },
    authorization: profile.authorization || {},
    availability: profile.availability || {},
    targeting: {
      role_buckets: config.targeting?.role_buckets || [],
      keep_signals: config.targeting?.keep_signals || [],
      cut_signals: config.targeting?.cut_signals || [],
      tracked_companies: config.targeting?.tracked_companies || [],
      excluded_companies: config.targeting?.excluded_companies || [],
      company_preferences: config.targeting?.company_preferences || {},
    },
    evidence: config.evidence?.claims || [],
    honesty: config.honesty || {},
    applications,
  };
}

function buildWorkspaceAgentSystemPrompt({ repoRoot, env = process.env } = {}) {
  const snapshot = compactCandidateSnapshot({ repoRoot, env });
  return [
    "You are CareerRat, the one durable career-search workspace agent for this candidate.",
    "Continue the same relationship across onboarding, Ask, and every contextual button result.",
    "Use the complete conversation supplied with this turn and the canonical candidate snapshot below.",
    "Never invent candidate facts, job facts, completed actions, or evidence. If information is missing, say so plainly.",
    "Do not claim a product action ran merely because the user asked; deterministic app actions report their own completion in this conversation.",
    PLAIN_ENGLISH_AGENT_VOICE,
    "Do not expose internal database ids unless the user asks for them.",
    CHAT_ANSWER_MODE_GUIDANCE,
    `Canonical candidate snapshot (current_base, email, and phone intentionally omitted):\n${JSON.stringify(snapshot)}`,
  ].join("\n\n");
}

function messageForModel(message) {
  let content = message.text || "";
  if (message.kind === "intake") {
    const excerpt = content.slice(0, 12_000);
    const clipped =
      excerpt.length < content.length ? "\n[attachment text truncated in prompt]" : "";
    content = `[Captured intake: ${message.metadata?.inputKind || "text"}] ${excerpt}${clipped}`;
  } else if (message.kind === "intent") {
    content = `[Action requested: ${message.intent?.type || "unknown"} for ${message.entity?.type || "entity"}:${message.entity?.id || "unknown"}] ${content}`;
  } else if (message.kind === "action_result") {
    const draft = message.artifacts?.find((artifact) => artifact.kind === "communication_draft");
    const draftContext = draft?.body ? `\n[Draft body: ${draft.body}]` : "";
    const evaluation = message.artifacts?.find(
      (artifact) => artifact.kind === "job_evaluation"
    )?.evaluation;
    const evaluationContext = evaluation
      ? `\n[Typed job evaluation: ${JSON.stringify(evaluation).slice(0, 8_000)}]`
      : "";
    const packet = message.artifacts?.find((artifact) => artifact.kind === "packet_generation");
    const packetContext = packet
      ? `\n[Generated packet state: ${JSON.stringify(packet).slice(0, 8_000)}]`
      : "";
    const packetExport = message.artifacts?.find((artifact) => artifact.kind === "packet_export");
    const packetExportContext = packetExport
      ? `\n[Exported packet state: ${JSON.stringify(packetExport).slice(0, 8_000)}]`
      : "";
    const search = message.artifacts?.find((artifact) => artifact.kind === "search_run");
    if (search) content = searchResultText(search);
    const searchForModel = search
      ? {
          kind: search.kind,
          title: search.title,
          purpose: search.purpose,
          status: search.status,
          summary: search.summary,
          ...(search.status === "failed" ? { error: { message: searchResultText(search) } } : {}),
        }
      : null;
    const searchContext = searchForModel
      ? `\n[Job search state: ${JSON.stringify(searchForModel).slice(0, 8_000)}]`
      : "";
    const companies = message.artifacts?.find((artifact) => artifact.kind === "company_proposals");
    const companyContext = companies
      ? `\n[Company proposal state: ${JSON.stringify(companies).slice(0, 8_000)}]`
      : "";
    const source = message.artifacts?.find((artifact) => artifact.kind === "search_source");
    const sourceContext = source
      ? `\n[Search source state: ${JSON.stringify(source).slice(0, 4_000)}]`
      : "";
    const scheduling = message.artifacts?.find((artifact) => artifact.kind === "scheduling_plan");
    const schedulingContext = scheduling
      ? `\n[Scheduling plan state: ${JSON.stringify(scheduling).slice(0, 6_000)}]`
      : "";
    const screening = message.artifacts?.find((artifact) => artifact.kind === "screening_answers");
    const screeningContext = screening
      ? `\n[Screening answer state: ${JSON.stringify(screening).slice(0, 6_000)}]`
      : "";
    content = `[Action completed: ${message.artifacts?.map((artifact) => artifact.title || artifact.kind).join(", ") || "completed"}] ${content}${draftContext}${evaluationContext}${packetContext}${packetExportContext}${searchContext}${companyContext}${sourceContext}${schedulingContext}${screeningContext}`;
  } else if (message.kind === "action_error") {
    content = `[Action failed: ${message.error?.code || "ACTION_FAILED"}] ${content}`;
  } else if (message.kind === "agent_error") {
    content = `[Previous agent call failed: ${message.error?.code || "AGENT_FAILED"}] ${content}`;
  }
  const jobContext = message.metadata?.jobContext;
  if (jobContext) {
    content += `\n[Selected job context: ${jobContext.company}, ${jobContext.role}, status ${jobContext.status}]`;
  }
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content,
  };
}

function responseText(response) {
  return (response?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("\n")
    .trim();
}

function unsupported(type) {
  const error = new Error(`workspace intent is not implemented yet: ${type}`);
  error.code = "INTENT_NOT_IMPLEMENTED";
  return error;
}

function actionError(message, code, { diagnostics } = {}) {
  const error = new Error(message);
  error.code = code;
  if (diagnostics) error.diagnostics = diagnostics;
  return error;
}

function notFoundError(type, id) {
  const labels = {
    application: "saved application",
    communication: "communication thread",
    sourced: "sourced role",
    intake: "intake item",
  };
  return actionError(`That ${labels[type] || "workspace item"} could not be found.`, "NOT_FOUND", {
    diagnostics: { entity: { type, id: String(id || "") } },
  });
}

function visibleActionError(error, entity) {
  const rawMessage = String(error?.message || "The action could not be completed.");
  const labels = {
    application: "this application",
    candidate: "the candidate profile",
    communication: "this conversation",
    company: "this company",
    "company-proposal": "this company proposal",
    intake: "this intake item",
    "linkedin-proposal": "this LinkedIn proposal",
    sourced: "this sourced role",
    workspace: "this workspace",
  };
  const type = String(entity?.type || "").trim();
  const id = String(entity?.id || "").trim();
  const label = labels[type] || "this workspace item";
  let message = rawMessage;
  const references = [type && id ? `${type}:${id}` : "", id !== type ? id : ""]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const reference of references) message = message.replaceAll(reference, label);
  if (error && typeof error === "object" && message !== rawMessage) {
    error.diagnostics = {
      ...(error.diagnostics && typeof error.diagnostics === "object" ? error.diagnostics : {}),
      rawMessage,
    };
    error.message = message;
  }
  return message;
}

function profileSettingList(values, label) {
  const normalized = [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
  ];
  if (
    !normalized.length ||
    normalized.length > 20 ||
    normalized.some((value) => value.length > 160)
  ) {
    throw actionError(`${label} need between 1 and 20 short values.`, "SETTINGS_CHANGE_INVALID");
  }
  return normalized;
}

function applicationForIntent({ repoRoot, env, id }) {
  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(String(id));
  if (!row) throw notFoundError("application", id);
  return JSON.parse(row.data);
}

function communicationForIntent({ repoRoot, env, id }) {
  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM communications WHERE id = ?").get(String(id));
  if (!row) throw notFoundError("communication", id);
  return JSON.parse(row.data);
}

function sourcedForIntent({ repoRoot, env, id }) {
  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM sourced WHERE id = ?").get(String(id));
  if (!row) throw notFoundError("sourced", id);
  return JSON.parse(row.data);
}

function requestDate(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function safeExternalHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// Status polling only supports the ATS platforms that expose a candidate
// portal CareerRat can scrape. hostnameToPortal (form-fill.mjs) already
// covers greenhouse/ashby/lever/workable/smartrecruiters/linkedin; Workday
// isn't a form-fill recipe host, so it gets its own hostname check here.
function statusPollingPlatformForUrl(url) {
  const portal = hostnameToPortal(url);
  if (portal === "greenhouse" || portal === "ashby" || portal === "lever") return portal;
  try {
    const hostname = new URL(String(url || "")).hostname.toLowerCase();
    if (
      hostname === "myworkdayjobs.com" ||
      hostname === "myworkday.com" ||
      hostname.endsWith(".myworkdayjobs.com") ||
      hostname.endsWith(".myworkday.com")
    ) {
      return "workday";
    }
  } catch {
    return null;
  }
  return null;
}

function statusPollingPlatformForApplication(application = {}) {
  const declared = String(application.statusPlatform || "")
    .trim()
    .toLowerCase();
  if (["greenhouse", "workday", "ashby", "lever"].includes(declared)) return declared;
  return statusPollingPlatformForUrl(
    application.statusUrl || application.portalUrl || application.applicationUrl
  );
}

// Mail sync sources: one entry per ingest-mail webmail platform (the list
// lives in mail-access.mjs so this never drifts from what ingest-mail
// actually supports), plus a local Apple Mail entry on macOS. `tracker` lets
// callers that already fetched assembleTrackerObject this request reuse it
// instead of hitting the db twice; omit it and the helper fetches its own.
export function mailSyncSources({ repoRoot, env, hostPlatform, tracker }) {
  const trackerObject = tracker || assembleTrackerObject(requireDb({ repoRoot, env }));
  const trackerSources = trackerObject.sources || [];
  const lastRunAtFor = (id) => trackerSources.find((row) => row.id === id)?.lastRunAt || null;

  const sources = MAIL_ACCESS_INGEST_PLATFORMS.map((platform) => {
    const id = `${platform}-webmail`;
    return {
      id,
      platform,
      allowed: mayRun({ capability: MAIL_ACCESS_CAPABILITY, platform, root: repoRoot, env })
        .allowed,
      lastRunAt: lastRunAtFor(id),
    };
  });

  if (hostPlatform === "darwin") {
    // Apple Mail has no platform/consent gate: it's read locally via the
    // Mail app rather than a webmail session. This assumes the workspace
    // server runs on the same machine as the user's Mail app (CareerRat's
    // local-first single-user model).
    sources.unshift({
      id: "apple-mail",
      platform: null,
      allowed: true,
      lastRunAt: lastRunAtFor("apple-mail"),
    });
  }

  return sources;
}

// Messages sync sources: one entry per ingest-messages platform (the list
// lives in CAPABILITIES.messaging so this never drifts from what
// ingest-messages actually supports). `tracker` lets callers that already
// fetched assembleTrackerObject this request reuse it instead of hitting the
// db twice; omit it and the helper fetches its own.
export function messagesSyncSources({ repoRoot, env, tracker }) {
  const trackerObject = tracker || assembleTrackerObject(requireDb({ repoRoot, env }));
  const trackerSources = trackerObject.sources || [];
  const lastRunAtFor = (id) => trackerSources.find((row) => row.id === id)?.lastRunAt || null;

  return CAPABILITIES.messaging.platforms.map((platform) => {
    const id = `${platform}-messages`;
    return {
      id,
      platform,
      allowed: mayRun({ capability: "messaging", platform, root: repoRoot, env }).allowed,
      lastRunAt: lastRunAtFor(id),
    };
  });
}

async function captureJobRequest({ repoRoot, env, jobUrl, resolveJobUrlImpl, fetchImpl, now }) {
  const resolved = await resolveJobUrlImpl(jobUrl, { fetchImpl });
  const bodyText = String(resolved?.bodyText || "").trim();
  if (resolved?.bodyFetchStatus !== "resolved" || !bodyText) {
    throw actionError(
      `CareerRat could not read the full job description from this link yet. ${resolved?.reason || "Open it in the signed-in browser or paste the job description."}`,
      "JOB_BODY_REQUIRES_BROWSER"
    );
  }

  const canonicalUrl = String(resolved.url || jobUrl).trim();
  const db = requireDb({ repoRoot, env });
  const match = matchTrackerRecord({
    db,
    url: canonicalUrl,
    company: resolved.company,
    role: resolved.title,
  });
  const company = String(resolved.company || match.company || "").trim();
  const title = String(resolved.title || match.role || "").trim();
  if (!company || !title) {
    throw actionError(
      "CareerRat captured the page but could not identify both the company and role without guessing.",
      "JOB_IDENTITY_REQUIRED"
    );
  }

  const savedAt = requestDate(now);
  const [captured] = offersWithCapturedJobs({
    repoRoot,
    env,
    savedAt,
    offers: [
      {
        company,
        title,
        url: canonicalUrl,
        location: resolved.location || "",
        comp: resolved.comp || "verify",
        bodyText,
        source: "ask",
        sourceProvider: resolved.provider || null,
        capturedUrl: jobUrl,
        gate: "review",
        fit: "",
        score: 0,
      },
    ],
  });
  if (!captured?.artifacts?.jd) {
    throw actionError("CareerRat could not save the job description.", "JOB_CAPTURE_FAILED");
  }

  const exactPostingMatch = new Set(["exact_req_id", "exact_url"]).has(match.confidence);
  let applicationId;
  if (match.matched && exactPostingMatch && match.recordType === "application") {
    applicationId = match.id;
    appSetFields({
      repoRoot,
      env,
      id: applicationId,
      patch: { artifacts: { jd: captured.artifacts.jd } },
    });
  } else if (match.matched && exactPostingMatch && match.recordType === "sourced") {
    const sourced = sourcedForIntent({ repoRoot, env, id: match.id });
    sourcedUpsertBatch({
      repoRoot,
      env,
      rows: [
        {
          ...sourced,
          company,
          role: title,
          link: canonicalUrl,
          loc: resolved.location || sourced.loc || "",
          base: resolved.comp || sourced.base || "verify",
          artifacts: { ...(sourced.artifacts || {}), jd: captured.artifacts.jd },
          scanner: {
            ...(sourced.scanner || {}),
            bodyChars: bodyText.length,
          },
          updatedAt: savedAt.toISOString(),
        },
      ],
    });
    applicationId = sourcedPromote({ repoRoot, env, id: match.id }).id;
  } else {
    const rows = sourcedRowsFromScanOffers([captured], savedAt.toISOString());
    if (!rows.length) {
      throw actionError(
        "CareerRat could not create a tracked job from this link.",
        "JOB_CAPTURE_FAILED"
      );
    }
    sourcedUpsertBatch({ repoRoot, env, rows });
    applicationId = sourcedPromote({ repoRoot, env, id: rows[0].id }).id;
  }

  return {
    applicationId,
    application: applicationForIntent({ repoRoot, env, id: applicationId }),
    bodyText,
    jobUrl: canonicalUrl,
    jdPath: captured.artifacts.jd,
    match,
  };
}

async function captureIntakeJobRequest({
  repoRoot,
  env,
  intakeId,
  resolveJobUrlImpl,
  fetchImpl,
  now,
}) {
  const item = intakeOne({ repoRoot, env, id: intakeId });
  if (!item) throw notFoundError("intake", intakeId);
  if (item.status !== "confirmed" || item.decision !== "confirm") {
    throw actionError(
      "Review and confirm this job before CareerRat saves and evaluates it.",
      "INTAKE_CONFIRMATION_REQUIRED"
    );
  }
  if (item.kind === "job-url") {
    const jobUrl = String(item.classification?.entities?.url || item.rawInput || "").trim();
    if (!jobUrl) throw actionError("The confirmed job link is missing.", "JOB_URL_REQUIRED");
    return {
      ...(await captureJobRequest({
        repoRoot,
        env,
        jobUrl,
        resolveJobUrlImpl,
        fetchImpl,
        now,
      })),
      sourceIntakeId: item.id,
    };
  }
  if (item.kind !== "jd-text") {
    throw actionError(
      "Only confirmed job descriptions and job links can be evaluated as jobs.",
      "BAD_INTAKE_KIND"
    );
  }

  const bodyText = String(item.rawInput || "").trim();
  const entities = item.classification?.entities || {};
  const company = String(entities.company || item.trackerMatch?.company || "").trim();
  const title = String(entities.role || item.trackerMatch?.role || "").trim();
  if (!bodyText) throw actionError("The confirmed job description is empty.", "MISSING_JOB_BODY");
  if (!company || !title) {
    throw actionError(
      "CareerRat needs both the company and role before it can save this job without guessing.",
      "JOB_IDENTITY_REQUIRED"
    );
  }

  const db = requireDb({ repoRoot, env });
  const match = matchTrackerRecord({ db, company, role: title });
  const savedAt = requestDate(now);
  const intakeUrl = `careerrat://intake/${item.id}`;
  const [captured] = offersWithCapturedJobs({
    repoRoot,
    env,
    savedAt,
    offers: [
      {
        company,
        title,
        url: intakeUrl,
        location: entities.location || "",
        comp: entities.comp || "verify",
        bodyText,
        source: "ask-intake",
        sourceProvider: "intake",
        capturedUrl: item.sourceFilePath || item.capturedPath || null,
        gate: "review",
        fit: "",
        score: 0,
      },
    ],
  });
  if (!captured?.artifacts?.jd) {
    throw actionError("CareerRat could not save the job description.", "JOB_CAPTURE_FAILED");
  }

  let applicationId;
  if (match.matched && match.recordType === "application") {
    appSetFields({
      repoRoot,
      env,
      id: match.id,
      patch: {
        artifacts: { jd: captured.artifacts.jd },
        sourceMeta: { sourceIntakeId: item.id },
      },
    });
    applicationId = match.id;
  } else if (match.matched && match.recordType === "sourced") {
    const sourced = sourcedForIntent({ repoRoot, env, id: match.id });
    sourcedUpsertBatch({
      repoRoot,
      env,
      rows: [
        {
          ...sourced,
          artifacts: { ...(sourced.artifacts || {}), jd: captured.artifacts.jd },
          sourceMeta: { ...(sourced.sourceMeta || {}), sourceIntakeId: item.id },
          scanner: { ...(sourced.scanner || {}), bodyChars: bodyText.length },
          updatedAt: savedAt.toISOString(),
        },
      ],
    });
    applicationId = sourcedPromote({ repoRoot, env, id: match.id }).id;
  } else {
    const rows = sourcedRowsFromScanOffers([captured], savedAt.toISOString());
    if (!rows.length) {
      throw actionError("CareerRat could not create a tracked job.", "JOB_CAPTURE_FAILED");
    }
    sourcedUpsertBatch({ repoRoot, env, rows });
    applicationId = sourcedPromote({ repoRoot, env, id: rows[0].id }).id;
    appSetFields({
      repoRoot,
      env,
      id: applicationId,
      patch: {
        link: null,
        sourceMeta: { sourceIntakeId: item.id },
      },
    });
  }

  const application = applicationForIntent({ repoRoot, env, id: applicationId });
  return {
    applicationId,
    application,
    bodyText,
    jobUrl: application.link || application.url || application.sourceUrl || intakeUrl,
    jdPath: captured.artifacts.jd,
    match,
    sourceIntakeId: item.id,
  };
}

function resolveSavedJobRequest({ repoRoot, env, jobId }) {
  let application;
  try {
    application = applicationForIntent({ repoRoot, env, id: jobId });
  } catch (error) {
    if (error?.code !== "NOT_FOUND") throw error;
    const sourced = sourcedForIntent({ repoRoot, env, id: jobId });
    const promoted = sourcedPromote({ repoRoot, env, id: sourced.id });
    application = applicationForIntent({ repoRoot, env, id: promoted.id });
  }
  return {
    applicationId: application.id,
    application,
    bodyText: null,
    jobUrl: application.link || application.url || application.sourceUrl || null,
    jdPath: application.artifacts?.jd || null,
    match: { matched: true, recordType: "application", id: application.id },
  };
}

const JOB_REFERENCE_STOP_WORDS = new Set([
  "a",
  "an",
  "application",
  "apply",
  "applied",
  "as",
  "assess",
  "at",
  "by",
  "can",
  "could",
  "evaluate",
  "for",
  "from",
  "got",
  "have",
  "help",
  "i",
  "interview",
  "it",
  "job",
  "just",
  "made",
  "me",
  "my",
  "offer",
  "opening",
  "please",
  "posting",
  "prep",
  "prepare",
  "rate",
  "received",
  "record",
  "rejected",
  "review",
  "role",
  "submitted",
  "submit",
  "that",
  "the",
  "this",
  "to",
  "want",
  "was",
  "withdrew",
  "withdrawn",
  "you",
]);

function jobReferenceTokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !JOB_REFERENCE_STOP_WORDS.has(token));
}

function jobIdentityMatchStrength(row, referenceTokens) {
  const referenceSet = new Set(referenceTokens);
  const compactReference = referenceTokens.join("");
  const companyTokens = jobReferenceTokens(row.company);
  const roleTokens = jobReferenceTokens(row.role);
  return [companyTokens, roleTokens].filter((identityTokens) => {
    if (!identityTokens.length) return false;
    if (identityTokens.every((token) => referenceSet.has(token))) return true;
    const compactIdentity = identityTokens.join("");
    return compactIdentity.length >= 6 && compactReference.includes(compactIdentity);
  }).length;
}

function resolveReferencedJobRequest({ repoRoot, env, jobReference }) {
  const tokens = jobReferenceTokens(jobReference);
  if (!tokens.length) {
    throw actionError(
      "Name the company or role so CareerRat can identify the saved job.",
      "JOB_REFERENCE_NOT_FOUND"
    );
  }
  const db = requireDb({ repoRoot, env });
  const applications = db
    .prepare("SELECT data FROM applications ORDER BY rowid ASC")
    .all()
    .map((row) => ({ recordType: "application", ...JSON.parse(row.data) }));
  const applicationLinks = new Set(
    applications
      .map((row) =>
        String(row.link || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
  const sourced = db
    .prepare("SELECT data FROM sourced ORDER BY rowid ASC")
    .all()
    .map((row) => ({ recordType: "sourced", ...JSON.parse(row.data) }))
    .filter(
      (row) =>
        !row.link ||
        !applicationLinks.has(
          String(row.link || "")
            .trim()
            .toLowerCase()
        )
    );
  const rankedMatches = [...applications, ...sourced]
    .map((row) => ({ row, strength: jobIdentityMatchStrength(row, tokens) }))
    .filter((candidate) => candidate.strength > 0);
  const strongestMatch = Math.max(0, ...rankedMatches.map((candidate) => candidate.strength));
  const matches = rankedMatches
    .filter((candidate) => candidate.strength === strongestMatch)
    .map((candidate) => candidate.row);
  if (!matches.length) {
    throw actionError(
      `CareerRat could not find a saved job matching “${String(jobReference).trim()}”.`,
      "JOB_REFERENCE_NOT_FOUND"
    );
  }
  if (matches.length > 1) {
    const safeMatches = matches.slice(0, 5).map((row) => ({
      company: String(row.company || "this company").slice(0, 120),
      role: String(row.role || "this role").slice(0, 160),
    }));
    const choices = safeMatches.map((row) => `${row.company}, ${row.role}`).join("; ");
    const error = actionError(
      `That matches more than one saved job: ${choices}. Name the company and role more specifically.`,
      "JOB_REFERENCE_AMBIGUOUS"
    );
    error.details = { matches: safeMatches };
    throw error;
  }
  return resolveSavedJobRequest({ repoRoot, env, jobId: matches[0].id });
}

function resolveReferencedApplication({ repoRoot, env, jobReference, interviewOnly = false }) {
  const tokens = jobReferenceTokens(jobReference);
  const db = requireDb({ repoRoot, env });
  const applications = db
    .prepare("SELECT data FROM applications ORDER BY rowid ASC")
    .all()
    .map((row) => JSON.parse(row.data))
    .filter((application) => {
      if (!interviewOnly) return true;
      return Boolean(
        application.status === "interview" || application.interviewAt || application.nextInterviewAt
      );
    });
  const matches = tokens.length
    ? applications.filter((application) => {
        const candidateTokens = new Set(
          jobReferenceTokens(`${application.company || ""} ${application.role || ""}`)
        );
        return tokens.every((token) => candidateTokens.has(token));
      })
    : applications;
  if (!matches.length) {
    throw actionError(
      interviewOnly
        ? "CareerRat could not find a matching saved interview. Name the company or role."
        : `CareerRat could not find a saved job matching “${String(jobReference).trim()}”.`,
      "JOB_REFERENCE_NOT_FOUND"
    );
  }
  if (matches.length > 1) {
    const safeMatches = matches.slice(0, 5).map((application) => ({
      company: String(application.company || "this company").slice(0, 120),
      role: String(application.role || "this role").slice(0, 160),
    }));
    const choices = safeMatches.map((row) => `${row.company}, ${row.role}`).join("; ");
    const error = actionError(
      `That matches more than one saved job: ${choices}. Name the company and role more specifically.`,
      "JOB_REFERENCE_AMBIGUOUS"
    );
    error.details = { matches: safeMatches };
    throw error;
  }
  return matches[0];
}

// Resolves a calendar.record-write's `event` reference to exactly one tracked
// interview — either a direct applicationId, or a token match against
// upcoming (not-yet-happened) scheduled interviews' company/role, mirroring
// resolveReferencedApplication's tokenized matching above. Unlike that
// resolver, both the zero-match and multi-match cases collapse into a single
// CALENDAR_WRITE_EVENT_UNRESOLVED and the raw reference text is never echoed
// back (a self-report should never look like it captured something it
// didn't).
function resolveCalendarWriteEvent({ repoRoot, env, event }) {
  const unresolved = () =>
    actionError(
      "Tell me which tracked interview or event you mean, like the company name.",
      "CALENDAR_WRITE_EVENT_UNRESOLVED"
    );

  const applicationId = String(event?.applicationId || "").trim();
  let application;
  if (applicationId) {
    application = applicationForIntent({ repoRoot, env, id: applicationId });
  } else {
    const tokens = jobReferenceTokens(event?.title);
    if (!tokens.length) throw unresolved();
    const db = requireDb({ repoRoot, env });
    const now = Date.now();
    const matches = db
      .prepare("SELECT data FROM applications ORDER BY rowid ASC")
      .all()
      .map((row) => JSON.parse(row.data))
      .filter((app) => {
        const iso = app.nextInterviewAt || app.interviewAt || "";
        return Boolean(iso) && !Number.isNaN(Date.parse(iso)) && Date.parse(iso) >= now;
      })
      .filter((app) => {
        const candidateTokens = new Set(
          jobReferenceTokens(`${app.company || ""} ${app.role || ""}`)
        );
        return tokens.every((token) => candidateTokens.has(token));
      });
    if (matches.length !== 1) throw unresolved();
    application = matches[0];
  }

  const eventIso = application.nextInterviewAt || application.interviewAt || "";
  if (!eventIso) throw unresolved();
  return {
    applicationId: application.id,
    company: application.company || "",
    role: application.role || "",
    title: `${application.company || "This"} interview`,
    eventIso,
  };
}

const COMMUNICATION_REFERENCE_STOP_WORDS = new Set([
  "a",
  "about",
  "availability",
  "calendar",
  "can",
  "confirm",
  "draft",
  "email",
  "for",
  "from",
  "handle",
  "help",
  "i",
  "interview",
  "job",
  "mark",
  "me",
  "message",
  "my",
  "offer",
  "plan",
  "please",
  "record",
  "recruiter",
  "reply",
  "response",
  "role",
  "schedule",
  "scheduling",
  "send",
  "sent",
  "slot",
  "slots",
  "the",
  "time",
  "times",
  "thread",
  "to",
  "with",
  "write",
  "you",
]);

function communicationReferenceTokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !COMMUNICATION_REFERENCE_STOP_WORDS.has(token));
}

function resolveReferencedCommunication({ repoRoot, env, communicationReference }) {
  const tokens = communicationReferenceTokens(communicationReference);
  const db = requireDb({ repoRoot, env });
  const communications = db
    .prepare("SELECT data FROM communications ORDER BY rowid ASC")
    .all()
    .map((row) => JSON.parse(row.data));
  const matches = tokens.length
    ? communications.filter((communication) => {
        const participants = (communication.participants || [])
          .map((participant) => `${participant?.name || ""} ${participant?.email || ""}`)
          .join(" ");
        const candidateTokens = new Set(
          communicationReferenceTokens(
            `${communication.company || ""} ${communication.role || ""} ${communication.subject || ""} ${participants}`
          )
        );
        return tokens.every((token) => candidateTokens.has(token));
      })
    : communications;
  if (!matches.length) {
    throw actionError(
      `CareerRat could not find a recruiter thread matching “${String(communicationReference).trim()}”.`,
      "COMMUNICATION_REFERENCE_NOT_FOUND"
    );
  }
  if (matches.length > 1) {
    const safeMatches = matches.slice(0, 5).map((communication) => ({
      company: String(communication.company || "this company").slice(0, 120),
      role: String(communication.role || "this role").slice(0, 160),
      subject: String(communication.subject || "this conversation").slice(0, 160),
    }));
    const choices = safeMatches
      .map((row) => `${row.company}, ${row.role}, ${row.subject}`)
      .join("; ");
    const error = actionError(
      `That matches more than one recruiter thread: ${choices}. Name the company, role, or subject more specifically.`,
      "COMMUNICATION_REFERENCE_AMBIGUOUS"
    );
    error.details = { matches: safeMatches };
    throw error;
  }
  return matches[0];
}

const COMPANY_REFERENCE_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "before",
  "company",
  "for",
  "from",
  "health",
  "help",
  "how",
  "i",
  "interview",
  "is",
  "it",
  "job",
  "land",
  "landing",
  "layoffs",
  "me",
  "my",
  "of",
  "on",
  "opening",
  "place",
  "please",
  "position",
  "posting",
  "research",
  "risky",
  "role",
  "s",
  "safe",
  "stability",
  "stable",
  "that",
  "the",
  "there",
  "this",
  "to",
  "was",
  "what",
  "whats",
  "you",
]);

function companyReferenceTokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !COMPANY_REFERENCE_STOP_WORDS.has(token));
}

// Every tracked company reference (fuzzy company research, company health)
// resolves against this same applications+sourced set, deduped by link the
// same way resolveReferencedJobRequest does — a promoted application and its
// originating sourced row must never both surface as separate companies.
function trackedCompanyRows({ repoRoot, env }) {
  const db = requireDb({ repoRoot, env });
  const applications = db
    .prepare("SELECT data FROM applications ORDER BY rowid ASC")
    .all()
    .map((row) => ({ recordType: "application", ...JSON.parse(row.data) }));
  const applicationLinks = new Set(
    applications
      .map((row) =>
        String(row.link || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
  const sourced = db
    .prepare("SELECT data FROM sourced ORDER BY rowid ASC")
    .all()
    .map((row) => ({ recordType: "sourced", ...JSON.parse(row.data) }))
    .filter(
      (row) =>
        !row.link ||
        !applicationLinks.has(
          String(row.link || "")
            .trim()
            .toLowerCase()
        )
    );
  return [...applications, ...sourced];
}

// A tracked company can have more than one row (multiple applications, or an
// application plus the sourced row it hasn't been promoted from). Prefer the
// application record — it is the one the candidate is actually pursuing —
// and break remaining ties by most recently updated.
function primaryCompanyRow(rows) {
  const rank = (row) => (row.recordType === "application" ? 1 : 0);
  return [...rows].sort((a, b) => {
    const rankDiff = rank(b) - rank(a);
    if (rankDiff !== 0) return rankDiff;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  })[0];
}

function resolveReferencedCompany({
  repoRoot,
  env,
  companyReference,
  notFoundCode = "COMPANY_NOT_FOUND",
  notFoundMessage,
}) {
  const tokens = companyReferenceTokens(companyReference);
  const reference = String(companyReference || "").trim();
  if (!tokens.length) {
    throw actionError(
      notFoundMessage || "Name the company so CareerRat can identify it.",
      notFoundCode
    );
  }
  const rows = trackedCompanyRows({ repoRoot, env });

  // Exact whole-name match (case-insensitive) always wins first, and is the
  // ONLY path available when every remaining token is a single character —
  // e.g. "AT&T" reduces to ["at","t"] and then ["t"] once "at" is dropped as
  // a stop word. A lone single-char token is too weak to subset-match safely
  // (it would match any tracked company whose name contains that one letter
  // as a standalone word), so it falls back to exact-name comparison instead
  // of the normal subset match below.
  const referenceKey = reference.toLowerCase();
  const exactMatches = rows.filter(
    (row) =>
      String(row.company || "")
        .trim()
        .toLowerCase() === referenceKey
  );
  const hasSubsetMatchableToken = tokens.some((token) => token.length >= 2);

  let matches;
  if (exactMatches.length) {
    matches = exactMatches;
  } else if (!hasSubsetMatchableToken) {
    throw actionError(
      notFoundMessage || `CareerRat could not find a tracked company matching “${reference}”.`,
      notFoundCode
    );
  } else {
    matches = rows.filter((row) => {
      const candidateTokens = new Set(companyReferenceTokens(row.company || ""));
      return tokens.every((token) => candidateTokens.has(token));
    });
  }
  if (!matches.length) {
    throw actionError(
      notFoundMessage || `CareerRat could not find a tracked company matching “${reference}”.`,
      notFoundCode
    );
  }
  const byCompany = new Map();
  for (const row of matches) {
    const key = String(row.company || "")
      .trim()
      .toLowerCase();
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(row);
  }
  if (byCompany.size > 1) {
    const safeMatches = [...byCompany.values()].slice(0, 5).map((companyRows) => ({
      company: String(companyRows[0].company || "this company").slice(0, 120),
    }));
    const choices = safeMatches.map((row) => row.company).join("; ");
    const error = actionError(
      `That matches more than one tracked company: ${choices}. Name the company more specifically.`,
      "COMPANY_AMBIGUOUS"
    );
    error.details = { matches: safeMatches };
    throw error;
  }
  const chosen = primaryCompanyRow([...byCompany.values()][0]);
  return {
    company: String(chosen.company || "").trim(),
    recordType: chosen.recordType,
    id: chosen.id,
  };
}

// Read-only company lookup for an open-job "this company" reference — unlike
// resolveSavedJobRequest, this never promotes a sourced row to an
// application; research and health checks are not a commitment to apply.
function companyFromJobId({ repoRoot, env, jobId }) {
  let row;
  try {
    row = applicationForIntent({ repoRoot, env, id: jobId });
  } catch (error) {
    if (error?.code !== "NOT_FOUND") throw error;
    row = sourcedForIntent({ repoRoot, env, id: jobId });
  }
  return String(row.company || "").trim();
}

function trackedCompanyFromJobId({ repoRoot, env, jobId }) {
  try {
    const application = applicationForIntent({ repoRoot, env, id: jobId });
    return {
      recordType: "application",
      id: application.id,
      company: String(application.company || "").trim(),
    };
  } catch (error) {
    if (error?.code !== "NOT_FOUND") throw error;
  }
  const sourced = sourcedForIntent({ repoRoot, env, id: jobId });
  return { recordType: "sourced", id: sourced.id, company: String(sourced.company || "").trim() };
}

function readCommunicationArtifact({ repoRoot, env, artifactPath }) {
  const relativePath = String(artifactPath || "").trim();
  if (
    !relativePath.startsWith("workspace/") ||
    relativePath.includes("\0") ||
    relativePath.includes("../")
  ) {
    return "";
  }
  let descriptor;
  try {
    descriptor = openSync(userPath({ repoRoot, env }, relativePath), "r");
    const buffer = Buffer.alloc(12_000);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function communicationWithArtifactBodies({ repoRoot, env, communication }) {
  return {
    ...communication,
    messages: (Array.isArray(communication.messages) ? communication.messages : []).map(
      (message) => ({
        ...message,
        ...(!message?.body && message?.artifactPath
          ? {
              body: readCommunicationArtifact({
                repoRoot,
                env,
                artifactPath: message.artifactPath,
              }),
            }
          : {}),
      })
    ),
  };
}

function resolveNaturalWorkspaceRequest({ repoRoot, env, intent }) {
  const input = intent.input || {};
  if (intent.type === "outcome.record-request") {
    const application = resolveReferencedApplication({
      repoRoot,
      env,
      jobReference: input.jobReference,
    });
    return {
      ...intent,
      type: "outcome.record",
      entity: { type: "application", id: application.id },
    };
  }
  if (intent.type === "status.record-portal-request") {
    // Guard both captured fields before resolution: an unmatched jobReference
    // is echoed back verbatim in JOB_REFERENCE_NOT_FOUND, so a comp phrase in
    // either capture must refuse here, not after the lookup.
    const guarded = `${String(input.jobReference || "")}\n${String(input.rawStatus || "")}`;
    if (findCurrentBaseToken(guarded) || findCompLeak(guarded)) {
      throw actionError(
        "That update includes your private current pay figure. Remove it, then try again.",
        "STATUS_UPDATE_COMP_LEAK"
      );
    }
    const application = resolveReferencedApplication({
      repoRoot,
      env,
      jobReference: input.jobReference,
    });
    return {
      ...intent,
      type: "status.record-portal",
      entity: { type: "application", id: application.id },
    };
  }
  if (intent.type === "status.connect-portal-request") {
    const url = safeExternalHttpUrl(input.url);
    if (!url || new URL(url).protocol !== "https:") {
      throw actionError(
        "Paste a full https:// application dashboard URL.",
        "STATUS_PORTAL_URL_INVALID"
      );
    }
    const application = resolveReferencedApplication({
      repoRoot,
      env,
      jobReference: input.jobReference,
    });
    return {
      ...intent,
      type: "status.connect-portal",
      entity: { type: "application", id: application.id },
      input: { url },
    };
  }
  if (intent.type === "application.record-external-request") {
    const application = resolveReferencedApplication({
      repoRoot,
      env,
      jobReference: input.jobReference,
    });
    return {
      ...intent,
      type: "application.record-external",
      entity: { type: "application", id: application.id },
    };
  }
  if (intent.type === "interview.prepare-request") {
    const application = resolveReferencedApplication({
      repoRoot,
      env,
      jobReference: input.jobReference,
      interviewOnly: true,
    });
    return {
      ...intent,
      type: "interview.prepare",
      entity: { type: "application", id: application.id },
    };
  }
  if (
    intent.type === "communication.draft-request" ||
    intent.type === "communication.record-external-request" ||
    intent.type === "communication.handoff-request" ||
    intent.type === "scheduling.prepare-request"
  ) {
    const communication = resolveReferencedCommunication({
      repoRoot,
      env,
      communicationReference: input.communicationReference,
    });
    return {
      ...intent,
      type:
        intent.type === "communication.draft-request"
          ? "communication.draft"
          : intent.type === "scheduling.prepare-request"
            ? "scheduling.prepare"
            : intent.type === "communication.handoff-request"
              ? "communication.handoff"
              : "communication.record-external",
      entity: { type: "communication", id: communication.id },
    };
  }
  if (intent.type === "communication.note-request") {
    const note = String(input.note || "").trim();
    if (!note) {
      throw actionError("Enter a note before saving it.", "EMPTY_COMMUNICATION_NOTE");
    }
    const communication = resolveReferencedCommunication({
      repoRoot,
      env,
      communicationReference: input.reference,
    });
    return {
      ...intent,
      type: "communication.add-note",
      entity: { type: "communication", id: communication.id },
      input: { ...input, note },
    };
  }
  if (intent.type === "research.company-request") {
    const company = input.jobId
      ? companyFromJobId({ repoRoot, env, jobId: input.jobId })
      : resolveReferencedCompany({ repoRoot, env, companyReference: input.companyReference })
          .company;
    if (!company) {
      throw actionError(
        "CareerRat could not identify the company for this job.",
        "COMPANY_NOT_FOUND"
      );
    }
    return {
      ...intent,
      type: "research.company",
      entity: { type: "company", id: slugifyCompany(company) },
      input: { ...input, company },
    };
  }
  if (intent.type === "company.health-request") {
    const reference = String(input.companyReference || "").trim();
    const resolved = input.jobId
      ? trackedCompanyFromJobId({ repoRoot, env, jobId: input.jobId })
      : resolveReferencedCompany({
          repoRoot,
          env,
          companyReference: reference,
          notFoundCode: "COMPANY_NOT_TRACKED",
          notFoundMessage: reference
            ? `CareerRat could not find “${reference}” among your tracked jobs. Company health attaches to a tracked job, so track it first, or ask CareerRat to research the company instead.`
            : "Name the company. Company health attaches to a tracked job.",
        });
    return {
      ...intent,
      type: "company.health",
      entity: { type: resolved.recordType, id: resolved.id },
      input: { ...input, company: resolved.company },
    };
  }
  return intent;
}

async function evaluateApplicationRequest({
  repoRoot,
  env,
  applicationId,
  jobBody,
  jobUrl,
  evaluateJobImpl,
}) {
  const application = applicationForIntent({ repoRoot, env, id: applicationId });
  const body = { applicationId };
  if (jobBody) body.jobBody = String(jobBody);
  if (jobUrl) body.jobUrl = String(jobUrl);
  const operation = await evaluateJobImpl({ repoRoot, env, body });
  const evaluation = operation?.body?.data;
  if (operation?.status !== 200 || !operation?.body?.ok || !evaluation) {
    throw actionError(
      operation?.body?.error?.message || "The job evaluation could not be completed.",
      operation?.body?.code || "JOB_EVALUATION_FAILED"
    );
  }
  const gate = String(evaluation.gate || "review").toLowerCase();
  const gateLabel = gate.charAt(0).toUpperCase() + gate.slice(1);
  return {
    application,
    evaluation,
    gate,
    gateLabel,
    text: `Evaluated ${applicationLabel(application)}: ${gateLabel}${evaluation.fitScore == null ? "" : ` (${evaluation.fitScore}/100 fit)`}.`,
    artifact: {
      kind: "job_evaluation",
      title: `${applicationLabel(application)}: ${gateLabel}`,
      applicationId,
      evaluation,
    },
  };
}

function persistedEvaluationResult(application, applicationId) {
  const evaluation = application?.evaluation || {};
  const gate = String(evaluation.gate || "review").toLowerCase();
  const gateLabel = gate.charAt(0).toUpperCase() + gate.slice(1);
  return {
    application,
    evaluation,
    gate,
    gateLabel,
    text: `Evaluated ${applicationLabel(application)}: ${gateLabel}${evaluation.fitScore == null ? "" : ` (${evaluation.fitScore}/100 fit)`}.`,
    artifact: {
      kind: "job_evaluation",
      title: `${applicationLabel(application)}: ${gateLabel}`,
      applicationId,
      evaluation,
    },
  };
}

function evaluationNextActions(gate, applicationId, fitRisks = [], evaluatedAt = null) {
  if (gate === "keep") {
    return [
      {
        label: "Prepare application",
        intent: {
          type: "job.generate-documents",
          entity: { type: "application", id: applicationId },
          input: { applyIntent: true, formats: ["pdf"] },
        },
      },
    ];
  }
  const actions = [
    navigationAction(gate === "cut" ? "Review why this was cut" : "Review this job", {
      surface: "job",
      entityType: "application",
      entityId: applicationId,
    }),
  ];
  if (gate === "review") {
    actions.push({
      label: "Approve review and prepare",
      intent: {
        type: "job.apply",
        entity: { type: "application", id: applicationId },
        input: { reviewApproved: true, approvedEvaluationAt: evaluatedAt },
      },
    });
  }
  // Coaching only ever offers on a review verdict with named gaps — never on
  // cut (nothing to coach toward) — matching coaching.plan's own trigger
  // contract in src/core/coaching/plan.mjs, not re-derived here.
  if (gate === "review" && Array.isArray(fitRisks) && fitRisks.length > 0) {
    actions.push({
      label: "Coach me on this fit",
      intent: {
        type: "coaching.plan",
        entity: { type: "application", id: applicationId },
      },
    });
  }
  return actions;
}

function reviewApprovalMatches(application, input) {
  const currentEvaluatedAt = String(application?.evaluation?.evaluatedAt || "").trim();
  const approvedEvaluationAt = String(input?.approvedEvaluationAt || "").trim();
  return (
    input?.reviewApproved === true &&
    String(application?.evaluation?.gate || "").toLowerCase() === "review" &&
    Boolean(currentEvaluatedAt) &&
    approvedEvaluationAt === currentEvaluatedAt
  );
}

function carriedReviewApproval(input) {
  const approvedEvaluationAt = String(input?.approvedEvaluationAt || "").trim();
  return input?.reviewApproved === true && approvedEvaluationAt
    ? { reviewApproved: true, approvedEvaluationAt }
    : {};
}

function navigationAction(
  label,
  { surface, entityType = "workspace", entityId = WORKSPACE_THREAD_ID, section, artifactKind } = {}
) {
  return {
    label,
    intent: {
      type: "ui.navigate",
      entity: { type: entityType, id: entityId },
      input: {
        surface,
        ...(section ? { section } : {}),
        ...(artifactKind ? { artifactKind } : {}),
      },
    },
  };
}

const QUESTION_CAPTURE_DEFERRED = "QUESTION_CAPTURE_DEFERRED";

function isDeferredQuestionGap(gap) {
  const kind = String(gap?.kind || "").toLowerCase();
  const code = String(gap?.code || "").toUpperCase();
  return kind === "answers" && code === QUESTION_CAPTURE_DEFERRED;
}

function isNonBlockingPacketGap(gap) {
  const kind = String(gap?.kind || "").toLowerCase();
  const code = String(gap?.code || "").toUpperCase();
  return (
    isDeferredQuestionGap(gap) || (kind === "coverletter" && code === "COVER_LETTER_CONFIRMATION")
  );
}

function blockingPacketGaps(gaps) {
  return gaps.filter((gap) => !isNonBlockingPacketGap(gap));
}

// Server-side corroboration for job.apply's resumeSession shortcut (see the
// call site below): the persisted evaluation must have cleared the gate, and
// the persisted packet manifest must be free of blocking gaps. Both fields
// come straight off the application row — no AI call, no doc regeneration —
// so resumeSession still skips the REDUNDANT re-evaluate/re-generate work,
// just never the safety checks themselves.
function applicationApplySafetyBlockReason(application) {
  if (!applicationPacketGatePasses(application)) {
    return "This application does not have a passing gate verdict on record.";
  }
  const manifest = application?.packetManifest;
  if (!manifest) {
    return "This application's packet has not been generated yet.";
  }
  const gaps = Array.isArray(manifest.gaps) ? manifest.gaps : null;
  const packetComplete = gaps
    ? blockingPacketGaps(gaps).length === 0
    : manifest.uploadReady === true;
  if (!packetComplete) {
    return "This application's packet still has open items to resolve.";
  }
  return null;
}

function questionCaptureFromApplication(application) {
  const summary = application?.packetManifest?.questions;
  if (!summary || typeof summary !== "object") return null;
  const answerableCount = Number(summary.answerableCount) || 0;
  const excludedCount = Number(summary.excludedCount) || 0;
  if (answerableCount + excludedCount === 0) return null;
  return {
    state: "captured",
    source: "saved",
    answerableCount,
    excludedCount,
    demographicSectionPresent: summary.demographicSectionPresent === true,
    ...(Array.isArray(summary.answerableIds)
      ? { answerableIds: summary.answerableIds.map(String) }
      : {}),
    ...(Array.isArray(summary.excludedIds) ? { excludedIds: summary.excludedIds.map(String) } : {}),
  };
}

function packetQuestionLineageIsStale(application) {
  const manifest = application?.packetManifest;
  const summary = manifest?.questions;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const idsFrom = (value) => (Array.isArray(value) ? value : []);

  const capturedIds = new Set(
    [...idsFrom(summary.answerableIds), ...idsFrom(summary.excludedIds)]
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  const lineage = manifest.answerLineage;
  const openGapIds = idsFrom(manifest.gaps)
    .map((gap) => String(gap?.questionId || "").trim())
    .filter(Boolean);
  const lineageIds = new Set(
    [
      ...idsFrom(lineage?.answeredQuestionIds),
      ...idsFrom(lineage?.skippedQuestionIds),
      ...idsFrom(lineage?.excludedQuestionIds),
      ...openGapIds,
    ]
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  if (capturedIds.size > 0) {
    if (capturedIds.size !== lineageIds.size) return true;
    return [...capturedIds].some((id) => !lineageIds.has(id));
  }

  const capturedCount =
    (Number(summary.answerableCount) || 0) + (Number(summary.excludedCount) || 0);
  return capturedCount > 0 && capturedCount !== lineageIds.size;
}

function siteRequiredQuestionCapture(extra = {}) {
  return {
    state: "site-required",
    source: null,
    answerableCount: 0,
    excludedCount: 0,
    demographicSectionPresent: false,
    ...extra,
  };
}

async function prepareApplicationQuestions({
  repoRoot,
  env,
  application,
  applicationId,
  captureQuestionsImpl,
  fetchImpl,
}) {
  const saved = questionCaptureFromApplication(application);
  if (saved) return saved;

  const url = safeExternalHttpUrl(application.link || application.url || application.sourceUrl);
  const request = url ? buildQuestionsRequest(url) : null;
  if (!request) return siteRequiredQuestionCapture();

  try {
    const capture = await captureQuestionsImpl({
      repoRoot,
      env,
      applicationId,
      source: "url",
      url,
      fetchImpl,
    });
    const questions = Array.isArray(capture?.questions) ? capture.questions : [];
    const excluded = Array.isArray(capture?.excluded) ? capture.excluded : [];
    const answerableCount = questions.length;
    const excludedCount = excluded.length;
    if (answerableCount + excludedCount === 0) {
      return siteRequiredQuestionCapture({ attempted: true });
    }
    return {
      state: "captured",
      source: String(capture?.source || request.provider),
      answerableCount,
      excludedCount,
      demographicSectionPresent: capture?.demographicSectionPresent === true,
      answerableIds: questions.map((question) => String(question.id)),
      excludedIds: excluded.map((question) => String(question.id)),
    };
  } catch (error) {
    return siteRequiredQuestionCapture({
      attempted: true,
      reason: String(error?.message || "Automatic question capture failed.").slice(0, 500),
    });
  }
}

function questionCaptureText(questionCapture, application = null) {
  if (!questionCapture) return "";
  if (questionCapture.state === "captured") {
    const count = questionCapture.answerableCount;
    return `Captured ${count} application question${count === 1 ? "" : "s"} before generating the packet.`;
  }
  if (!safeExternalHttpUrl(application?.link || application?.url || application?.sourceUrl)) {
    return "Paste the application link so CareerRat can capture the form questions and open the supervised handoff.";
  }
  return "Open the site, then paste the questions here so CareerRat can rebuild the answers.";
}

const ACTIVE_APPLICATION_SESSION_STATES = new Set([
  "questions-captured",
  "awaiting-submit",
  "blocked",
]);

function applicationSessionText(execution) {
  const filledCount = Number(execution?.session?.filledCount) || 0;
  const uploadedCount = Number(execution?.session?.uploadedCount) || 0;
  const unresolvedCount = Array.isArray(execution?.session?.unresolved)
    ? execution.session.unresolved.length
    : 0;
  const filled = filledCount
    ? `CareerRat filled ${filledCount} field${filledCount === 1 ? "" : "s"}. `
    : "";
  const uploaded = uploadedCount
    ? `CareerRat attached ${uploadedCount} file${uploadedCount === 1 ? "" : "s"}. `
    : "";
  const unresolved = unresolvedCount
    ? `${unresolvedCount} field${unresolvedCount === 1 ? "" : "s"} still ${unresolvedCount === 1 ? "needs" : "need"} your review. `
    : "";
  const detail = String(execution?.reason || "Review the live application form.").trim();
  return `${filled}${uploaded}${unresolved}${detail} This application was not marked Applied.`.trim();
}

function packetGapsForApplication(gaps, application, applyIntent) {
  const next = Array.isArray(gaps) ? [...gaps] : [];
  if (
    applyIntent &&
    !safeExternalHttpUrl(application?.link || application?.url || application?.sourceUrl) &&
    !next.some((gap) => String(gap?.code || "") === "APPLICATION_URL_REQUIRED")
  ) {
    next.push({
      kind: "application",
      code: "APPLICATION_URL_REQUIRED",
      message:
        "Paste the application link so CareerRat can capture the form and open the supervised handoff.",
    });
  }
  return next;
}

function applicationHandoffArtifact(
  application,
  applicationId,
  questionCapture,
  { executorAvailable = false } = {}
) {
  const url = safeExternalHttpUrl(application.link || application.url || application.sourceUrl);
  if (!url) return null;
  return {
    kind: "application_handoff",
    title: `${applicationLabel(application)}: Application site`,
    applicationId,
    url,
    submissionVerified: false,
    executorAvailable,
    ...(questionCapture ? { questionCapture } : {}),
  };
}

function packetNextActions(gaps, applicationId, hasHandoff, executorAvailable = false) {
  const blockingGaps = gaps.filter((gap) => !isNonBlockingPacketGap(gap));
  if (blockingGaps.length === 0 && hasHandoff) {
    if (executorAvailable) {
      return [
        {
          label: "Start supervised apply",
          intent: {
            type: "job.prepare-submit",
            entity: { type: "application", id: applicationId },
          },
        },
      ];
    }
    return [
      {
        label: "I applied",
        intent: {
          type: "application.record-external",
          entity: { type: "application", id: applicationId },
        },
      },
    ];
  }
  return [
    navigationAction("Review application", {
      surface: "job",
      entityType: "application",
      entityId: applicationId,
    }),
  ];
}

function tailoredPacketNextActions(applicationId) {
  return [
    {
      label: "Export documents",
      intent: {
        type: "job.export-documents",
        entity: { type: "application", id: applicationId },
        input: { formats: ["pdf"] },
      },
    },
    navigationAction("Review documents", {
      surface: "files",
      entityType: "application",
      entityId: applicationId,
    }),
  ];
}

function packetGapText(gaps, questionCaptureDeferred, { tailoring = false } = {}) {
  const blockingCount = blockingPacketGaps(gaps).length;
  const questionsPending = questionCaptureDeferred || gaps.some(isDeferredQuestionGap);
  const reviewVerb = blockingCount === 1 ? "needs" : "need";
  if (tailoring) {
    if (questionsPending && blockingCount === 0) {
      return "The tailored documents are ready. Screening answers will be handled only if you later choose to apply.";
    }
    if (blockingCount > 0) {
      return `${blockingCount} item${blockingCount === 1 ? "" : "s"} still ${reviewVerb} review${
        questionsPending ? "; screening answers stay pending until you choose to apply" : ""
      }.`;
    }
    return "The tailored documents are ready to review.";
  }
  if (questionsPending && blockingCount === 0) {
    return "The base documents are ready. Application questions will be completed on the application site.";
  }
  if (blockingCount > 0) {
    return `${blockingCount} item${blockingCount === 1 ? "" : "s"} still ${reviewVerb} review${
      questionsPending ? "; application questions will be completed on the site" : ""
    }.`;
  }
  return "It is ready for your submission handoff.";
}

async function generateDocumentsWithQuestionFallback({
  repoRoot,
  env,
  applicationId,
  formats,
  applyIntent,
  force = false,
  generateDocumentsImpl,
}) {
  const invoke = (nextApplyIntent) =>
    generateDocumentsImpl({
      repoRoot,
      env,
      body: {
        applicationId,
        applyIntent: nextApplyIntent,
        formats,
        ...(force ? { force: true } : {}),
      },
    });
  try {
    return { packet: await invoke(applyIntent), questionCaptureDeferred: false };
  } catch (error) {
    if (!applyIntent || error?.code !== "BAD_QUESTION_CAPTURE") throw error;
    return { packet: await invoke(false), questionCaptureDeferred: true };
  }
}

function resolvedDate(value, now) {
  const source = value || (typeof now === "function" ? now() : now) || new Date();
  const date = source instanceof Date ? source : new Date(source);
  if (!Number.isFinite(date.getTime())) {
    throw actionError("Applied date must be a valid date or datetime.", "BAD_APPLIED_AT");
  }
  return date.toISOString();
}

function resolvedCommunicationDate(value, now) {
  const source = value || (typeof now === "function" ? now() : now) || new Date();
  const date = source instanceof Date ? source : new Date(source);
  if (!Number.isFinite(date.getTime())) {
    throw actionError("Sent date must be a valid date or datetime.", "BAD_SENT_AT");
  }
  return date.toISOString();
}

function applicationLabel(app) {
  return `${app.company || "this company"}, ${app.role || "this role"}`;
}

// A coaching plan's basedOn records the evaluation it was built against
// (config/tracker.schema.json#applications[].coachingPlan). evaluatedAt is
// the discriminator — a re-evaluation always changes it — with gate and
// fitScore as a sanity check on top, so a plan is never acted on once the
// evaluation it coached toward is gone.
function coachingPlanIsStale(plan, evaluation) {
  const basedOn = plan?.basedOn;
  if (!basedOn) return true;
  if ((basedOn.evaluatedAt ?? null) !== (evaluation?.evaluatedAt ?? null)) return true;
  if ((basedOn.gate ?? null) !== (evaluation?.gate ?? null)) return true;
  if ((basedOn.fitScore ?? null) !== (evaluation?.fitScore ?? null)) return true;
  return false;
}

function communicationLabel(comm) {
  return [comm.company, comm.role, comm.subject].filter(Boolean).join(", ") || "this thread";
}

function replySubject(comm, input) {
  const explicit = String(input.subject || "").trim();
  if (explicit) return explicit;
  const subject = String(comm.subject || "").trim();
  if (!subject) return "";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function draftSummary(body) {
  const compact = String(body || "")
    .replace(/\s+/g, " ")
    .trim();
  return compact ? `Drafted reply: ${compact.slice(0, 160)}` : "Reply drafted for review.";
}

function intakeLabel(kind) {
  return (
    {
      "jd-text": "job description",
      "job-url": "job link",
      "recruiter-email": "recruiter message",
      "interview-transcript": "interview transcript",
      "status-update": "status update",
      other: "intake item",
    }[kind] || "intake item"
  );
}

function compactSearchSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const numericKeys = [
    "attemptedSources",
    "scanned",
    "new",
    "qualified",
    "presented",
    "filtered",
    "reconciled",
    "duplicates",
    "invalid",
    "partial",
    "unreadable",
    "errorCount",
    "offerCount",
  ];
  const compact = {};
  for (const key of numericKeys) {
    if (Number.isFinite(Number(summary[key]))) compact[key] = Number(summary[key]);
  }
  if (summary.reasonCounts && typeof summary.reasonCounts === "object") {
    compact.reasonCounts = JSON.parse(JSON.stringify(summary.reasonCounts));
  }
  if (summary.rejectionSamples && typeof summary.rejectionSamples === "object") {
    compact.rejectionSamples = Object.fromEntries(
      Object.entries(summary.rejectionSamples)
        .slice(0, 20)
        .map(([reason, samples]) => [
          String(reason).slice(0, 120),
          (Array.isArray(samples) ? samples : []).slice(0, 3).map((sample) => ({
            ...(sample?.company ? { company: String(sample.company).slice(0, 160) } : {}),
            ...(sample?.title ? { title: String(sample.title).slice(0, 240) } : {}),
            ...(sample?.location ? { location: String(sample.location).slice(0, 240) } : {}),
            ...(sample?.reason ? { reason: String(sample.reason).slice(0, 500) } : {}),
            ...(sample?.kind ? { kind: String(sample.kind).slice(0, 80) } : {}),
            ...(sample?.provider ? { provider: String(sample.provider).slice(0, 120) } : {}),
          })),
        ])
    );
  }
  if (Array.isArray(summary.captureFailures)) {
    compact.captureFailures = summary.captureFailures.slice(0, 10).map((failure) => ({
      ...(failure?.company ? { company: String(failure.company).slice(0, 160) } : {}),
      ...(failure?.title ? { title: String(failure.title).slice(0, 240) } : {}),
      ...(failure?.reason ? { reason: String(failure.reason).slice(0, 500) } : {}),
    }));
  }
  if (Array.isArray(summary.errors)) {
    compact.errors = summary.errors.slice(0, 20).map((error) => ({
      ...(error?.code ? { code: String(error.code).slice(0, 120) } : {}),
      ...(error?.source ? { source: String(error.source).slice(0, 240) } : {}),
      ...(error?.message ? { message: String(error.message).slice(0, 500) } : {}),
    }));
  }
  if (typeof summary.zeroResults === "boolean") compact.zeroResults = summary.zeroResults;
  return compact;
}

function searchStatusLabel(run) {
  if (run?.label) return String(run.label);
  if (run?.status === "completed") return "Complete";
  if (run?.status === "failed") return "Needs attention";
  if (run?.status === "running") return "Searching";
  return "Not started";
}

function compactSearchError(error) {
  if (!error || typeof error !== "object") return null;
  return {
    ...(error.code ? { code: String(error.code).slice(0, 120) } : {}),
    ...(error.message ? { message: String(error.message).slice(0, 500) } : {}),
    ...(error.action ? { action: String(error.action).slice(0, 120) } : {}),
    ...(Array.isArray(error.failedPromptIds)
      ? { failedPromptIds: error.failedPromptIds.slice(0, 20).map(String) }
      : {}),
    ...(Array.isArray(error.errors)
      ? { errors: error.errors.slice(0, 20).map((value) => String(value).slice(0, 500)) }
      : {}),
    ...(Array.isArray(error.queryResults)
      ? {
          queryResults: error.queryResults.slice(0, 20).map((result) => ({
            ...(result?.promptId ? { promptId: String(result.promptId).slice(0, 120) } : {}),
            ...(result?.status ? { status: String(result.status).slice(0, 80) } : {}),
            ...(result?.error ? { error: String(result.error).slice(0, 500) } : {}),
            queryCount: Array.isArray(result?.queries) ? result.queries.length : 0,
          })),
        }
      : {}),
    ...(Array.isArray(error.sources)
      ? {
          sources: error.sources.slice(0, 20).map((source) => ({
            ...(source?.url ? { url: String(source.url).slice(0, 500) } : {}),
            ...(source?.status ? { status: String(source.status).slice(0, 80) } : {}),
            ...(source?.error ? { error: String(source.error).slice(0, 500) } : {}),
          })),
        }
      : {}),
  };
}

function searchRunArtifact({ run, sources = null, reused = false, parked = false } = {}) {
  const purpose = String(run?.purpose || "manual-search");
  const titlePrefix =
    purpose === "first-search"
      ? "First job search"
      : purpose === "ai-web-search"
        ? "AI web search"
        : "Job search";
  return {
    kind: "search_run",
    title: `${titlePrefix}: ${searchStatusLabel(run)}`,
    purpose,
    runId: run?.id ? String(run.id) : null,
    status: String(run?.status || "not_started"),
    reused: Boolean(reused),
    parked: Boolean(parked),
    sources: sources && typeof sources === "object" ? JSON.parse(JSON.stringify(sources)) : null,
    summary: compactSearchSummary(run?.summary),
    error:
      purpose === "ai-web-search" && run?.status === "failed"
        ? { message: searchResultText({ ...run, purpose }) }
        : compactSearchError(run?.error),
  };
}

async function startExpandedSourceSearch({
  repoRoot,
  env,
  searchFetchImpl,
  startManualSearchImpl,
  onSearchStarted,
}) {
  try {
    const operation = await startManualSearchImpl({
      repoRoot,
      env,
      fetchImpl: searchFetchImpl,
    });
    const run = operation?.run || {
      purpose: "manual-search",
      status: "failed",
      error: { message: "The expanded job search did not return a run state." },
    };
    const normalizedRun = { ...run, purpose: run.purpose || "manual-search" };
    const artifact = searchRunArtifact({
      run: normalizedRun,
      sources: operation?.sources || null,
      reused: operation?.reused === true,
      parked: operation?.parked === true,
    });
    onSearchStarted?.({ operation, run: normalizedRun });
    return {
      operation,
      artifact,
      started: new Set(["running", "completed"]).has(artifact.status),
    };
  } catch (error) {
    return {
      operation: null,
      artifact: searchRunArtifact({
        run: {
          purpose: "manual-search",
          status: "failed",
          error: { message: error?.message || "The expanded job search could not start." },
        },
      }),
      started: false,
    };
  }
}

function searchResultText(run) {
  if (run?.status === "failed") {
    return run?.purpose === "ai-web-search"
      ? "AI search stopped before it finished. Try it again."
      : "The job search stopped before it finished. Try it again.";
  }
  if (run?.status === "completed") {
    const summary = compactSearchSummary(run.summary) || {};
    const presented = summary.presented ?? summary.new ?? 0;
    const filtered = summary.filtered ?? Math.max(0, (summary.scanned || 0) - presented);
    return `Job search complete: ${presented} qualified role${presented === 1 ? "" : "s"} presented, ${filtered} filtered out, ${summary.reconciled ?? summary.scanned ?? 0} reconciled.`;
  }
  if (run?.status === "running") {
    return "Job search started. Qualified results will return to this workspace when the scan finishes.";
  }
  return `The job search is waiting: ${run?.error?.message || "add a search location before running it."}`;
}

function pendingCompanyProposals(proposals) {
  return (Array.isArray(proposals) ? proposals : []).filter((proposal) => !proposal?.decision);
}

function compactCompanyProposal(proposal) {
  const compact = JSON.parse(JSON.stringify(proposal || {}));
  delete compact.capturedOffers;
  return compact;
}

function companyProposalArtifact(batch = {}, meta = {}) {
  const proposals = pendingCompanyProposals(batch.proposals);
  const rejected = Array.isArray(batch.rejected) ? batch.rejected : [];
  return {
    kind: "company_proposals",
    title: proposals.length
      ? `Company discovery: ${proposals.length} to review`
      : "Company discovery: review complete",
    batchId: String(batch.batchId || ""),
    version: Number(meta.version ?? batch.version ?? 0),
    proposals: proposals.map(compactCompanyProposal),
    rejected: JSON.parse(JSON.stringify(rejected)),
    counts: JSON.parse(
      JSON.stringify(
        batch.counts || {
          seeds: proposals.length + rejected.length,
          proposals: proposals.length,
          rejected: rejected.length,
        }
      )
    ),
    seedSource: meta.seedSource || null,
    ...((meta.trigger || batch.trigger) && { trigger: meta.trigger || batch.trigger }),
  };
}

// Shared by search.run and company.discover: an unresolved (pending) company
// proposal batch is reopened instead of duplicated. companyDiscoveryCadenceState
// reports "needs-review" whenever the latest batch still has undecided
// proposals, so both call sites check that status the same way before ever
// starting a new discovery batch. Returns the existing batch's artifact, or
// null when there is nothing pending to reopen.
function reopenPendingCompanyProposalBatch({ repoRoot, env, cadence, getBatchImpl, trigger }) {
  if (cadence?.status !== "needs-review" || !cadence.batchId) return null;
  const batch = getBatchImpl({ repoRoot, env, batchId: cadence.batchId })?.batch;
  if (!batch) return null;
  return companyProposalArtifact(batch, trigger ? { trigger } : {});
}

function companyDiscoveryReviewSentence(count, { also = false } = {}) {
  if (!count) return null;
  const lead = also ? "Company discovery also found" : "Company discovery found";
  return `${lead} ${count} compan${count === 1 ? "y" : "ies"}; ${count === 1 ? "it needs" : "they need"} review.`;
}

// linkedin_optimize_handoff / linkedin_profile_proposals — support for the
// linkedin.optimize-request / linkedin.proposal-decide handlers. Mirrors the
// mail/messages sync handoff shape: capability gates surfaced per key, plus
// (when a pending batch exists) a compact summary card and the full
// per-surface proposals artifact for review.
function linkedinProposalBatchSummary(batch) {
  const surfaces = Array.isArray(batch.surfaces) ? batch.surfaces : [];
  const decided = surfaces.filter((surface) => surface.decision);
  const approved = decided.filter((surface) =>
    new Set(["approve", "applied"]).has(surface.decision?.action)
  );
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    total: surfaces.length,
    decidedCount: decided.length,
    approvedCount: approved.length,
  };
}

function linkedinOptimizeHandoffArtifact({ capabilities, batch, now }) {
  return {
    kind: "linkedin_optimize_handoff",
    capabilities,
    batch: batch ? linkedinProposalBatchSummary(batch) : null,
    at: requestDate(now).toISOString(),
  };
}

function linkedinProfileProposalsArtifact(batch) {
  return {
    kind: "linkedin_profile_proposals",
    batchId: batch.id,
    version: batch.version,
    createdAt: batch.createdAt,
    surfaces: JSON.parse(JSON.stringify(batch.surfaces || [])),
  };
}

function boardDiscoveryChatArtifact(chat = {}) {
  const chatId = String(chat.chatId || "").trim();
  if (!chatId) throw actionError("Board discovery did not return a visible chat.", "NOT_FOUND");
  return {
    kind: "board_discovery_chat",
    title: "Job board discovery",
    chatId,
    skill: "research-boards",
    state: String(chat.state || "running"),
    reused: chat.reused === true,
  };
}

function researchChatArtifact(chat = {}, { skill, title }) {
  const chatId = String(chat.chatId || "").trim();
  if (!chatId) throw actionError(`${title} did not return a visible chat.`, "NOT_FOUND");
  return {
    kind: "research_chat",
    title,
    chatId,
    skill,
    state: String(chat.state || "running"),
    reused: chat.reused === true,
  };
}

// company_research / comp_benchmark / company_health artifact builders —
// shared by the freshness-hit reuse path (an already-current artifact just
// gets re-served) and the confirmed research.record / company.health-record
// write path below (a freshly written artifact gets served back the same
// shape), so the client renders the identical card either way.
function companyResearchArtifact({ fm = {}, company, slug, stale, markdown }) {
  return {
    kind: "company_research",
    company: fm.company || company,
    slug,
    path: researchRelPath(slug),
    fetchedAt: fm.fetchedAt || null,
    stale,
    sources: Array.isArray(fm.sources) ? fm.sources.length : 0,
    markdown,
  };
}

function compBenchmarkArtifact({ fm = {}, role, location, path, markdown }) {
  return {
    kind: "comp_benchmark",
    role: fm.role || role,
    location: fm.location || location,
    benchmark: fm.benchmark || null,
    fetchedAt: fm.fetchedAt || null,
    path,
    markdown,
  };
}

function companyHealthArtifactFromRating({ entityType, rowId, company, role, health }) {
  return {
    kind: "company_health",
    ...(entityType === "application" ? { applicationId: rowId } : { sourcedId: rowId }),
    company,
    role,
    forFunction: health.forFunction || null,
    rating: health.rating,
    provenance: health.provenance,
    asOf: health.asOf,
    dimensions: health.dimensions || {},
    crossCut: health.crossCut || [],
    fitDelta: health.fitDelta ?? 0,
    rationale: health.rationale || "",
  };
}

// research.record's Activity Pulse summary for a comp-benchmark save — the
// CLI path (research-comp SKILL.md STEP 5) passes "<floor / midpoint /
// ceiling synthesized>" by hand; this derives the same shape from the
// artifact's own parsed frontmatter.benchmark.
function compBenchmarkActivitySummary(benchmark) {
  const parts = [];
  if (benchmark?.floor != null) parts.push(`floor $${benchmark.floor}`);
  if (benchmark?.midpoint != null) parts.push(`mid $${benchmark.midpoint}`);
  if (benchmark?.ceiling != null) parts.push(`ceiling $${benchmark.ceiling}`);
  return parts.join(" / ") || "insufficient public data";
}

const COMPANY_HEALTH_RECHECK_DAYS_DEFAULT = 14;

// candidate/modes.yml#company_health.recheck_days (SKILL.md's freshness
// contract) — candidateConfigGet's DB-first accessor already returns the
// raw modes doc whole (readSingleton stores/reads the JSON blob as-is), so
// the company_health block just falls out of the same call this file
// already makes elsewhere; no new config machinery needed.
function companyHealthRecheckDays({ repoRoot, env }) {
  const modes = candidateConfigGet({ repoRoot, env }).modes || {};
  const days = Number(modes.company_health?.recheck_days);
  return Number.isFinite(days) && days > 0 ? days : COMPANY_HEALTH_RECHECK_DAYS_DEFAULT;
}

// The comp-benchmark artifact stem embeds the year-month it was written
// (see research-comp's STEP 1), so a fresh hit from an earlier month is
// still found by role+location prefix rather than requiring an exact stem
// match. listResearch() already computes `.stale` per item against the
// artifact's own frontmatter.staleness_days — reused as-is here.
function findFreshCompBenchmark({ repoRoot, role, location }) {
  const roleSlug = slugifyCompany(role);
  const locationSlug = slugifyCompany(location);
  if (!roleSlug || !locationSlug) return null;
  const prefix = `comp-bench-${roleSlug}-${locationSlug}-`;
  const items = listResearch({ root: repoRoot })
    .filter((item) => item.type === "comp-benchmark" && item.stem.startsWith(prefix) && !item.stale)
    .sort((a, b) => String(b.fetchedAt || "").localeCompare(String(a.fetchedAt || "")));
  return items[0] || null;
}

function searchExpandedCompaniesAction() {
  return {
    label: "Search the expanded company set",
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose: "manual-search" },
    },
  };
}

function currentSearchAction() {
  return navigationAction("Review the current job search", { surface: "search" });
}

function companyProposalOperationError(operation) {
  const error = actionError(
    operation?.body?.error?.message || "Company discovery could not create proposals.",
    operation?.body?.code || "COMPANY_DISCOVERY_FAILED"
  );
  error.status = operation?.status;
  return error;
}

function compactCompanyDiscoveryState(state = {}, overrides = {}) {
  return Object.fromEntries(
    Object.entries({
      status: state.status,
      due: state.due,
      reason: state.reason,
      dueAt: state.dueAt,
      batchId: state.batchId,
      pendingCount: state.pendingCount,
      ...overrides,
    }).filter(([, value]) => value !== undefined)
  );
}

export function recordWorkspaceSearchCompletion({ repoRoot, env = process.env, run, now } = {}) {
  const runId = String(run?.id || "").trim();
  const status = String(run?.status || "").trim();
  if (!runId) throw actionError("Search completion requires a run id.", "BAD_SEARCH_RUN");
  if (!new Set(["completed", "failed"]).has(status)) {
    throw actionError("Search completion must be completed or failed.", "BAD_SEARCH_RUN");
  }
  const current = workspaceThreadRead({ repoRoot, env });
  const duplicate = current.messages.some(
    (message) =>
      message.kind === "action_result" &&
      message.metadata?.searchTerminal === true &&
      message.metadata?.searchRunId === runId
  );
  if (duplicate) return current;

  const artifact = searchRunArtifact({ run });
  workspaceMessageAppend({
    repoRoot,
    env,
    role: "assistant",
    kind: "action_result",
    text: searchResultText(run),
    entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    artifacts: [artifact],
    metadata: {
      state: status,
      purpose: artifact.purpose,
      searchRunId: runId,
      searchTerminal: true,
    },
    now,
  });
  return workspaceThreadRead({ repoRoot, env });
}

function recordWorkspaceSearchStart({
  repoRoot,
  env = process.env,
  run,
  input = {},
  sources = null,
  now,
} = {}) {
  const runId = String(run?.id || "").trim();
  if (!runId || run?.status !== "running") {
    throw actionError("Search start requires a running run with an id.", "BAD_SEARCH_RUN");
  }
  const current = workspaceThreadRead({ repoRoot, env });
  const duplicate = current.messages.some(
    (message) => message.kind === "action_result" && message.metadata?.searchRunId === runId
  );
  if (duplicate) return current;

  const normalized = normalizeWorkspaceIntent({
    type: "search.run",
    entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    input: { ...input, purpose: run.purpose || input.purpose || "manual-search" },
  });
  const intentMessage = workspaceIntentAppend({ repoRoot, env, intent: normalized, now });
  const artifact = searchRunArtifact({ run, sources });
  return appendActionResult({
    repoRoot,
    env,
    normalized,
    intentMessage,
    text: searchResultText(run),
    artifacts: [artifact],
    metadata: {
      state: "running",
      purpose: artifact.purpose,
      searchRunId: runId,
      searchTerminal: false,
      reused: false,
      parked: false,
    },
    now,
  });
}

function headerValue(raw, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    String(raw || "")
      .match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"))?.[1]
      ?.trim() || ""
  );
}

function inboundSummary(item) {
  const raw = String(item?.rawInput || "");
  const content = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(from|to|cc|bcc|subject|date):/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (content) return content.slice(0, 200);
  return String(item?.classification?.proposedAction || "Inbound recruiter message captured.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function appendActionResult({
  repoRoot,
  env,
  normalized,
  intentMessage,
  text,
  artifacts,
  metadata,
  operationResult,
  now,
}) {
  workspaceMessageAppend({
    repoRoot,
    env,
    role: "assistant",
    kind: "action_result",
    text,
    entity: normalized.entity,
    artifacts,
    metadata: { intentMessageId: intentMessage.message.id, ...metadata },
    now,
  });
  return { ...workspaceThreadRead({ repoRoot, env }), operationResult };
}

function workflowActionMetadata(normalized, execution, retryLabel, extra = {}) {
  return {
    state: execution?.state || "requested",
    ...extra,
    ...(execution?.state === "needs-user"
      ? {
          nextActions: [
            {
              label: retryLabel,
              intent: {
                type: normalized.type,
                entity: normalized.entity,
                input: normalized.input || {},
              },
            },
          ],
        }
      : {}),
  };
}

export async function executeWorkspaceIntent({
  repoRoot,
  env = process.env,
  intent,
  hostPlatform = process.platform,
  buildInterviewDossierImpl = buildInterviewDossier,
  evaluateJobImpl = evaluateAndPersistPacketGate,
  resolveJobUrlImpl = resolveJobUrl,
  generateDocumentsImpl = generateApplicationPacket,
  exportDocumentsImpl = exportPacketArtifacts,
  packetExportArtifact,
  startFirstSearchImpl = startFirstSearchRun,
  startManualSearchImpl = startManualSearchRun,
  createCompanyProposalsImpl = createCompanyProposalBatch,
  decideCompanyProposalImpl = applyCompanyProposalDecision,
  getCompanyProposalBatchImpl = companyProposalBatchGet,
  companyDiscoveryCadenceImpl = companyDiscoveryCadenceState,
  addBoardSourceImpl,
  addSearchSourceQueryImpl,
  setSearchSourceEnabledImpl,
  startBoardDiscoveryImpl,
  startCompanyResearchImpl,
  startCompResearchImpl,
  startCompanyHealthImpl,
  runMailSyncImpl,
  runWebmailSyncImpl,
  runMessagesSyncImpl,
  runRelationshipSourcingImpl,
  runLinkedinOptimizeImpl,
  runStatusSyncImpl,
  buildCoachingPlanImpl = buildCoachingPlan,
  onSearchStarted,
  searchFetchImpl,
  applyJobImpl,
  captureQuestionsImpl = capturePacketQuestions,
  answerScreeningQuestionsImpl = draftOneOffScreeningAnswers,
  confirmScreeningAnswerImpl = confirmOneOffScreeningAnswer,
  saveScreeningAnswerImpl = saveOneOffScreeningAnswer,
  prepareSchedulingPlanImpl = planSchedulingReply,
  draftStrategyReviewImpl = draftStrategyReview,
  applyStrategyRecommendationImpl = applyStrategyRecommendation,
  stampStrategyReviewImpl = stampStrategyReview,
  callAIImpl = callAI,
  sendCommunicationImpl,
  now = () => new Date(),
} = {}) {
  let normalized = normalizeWorkspaceIntent(intent);
  if (!EXECUTABLE_INTENTS.has(normalized.type)) throw unsupported(normalized.type);

  const intentMessage = workspaceIntentAppend({ repoRoot, env, intent: normalized, now });
  try {
    normalized = resolveNaturalWorkspaceRequest({ repoRoot, env, intent: normalized });
    const input = normalized.input || {};
    if (normalized.type === "screening.answer") {
      const questionText = String(input.questionText || "").trim();
      if (!questionText) {
        throw actionError("Paste the application question you want answered.", "QUESTION_REQUIRED");
      }
      const operation = await answerScreeningQuestionsImpl({
        repoRoot,
        env,
        questionText,
        applicationId: normalized.entity.type === "application" ? normalized.entity.id : undefined,
      });
      const reusableAnswers = (operation.answers || []).filter(
        (answer) => answer.durable && answer.uploadReady
      );
      const applicationAnswers = operation.applicationId
        ? (operation.answers || []).filter(
            (answer) => answer.uploadReady && answer.confirmationRequired === true
          )
        : [];
      if (
        operation.userSupplied === true &&
        applicationAnswers.length > 0 &&
        applicationAnswers.length === (operation.answers || []).length &&
        operation.needsUser !== true
      ) {
        const confirmation = await confirmScreeningAnswerImpl({
          repoRoot,
          env,
          applicationId: operation.applicationId,
          answers: applicationAnswers.map((entry) => ({
            questionId: entry.questionId,
            question: entry.question,
            answer: entry.answer,
          })),
        });
        const manifest = confirmation.packetManifest || {};
        const uploadReady = manifest.uploadReady === true;
        const gapCount = Number.isInteger(manifest.gapCount)
          ? manifest.gapCount
          : Array.isArray(manifest.gaps)
            ? manifest.gaps.length
            : 0;
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text: uploadReady
            ? `Confirmed ${confirmation.answers?.length > 1 ? "these answers" : "this answer"}. The application packet is ready to resume.`
            : `Confirmed ${confirmation.answers?.length > 1 ? "these answers" : "this answer"}. ${gapCount} packet item${gapCount === 1 ? "" : "s"} still need review.`,
          artifacts: [
            {
              kind: "screening_answer_confirmed",
              title: "Application answer confirmed",
              applicationId: confirmation.applicationId,
              questionId: confirmation.questionId,
              question: confirmation.question,
              answer: confirmation.answer,
              answers: confirmation.answers,
              artifactPath: confirmation.artifactPath,
            },
          ],
          metadata: {
            state: "confirmed",
            persisted: true,
            uploadReady,
            gapCount,
            ...(uploadReady
              ? {
                  nextActions: [
                    {
                      label: "Resume supervised apply",
                      intent: {
                        type: "job.prepare-submit",
                        entity: { type: "application", id: confirmation.applicationId },
                        input: { resumeSession: true },
                      },
                    },
                  ],
                }
              : {}),
          },
          operationResult: confirmation,
          now,
        });
      }
      const applicationActions =
        applicationAnswers.length === 1
          ? [
              {
                label: "Use this answer",
                intent: {
                  type: "screening.answer-confirm",
                  entity: { type: "application", id: operation.applicationId },
                  input: {
                    questionId: applicationAnswers[0].questionId,
                    question: applicationAnswers[0].question,
                    answer: applicationAnswers[0].answer,
                  },
                },
              },
            ]
          : applicationAnswers.length > 1
            ? [
                {
                  label: "Use reviewed answers",
                  intent: {
                    type: "screening.answer-confirm",
                    entity: { type: "application", id: operation.applicationId },
                    input: {
                      answers: applicationAnswers.map((answer) => ({
                        questionId: answer.questionId,
                        question: answer.question,
                        answer: answer.answer,
                      })),
                    },
                  },
                },
              ]
            : [];
      const reusableActions =
        (operation.answers || []).length === 1
          ? reusableAnswers.map((answer) => ({
              label: "Save for future applications",
              intent: {
                type: "screening.answer-save",
                entity: { type: "candidate", id: "candidate" },
                input: {
                  question: answer.question,
                  key: answer.key,
                  answer: answer.answer,
                },
              },
            }))
          : [];
      const count = (operation.answers || []).length;
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `${count === 1 ? "I drafted this answer" : `I drafted ${count} answers`}. Review ${count === 1 ? "this answer" : "them"} before using ${count === 1 ? "it" : "them"}. Nothing was submitted.`,
        artifacts: [
          {
            kind: "screening_answers",
            title: operation.applicationId
              ? `${operation.company || "Application"}: Screening answers`
              : "Screening answers",
            applicationId: operation.applicationId || null,
            answers: operation.answers || [],
            excluded: operation.excluded || [],
            artifactPath: operation.artifactPath || null,
          },
        ],
        metadata: {
          state: operation.needsUser ? "needs-user" : "reviewable",
          requiresReview: true,
          persisted: false,
          ai: operation.ai || { used: false },
          ...(applicationActions.length || reusableActions.length
            ? {
                nextActions: [...applicationActions, ...reusableActions],
              }
            : {}),
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "screening.answer-confirm") {
      const operation = await confirmScreeningAnswerImpl({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
        questionId: input.questionId,
        question: input.question,
        answer: input.answer,
        answers: input.answers,
      });
      const manifest = operation.packetManifest || {};
      const uploadReady = manifest.uploadReady === true;
      const gapCount = Number.isInteger(manifest.gapCount)
        ? manifest.gapCount
        : Array.isArray(manifest.gaps)
          ? manifest.gaps.length
          : 0;
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: uploadReady
          ? `Confirmed ${operation.answers?.length > 1 ? "these answers" : "this answer"}. The application packet is ready to resume.`
          : `Confirmed ${operation.answers?.length > 1 ? "these answers" : "this answer"}. ${gapCount} packet item${gapCount === 1 ? "" : "s"} still need review.`,
        artifacts: [
          {
            kind: "screening_answer_confirmed",
            title: "Application answer confirmed",
            applicationId: operation.applicationId,
            questionId: operation.questionId,
            question: operation.question,
            answer: operation.answer,
            answers: operation.answers,
            artifactPath: operation.artifactPath,
          },
        ],
        metadata: {
          state: "confirmed",
          persisted: true,
          uploadReady,
          gapCount,
          ...(uploadReady
            ? {
                nextActions: [
                  {
                    label: "Resume supervised apply",
                    intent: {
                      type: "job.prepare-submit",
                      entity: { type: "application", id: operation.applicationId },
                      input: { resumeSession: true },
                    },
                  },
                ],
              }
            : {}),
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "screening.answer-save") {
      const operation = await saveScreeningAnswerImpl({
        repoRoot,
        env,
        question: input.question,
        key: input.key,
        answer: input.answer,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: "Saved this reviewed answer for future applications.",
        artifacts: [
          {
            kind: "screening_answer_saved",
            title: "Reusable screening answer saved",
            key: operation.key,
            answer: operation.answer,
          },
        ],
        metadata: { state: "saved", persisted: true },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "communication.capture-inbound") {
      const item = intakeOne({ repoRoot, env, id: normalized.entity.id });
      if (!item) throw notFoundError("intake", normalized.entity.id);
      if (item.status !== "confirmed" || item.decision !== "confirm") {
        throw actionError(
          "Review and confirm this recruiter message before it changes communication state.",
          "INTAKE_CONFIRMATION_REQUIRED"
        );
      }
      if (item.kind !== "recruiter-email") {
        throw actionError(
          "Only confirmed recruiter-email intake can create a communication thread.",
          "BAD_COMMUNICATION_INTAKE"
        );
      }
      const entities = item.classification?.entities || {};
      const match = item.trackerMatch || {};
      const applicationId =
        match.matched && match.recordType === "application" ? match.id : undefined;
      const sourcedId = match.matched && match.recordType === "sourced" ? match.id : undefined;
      const company = entities.company || match.company || "";
      const role = entities.role || match.role || "";
      const subject = headerValue(item.rawInput, "Subject");
      const operation = commCaptureInbound({
        repoRoot,
        env,
        applicationId,
        sourcedId,
        company,
        role,
        channel: "email",
        subject,
        participant: {
          name: entities.contactName || "",
          email: entities.contactEmail || "",
        },
        summary: inboundSummary(item),
        artifactPath: item.capturedPath || item.sourceFilePath || undefined,
        sourceId: item.id,
        at: resolvedCommunicationDate(input.receivedAt, now),
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Captured the recruiter message${company ? ` for ${company}` : ""}. It is ready to review and reply in this workspace.`,
        artifacts: [
          {
            kind: "communication_thread",
            title: [company, role, subject].filter(Boolean).join(", ") || "Recruiter message",
            communicationId: operation.id,
          },
        ],
        metadata: {
          state: "needs-reply",
          communicationId: operation.id,
          created: operation.created,
          sourceIntakeId: item.id,
        },
        now,
      });
    }

    if (normalized.type === "interview.capture-context") {
      const item = intakeOne({ repoRoot, env, id: normalized.entity.id });
      if (!item) throw notFoundError("intake", normalized.entity.id);
      if (item.status !== "confirmed" || item.decision !== "confirm") {
        throw actionError(
          "Review and confirm this interview context before it changes application state.",
          "INTAKE_CONFIRMATION_REQUIRED"
        );
      }
      if (item.kind !== "interview-transcript") {
        throw actionError(
          "Only confirmed interview intake can be captured as interview context.",
          "BAD_INTERVIEW_INTAKE"
        );
      }
      const match = item.trackerMatch || {};
      if (!match.matched || match.recordType !== "application" || !match.id) {
        throw actionError(
          "Choose the tracked application this interview belongs to before confirming it.",
          "INTERVIEW_APPLICATION_REQUIRED"
        );
      }
      const entities = item.classification?.entities || {};
      const operation = appCaptureInterviewIntake({
        repoRoot,
        env,
        id: match.id,
        interviewAt: entities.interviewDate || undefined,
        summary: inboundSummary(item),
        artifactPath: item.capturedPath || item.sourceFilePath || undefined,
        who: entities.contactName || undefined,
        at: resolvedCommunicationDate(input.capturedAt, now),
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: operation.scheduled
          ? `Captured and scheduled the interview for ${match.company || "the matched application"}.`
          : `Captured the interview context for ${match.company || "the matched application"}; no reliable future time was inferred.`,
        artifacts: [
          {
            kind: "interview_context",
            title: [match.company, match.role].filter(Boolean).join(", ") || "Interview context",
            applicationId: match.id,
            path: item.capturedPath || item.sourceFilePath || null,
          },
        ],
        metadata: {
          state: operation.scheduled ? "scheduled" : "captured",
          applicationId: match.id,
          scheduled: operation.scheduled,
          scheduledAt: operation.scheduledAt,
          sourceIntakeId: item.id,
        },
        now,
      });
    }

    if (normalized.type === "interview.prepare") {
      const operation = buildInterviewDossierImpl({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
        audience: input.audience,
        inviteNotes: input.inviteNotes,
        jobSignals: input.jobSignals,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Prepared the interview packet for ${operation.company}, ${operation.role}.`,
        artifacts: [
          {
            kind: "interview_dossier",
            title: operation.dossier.title,
            path: operation.dossier.path,
            markdown: operation.dossier.markdown,
          },
        ],
        metadata: {
          state: "ready",
          applicationId: normalized.entity.id,
          nextActions: [
            navigationAction("Open dossier", {
              surface: "files",
              entityType: "application",
              entityId: normalized.entity.id,
              artifactKind: "interview-dossier",
            }),
          ],
        },
        now,
      });
    }

    if (
      normalized.type === "job.evaluate-request" ||
      normalized.type === "job.prepare-request" ||
      normalized.type === "job.tailor-request"
    ) {
      const jobUrl = String(input.jobUrl || "").trim();
      const jobId = String(input.jobId || "").trim();
      const jobReference = String(input.jobReference || "").trim();
      const intakeId = normalized.entity.type === "intake" ? normalized.entity.id : "";
      if (!jobUrl && !jobId && !jobReference && !intakeId) {
        throw actionError(
          "A job URL, confirmed job description, or saved job is required.",
          "JOB_URL_REQUIRED"
        );
      }
      const captured = intakeId
        ? await captureIntakeJobRequest({
            repoRoot,
            env,
            intakeId,
            resolveJobUrlImpl,
            fetchImpl: searchFetchImpl,
            now,
          })
        : jobUrl
          ? await captureJobRequest({
              repoRoot,
              env,
              jobUrl,
              resolveJobUrlImpl,
              fetchImpl: searchFetchImpl,
              now,
            })
          : jobId
            ? resolveSavedJobRequest({ repoRoot, env, jobId })
            : resolveReferencedJobRequest({ repoRoot, env, jobReference });
      const evaluated = await evaluateApplicationRequest({
        repoRoot,
        env,
        applicationId: captured.applicationId,
        jobBody: captured.bodyText,
        jobUrl: captured.jobUrl,
        evaluateJobImpl,
      });
      const evaluationMetadata = {
        applicationId: captured.applicationId,
        gate: evaluated.gate,
        fitScore: evaluated.evaluation.fitScore ?? null,
        manualRequired: Boolean(evaluated.evaluation.manual?.required),
      };

      if (normalized.type === "job.evaluate-request" || evaluated.gate !== "keep") {
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text: evaluated.text,
          artifacts: [evaluated.artifact],
          metadata: {
            ...evaluationMetadata,
            ...(captured.sourceIntakeId ? { sourceIntakeId: captured.sourceIntakeId } : {}),
            state: evaluated.gate,
            nextActions: evaluationNextActions(
              evaluated.gate,
              captured.applicationId,
              evaluated.evaluation.fitRisks,
              evaluated.evaluation.evaluatedAt
            ),
          },
          now,
        });
      }

      const applyIntent = normalized.type === "job.prepare-request";
      const questionCapture = applyIntent
        ? await prepareApplicationQuestions({
            repoRoot,
            env,
            application: evaluated.application,
            applicationId: captured.applicationId,
            captureQuestionsImpl,
            fetchImpl: searchFetchImpl,
          })
        : null;
      const { packet, questionCaptureDeferred } = await generateDocumentsWithQuestionFallback({
        repoRoot,
        env,
        applicationId: captured.applicationId,
        applyIntent,
        formats: ["pdf"],
        generateDocumentsImpl,
      });
      const gaps = packetGapsForApplication(packet.gaps, evaluated.application, applyIntent);
      const blockingGapCount = blockingPacketGaps(gaps).length;
      const handoffArtifact =
        applyIntent && blockingGapCount === 0
          ? applicationHandoffArtifact(
              evaluated.application,
              captured.applicationId,
              questionCapture,
              { executorAvailable: typeof applyJobImpl === "function" }
            )
          : null;
      const packetArtifact = {
        kind: "packet_generation",
        purpose: applyIntent ? "application" : "tailoring",
        title: `${applicationLabel(evaluated.application)}: Documents`,
        applicationId: captured.applicationId,
        status: packet.status || "reviewable",
        uploadReady: Boolean(packet.uploadReady),
        artifacts: packet.artifacts || {},
        gaps,
        blockingGapCount,
      };
      const nextActions = applyIntent
        ? packetNextActions(
            gaps,
            captured.applicationId,
            Boolean(handoffArtifact),
            typeof applyJobImpl === "function"
          )
        : tailoredPacketNextActions(captured.applicationId);
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `${evaluated.text} ${
          applyIntent
            ? `${questionCaptureText(questionCapture, evaluated.application)} Generated the application packet.`
            : "Generated the tailored résumé and cover letter."
        } ${packetGapText(gaps, questionCaptureDeferred, { tailoring: !applyIntent })}`,
        artifacts: [evaluated.artifact, packetArtifact, handoffArtifact].filter(Boolean),
        metadata: {
          ...evaluationMetadata,
          ...(captured.sourceIntakeId ? { sourceIntakeId: captured.sourceIntakeId } : {}),
          state: packet.status || "reviewable",
          uploadReady: Boolean(packet.uploadReady),
          gapCount: gaps.length,
          blockingGapCount,
          nextActions,
        },
        operationResult: { ...packet, gaps },
        now,
      });
    }

    if (normalized.type === "job.evaluate") {
      if (normalized.entity.type !== "application") {
        throw actionError(
          "Promote this sourced role to a tracked application before running the full evaluation.",
          "EVALUATION_APPLICATION_REQUIRED"
        );
      }
      const evaluated = await evaluateApplicationRequest({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
        jobBody: input.jobBody,
        jobUrl: input.jobUrl,
        evaluateJobImpl,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: evaluated.text,
        artifacts: [evaluated.artifact],
        metadata: {
          state: evaluated.gate,
          applicationId: normalized.entity.id,
          fitScore: evaluated.evaluation.fitScore ?? null,
          manualRequired: Boolean(evaluated.evaluation.manual?.required),
          nextActions: evaluationNextActions(
            evaluated.gate,
            normalized.entity.id,
            evaluated.evaluation.fitRisks,
            evaluated.evaluation.evaluatedAt
          ),
        },
        now,
      });
    }

    if (normalized.type === "job.generate-documents") {
      const application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      const formats = Array.isArray(input.formats)
        ? [...new Set(input.formats.map((value) => String(value).toLowerCase()))].filter((value) =>
            ["pdf", "docx"].includes(value)
          )
        : ["pdf"];
      const applyIntent = input.applyIntent === true;
      const questionCapture = applyIntent
        ? await prepareApplicationQuestions({
            repoRoot,
            env,
            application,
            applicationId: normalized.entity.id,
            captureQuestionsImpl,
            fetchImpl: searchFetchImpl,
          })
        : null;
      const { packet: operation, questionCaptureDeferred } =
        await generateDocumentsWithQuestionFallback({
          repoRoot,
          env,
          applicationId: normalized.entity.id,
          applyIntent,
          formats: formats.length ? formats : ["pdf"],
          generateDocumentsImpl,
        });
      const gaps = packetGapsForApplication(operation.gaps, application, applyIntent);
      const blockingGapCount = blockingPacketGaps(gaps).length;
      const handoffArtifact =
        applyIntent && blockingGapCount === 0
          ? applicationHandoffArtifact(application, normalized.entity.id, questionCapture, {
              executorAvailable: typeof applyJobImpl === "function",
            })
          : null;
      const gapText = packetGapText(gaps, questionCaptureDeferred, {
        tailoring: !applyIntent,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `${
          applyIntent
            ? `${questionCaptureText(questionCapture, application)} Generated documents for ${applicationLabel(application)}.`
            : `Generated the tailored résumé and cover letter for ${applicationLabel(application)}.`
        } ${gapText}`.trim(),
        artifacts: [
          {
            kind: "packet_generation",
            purpose: applyIntent ? "application" : "tailoring",
            title: `${applicationLabel(application)}: Documents`,
            applicationId: normalized.entity.id,
            status: operation.status || "reviewable",
            uploadReady: Boolean(operation.uploadReady),
            artifacts: operation.artifacts || {},
            gaps,
            blockingGapCount,
          },
          handoffArtifact,
        ].filter(Boolean),
        metadata: {
          state: operation.status || "reviewable",
          uploadReady: Boolean(operation.uploadReady),
          gapCount: gaps.length,
          blockingGapCount,
          nextActions: applyIntent
            ? packetNextActions(
                gaps,
                normalized.entity.id,
                Boolean(handoffArtifact),
                typeof applyJobImpl === "function"
              )
            : tailoredPacketNextActions(normalized.entity.id),
        },
        operationResult: { ...operation, gaps },
        now,
      });
    }

    if (normalized.type === "job.export-documents") {
      const application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      const formats = Array.isArray(input.formats)
        ? [...new Set(input.formats.map((value) => String(value).toLowerCase()))].filter((value) =>
            ["pdf", "docx"].includes(value)
          )
        : ["pdf"];
      const operation = await exportDocumentsImpl({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
        formats: formats.length ? formats : ["pdf"],
        exportArtifact: packetExportArtifact,
      });
      const artifacts = operation.artifacts || {};
      const fileCount = Object.keys(artifacts).filter((key) => /(Pdf|Docx)$/.test(key)).length;
      const downloadsErrors = Array.isArray(operation.downloadsErrors)
        ? operation.downloadsErrors
        : [];
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Exported ${fileCount} packaged file${fileCount === 1 ? "" : "s"} for ${applicationLabel(application)}.${downloadsErrors.length ? ` ${downloadsErrors.length} convenience copy failed; the workspace exports are still available.` : ""}`,
        artifacts: [
          {
            kind: "packet_export",
            title: `${applicationLabel(application)}: Exported files`,
            applicationId: normalized.entity.id,
            formats: operation.formats || formats,
            artifacts,
            userFacing: operation.userFacing || {},
            downloadsErrors,
          },
        ],
        metadata: {
          state: "exported",
          fileCount,
          downloadsErrorCount: downloadsErrors.length,
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "source.add") {
      if (typeof addBoardSourceImpl !== "function") {
        const error = actionError(
          "Job-board setup is not connected in this runtime.",
          "SOURCE_SETUP_UNAVAILABLE"
        );
        error.status = 501;
        throw error;
      }
      const url = String(input.url || "").trim();
      if (!url) throw actionError("A job-board URL is required.", "SOURCE_URL_REQUIRED");
      const operation = await addBoardSourceImpl({ repoRoot, env, url });
      const source = operation?.source || {};
      const label = String(source.label || source.provider || "This source");
      const added = operation?.added !== false;
      const enabled = source.enabled !== false;
      const authPending = source.auth === true && !enabled;
      const expandedSearch =
        added && enabled && source.auth !== true
          ? await startExpandedSourceSearch({
              repoRoot,
              env,
              searchFetchImpl,
              startManualSearchImpl,
              onSearchStarted,
            })
          : null;
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: added
          ? `Added ${label} to your search sources.${
              authPending
                ? " It stays off until you enable browser access for this provider."
                : expandedSearch?.started
                  ? " It is enabled, and CareerRat is searching it now."
                  : " It is enabled for future searches."
            }`
          : `${label} is already in your search sources. Nothing changed.`,
        artifacts: [
          {
            kind: "search_source",
            title: `${label}: ${added ? "Added" : "Already configured"}`,
            added,
            index: source.index ?? null,
            provider: source.provider || null,
            label,
            target: source.target || url,
            sourceType: source.sourceType || source.source_type || null,
            enabled,
            auth: source.auth === true,
          },
          expandedSearch?.artifact,
        ].filter(Boolean),
        metadata: {
          state: expandedSearch?.started ? "running" : added ? "added" : "existing",
          nextActions: [
            navigationAction("Search jobs", { surface: "search" }),
            navigationAction("Manage sources", { surface: "settings", section: "sources" }),
          ],
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "source.query-add") {
      if (typeof addSearchSourceQueryImpl !== "function") {
        const error = actionError(
          "Keyword search setup is not connected in this runtime.",
          "SOURCE_SETUP_UNAVAILABLE"
        );
        error.status = 501;
        throw error;
      }
      const query = String(input.query || "").trim();
      if (!query) throw actionError("A search phrase is required.", "SOURCE_QUERY_REQUIRED");
      const provider = String(input.provider || "HiringCafe").trim() || "HiringCafe";
      const operation = await addSearchSourceQueryImpl({ repoRoot, env, query, provider });
      const source = operation?.source || {};
      const label = String(source.label || query);
      const added = operation?.added !== false;
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: added
          ? `Added ${label} to your search sources. It is enabled for future searches.`
          : `${label} is already in your search sources. Nothing changed.`,
        artifacts: [
          {
            kind: "search_source",
            title: `${label}: ${added ? "Added" : "Already configured"}`,
            added,
            index: source.index ?? null,
            provider: source.provider || provider,
            label,
            target: source.target || query,
            sourceType: source.sourceType || source.source_type || null,
            enabled: source.enabled !== false,
            auth: source.auth === true,
          },
        ],
        metadata: {
          state: added ? "added" : "existing",
          nextActions: [
            navigationAction("Search jobs", { surface: "search" }),
            navigationAction("Manage sources", { surface: "settings", section: "sources" }),
          ],
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "source.set-enabled") {
      if (typeof setSearchSourceEnabledImpl !== "function") {
        const error = actionError(
          "Search-source controls are not connected in this runtime.",
          "SOURCE_SETUP_UNAVAILABLE"
        );
        error.status = 501;
        throw error;
      }
      const selector = String(input.selector || "").trim();
      if (!selector) throw actionError("Name the search source to change.", "SOURCE_REQUIRED");
      if (typeof input.enabled !== "boolean") {
        throw actionError(
          "Choose whether to enable or disable the source.",
          "SOURCE_STATE_REQUIRED"
        );
      }
      const operation = await setSearchSourceEnabledImpl({
        repoRoot,
        env,
        selector,
        enabled: input.enabled,
      });
      const source = operation?.source || {};
      const label = String(source.label || source.provider || selector);
      const changed = operation?.changed !== false;
      const stateLabel = input.enabled ? "Enabled" : "Disabled";
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: changed
          ? `${stateLabel} ${label} for future searches.${
              input.enabled && source.auth === true
                ? " Browser access still needs separate consent before CareerRat can use it."
                : ""
            }`
          : `${label} is already ${input.enabled ? "enabled" : "disabled"}. Nothing changed.`,
        artifacts: [
          {
            kind: "search_source",
            title: `${label}: ${stateLabel}`,
            changed,
            index: source.index ?? null,
            provider: source.provider || null,
            label,
            target: source.target || null,
            sourceType: source.sourceType || source.source_type || null,
            enabled: input.enabled,
            auth: source.auth === true,
          },
        ],
        metadata: {
          state: input.enabled ? "enabled" : "disabled",
          nextActions: [
            navigationAction("Search jobs", { surface: "search" }),
            navigationAction("Manage sources", { surface: "settings", section: "sources" }),
          ],
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "source.discover") {
      if (typeof startBoardDiscoveryImpl !== "function") {
        const error = actionError(
          "Guided board discovery is not connected in this runtime.",
          "BOARD_DISCOVERY_UNAVAILABLE"
        );
        error.status = 501;
        throw error;
      }
      const request = String(input.request || "")
        .trim()
        .slice(0, 500);
      const operation = await startBoardDiscoveryImpl({ repoRoot, env, request });
      const artifact = boardDiscoveryChatArtifact(
        operation?.chat || operation?.activeDiscoveryChat || operation
      );
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: artifact.reused
          ? "Reopened your job-board discovery. Review every source before adding it."
          : "Started a guided search for new job boards. Review every source before adding it.",
        artifacts: [artifact],
        metadata: {
          state: artifact.state,
          nextActions: [
            navigationAction("Search jobs", { surface: "search" }),
            navigationAction("Manage sources", { surface: "settings", section: "sources" }),
          ],
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "company.discover") {
      // An unresolved proposal batch is reopened instead of duplicated: same
      // guard as search.run (see reopenPendingCompanyProposalBatch). A
      // changed discovery context (targeting drift since the pending batch)
      // still surfaces here because companyDiscoveryCadenceImpl reports that
      // batch as "needs-review" only while it has undecided proposals; once
      // it is fully decided, a stale context falls through to "due" below
      // and a fresh batch is created.
      const cadence = companyDiscoveryCadenceImpl({ repoRoot, env, now: requestDate(now) });
      const reopenArtifact = reopenPendingCompanyProposalBatch({
        repoRoot,
        env,
        cadence,
        getBatchImpl: getCompanyProposalBatchImpl,
      });
      if (reopenArtifact) {
        const proposalCount = reopenArtifact.proposals.length;
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text:
            companyDiscoveryReviewSentence(proposalCount) || "All company proposals are reviewed.",
          artifacts: [reopenArtifact],
          metadata: {
            state: proposalCount ? "needs-review" : "complete",
            proposalCount,
            rejectedCount: reopenArtifact.rejected.length,
          },
          now,
        });
      }
      const requestedCount = Number(input.requestedCount);
      const body = {
        requestedCount:
          Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : 12,
        ...(String(input.request || "").trim()
          ? { request: String(input.request).trim().slice(0, 500) }
          : {}),
      };
      const operation = await createCompanyProposalsImpl({
        repoRoot,
        env,
        body,
        fetchImpl: searchFetchImpl,
        seedCall: callAIImpl,
        now: requestDate(now),
      });
      if (operation?.body) {
        throw companyProposalOperationError(operation);
      }
      const artifact = companyProposalArtifact(operation?.data, operation?.meta);
      const proposalCount = artifact.proposals.length;
      const reviewedCount = Number(artifact.counts.seeds || 0);
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: proposalCount
          ? `Found ${proposalCount} new compan${proposalCount === 1 ? "y" : "ies"} beyond your focus examples. Review each one before CareerRat tracks its job board.`
          : `Reviewed ${reviewedCount} compan${reviewedCount === 1 ? "y" : "ies"} beyond your focus examples. No new supported job boards need approval right now.`,
        artifacts: [artifact],
        metadata: {
          state: proposalCount ? "needs-review" : "complete",
          proposalCount,
          rejectedCount: artifact.rejected.length,
          ...(proposalCount ? {} : { nextActions: [searchExpandedCompaniesAction()] }),
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "research.company") {
      // Entity shape has drifted across callers over time: the deleted api.js
      // researchCompany() wrapper always sent a workspace entity
      // ({type: "workspace"}), while the live free-text classifier (below,
      // around line 7068) sends {type: "company", id: slugifyCompany(...)}.
      // This handler ignores entity.type, so nothing breaks today, but
      // company.proposal-decide (a sibling intent) does branch on entity
      // type via BAD_INTENT_ENTITY, so don't assume that stays true here.
      const company = String(input.company || "").trim();
      if (!company) {
        throw actionError("Name the company CareerRat should research.", "COMPANY_NOT_FOUND");
      }
      if (typeof startCompanyResearchImpl !== "function") {
        const error = actionError(
          "Company research is not connected in this runtime.",
          "COMPANY_RESEARCH_UNAVAILABLE"
        );
        error.status = 501;
        throw error;
      }

      if (!input.force) {
        const hit = readCompanyResearch(company, { root: repoRoot });
        if (hit && !hit.stale) {
          const fm = hit.frontmatter || {};
          const slug = slugifyCompany(company);
          return appendActionResult({
            repoRoot,
            env,
            normalized,
            intentMessage,
            text: `CareerRat already researched ${fm.company || company}, fetched ${fm.fetchedAt}. It is still current.`,
            artifacts: [
              companyResearchArtifact({
                fm,
                company,
                slug,
                stale: false,
                markdown: splitFrontmatter(hit.text).body,
              }),
            ],
            metadata: {
              state: "reused",
              nextActions: [
                {
                  label: "Refresh research",
                  intent: {
                    type: "research.company",
                    entity: normalized.entity,
                    input: { company, force: true },
                  },
                },
              ],
            },
            now,
          });
        }
      }

      const request = `Research ${company} for the candidate.`;
      const operation = await startCompanyResearchImpl({ repoRoot, env, request });
      const artifact = researchChatArtifact(
        operation?.chat || operation?.activeDiscoveryChat || operation,
        { skill: "research-company", title: `Researching ${company}` }
      );
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: artifact.reused
          ? `Reopened the research session for ${company}.`
          : `Started researching ${company}. CareerRat will cite every claim.`,
        artifacts: [artifact],
        metadata: { state: artifact.state },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "research.comp") {
      let role = String(input.role || "").trim();
      let location = String(input.location || "").trim();
      let company = String(input.company || "").trim();
      if ((!role || !location) && input.jobId) {
        let jobRow;
        try {
          jobRow = applicationForIntent({ repoRoot, env, id: input.jobId });
        } catch (error) {
          if (error?.code !== "NOT_FOUND") throw error;
          jobRow = sourcedForIntent({ repoRoot, env, id: input.jobId });
        }
        role = role || String(jobRow.role || "").trim();
        location = location || String(jobRow.location || jobRow.loc || "").trim();
        company = company || String(jobRow.company || "").trim();
      }
      if (!role || !location) {
        throw actionError(
          "Tell CareerRat the role and location so it can research market comp.",
          "RESEARCH_COMP_INPUT_REQUIRED"
        );
      }
      if (typeof startCompResearchImpl !== "function") {
        const error = actionError(
          "Market comp research is not connected in this runtime.",
          "COMP_RESEARCH_UNAVAILABLE"
        );
        error.status = 501;
        throw error;
      }

      if (!input.force) {
        const fresh = findFreshCompBenchmark({ repoRoot, role, location });
        // findFreshCompBenchmark's listResearch() scan and this readResearch()
        // read aren't atomic; if the file's gone by the time we read it, fall
        // through to the fresh-run path below instead of dereferencing null.
        const hit = fresh ? readResearch(fresh.stem, { root: repoRoot }) : null;
        if (fresh && hit) {
          const fm = hit.frontmatter || {};
          return appendActionResult({
            repoRoot,
            env,
            normalized,
            intentMessage,
            text: `CareerRat already has a market comp benchmark for ${fm.role || role} in ${fm.location || location}, fetched ${fm.fetchedAt}. It is still current.`,
            artifacts: [
              compBenchmarkArtifact({
                fm,
                role,
                location,
                path: researchRelPath(fresh.stem),
                markdown: splitFrontmatter(hit.text).body,
              }),
            ],
            metadata: {
              state: "reused",
              nextActions: [
                {
                  label: "Refresh benchmark",
                  intent: {
                    type: "research.comp",
                    entity: normalized.entity,
                    input: { role, location, ...(company ? { company } : {}), force: true },
                  },
                },
              ],
            },
            now,
          });
        }
      }

      const request = `Benchmark market comp for ${role} in ${location}${company ? ` at ${company}` : ""}.`;
      const operation = await startCompResearchImpl({ repoRoot, env, request });
      const artifact = researchChatArtifact(
        operation?.chat || operation?.activeDiscoveryChat || operation,
        { skill: "research-comp", title: "Market comp research" }
      );
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: artifact.reused
          ? `Reopened the market comp research for ${role} in ${location}.`
          : `Started market comp research for ${role} in ${location}. CareerRat will cite every figure.`,
        artifacts: [artifact],
        metadata: { state: artifact.state },
        operationResult: operation,
        now,
      });
    }

    // The conversational bridge for research-company / research-comp: the
    // CHAT_RUNTIME_TOOLS profile (src/core/ai/runtime-tools.mjs) never
    // includes Bash, so an embedded chat session can never shell out to
    // `careerrat research record ... --write` the way the skills' CLI path
    // does. Instead the skill emits its finished artifact as a typed block
    // (see research-company/research-comp SKILL.md's Conversational web
    // handoff section) and the app turns that into a confirm affordance that
    // fires this intent — the write itself runs through the exact same
    // computeResearchWrite/writeResearch guards (citation-hygiene,
    // placeholder lint, current_base privacy) the CLI path already used.
    if (normalized.type === "research.record") {
      const type = String(input.type || "").trim();
      const allowedTypes = new Set(["company-research", "comp-benchmark"]);
      if (!allowedTypes.has(type)) {
        throw actionError(
          `CareerRat needs to know whether this is company research or a comp benchmark (got ${JSON.stringify(input.type || "")}).`,
          "RESEARCH_RECORD_TYPE_REQUIRED"
        );
      }
      const markdown = String(input.markdown || "");
      if (!markdown.trim()) {
        throw actionError(
          "CareerRat needs the finished research text before it can save it.",
          "RESEARCH_RECORD_MARKDOWN_REQUIRED"
        );
      }
      const name = String(input.name || "").trim();
      const slug = String(input.slug || name || "").trim();
      if (!slug) {
        throw actionError(
          "CareerRat needs a company or role name to file this research under.",
          "RESEARCH_RECORD_NAME_REQUIRED"
        );
      }

      const written = writeResearch({ stem: slug, text: markdown, root: repoRoot });
      if (!written.ok) {
        throw actionError(
          `CareerRat could not save this research: ${written.error}`,
          "RESEARCH_RECORD_INVALID"
        );
      }
      const fm = written.frontmatter || {};
      const body = splitFrontmatter(markdown).body;
      const artifact =
        type === "company-research"
          ? companyResearchArtifact({
              fm,
              company: fm.company || name,
              slug: written.stem,
              stale: written.stale,
              markdown: body,
            })
          : compBenchmarkArtifact({
              fm,
              role: fm.role || name,
              location: fm.location || "",
              path: written.relPath,
              markdown: body,
            });
      // Best-effort Activity Pulse log, mirroring the explicit `careerrat
      // activity append` call in research-company/research-comp SKILL.md's
      // STEP 5 — writeResearch() itself never logs (unlike companyHealthSet,
      // a research artifact is a plain fs write, not a DB verb). The
      // artifact write above already succeeded and is the durable result;
      // a logging hiccup here must not fail the whole confirmed save.
      try {
        activityAppend({
          repoRoot,
          env,
          event: {
            type: "research",
            actor: "agent",
            title:
              type === "company-research"
                ? `Researched ${artifact.company}`
                : `Comp benchmark: ${artifact.role}${artifact.location ? ` (${artifact.location})` : ""}`,
            ...(type === "comp-benchmark"
              ? { summary: compBenchmarkActivitySummary(fm.benchmark) }
              : {}),
            refs:
              type === "company-research" ? { company: artifact.company } : { role: artifact.role },
            skill: type === "company-research" ? "research-company" : "research-comp",
            operation: "research:record",
          },
        });
      } catch {
        // non-fatal — see comment above
      }
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text:
          type === "company-research"
            ? `Saved research for ${artifact.company} to your workspace.`
            : `Saved the comp benchmark for ${artifact.role}${artifact.location ? ` in ${artifact.location}` : ""} to your workspace.`,
        artifacts: [artifact],
        metadata: { state: "recorded" },
        now,
      });
    }

    if (normalized.type === "company.health") {
      const entityType = normalized.entity.type;
      const row =
        entityType === "application"
          ? applicationForIntent({ repoRoot, env, id: normalized.entity.id })
          : sourcedForIntent({ repoRoot, env, id: normalized.entity.id });
      const company = String(input.company || row.company || "").trim();
      const role = String(row.role || "").trim();
      if (!company) {
        throw actionError("Name the company CareerRat should check.", "COMPANY_NOT_FOUND");
      }

      if (!input.force && row.companyHealth?.asOf) {
        const stillFresh = !isStale(
          row.companyHealth.asOf,
          companyHealthRecheckDays({ repoRoot, env }),
          requestDate(now).getTime()
        );
        if (stillFresh) {
          const health = row.companyHealth;
          return appendActionResult({
            repoRoot,
            env,
            normalized,
            intentMessage,
            text: `${company || "This company"}: ${health.rating} for ${health.forFunction || role || "this role"}, as of ${health.asOf}.`,
            artifacts: [
              companyHealthArtifactFromRating({ entityType, rowId: row.id, company, role, health }),
            ],
            metadata: {
              state: "reused",
              nextActions: [
                {
                  label: "Re-check now",
                  intent: {
                    type: "company.health",
                    entity: normalized.entity,
                    input: { force: true },
                  },
                },
                navigationAction("Open in Jobs", {
                  surface: entityType === "application" ? "job" : "search",
                  entityType,
                  entityId: row.id,
                }),
              ],
            },
            now,
          });
        }
      }

      if (typeof startCompanyHealthImpl !== "function") {
        const error = actionError(
          "Company health research is not connected in this runtime.",
          "COMPANY_HEALTH_UNAVAILABLE"
        );
        error.status = 501;
        throw error;
      }
      const request = `Check company health for ${company}${role ? ` (${role} role)` : ""}.`;
      const operation = await startCompanyHealthImpl({ repoRoot, env, request });
      const artifact = researchChatArtifact(
        operation?.chat || operation?.activeDiscoveryChat || operation,
        { skill: "company-health", title: `Company health: ${company}` }
      );
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: artifact.reused
          ? `Reopened the company-health check for ${company}.`
          : `Started a company-health check for ${company}. This stays internal and never reaches the company.`,
        artifacts: [artifact],
        metadata: { state: artifact.state },
        operationResult: operation,
        now,
      });
    }

    // The conversational bridge for company-health, mirroring research.record
    // above: the embedded chat session emits the finished rating as a typed
    // block instead of shelling out to `careerrat health record ... --write`,
    // and this intent performs the write server-side through the same
    // companyHealthSet validation (rating/provenance enums, asOf format,
    // fitDelta sign, current_base leak guard) the CLI path already used.
    if (normalized.type === "company.health-record") {
      const entityType = normalized.entity.type;
      const row =
        entityType === "application"
          ? applicationForIntent({ repoRoot, env, id: normalized.entity.id })
          : sourcedForIntent({ repoRoot, env, id: normalized.entity.id });
      const company = String(input.company || row.company || "").trim();
      const role = String(row.role || "").trim();

      let result;
      try {
        result = companyHealthSet({
          repoRoot,
          env,
          id: normalized.entity.id,
          companyHealth: input.companyHealth,
        });
      } catch (error) {
        if (error?.code === "NOT_FOUND") throw error;
        throw actionError(
          `CareerRat could not save this company-health rating: ${error.message}`,
          error?.code || "HEALTH_RECORD_INVALID"
        );
      }
      const health = result.companyHealth;
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `${company || "This company"}: ${health.rating} for ${health.forFunction || role || "this role"}, as of ${health.asOf}.`,
        artifacts: [
          companyHealthArtifactFromRating({ entityType, rowId: row.id, company, role, health }),
        ],
        metadata: {
          state: "recorded",
          nextActions: [
            navigationAction("Open in Jobs", {
              surface: entityType === "application" ? "job" : "search",
              entityType,
              entityId: row.id,
            }),
          ],
        },
        now,
      });
    }

    // coaching.plan — Phase 1 coaching loop: the explicit "Coach me on this
    // fit" click on a review-gate verdict with named fitRisks. Mirrors
    // job.evaluate's own shape (buildCoachingPlanImpl owns the bounded-AI
    // call + NO_AI_ROUTE degradation, src/core/coaching/plan.mjs), persisted
    // through the generic appSetFields patch verb — coaching earns no new DB
    // verb, it just writes one more typed field onto the application row.
    if (normalized.type === "coaching.plan") {
      const application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      const operation = await buildCoachingPlanImpl({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
      });
      const plan = operation?.body?.data;
      if (operation?.status !== 200 || !operation?.body?.ok || !plan) {
        throw actionError(
          operation?.body?.error?.message || "The coaching plan could not be built.",
          operation?.body?.code || "COACHING_PLAN_FAILED"
        );
      }
      appSetFields({
        repoRoot,
        env,
        id: normalized.entity.id,
        patch: { coachingPlan: plan },
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Built a coaching plan for ${applicationLabel(application)}: ${plan.gaps.length} gap${plan.gaps.length === 1 ? "" : "s"} named.`,
        artifacts: [
          {
            kind: "coaching_plan",
            applicationId: normalized.entity.id,
            title: `${applicationLabel(application)}: Coaching plan`,
            coachingPlan: plan,
          },
        ],
        metadata: { state: "planned" },
        now,
      });
    }

    // coaching.evidence-save — confirming one gap's evidence-claim draft.
    // Routes through the SAME evidence firewall every other guarded evidence
    // write uses: computeEvidenceWrite (evidence-writer.mjs) validates the
    // claim (id/claim/evidence required, placeholder lint, current_base leak
    // guard) and computes the merged claim set, then candidateEvidenceMerge
    // (db/verbs/candidate.mjs) is the actual DB-mode persistence — the SAME
    // branch src/cli/evidence.mjs itself takes when a DB workspace exists.
    // evidence-writer.mjs's own writeEvidence() only writes the LEGACY
    // candidate/evidence.yml file and has no DB-mode branch, so it is never
    // the right call in this DB-only web workspace; NO firewall is bypassed
    // either way, since candidateEvidenceMerge enforces the identical
    // lint/leak backstop (assertCleanEvidenceClaims) on top.
    //
    // Only the stored, reviewed gap.suggestion.draftClaim is ever persisted —
    // there is no caller-supplied override. The draft the candidate saw and
    // confirmed on the card is the exact draft that gets written; nothing in
    // the product has ever populated a different one, and accepting one from
    // input would let a confirm click silently save text the candidate never
    // reviewed.
    if (normalized.type === "coaching.evidence-save") {
      const application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      const gapId = String(input.gapId || "").trim();
      const plan = application.coachingPlan;
      const gap = Array.isArray(plan?.gaps) ? plan.gaps.find((g) => g.id === gapId) : null;
      if (!gapId || !gap) {
        throw actionError("CareerRat could not find that coaching gap.", "COACHING_GAP_NOT_FOUND");
      }
      // The schema documents basedOn as the plan's provenance but nothing
      // enforced it: a plan built against a prior evaluation must never be
      // actable once a new evaluation has landed (evaluatedAt is the
      // discriminator; gate/fitScore are a sanity check on top).
      if (coachingPlanIsStale(plan, application.evaluation)) {
        throw actionError(
          "This coaching plan was built for an earlier evaluation. Run Coach me on this fit again to refresh it.",
          "COACHING_PLAN_STALE"
        );
      }
      if (gap.status !== "open") {
        throw actionError(
          "This coaching gap was already resolved and cannot be saved again.",
          "COACHING_GAP_NOT_OPEN"
        );
      }
      const draftClaim = gap.suggestion?.draftClaim;
      if (!draftClaim?.claim || !draftClaim?.evidence) {
        throw actionError(
          "This gap has no evidence-claim draft to save.",
          "COACHING_NO_DRAFT_CLAIM"
        );
      }

      const { claims: currentClaims } = loadEvidence({ root: repoRoot });
      const writePlan = computeEvidenceWrite({ newClaim: draftClaim, currentClaims });
      if (!writePlan.ok) {
        throw actionError(
          `CareerRat could not save this evidence claim: ${writePlan.error}`,
          "EVIDENCE_WRITE_REJECTED"
        );
      }
      const mergeResult = candidateEvidenceMerge({ repoRoot, env, claims: [writePlan.claim] });
      const wasDuplicate = (mergeResult?.added || 0) === 0 && (mergeResult?.skipped || 0) > 0;

      const nextGaps = plan.gaps.map((g) => (g.id === gapId ? { ...g, status: "closed" } : g));
      appSetFields({
        repoRoot,
        env,
        id: normalized.entity.id,
        patch: { coachingPlan: { ...plan, gaps: nextGaps } },
      });

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: wasDuplicate
          ? `"${writePlan.claim.claim}" was already in your evidence bank. See if this changed your fit.`
          : `Saved "${writePlan.claim.claim}" to your evidence bank. See if this changed your fit.`,
        artifacts: [
          {
            kind: "evidence_claim_saved",
            applicationId: normalized.entity.id,
            claim: writePlan.claim,
            duplicate: wasDuplicate,
          },
        ],
        metadata: {
          state: "saved",
          nextActions: [
            {
              label: "See if this changed your fit",
              intent: {
                type: "job.evaluate",
                entity: { type: "application", id: normalized.entity.id },
              },
            },
          ],
        },
        now,
      });
    }

    // strategy.review — the embedded-chat sibling of the reevaluate-strategy
    // skill (src/core/strategy/review.mjs). The card owns the per-recommendation
    // Apply buttons directly off this artifact's `recommendations[]`; nextActions
    // here only ever carries the review-level follow-ups (finish, or re-run past
    // the freshness gate) — never a per-recommendation entry.
    if (normalized.type === "strategy.review") {
      const force = Boolean(input.force);
      const draft = await draftStrategyReviewImpl({ repoRoot, env, force, now: now() });
      const artifact = {
        kind: "strategy_review",
        state: draft.state,
        generatedAt: draft.generatedAt,
        reviewSignal: draft.reviewSignal,
        reevaluation: draft.reevaluation,
        headline: draft.headline,
        findings: draft.findings,
        recommendations: draft.recommendations,
      };
      const nextActions =
        draft.state === "fresh"
          ? [
              {
                label: "Run it anyway",
                intent: {
                  type: "strategy.review",
                  entity: normalized.entity,
                  input: { force: true },
                },
              },
            ]
          : [
              {
                label: "Finish review",
                intent: { type: "strategy.stamp", entity: normalized.entity },
              },
            ];
      const text =
        draft.state === "fresh"
          ? "Nothing new since your last strategy review."
          : draft.state === "manual"
            ? `${draft.headline} The AI reviewer wasn't available, so this is the deterministic read. Review it, then finish the review.`
            : `${draft.headline} Review the findings and recommendations, then finish the review.`;
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text,
        artifacts: [artifact],
        metadata: { state: draft.state, nextActions },
        operationResult: draft,
        now,
      });
    }

    // strategy.apply — a single confirm-first Apply click off a strategy_review
    // artifact's recommendations[]. Apply intents are only ever fired by a user
    // click on that card (never auto-fired), so no additional confirm gate runs
    // here; applyStrategyRecommendation itself validates and dispatches to the
    // owning writer (gate-writer/candidateConfigPatch, appSetStatus/appSetFields/
    // sourcedSetStatus, or learnings.mjs) per recommendation type.
    if (normalized.type === "strategy.apply") {
      const recommendation = input.recommendation;
      if (!recommendation || typeof recommendation !== "object") {
        throw actionError(
          "A recommendation is required to apply a strategy change.",
          "STRATEGY_APPLY_INVALID"
        );
      }
      const operation = await applyStrategyRecommendationImpl({
        repoRoot,
        env,
        recommendation,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Applied: ${operation.title || recommendation.title || "the recommendation"}.`,
        artifacts: [
          {
            kind: "strategy_apply",
            type: operation.type,
            title: operation.title,
            result: operation.result,
          },
        ],
        metadata: { state: "applied" },
        operationResult: operation,
        now,
      });
    }

    // strategy.stamp — clears the dashboard "review ready" nudge, whether or
    // not any recommendation was accepted (running the review IS the review;
    // mirrors reevaluate-strategy SKILL.md STEP 7(f)).
    if (normalized.type === "strategy.stamp") {
      const stamp = stampStrategyReviewImpl({ repoRoot, env, now });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: "Recorded this strategy review. The review-ready nudge stays quiet until enough new outcomes accrue.",
        artifacts: [
          {
            kind: "strategy_review_stamp",
            lastReviewedAt: stamp.strategyReview.lastReviewedAt,
            snapshot: stamp.strategyReview.snapshot,
          },
        ],
        metadata: { state: "stamped" },
        operationResult: stamp,
        now,
      });
    }

    // settings.explain — the read half of the Ask "configure" row. A pure,
    // side-effect-free read built by STRICT ALLOW-LIST (never a spread of a
    // config doc), so a field that shouldn't leave this module (current_base,
    // email, phone, ...) can never ride along by accident. automationStatus
    // already fills every known capability/platform in from CAPABILITIES —
    // even ones the stored doc predates — so a newly-added capability reads
    // false here, never undefined.
    if (normalized.type === "settings.explain") {
      const domain = new Set(["automation", "modes", "gates"]).has(input.domain)
        ? input.domain
        : "all";
      const config = candidateConfigGet({ repoRoot, env });
      const modesDoc = config.modes || {};
      const targeting = config.targeting || {};
      // PRIVACY (AGENTS.md): current_base is a private gate input and is
      // never read here — comp fields come from minimum_base/target_base/
      // expected_base only, same as buildStrategyReviewContext (review.mjs).
      const compensation = config.profile?.compensation || {};

      const modes =
        domain === "all" || domain === "modes"
          ? {
              usage_mode: modesDoc.usage_mode || null,
              application_mode: modesDoc.application_mode || null,
              agent_voice: modesDoc.agent_voice || null,
            }
          : null;

      let automation = null;
      if (domain === "all" || domain === "automation") {
        const status = automationStatus({ root: repoRoot });
        automation = {
          setup_mode: status.mode,
          session_provider: status.session?.provider || null,
          capabilities: status.capabilities.map((cap) => ({
            key: cap.capability,
            label: cap.label,
            enabled: cap.enabled,
            platforms: cap.platforms.map((platform) => ({
              key: platform.platform,
              enabled: platform.enabled,
              consent: platform.consent,
            })),
          })),
        };
      }

      const gates =
        domain === "all" || domain === "gates"
          ? {
              comp_floor: compensation.minimum_base ?? null,
              comp_target: compensation.target_base ?? null,
              comp_expected: compensation.expected_base ?? null,
              excluded_companies: Array.isArray(targeting.excluded_companies)
                ? targeting.excluded_companies.length
                : 0,
              cut_signals: Array.isArray(targeting.cut_signals) ? targeting.cut_signals : [],
              keep_signals: Array.isArray(targeting.keep_signals) ? targeting.keep_signals : [],
              do_not_claim: Array.isArray(config.honesty?.tools?.do_not_claim)
                ? config.honesty.tools.do_not_claim
                : [],
            }
          : null;

      const artifact = { kind: "settings_overview", domain, modes, automation, gates };

      // Backstop, mirroring the leak checks elsewhere in this file (e.g. the
      // communication.send handler above): if the private field token slips
      // in despite the allow-list above, refuse to surface it rather than
      // let it reach the thread. This is a code bug if it ever fires, not a
      // user-input problem, so it is deliberately NOT in the route's 400 list.
      if (findCurrentBaseToken(JSON.stringify(artifact))) {
        throw actionError(
          "CareerRat could not build the settings summary without exposing a private field.",
          "SETTINGS_EXPLAIN_LEAK"
        );
      }

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: "Here are your current settings.",
        artifacts: [artifact],
        metadata: { domain },
        operationResult: artifact,
        now,
      });
    }

    // settings.apply — a single confirm-first setting change, fired only by
    // the preview chip (or Enter) built from settingsApplyFromText below.
    // REST can call this intent directly, so every restriction is enforced
    // HERE in the handler, not just in the matcher. Reuses the same validated
    // write paths every other surface uses: applyGateWrite for gate types
    // (Step 1's shared primitive), candidateConfigPatch directly for modes,
    // and candidateConfigPatch with a narrow automation patch (deepMerge in
    // candidateConfigPatch recurses plain objects, so a narrow patch is
    // sibling-safe). candidateConfigPatch already logs the Activity Pulse
    // event for each of these — no manual activityAppend call here.
    if (normalized.type === "settings.apply") {
      const change = input.change;
      if (!change || typeof change !== "object" || !change.kind) {
        throw actionError("A setting change is required to apply it.", "SETTINGS_CHANGE_INVALID");
      }

      let result;
      if (change.kind === "gate") {
        // Re-derived here, not trusted from the matcher's compReference flag:
        // REST can call this intent directly with any flag value, so the
        // privacy refusal has to fire on the value itself either way.
        if (change.compReference || findCompLeak(String(change.value ?? ""))) {
          const error = actionError(
            "CareerRat keeps your current pay private and never uses it to set search settings; give the number you want instead.",
            "SETTINGS_CHANGE_INVALID"
          );
          error.details = { reason: "comp-reference" };
          throw error;
        }
        if (String(change.value ?? "").length > 200) {
          throw actionError(
            "That value is too long for a settings change.",
            "SETTINGS_CHANGE_INVALID"
          );
        }
        const type = String(change.type || "");
        let applied;
        try {
          applied = applyGateWrite({ repoRoot, env, type, value: change.value });
        } catch (error) {
          // applyGateWrite throws plain, candidate-safe errors (unknown gate
          // type, non-numeric comp amount, a schema-invalid write) — surface
          // the message as-is rather than inventing a new one.
          throw actionError(error.message, "SETTINGS_CHANGE_INVALID");
        }
        result = {
          label: GATE_ROUTES[type]?.label || type,
          field: applied.field,
          from: applied.from,
          to: applied.value,
          summary: applied.summary,
          changed: applied.changed,
        };
      } else if (change.kind === "mode") {
        const field = String(change.field || "");
        if (!new Set(["usage_mode", "application_mode"]).has(field)) {
          throw actionError(`Unsupported setting field "${field}".`, "SETTINGS_CHANGE_UNSUPPORTED");
        }
        const value = String(change.value || "").trim();
        if (!value) {
          throw actionError("A value is required to change this mode.", "SETTINGS_CHANGE_INVALID");
        }
        const modesDoc = candidateConfigGet({ repoRoot, env }).modes || {};
        const from = modesDoc[field] ?? null;
        candidateConfigPatch({ repoRoot, env, name: "modes", patch: { [field]: value } });
        const label = field === "usage_mode" ? "Usage mode" : "Application mode";
        result = { label, field, from, to: value, summary: `${label} set to ${value}.` };
      } else if (change.kind === "automation") {
        const op = String(change.op || "");
        if (op === "consent") {
          const error = actionError(
            "Consent changes happen in Settings where the terms are shown.",
            "SETTINGS_CHANGE_UNSUPPORTED"
          );
          error.details = { reason: "consent" };
          throw error;
        }
        // One normalized boolean for both the tier gate and the writers below
        // — REST callers have sent the flag as either `enabled` or `value`,
        // and gating on one while persisting the other would let "turn this
        // on" record it off.
        const requested = change.enabled === true || change.value === true;
        if ((op === "capability" || op === "platform") && requested) {
          const capability = change.capability;
          if (!isCapability(capability)) {
            const error = actionError(
              `Unknown capability "${capability}".`,
              "SETTINGS_CHANGE_INVALID"
            );
            error.details = { options: CAPABILITY_KEYS };
            throw error;
          }
          if (!new Set(["status_polling", "authenticated_search"]).has(capability)) {
            const error = actionError(
              `Turning on ${CAPABILITIES[capability].label} happens in Settings, where the permissions are explained.`,
              "SETTINGS_CHANGE_UNSUPPORTED"
            );
            error.details = { reason: "capability-tier", capability };
            throw error;
          }
        }

        const automationDoc = mergeAutomationDefaults(loadAutomation({ root: repoRoot }).data);
        let patch;
        if (op === "setup_mode") {
          const value = String(change.value || "");
          if (value !== "basic" && value !== "advanced") {
            throw actionError(
              'Setup mode must be "basic" or "advanced".',
              "SETTINGS_CHANGE_INVALID"
            );
          }
          const from = automationDoc.setup_mode || "basic";
          patch = { setup_mode: value };
          result = {
            label: "Automation setup mode",
            field: "setup_mode",
            from,
            to: value,
            summary: `Setup mode set to ${value}.`,
          };
        } else if (op === "capability") {
          const capability = change.capability;
          if (!isCapability(capability)) {
            const error = actionError(
              `Unknown capability "${capability}".`,
              "SETTINGS_CHANGE_INVALID"
            );
            error.details = { options: CAPABILITY_KEYS };
            throw error;
          }
          const value = requested;
          const from = automationDoc.capabilities?.[capability]?.enabled === true;
          patch = { capabilities: { [capability]: { enabled: value } } };
          const label = `${CAPABILITIES[capability].label} (global switch)`;
          result = {
            label,
            field: `capabilities.${capability}.enabled`,
            from,
            to: value,
            summary: `${value ? "Turned on" : "Turned off"} ${CAPABILITIES[capability].label}.`,
          };
        } else if (op === "platform") {
          const capability = change.capability;
          const platform = change.platform;
          if (!isCapability(capability)) {
            const error = actionError(
              `Unknown capability "${capability}".`,
              "SETTINGS_CHANGE_INVALID"
            );
            error.details = { options: CAPABILITY_KEYS };
            throw error;
          }
          if (!CAPABILITIES[capability].platforms.includes(platform)) {
            const error = actionError(
              `Unknown platform "${platform}" for ${capability}.`,
              "SETTINGS_CHANGE_INVALID"
            );
            error.details = { options: CAPABILITIES[capability].platforms };
            throw error;
          }
          const value = requested;
          const from = automationDoc.capabilities?.[capability]?.platforms?.[platform] === true;
          patch = { capabilities: { [capability]: { platforms: { [platform]: value } } } };
          result = {
            label: `${capability} on ${platform}`,
            field: `capabilities.${capability}.platforms.${platform}`,
            from,
            to: value,
            summary: `${value ? "Turned on" : "Turned off"} ${capability} for ${platform}.`,
          };
        } else if (op === "session") {
          const provider = String(change.value || "").trim();
          // Object.hasOwn: `provider` is HTTP-body input, and prototype-chain
          // keys would pass a bare truthy lookup on the PROVIDERS literal.
          if (!Object.hasOwn(PROVIDERS, provider)) {
            const error = actionError(
              `Unknown session provider "${provider}".`,
              "SETTINGS_CHANGE_INVALID"
            );
            error.details = { options: Object.keys(PROVIDERS) };
            throw error;
          }
          const from = automationDoc.session?.provider || "auto";
          patch = { session: { provider } };
          result = {
            label: "Session browser provider",
            field: "session.provider",
            from,
            to: provider,
            summary: `Session browser set to ${provider}.`,
          };
        } else {
          throw actionError(
            `Unsupported automation change "${op}".`,
            "SETTINGS_CHANGE_UNSUPPORTED"
          );
        }
        candidateConfigPatch({ repoRoot, env, name: "automation", patch });
      } else if (change.kind === "profile") {
        const section = String(change.section || "");
        const config = candidateConfigGet({ repoRoot, env });
        if (section === "targets") {
          const values = profileSettingList(change.values, "Target roles");
          const op = String(change.op || "replace");
          if (!new Set(["replace", "append"]).has(op)) {
            throw actionError("Unknown target-role change.", "SETTINGS_CHANGE_INVALID");
          }
          const currentBuckets = Array.isArray(config.targeting?.role_buckets)
            ? config.targeting.role_buckets
            : [];
          const from = currentBuckets.flatMap((bucket) =>
            Array.isArray(bucket?.titles) ? bucket.titles : []
          );
          let roleBuckets;
          let added = values;
          if (op === "append") {
            const seen = new Set(from.map((title) => String(title).trim().toLowerCase()));
            added = values.filter((title) => !seen.has(title.toLowerCase()));
            roleBuckets = currentBuckets.map((bucket) => ({
              ...bucket,
              titles: Array.isArray(bucket?.titles) ? [...bucket.titles] : [],
            }));
            if (!roleBuckets.length) {
              roleBuckets.push({ name: "Primary targets", priority: "primary", titles: [] });
            }
            const primaryIndex = roleBuckets.findIndex((bucket) => bucket.priority === "primary");
            roleBuckets[primaryIndex === -1 ? 0 : primaryIndex].titles.push(...added);
          } else {
            roleBuckets = [{ name: "Primary targets", priority: "primary", titles: values }];
          }
          candidateConfigPatch({
            repoRoot,
            env,
            name: "targeting",
            patch: { role_buckets: roleBuckets },
          });
          const to = roleBuckets.flatMap((bucket) => bucket.titles);
          result = {
            label: "Target roles",
            field: "role_buckets",
            from,
            to,
            changed: op === "append" ? added.length > 0 : undefined,
            summary:
              op === "append"
                ? added.length
                  ? `Added target roles ${added.join(", ")}.`
                  : "Already saved. Nothing changed."
                : `Target roles set to ${values.join(", ")}.`,
          };
        } else if (section === "home") {
          const value = String(change.value || "").trim();
          if (!value || value.length > 160) {
            throw actionError("A short home market is required.", "SETTINGS_CHANGE_INVALID");
          }
          const from = config.profile?.location?.home || null;
          candidateConfigPatch({
            repoRoot,
            env,
            name: "profile",
            patch: { candidate: { location: value }, location: { home: value } },
          });
          result = {
            label: "Home market",
            field: "location.home",
            from,
            to: value,
            summary: `Home market set to ${value}.`,
          };
        } else if (section === "location-mode") {
          const field = String(change.field || "");
          if (!new Set(["remote", "hybrid", "onsite"]).has(field)) {
            throw actionError("Unknown location mode.", "SETTINGS_CHANGE_INVALID");
          }
          if (typeof change.value !== "boolean") {
            throw actionError("Location mode must be on or off.", "SETTINGS_CHANGE_INVALID");
          }
          const from = config.profile?.location?.[field] === true;
          candidateConfigPatch({
            repoRoot,
            env,
            name: "profile",
            patch: {
              location: { [field]: change.value, mode_preferences_confirmed: true },
            },
          });
          result = {
            label: `${field} roles`,
            field: `location.${field}`,
            from,
            to: change.value,
            summary: `${change.value ? "Turned on" : "Turned off"} ${field} roles.`,
          };
        } else if (section === "writing-style") {
          const value = String(change.value || "").trim();
          if (!value || value.length > 800) {
            throw actionError(
              "Writing style needs a short description.",
              "SETTINGS_CHANGE_INVALID"
            );
          }
          const current = deepIngestStateGet({ repoRoot, env }).confirmed.writingVoice[0] || null;
          const saved = deepIngestConfirmedItemUpsert({
            repoRoot,
            env,
            lane: "writing_voice",
            id: current?.id,
            fields: { summary: value },
          });
          result = {
            label: "Writing style",
            field: "writing_voice.summary",
            from: current?.summary || null,
            to: value,
            summary: "Writing style updated.",
            operationResult: saved,
          };
        } else if (section === "search-cadence") {
          const value = String(change.value || "").trim();
          if (!new Set(["daily", "every-3-days", "weekly", "manual"]).has(value)) {
            throw actionError("Unknown search cadence.", "SETTINGS_CHANGE_INVALID");
          }
          const from = config.targeting?.search_preferences?.cadence?.mode || null;
          candidateConfigPatch({
            repoRoot,
            env,
            name: "targeting",
            patch: { search_preferences: { cadence: { mode: value } } },
          });
          result = {
            label: "Search cadence",
            field: "search_preferences.cadence.mode",
            from,
            to: value,
            summary: `Search cadence set to ${value}.`,
          };
        } else if (section === "fit-floor") {
          const value = Number(change.value);
          if (!Number.isFinite(value) || value < 0 || value > 100) {
            throw actionError("Minimum fit must be between 0 and 100.", "SETTINGS_CHANGE_INVALID");
          }
          const from = config.targeting?.fit_bands?.fit_floor ?? null;
          candidateConfigPatch({
            repoRoot,
            env,
            name: "targeting",
            patch: { fit_bands: { fit_floor: value } },
          });
          result = {
            label: "Minimum fit",
            field: "fit_bands.fit_floor",
            from,
            to: value,
            summary: `Minimum fit set to ${value}+.`,
          };
        } else if (section === "dealbreakers" || section === "keep-signals") {
          const label = section === "dealbreakers" ? "Dealbreakers" : "Positive fit signals";
          const field = section === "dealbreakers" ? "cut_signals" : "keep_signals";
          const values = profileSettingList(change.values, label);
          const from = Array.isArray(config.targeting?.[field]) ? config.targeting[field] : [];
          candidateConfigPatch({
            repoRoot,
            env,
            name: "targeting",
            patch: { [field]: values },
          });
          result = {
            label,
            field,
            from,
            to: values,
            summary: `${label} set to ${values.join(", ")}.`,
          };
        } else if (section === "relocation") {
          const values = profileSettingList(change.values, "Relocation markets");
          const from = Array.isArray(config.profile?.location?.relocation)
            ? config.profile.location.relocation
            : [];
          candidateConfigPatch({
            repoRoot,
            env,
            name: "profile",
            patch: { location: { relocation: values } },
          });
          result = {
            label: "Relocation markets",
            field: "location.relocation",
            from,
            to: values,
            summary: `Relocation markets set to ${values.join(", ")}.`,
          };
        } else {
          throw actionError(
            `Unsupported profile section "${section}".`,
            "SETTINGS_CHANGE_UNSUPPORTED"
          );
        }
      } else {
        throw actionError(
          `Unsupported setting change kind "${change.kind}".`,
          "SETTINGS_CHANGE_UNSUPPORTED"
        );
      }

      const artifact = {
        kind: "settings_apply",
        domain: change.kind,
        label: result.label,
        field: result.field,
        from: result.from,
        to: result.to,
        summary: result.summary,
        // Only the gate branch reports a no-op (applyGateWrite's changed:
        // false); mode/automation writes always persist. Absent means changed.
        ...(result.changed === false ? { changed: false } : {}),
      };
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: result.summary,
        artifacts: [artifact],
        metadata: { domain: change.kind },
        operationResult: result,
        now,
      });
    }

    // issue.report — a pure read (beyond appending to this thread): no
    // browser, no `gh`, no Activity Pulse. It assembles a redacted bug
    // report + prefilled GitHub URL for the user to review, and only offers
    // the "I filed it" follow-up (issue.record-filed); filing itself always
    // happens in the user's own browser/terminal, never here. The most
    // recent action_error/agent_error in the last 20 thread messages is
    // reused as context so the user doesn't have to re-describe a failure
    // that's already visible in the conversation.
    if (normalized.type === "issue.report") {
      // Array.from + join truncates by code point, not UTF-16 code unit, so
      // a surrogate pair never gets split (a lone trailing surrogate would
      // later crash encodeURIComponent in buildIssueUrl).
      const description = Array.from(String(input.description || ""))
        .slice(0, 2000)
        .join("");
      const recentMessages = (workspaceThreadRead({ repoRoot, env }).messages || []).slice(-20);
      let lastError = null;
      for (let i = recentMessages.length - 1; i >= 0; i--) {
        const candidate = recentMessages[i];
        if (candidate.kind === "action_error" || candidate.kind === "agent_error") {
          lastError = candidate.error || null;
          break;
        }
      }

      let report;
      try {
        report = buildIssueReport({
          repoRoot,
          env,
          description,
          lastError,
          version: readVersion(),
          nodeVersion: process.version,
          platform: process.platform,
        });
      } catch (error) {
        if (error?.code === ISSUE_REPORT_COMP_LEAK_MARKER) {
          throw actionError(
            "Rewrite the description without pay figures or personal/company names, then try again.",
            "ISSUE_REPORT_COMP_LEAK"
          );
        }
        throw error;
      }

      const { url, truncated } = buildIssueUrl({ title: report.title, body: report.body });
      const artifact = {
        kind: "issue_report",
        title: report.title,
        body: report.body,
        url,
        truncated,
        hasError: report.state.hasError,
        errorCode: lastError?.code || null,
        configHint: report.state.configHint,
        compFlagged: report.state.compFlagged,
        errorMessageDropped: report.state.errorMessageDropped,
      };
      const text = report.state.configHint
        ? "I put together a redacted bug report, but this looks like it could be a setup problem. Settings or careerrat doctor may fix it faster. Review the report below and file it if you still think it's a defect."
        : "I put together a redacted bug report for you to review before filing.";

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text,
        artifacts: [artifact],
        metadata: {
          nextActions: [
            {
              label: "I filed it",
              intent: {
                type: "issue.record-filed",
                entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
              },
            },
          ],
        },
        operationResult: artifact,
        now,
      });
    }

    // issue.record-filed — a tooling action, not a job-search event: no
    // Activity Pulse entry (see report-issue's SKILL.md STEP 6).
    if (normalized.type === "issue.record-filed") {
      const rawUrl = input.url !== undefined ? String(input.url).trim() : "";
      if (rawUrl && !FILED_ISSUE_URL_RE.test(rawUrl)) {
        throw actionError(
          "That doesn't look like a link to an issue on the CareerRat repo.",
          "ISSUE_URL_INVALID"
        );
      }
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: rawUrl ? `Recorded: filed at ${rawUrl}.` : "Recorded that you filed the issue.",
        artifacts: [
          { kind: "issue_filed", url: rawUrl || null, at: requestDate(now).toISOString() },
        ],
        now,
      });
    }

    if (normalized.type === "company.proposal-decide") {
      const action = String(input.action || "").trim();
      if (!new Set(["approve-supported-ats", "reject"]).has(action)) {
        throw actionError(
          "Company proposals can only be tracked or skipped from Ask.",
          "BAD_COMPANY_PROPOSAL_ACTION"
        );
      }
      const proposalId = normalized.entity.id;
      if (input.proposalId && String(input.proposalId) !== proposalId) {
        throw actionError(
          "The company proposal action does not match the selected proposal.",
          "BAD_INTENT_ENTITY"
        );
      }
      const operation = await decideCompanyProposalImpl({
        repoRoot,
        env,
        body: {
          batchId: input.batchId,
          proposalId,
          action,
          expectedVersion: input.expectedVersion,
          ...(action === "approve-supported-ats" ? { userConfirmed: true } : {}),
        },
        fetchImpl: searchFetchImpl,
        now: requestDate(now),
      });
      const batch = getCompanyProposalBatchImpl({
        repoRoot,
        env,
        batchId: input.batchId,
      })?.batch;
      if (!batch) throw actionError("Company proposal batch not found.", "NOT_FOUND");
      const artifact = companyProposalArtifact(batch);
      const remaining = artifact.proposals.length;
      const name =
        operation?.data?.proposal?.company?.name ||
        operation?.data?.refreshedProposal?.company?.name ||
        "that company";
      const decisionText =
        action === "approve-supported-ats" ? `Tracking ${name}.` : `Skipped ${name}.`;
      const returnToCurrentSearch =
        batch.trigger?.kind === "search-run" || String(input.searchRunId || "").trim();
      const approvedSourceAdded = (batch.proposals || []).some(
        (proposal) => proposal?.decision?.action === "approve-supported-ats"
      );
      const expandedSearch =
        !remaining && approvedSourceAdded
          ? await startExpandedSourceSearch({
              repoRoot,
              env,
              searchFetchImpl,
              startManualSearchImpl,
              onSearchStarted,
            })
          : null;
      const expandedSearchStarted = expandedSearch?.started === true;
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: remaining
          ? `${decisionText} ${remaining} compan${remaining === 1 ? "y still needs" : "ies still need"} review.`
          : expandedSearchStarted
            ? `${decisionText} All company proposals are reviewed. Searching the expanded sources now.`
            : expandedSearch?.artifact
              ? `${decisionText} All company proposals are reviewed. The expanded search could not start.`
              : `${decisionText} All company proposals are reviewed.`,
        artifacts: [artifact, expandedSearch?.artifact].filter(Boolean),
        metadata: {
          state: remaining ? "needs-review" : expandedSearchStarted ? "running" : "complete",
          proposalCount: remaining,
          decision: action,
          ...(remaining
            ? {}
            : {
                nextActions: [
                  expandedSearchStarted || returnToCurrentSearch
                    ? currentSearchAction()
                    : searchExpandedCompaniesAction(),
                ],
              }),
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "search.run") {
      const purpose = input.purpose === "first-search" ? "first-search" : "manual-search";
      const operation =
        purpose === "first-search"
          ? await startFirstSearchImpl({
              repoRoot,
              env,
              fetchImpl: searchFetchImpl,
              retryFailed: input.retryFailed === true,
            })
          : await startManualSearchImpl({
              repoRoot,
              env,
              fetchImpl: searchFetchImpl,
              ...(input.searchExecutionId
                ? { searchExecutionId: String(input.searchExecutionId) }
                : {}),
            });
      const run = operation?.run || {
        purpose,
        status: operation?.parked ? "not_started" : "failed",
        error: { message: "The job search did not return a run state." },
      };
      const artifact = searchRunArtifact({
        run: { ...run, purpose: run.purpose || purpose },
        sources: operation?.sources || null,
        reused: operation?.reused === true,
        parked: operation?.parked === true,
      });
      onSearchStarted?.({ operation, run: { ...run, purpose: run.purpose || purpose } });
      let companyArtifact = null;
      let companyDiscovery = null;
      if (
        purpose === "manual-search" &&
        artifact.runId &&
        new Set(["running", "completed"]).has(artifact.status)
      ) {
        try {
          const cadence = companyDiscoveryCadenceImpl({
            repoRoot,
            env,
            now: requestDate(now),
          });
          companyDiscovery = compactCompanyDiscoveryState(cadence);
          const trigger = { kind: "search-run", id: artifact.runId };
          companyArtifact = reopenPendingCompanyProposalBatch({
            repoRoot,
            env,
            cadence,
            getBatchImpl: getCompanyProposalBatchImpl,
            trigger,
          });
          if (!companyArtifact && cadence?.due === true) {
            const proposalOperation = await createCompanyProposalsImpl({
              repoRoot,
              env,
              body: { requestedCount: 12, trigger },
              fetchImpl: searchFetchImpl,
              seedCall: callAIImpl,
              now: requestDate(now),
            });
            if (proposalOperation?.body) throw companyProposalOperationError(proposalOperation);
            companyArtifact = companyProposalArtifact(proposalOperation?.data, {
              ...proposalOperation?.meta,
              trigger,
            });
          }
          if (companyArtifact) {
            const proposalCount = companyArtifact.proposals.length;
            companyDiscovery = compactCompanyDiscoveryState(cadence, {
              status: proposalCount ? "needs-review" : "complete",
              batchId: companyArtifact.batchId,
              pendingCount: proposalCount,
            });
          }
        } catch (error) {
          companyDiscovery = compactCompanyDiscoveryState(companyDiscovery, {
            status: "failed",
            error: {
              code: String(error?.code || "COMPANY_DISCOVERY_FAILED").slice(0, 120),
              message: String(error?.message || "Company discovery failed.").slice(0, 500),
            },
          });
        }
      }
      const companyReviewCount = companyArtifact?.proposals.length || 0;
      const text = [
        searchResultText({ ...run, purpose: run.purpose || purpose }),
        companyDiscoveryReviewSentence(companyReviewCount, { also: true }),
      ]
        .filter(Boolean)
        .join(" ");
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text,
        artifacts: [artifact, companyArtifact].filter(Boolean),
        metadata: {
          state: artifact.status,
          purpose: artifact.purpose,
          searchRunId: artifact.runId,
          searchTerminal: ["completed", "failed"].includes(artifact.status),
          reused: artifact.reused,
          parked: artifact.parked,
          companyReview: companyReviewCount > 0,
          ...(companyDiscovery ? { companyDiscovery } : {}),
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "sourced.promote") {
      const sourced = sourcedForIntent({ repoRoot, env, id: normalized.entity.id });
      const operation = sourcedPromote({
        repoRoot,
        env,
        id: normalized.entity.id,
        ...(input.appRow && typeof input.appRow === "object" ? { appRow: input.appRow } : {}),
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Promoted ${applicationLabel(sourced)} to the active pipeline.`,
        metadata: {
          previousState: sourced.status || "sourced",
          state: "promoted",
          applicationId: operation.id,
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "sourced.skip") {
      const sourced = sourcedForIntent({ repoRoot, env, id: normalized.entity.id });
      const note = String(input.note || "").trim();
      const operation = sourcedSetStatus({
        repoRoot,
        env,
        id: normalized.entity.id,
        to: "cut",
        note: note || undefined,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Skipped ${applicationLabel(sourced)}.`,
        metadata: { previousState: sourced.status || "sourced", state: "cut" },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "interview.schedule") {
      const application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      const at = String(input.at || "").trim();
      if (!at || Number.isNaN(Date.parse(at))) {
        throw actionError("Choose a valid interview date and time.", "BAD_INTERVIEW_AT");
      }
      const scheduledAt = new Date(at).toISOString();
      const round = String(input.round || "interview").trim() || "interview";
      const note = String(input.note || "").trim();
      const operation = appScheduleInterview({
        repoRoot,
        env,
        id: normalized.entity.id,
        at: scheduledAt,
        round,
        note: note || undefined,
        who: String(input.who || "").trim() || undefined,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Scheduled the ${round} interview for ${applicationLabel(application)}.`,
        artifacts: [
          {
            kind: "interview_schedule",
            title: `${applicationLabel(application)}: ${round}`,
            applicationId: normalized.entity.id,
            at: scheduledAt,
            round,
          },
        ],
        metadata: { state: "scheduled", scheduledAt, round },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "calendar.record-write") {
      const provider = String(input.provider || "").trim();
      if (!provider || !CALENDAR_WRITE_PROVIDERS.has(provider)) {
        throw actionError(
          "Which calendar did you add it to: Google, Outlook, or Apple?",
          "CALENDAR_WRITE_PROVIDER_INVALID"
        );
      }
      // Manual provenance (a self-report of something the candidate already did
      // in their own calendar app) is NOT consent-gated — CareerRat isn't writing
      // anything. Automated provenance IS gated: it asserts the app itself wrote
      // the event, so it must be backed by an actual calendar_sync consent grant.
      const provenance = input.provenance === "automated" ? "automated" : "manual";
      if (provenance === "automated") {
        const verdict = mayRun({
          capability: "calendar_sync",
          platform: provider,
          root: repoRoot,
          env,
        });
        if (!verdict.allowed) {
          throw actionError(
            "Automated calendar sync isn't enabled for that provider. Turn it on in Settings first.",
            "CALENDAR_WRITE_NOT_ALLOWED"
          );
        }
      }

      const resolved = resolveCalendarWriteEvent({ repoRoot, env, event: input.event });
      const operation = calendarWriteAppend({
        repoRoot,
        env,
        record: {
          provider,
          provenance,
          eventId: resolved.applicationId ? `app:${resolved.applicationId}` : undefined,
          eventIso: resolved.eventIso,
          title: resolved.title,
          applicationId: resolved.applicationId,
          company: resolved.company,
          role: resolved.role,
        },
      });

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text:
          provenance === "manual"
            ? "Recorded that you added it to your calendar."
            : "Recorded the synced calendar event.",
        artifacts: [
          {
            kind: "calendar_write",
            provider,
            provenance,
            title: resolved.title,
            eventIso: resolved.eventIso,
            company: resolved.company || null,
            role: resolved.role || null,
            at: operation.record.wroteAt,
          },
        ],
        metadata: { state: "recorded", provider, provenance },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "relationship.record-lead") {
      const name = String(input.name || "")
        .trim()
        .slice(0, 120);
      const companyInput = String(input.company || "")
        .trim()
        .slice(0, 120);
      // A reference with no matchable tokens ("...", bare punctuation) is not
      // a company at all — refuse rather than persisting junk via the
      // untracked-company fallback below.
      if (!name || !companyInput || !companyReferenceTokens(companyInput).length) {
        throw actionError(
          "Give the person's name and the company, like: add Jordan Lee as a recruiter at Acme.",
          "RELATIONSHIP_LEAD_INVALID"
        );
      }

      // A company CareerRat isn't tracking yet still gets the lead recorded —
      // it just falls back to the raw company string instead of a linked
      // application, rather than blocking the record.
      let company = companyInput;
      let applicationId = null;
      try {
        const resolved = resolveReferencedCompany({
          repoRoot,
          env,
          companyReference: companyInput,
          notFoundCode: "RELATIONSHIP_LEAD_COMPANY_UNTRACKED",
        });
        company = resolved.company;
        applicationId = resolved.recordType === "application" ? resolved.id : null;
      } catch (error) {
        if (error?.code !== "RELATIONSHIP_LEAD_COMPANY_UNTRACKED") throw error;
      }

      const LEAD_TYPES = ["Recruiter", "Decision maker", "Referral", "Contact"];
      const rawType = String(input.type || "")
        .trim()
        .toLowerCase();
      const type = LEAD_TYPES.find((candidate) => candidate.toLowerCase() === rawType) || "Contact";

      const LEAD_PLATFORMS = new Set(["linkedin", "wellfound"]);
      const rawPlatform = String(input.platform || "")
        .trim()
        .toLowerCase();
      const platform = LEAD_PLATFORMS.has(rawPlatform) ? rawPlatform : "linkedin";

      const url = safeExternalHttpUrl(input.url);
      const title = String(input.title || "")
        .trim()
        .slice(0, 120);
      const basis = String(input.basis || "")
        .trim()
        .slice(0, 120);

      // Both guards: the literal current_base token and the phrase-based
      // current-salary check, since basis/title are user-typed free text.
      if (findCurrentBaseToken(`${basis}\n${title}`) || findCompLeak(`${basis}\n${title}`)) {
        throw actionError(
          "That note still contains your private current pay figure. Remove it, then try again.",
          "RELATIONSHIP_LEAD_COMP_LEAK"
        );
      }

      const at = requestDate(now).toISOString();
      const operation = relationshipLeadUpsertBatch({
        repoRoot,
        env,
        leads: [
          {
            company,
            ...(applicationId ? { applicationId } : {}),
            name,
            type,
            ...(title ? { title } : {}),
            platform,
            ...(url ? { url } : {}),
            ...(basis ? { basis } : {}),
            status: "review",
            foundAt: at,
          },
        ],
      });
      const lead = operation.leads.find(
        (candidate) =>
          candidate.company === company &&
          candidate.name === name &&
          candidate.platform === platform
      );

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Recorded ${name} for your review in the Network tab.`,
        artifacts: [
          {
            kind: "lead_receipt",
            leadId: lead?.id || null,
            name,
            company,
            applicationId: applicationId || null,
            type,
            platform,
            status: "review",
            at,
          },
        ],
        metadata: { state: "recorded", type, platform },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "relationship.source-request") {
      const companyInput = String(input.company || "")
        .trim()
        .slice(0, 120);
      let company;
      let applicationId = null;
      let recordType = null;
      try {
        const resolved = resolveReferencedCompany({
          repoRoot,
          env,
          companyReference: companyInput,
          notFoundCode: "RELATIONSHIP_SOURCING_COMPANY_REQUIRED",
          notFoundMessage:
            "Name the company you want people sourcing for, like: find a recruiter at Acme.",
        });
        company = resolved.company;
        recordType = resolved.recordType;
        applicationId = recordType === "application" ? resolved.id : null;
      } catch (error) {
        // Untracked companies still get a handoff, but only when the
        // reference has real tokens — "..." or bare punctuation would
        // otherwise slip through as a nonsense company name.
        if (
          error?.code === "RELATIONSHIP_SOURCING_COMPANY_REQUIRED" &&
          companyReferenceTokens(companyInput).length
        ) {
          company = companyInput;
        } else {
          throw error;
        }
      }

      const platforms = ["linkedin", "wellfound"].map((platform) => ({
        platform,
        allowed: mayRun({ capability: "relationship_sourcing", platform, root: repoRoot, env })
          .allowed,
      }));
      if (platforms.every((entry) => !entry.allowed)) {
        throw actionError(
          "Relationship sourcing isn't turned on yet. Turn it on in Settings first.",
          "RELATIONSHIP_SOURCING_NOT_ALLOWED"
        );
      }

      // A durable CTA only gets written when the linked application has no
      // nextAction of its own yet — never overwrite an existing one. The CTA
      // text must keep "relationship" and "sourcing" in it: relationshipLead
      // upsert's auto-clear regex (verbs/relationship.mjs) matches on that
      // vocabulary to flip this CTA to the lead-review CTA once a lead lands.
      let ctaRecorded = false;
      if (recordType === "application" && applicationId) {
        const application = applicationForIntent({ repoRoot, env, id: applicationId });
        if (!application.nextAction) {
          appSetFields({
            repoRoot,
            env,
            id: applicationId,
            patch: {
              nextAction: `Relationship sourcing in progress for ${company}`,
              nextActionDue: null,
            },
          });
          ctaRecorded = true;
        }
      }

      const role = applicationId
        ? applicationForIntent({ repoRoot, env, id: applicationId }).role || null
        : null;
      const execution =
        typeof runRelationshipSourcingImpl === "function"
          ? await runRelationshipSourcingImpl({ company, applicationId, role })
          : null;
      if (execution?.state === "needs-user" && applicationId && ctaRecorded) {
        appSetFields({
          repoRoot,
          env,
          id: applicationId,
          patch: {
            nextAction: `Retry relationship sourcing for ${company} after browser sign-in`,
            nextActionDue: null,
          },
        });
      }

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text:
          execution?.summary ||
          `Relationship sourcing for ${company} is ready in CareerRat. New leads land in the Network tab for your review.`,
        artifacts: [
          {
            kind: "sourcing_handoff",
            company,
            applicationId: applicationId || null,
            platforms,
            ctaRecorded,
            at: requestDate(now).toISOString(),
          },
          ...(execution ? [execution] : []),
        ],
        metadata: workflowActionMetadata(normalized, execution, "Retry people sourcing", {
          ctaRecorded,
        }),
        now,
      });
    }

    if (normalized.type === "status.sync-request") {
      const platforms = ["greenhouse", "workday", "ashby", "lever"].map((platform) => ({
        platform,
        allowed: mayRun({ capability: "status_polling", platform, root: repoRoot, env }).allowed,
      }));
      if (platforms.every((entry) => !entry.allowed)) {
        throw actionError(
          "Portal status polling isn't turned on yet. Turn it on in Settings first.",
          "STATUS_SYNC_NOT_ALLOWED"
        );
      }

      const applications = assembleTrackerObject(requireDb({ repoRoot, env })).applications || [];
      for (const entry of platforms) {
        entry.eligible = applications.filter((application) => {
          if (statusPollingPlatformForApplication(application) !== entry.platform) {
            return false;
          }
          // In-flight only: settled stages are excluded by classified stage so
          // raw labels like "offer-extended" or "accepted" count correctly.
          const stageId = classifyStage(application.status).id;
          return !["rejected", "withdrawn", "offer", "accepted"].includes(stageId);
        }).length;
      }

      const eligibleApplications = applications.filter((application) => {
        const stageId = classifyStage(application.status).id;
        return !["rejected", "withdrawn", "offer", "accepted"].includes(stageId);
      });
      const execution =
        typeof runStatusSyncImpl === "function"
          ? await runStatusSyncImpl({ applications: eligibleApplications })
          : null;

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text:
          execution?.summary ||
          "Portal status checking is ready in CareerRat. Any updates come back here for review.",
        artifacts: [
          {
            kind: "status_sync_handoff",
            platforms,
            at: requestDate(now).toISOString(),
          },
          ...(execution ? [execution] : []),
        ],
        metadata: workflowActionMetadata(normalized, execution, "Retry portal status check"),
        now,
      });
    }

    if (normalized.type === "mail.sync-request") {
      const tracker = assembleTrackerObject(requireDb({ repoRoot, env }));
      const sources = mailSyncSources({
        repoRoot,
        env,
        hostPlatform,
        tracker,
      });
      if (sources.every((source) => !source.allowed)) {
        throw actionError(
          "Mail sync isn't available on this device yet. Turn on mail access for Gmail or Outlook in Settings first.",
          "MAIL_SYNC_NOT_ALLOWED"
        );
      }

      // Count only — never surface thread rows, subjects, participants, or
      // bodies in the artifact (privacy rule).
      const needsReply = (tracker.communications || []).filter(
        (comm) => comm.channel === "email" && comm.status === "needs-reply"
      ).length;

      const appleMailSource = sources.find(
        (source) => source.id === "apple-mail" && source.allowed
      );
      const mailResult =
        appleMailSource && typeof runMailSyncImpl === "function"
          ? await runMailSyncImpl({
              source: appleMailSource,
              applications: tracker.applications || [],
            })
          : null;
      const supervisedSources = sources.filter(
        (source) => source.id !== "apple-mail" && source.allowed
      );
      const webmailResult =
        supervisedSources.length && typeof runWebmailSyncImpl === "function"
          ? await runWebmailSyncImpl({
              sources: supervisedSources,
              applications: tracker.applications || [],
            })
          : null;

      const mailResultArtifact = mailResult
        ? {
            ...mailResult,
            title: "Apple Mail check",
            summary: mailResult.blocker
              ? mailResult.blocker.message
              : `${mailResult.captured} new message${mailResult.captured === 1 ? "" : "s"} captured`,
          }
        : null;
      const resultCopy = mailResult?.blocker
        ? mailResult.blocker.message
        : mailResult
          ? `Checked Apple Mail and captured ${mailResult.captured} new job-search message${mailResult.captured === 1 ? "" : "s"}.`
          : null;
      const mailExecution =
        mailResult?.blocker || webmailResult?.state === "needs-user"
          ? { state: "needs-user" }
          : webmailResult || mailResult;

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text:
          [resultCopy, webmailResult?.summary].filter(Boolean).join(" ") ||
          "Mail checking is ready in CareerRat.",
        artifacts: [
          {
            kind: "mail_sync_handoff",
            sources,
            needsReply,
            at: requestDate(now).toISOString(),
          },
          ...(mailResultArtifact ? [mailResultArtifact] : []),
          ...(webmailResult ? [webmailResult] : []),
        ],
        metadata: workflowActionMetadata(normalized, mailExecution, "Retry mail check"),
        now,
      });
    }

    if (normalized.type === "messages.sync-request") {
      const tracker = assembleTrackerObject(requireDb({ repoRoot, env }));
      const sources = messagesSyncSources({ repoRoot, env, tracker });
      if (sources.every((source) => !source.allowed)) {
        throw actionError(
          "Message sync isn't turned on yet. Turn on in-platform messaging for LinkedIn or Wellfound in Settings first.",
          "MESSAGES_SYNC_NOT_ALLOWED"
        );
      }

      // Count only — never surface thread rows, subjects, participants, or
      // bodies in the artifact (privacy rule). Wellfound threads record as
      // channel "portal" (shared with ATS portal threads), so the card counts
      // only the LinkedIn channel and labels it that way, never overclaiming.
      const needsReply = (tracker.communications || []).filter(
        (comm) => comm.channel === "linkedin" && comm.status === "needs-reply"
      ).length;

      const execution =
        typeof runMessagesSyncImpl === "function"
          ? await runMessagesSyncImpl({ sources, applications: tracker.applications || [] })
          : null;

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text:
          execution?.summary ||
          "Message checking is ready in CareerRat. Anything it finds comes back here for review.",
        artifacts: [
          {
            kind: "messages_sync_handoff",
            sources,
            needsReply,
            at: requestDate(now).toISOString(),
          },
          ...(execution ? [execution] : []),
        ],
        metadata: workflowActionMetadata(normalized, execution, "Retry message check"),
        now,
      });
    }

    if (normalized.type === "linkedin.optimize-request") {
      // Never refuses: the handoff card always renders so the candidate can
      // see current consent state and turn capabilities on from there. The
      // gate that actually blocks a browser write lives in the skill, not
      // here.
      const capabilities = [
        {
          key: "profile_optimize",
          label: "Read and suggest",
          allowed: mayRun({
            capability: "profile_optimize",
            platform: "linkedin",
            root: repoRoot,
            env,
          }).allowed,
        },
        {
          key: "profile_apply",
          label: "Write approved edits",
          allowed: mayRun({
            capability: "profile_apply",
            platform: "linkedin",
            root: repoRoot,
            env,
          }).allowed,
        },
      ];
      const batch = linkedinProposalBatchLatest({ repoRoot, env });
      const execution =
        capabilities[0].allowed && typeof runLinkedinOptimizeImpl === "function"
          ? await runLinkedinOptimizeImpl({ profileUrl: null })
          : null;

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: execution
          ? execution.summary
          : capabilities[0].allowed
            ? "LinkedIn profile review is ready in CareerRat. Suggestions come back here for your approval."
            : "Turn on LinkedIn profile review in Settings to read your profile and draft suggestions here.",
        artifacts: [
          linkedinOptimizeHandoffArtifact({ capabilities, batch, now }),
          ...(batch ? [linkedinProfileProposalsArtifact(batch)] : []),
          ...(execution ? [execution] : []),
        ],
        metadata: workflowActionMetadata(normalized, execution, "Retry LinkedIn review"),
        now,
      });
    }

    if (normalized.type === "linkedin.proposal-decide") {
      const action = String(input.action || "").trim();
      if (!new Set(["approve", "reject"]).has(action)) {
        throw actionError(
          "LinkedIn suggestions can only be approved or rejected from Ask.",
          "BAD_LINKEDIN_PROPOSAL_ACTION"
        );
      }
      const batchId = normalized.entity.id;
      if (input.batchId && String(input.batchId) !== batchId) {
        throw actionError(
          "The LinkedIn suggestion action does not match the selected batch.",
          "BAD_INTENT_ENTITY"
        );
      }
      const batch = linkedinProposalDecide({
        repoRoot,
        env,
        batchId,
        surfaceId: input.surfaceId,
        action,
        version: input.version,
        reason: input.reason,
      });
      const surface = (batch.surfaces || []).find((entry) => entry.surfaceId === input.surfaceId);
      const decisionText = action === "approve" ? "approved" : "rejected";

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Recorded: ${surface?.surface || String(input.surfaceId || "suggestion")} ${decisionText}.`,
        artifacts: [linkedinProfileProposalsArtifact(batch)],
        metadata: { state: batch.status === "reviewed" ? "complete" : "needs-review" },
        now,
      });
    }

    if (normalized.type === "scheduling.prepare") {
      const communication = communicationForIntent({
        repoRoot,
        env,
        id: normalized.entity.id,
      });
      if (!communication.applicationId) {
        throw actionError(
          "Link this recruiter thread to a tracked application before planning the interview.",
          "SCHEDULING_APPLICATION_REQUIRED"
        );
      }
      const application = applicationForIntent({
        repoRoot,
        env,
        id: communication.applicationId,
      });
      const profile = candidateConfigGet({ repoRoot, env }).profile || {};
      const tracker = assembleTrackerObject(requireDb({ repoRoot, env }));
      const schedulingTarget = [communication.company, communication.role, communication.subject]
        .filter(Boolean)
        .join(", ");
      const scheduling = await prepareSchedulingPlanImpl({
        repoRoot,
        env,
        communication: communicationWithArtifactBodies({ repoRoot, env, communication }),
        application,
        profile,
        calendarBusy: tracker.calendarBusy || [],
        instruction: String(input.instruction || "").trim(),
        now,
      });
      const artifact = {
        kind: "scheduling_plan",
        title: `${schedulingTarget || "Recruiter thread"}: scheduling`,
        communicationId: communication.id,
        applicationId: application.id,
        status: scheduling.status,
        calendarChecked: scheduling.calendarChecked === true,
        missing: scheduling.missing || [],
        message: scheduling.message || null,
        plan: scheduling.plan || null,
        hold: scheduling.hold || null,
      };
      if (scheduling.status !== "ready") {
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text:
            scheduling.message ||
            "I need a little more scheduling context before I can prepare the reply.",
          artifacts: [artifact],
          metadata: {
            state: scheduling.status === "needs_user" ? "needs-user" : "manual-fallback",
            sent: false,
            booked: false,
            calendarChecked: scheduling.calendarChecked === true,
            missing: scheduling.missing || [],
            engine: scheduling.ai?.engine || null,
            elapsedMs: scheduling.ai?.elapsedMs ?? null,
          },
          now,
        });
      }

      const draftedAt = resolvedCommunicationDate(undefined, now);
      const operation = commSetDraft({
        repoRoot,
        env,
        id: communication.id,
        draft: {
          ...(scheduling.plan.subject ? { subject: scheduling.plan.subject } : {}),
          body: scheduling.plan.body,
        },
        summary: scheduling.hold
          ? "Scheduling reply and tentative hold prepared for review."
          : "Scheduling reply prepared for review.",
        at: draftedAt,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: scheduling.hold
          ? `Prepared the reply and a tentative hold for ${schedulingTarget || "the recruiter thread"}. Nothing was sent or booked.`
          : `Prepared the scheduling reply for ${schedulingTarget || "the recruiter thread"}. Nothing was sent or booked.`,
        artifacts: [artifact],
        metadata: {
          state: scheduling.hold ? "tentative-hold" : "drafted",
          sent: false,
          booked: false,
          requiresReview: true,
          draftedAt,
          calendarChecked: scheduling.calendarChecked === true,
          engine: scheduling.ai?.engine || null,
          elapsedMs: scheduling.ai?.elapsedMs ?? null,
          nextActions: [
            navigationAction("Review job and reply", {
              surface: "job",
              entityType: "application",
              entityId: application.id,
            }),
          ],
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "communication.draft") {
      const communication = communicationForIntent({
        repoRoot,
        env,
        id: normalized.entity.id,
      });
      const history = workspaceThreadRead({ repoRoot, env });
      const response = await callAIImpl({
        root: repoRoot,
        env,
        system: [
          buildWorkspaceAgentSystemPrompt({ repoRoot, env }),
          "Draft a truthful, concise reply for the tracked communication below.",
          "Return only the message body, with no commentary, subject label, or Markdown fence.",
          `Tracked communication: ${JSON.stringify(communication)}`,
          `User instruction: ${String(input.instruction || "Use the candidate's established voice and answer only what the thread requires.")}`,
        ].join("\n\n"),
        messages: history.messages.map(messageForModel),
        maxTokens: 1024,
        stream: false,
        feature: "workspace-agent",
        skill: "email-comms",
        action: "draft",
        operation: "communication:draft",
      });
      const body = responseText(response);
      if (!body)
        throw actionError("The selected AI runtime returned an empty draft.", "EMPTY_AI_RESPONSE");
      const subject = replySubject(communication, input);
      // Same outbound-content backstops communication.handoff runs before a
      // draft goes into a compose link: an AI-drafted reply is free text and
      // gets no other check before this point, so it must clear the same
      // comp-leak and placeholder guards before it is persisted or returned.
      const draftLeak =
        findCurrentBaseToken(`${subject}\n${body}`) || findCompLeak(`${subject}\n${body}`);
      if (draftLeak) {
        throw actionError(
          "This draft still contains your private current pay figure. Edit the draft, then try again.",
          "COMMUNICATION_COMP_LEAK"
        );
      }
      const draftPlaceholderLint = lintArtifact(`${subject}\n${body}`);
      if (!draftPlaceholderLint.clean) {
        throw actionError(
          "This draft still has unfinished placeholder text. Finish the draft, then try again.",
          "COMMUNICATION_DRAFT_PLACEHOLDER"
        );
      }
      const summary = draftSummary(body);
      const draftedAt = resolvedCommunicationDate(undefined, now);
      commSetDraft({
        repoRoot,
        env,
        id: normalized.entity.id,
        draft: { ...(subject ? { subject } : {}), body },
        summary,
        at: draftedAt,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Drafted a reply for ${communicationLabel(communication)}. Review it before sending.`,
        artifacts: [
          {
            kind: "communication_draft",
            title: subject || `Reply to ${communication.company || "contact"}`,
            subject: subject || null,
            body,
          },
        ],
        metadata: {
          state: "drafted",
          sent: false,
          requiresReview: true,
          draftedAt,
          engine: response?.engine || null,
          elapsedMs: response?.elapsedMs ?? null,
        },
        now,
      });
    }

    if (normalized.type === "communication.send") {
      const communication = communicationForIntent({
        repoRoot,
        env,
        id: normalized.entity.id,
      });
      const sendChannel = String(communication.channel || "email").trim();
      if (sendChannel !== "email") {
        const error = actionError(
          `This thread is on ${sendChannel}. CareerRat can only prepare email sends; reply there and use I sent this.`,
          "COMMUNICATION_CHANNEL_UNSUPPORTED"
        );
        error.details = { channel: sendChannel };
        throw error;
      }
      if (!communication.draft) {
        throw actionError(
          "Draft a reply and review it before sending.",
          "COMMUNICATION_DRAFT_REQUIRED"
        );
      }
      if (typeof sendCommunicationImpl !== "function") {
        throw actionError(
          "The consented delivery executor is not connected, so the draft was not sent or cleared.",
          "COMMUNICATION_EXECUTOR_UNAVAILABLE"
        );
      }
      const execution = await sendCommunicationImpl({
        repoRoot,
        env,
        communicationId: normalized.entity.id,
        communication,
        draft: communication.draft,
        input,
      });
      if (execution?.verified !== true) {
        const detail = String(
          execution?.reason || "No verified delivery confirmation was returned."
        );
        throw actionError(
          `${detail} The draft was not marked sent or cleared.`,
          "COMMUNICATION_NOT_VERIFIED"
        );
      }
      const sentAt = resolvedCommunicationDate(execution.sentAt, now);
      const confirmation = execution.confirmation
        ? String(execution.confirmation)
        : "Verified delivery confirmation";
      // The evidence string is what lets commMarkSent record "verified" at
      // all; without it the verb derives a weaker tier by design.
      commMarkSent({
        repoRoot,
        env,
        id: normalized.entity.id,
        at: sentAt,
        summary: execution.summary,
        verification: "verified",
        deliveryEvidence: confirmation,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Sent and verified the reply for ${communicationLabel(communication)}.`,
        metadata: {
          state: "sent",
          deliveryVerified: true,
          sentAt,
          confirmation,
        },
        now,
      });
    }

    if (normalized.type === "communication.add-note") {
      const communication = communicationForIntent({
        repoRoot,
        env,
        id: normalized.entity.id,
      });
      const summary = String(input.summary ?? input.note ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!summary) {
        throw actionError("Enter a note before saving it.", "EMPTY_COMMUNICATION_NOTE");
      }
      const at = resolvedCommunicationDate(input.at, now);
      const notedSummary = summary.slice(0, 200);
      const operation = commAppendMessage({
        repoRoot,
        env,
        id: normalized.entity.id,
        message: { direction: "note", summary: notedSummary, at },
      });
      const company = communication.company || "this company";
      const role = communication.role || "this role";
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Noted on ${company}, ${role}.`,
        artifacts: [
          {
            kind: "communication_note",
            communicationId: normalized.entity.id,
            company,
            role,
            note: notedSummary,
          },
        ],
        metadata: { state: communication.status || "noted", at },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "communication.record-external") {
      const communication = communicationForIntent({
        repoRoot,
        env,
        id: normalized.entity.id,
      });
      const sentAt = resolvedCommunicationDate(input.sentAt, now);
      // No verification passed: commMarkSent derives the tier itself
      // (supervised when a CareerRat draft was in place, user_report
      // otherwise), so this surface can never disagree with the CLI/REST
      // callers of the same verb.
      const operation = commMarkSent({
        repoRoot,
        env,
        id: normalized.entity.id,
        at: sentAt,
        summary: input.summary,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Recorded that you sent the response for ${communicationLabel(communication)} outside CareerRat.`,
        metadata: {
          state: "sent",
          deliveryVerified: false,
          recordingMode: "external_report",
          sentAt,
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "communication.handoff") {
      const communication = communicationForIntent({
        repoRoot,
        env,
        id: normalized.entity.id,
      });
      const channel = String(communication.channel || "email").trim();
      if (channel !== "email") {
        const error = actionError(
          `This thread is on ${channel}. CareerRat can only prepare email sends; reply there and use I sent this.`,
          "COMMUNICATION_CHANNEL_UNSUPPORTED"
        );
        error.details = { channel };
        throw error;
      }
      if (!communication.draft) {
        throw actionError(
          "Draft a reply and review it before sending.",
          "COMMUNICATION_DRAFT_REQUIRED"
        );
      }
      // Legacy rows can hold a bare-string draft (see sentMessageFromDraft in
      // verbs/comm.mjs); normalize the same way so the body never opens empty.
      const draft =
        typeof communication.draft === "string"
          ? { body: communication.draft }
          : communication.draft;
      const subject =
        String(draft.subject || "").trim() ||
        `Re: ${communication.role || "this role"} at ${communication.company || "this company"}`;
      const body = String(draft.body || "");
      // Outbound-content backstops before anything goes into a compose link:
      // the private current_base figure never leaves (findCurrentBaseToken
      // catches the literal field name; findCompLeak catches phrase-based
      // disclosures like "my current salary is $X" that never mention the
      // field), and an unfinished draft with placeholder brackets goes back
      // for editing instead of out.
      const leak =
        findCurrentBaseToken(`${subject}\n${body}`) || findCompLeak(`${subject}\n${body}`);
      if (leak) {
        throw actionError(
          "This draft still contains your private current pay figure. Edit the draft, then try again.",
          "COMMUNICATION_COMP_LEAK"
        );
      }
      const placeholderLint = lintArtifact(`${subject}\n${body}`);
      if (!placeholderLint.clean) {
        throw actionError(
          "This draft still has unfinished placeholder text. Finish the draft, then try again.",
          "COMMUNICATION_DRAFT_PLACEHOLDER"
        );
      }
      const recipient = resolveRecipient(communication);
      const to = recipient.state === "ready" ? recipient.to : null;
      const links = buildSendLinks({ to: to || "", subject, body });
      const text =
        recipient.state === "ready"
          ? "Your reply is ready to send. Open it in your email app, send it, then tell CareerRat you sent it."
          : "This thread has no contact email address yet. Add one, then CareerRat can prepare the send. Once you've sent it, tell CareerRat you sent it.";
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text,
        artifacts: [
          {
            kind: "communication_handoff",
            communicationId: normalized.entity.id,
            company: communication.company || null,
            role: communication.role || null,
            subject,
            body,
            to,
            state: recipient.state,
            links,
          },
        ],
        metadata: {
          state: recipient.state,
          nextActions: [
            {
              label: "I sent this",
              intent: {
                type: "communication.record-external",
                entity: { type: "communication", id: normalized.entity.id },
              },
            },
          ],
        },
        now,
      });
    }

    let application = applicationForIntent({
      repoRoot,
      env,
      id: normalized.entity.id,
    });
    if (normalized.type === "outcome.record") {
      const to = String(input.to || "")
        .trim()
        .toLowerCase();
      if (!TRACK_OUTCOME_STATUSES.includes(to)) {
        throw actionError(
          `Outcome status must be one of: ${TRACK_OUTCOME_STATUSES.join(", ")}.`,
          "BAD_OUTCOME_STATUS"
        );
      }
      const note = String(input.note || "").trim();
      appSetStatus({
        repoRoot,
        env,
        id: normalized.entity.id,
        to,
        note: note || undefined,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Recorded ${applicationLabel(application)} as ${to}.`,
        metadata: {
          previousState: application.status || null,
          state: to,
          sourceIntakeId: input.sourceIntakeId || null,
        },
        now,
      });
    }
    if (normalized.type === "application.record-external") {
      const appliedAt = resolvedDate(input.appliedAt, now);
      appSetStatus({
        repoRoot,
        env,
        id: normalized.entity.id,
        to: "applied",
        note: "Applied outside CareerRat. Reported by user.",
        appliedAt,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Recorded that you applied outside CareerRat: ${applicationLabel(application)}.`,
        metadata: {
          state: "recorded",
          recordingMode: "external_report",
          submissionVerified: false,
          appliedAt,
        },
        now,
      });
    }

    if (normalized.type === "status.connect-portal") {
      const statusUrl = safeExternalHttpUrl(input.url);
      const statusPlatform = statusPollingPlatformForUrl(statusUrl);
      if (!statusUrl || new URL(statusUrl).protocol !== "https:" || !statusPlatform) {
        throw actionError(
          "Use a Greenhouse, Workday, Ashby, or Lever application dashboard URL.",
          "STATUS_PORTAL_UNSUPPORTED"
        );
      }
      appSetFields({
        repoRoot,
        env,
        id: normalized.entity.id,
        patch: { statusUrl, statusPlatform },
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Connected the ${statusPlatform} status portal for ${applicationLabel(application)}.`,
        artifacts: [
          {
            kind: "status_portal_connection",
            title: `${application.company}: Status portal connected`,
            summary: `${statusPlatform} is ready for in-app status checks.`,
            applicationId: application.id,
            platform: statusPlatform,
          },
        ],
        metadata: { state: "connected", applicationId: application.id, statusPlatform },
        now,
      });
    }

    if (normalized.type === "status.record-portal") {
      const rawStatus = String(input.rawStatus || "")
        .trim()
        .slice(0, 160);
      if (!rawStatus) {
        throw actionError(
          "Say what the portal shows, like: Greenhouse says phone screen scheduled for Acme.",
          "STATUS_UPDATE_INVALID"
        );
      }
      if (findCurrentBaseToken(rawStatus) || findCompLeak(rawStatus)) {
        throw actionError(
          "That update includes your private current pay figure. Remove it, then try again.",
          "STATUS_UPDATE_COMP_LEAK"
        );
      }

      const at = requestDate(now).toISOString();
      const transition = statusTransition(application.status, rawStatus);

      if (!transition.changed) {
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text: `No change recorded: ${applicationLabel(application)} is already tracked at that stage.`,
          artifacts: [
            {
              kind: "status_transition_receipt",
              applicationId: normalized.entity.id,
              company: application.company || null,
              role: application.role || null,
              from: application.status || null,
              to: null,
              rawStatus,
              changed: false,
              applied: false,
              at,
            },
          ],
          metadata: { state: "unchanged" },
          now,
        });
      }

      if (transition.autoApplicable) {
        const to = toTrackOutcomeStatus(transition.canonical);
        appSetStatus({
          repoRoot,
          env,
          id: normalized.entity.id,
          to,
          note: `Portal status reported by user: "${rawStatus}"`,
          round: transition.norm?.round || undefined,
        });
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text: `Recorded ${applicationLabel(application)} as ${to}.`,
          artifacts: [
            {
              kind: "status_transition_receipt",
              applicationId: normalized.entity.id,
              company: application.company || null,
              role: application.role || null,
              from: application.status || null,
              to,
              rawStatus,
              changed: true,
              applied: true,
              at,
            },
          ],
          metadata: {
            previousState: application.status || null,
            state: to,
            provenance: "portal-self-report",
          },
          now,
        });
      }

      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text:
          transition.direction === "regress"
            ? "The portal shows a step backward from where this application is tracked. Review it and press Apply to record it anyway."
            : "CareerRat isn't sure how that maps to a tracked stage. Review it and press Apply to record it.",
        artifacts: [
          {
            kind: "status_transition_proposal",
            applicationId: normalized.entity.id,
            company: application.company || null,
            role: application.role || null,
            from: application.status || null,
            rawStatus,
            to: toTrackOutcomeStatus(transition.canonical),
            direction: transition.direction,
            confidence: transition.confidence,
            round: transition.norm?.round || null,
            at,
          },
        ],
        metadata: { state: "proposed", direction: transition.direction },
        now,
      });
    }

    if (normalized.type === "status.apply-transition") {
      const to = String(input.to || "")
        .trim()
        .toLowerCase();
      if (!to || !TRACK_OUTCOME_STATUSES.includes(to)) {
        throw actionError(
          "CareerRat couldn't apply that status update as proposed.",
          "STATUS_APPLY_INVALID"
        );
      }
      if ((application.status || null) !== (input.from || null)) {
        throw actionError(
          "This application changed since that update was proposed. Ask CareerRat to check the status again.",
          "STATUS_TRANSITION_STALE"
        );
      }
      const rawStatus =
        input.rawStatus == null ? null : String(input.rawStatus).trim().slice(0, 160) || null;
      if (rawStatus && (findCurrentBaseToken(rawStatus) || findCompLeak(rawStatus))) {
        throw actionError(
          "That update includes your private current pay figure. Remove it, then try again.",
          "STATUS_UPDATE_COMP_LEAK"
        );
      }
      const round = input.round == null ? null : String(input.round).trim().slice(0, 60) || null;

      appSetStatus({
        repoRoot,
        env,
        id: normalized.entity.id,
        to,
        note: rawStatus ? `Portal status reported by user: "${rawStatus}"` : undefined,
        round: round || undefined,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Recorded ${applicationLabel(application)} as ${to}.`,
        artifacts: [
          {
            kind: "status_transition_receipt",
            applicationId: normalized.entity.id,
            company: application.company || null,
            role: application.role || null,
            from: input.from || null,
            to,
            rawStatus,
            changed: true,
            applied: true,
            at: requestDate(now).toISOString(),
          },
        ],
        metadata: {
          previousState: input.from || null,
          state: to,
          provenance: "portal-self-report",
        },
        now,
      });
    }

    const prepareSubmit = normalized.type === "job.prepare-submit";
    const resumeApplicationSession = prepareSubmit || input.resumeSession === true;
    const postingUrl = safeExternalHttpUrl(
      application.link || application.url || application.sourceUrl
    );
    if (!postingUrl) {
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `CareerRat cannot open the supervised handoff for ${applicationLabel(application)} yet. Paste the application link; this application was not marked Applied.`,
        artifacts: [
          {
            kind: "application_link_required",
            title: `${applicationLabel(application)}: Application link needed`,
            applicationId: normalized.entity.id,
            code: "APPLICATION_URL_REQUIRED",
          },
        ],
        metadata: {
          state: prepareSubmit ? "blocked" : "needs-input",
          applicationId: normalized.entity.id,
          submissionVerified: false,
        },
        now,
      });
    }

    let questionCapture = null;

    if (!resumeApplicationSession) {
      let evaluated;
      if (input.reviewApproved === true) {
        evaluated = persistedEvaluationResult(application, normalized.entity.id);
        if (!reviewApprovalMatches(application, input)) {
          return appendActionResult({
            repoRoot,
            env,
            normalized,
            intentMessage,
            text: `The job evaluation changed since that approval action was created. Review the current verdict before CareerRat prepares the application.`,
            artifacts: [evaluated.artifact],
            metadata: {
              state: evaluated.gate,
              applicationId: normalized.entity.id,
              fitScore: evaluated.evaluation.fitScore ?? null,
              manualRequired: Boolean(evaluated.evaluation.manual?.required),
              submissionVerified: false,
              nextActions: evaluationNextActions(
                evaluated.gate,
                normalized.entity.id,
                evaluated.evaluation.fitRisks,
                evaluated.evaluation.evaluatedAt
              ),
            },
            now,
          });
        }
        appApproveReview({
          repoRoot,
          env,
          id: normalized.entity.id,
          expectedEvaluatedAt: input.approvedEvaluationAt,
        });
        application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      } else {
        evaluated = await evaluateApplicationRequest({
          repoRoot,
          env,
          applicationId: normalized.entity.id,
          evaluateJobImpl,
        });
      }
      if (evaluated.gate !== "keep" && input.reviewApproved !== true) {
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text: `${evaluated.text} CareerRat did not open the application form.`,
          artifacts: [evaluated.artifact],
          metadata: {
            state: evaluated.gate,
            applicationId: normalized.entity.id,
            fitScore: evaluated.evaluation.fitScore ?? null,
            manualRequired: Boolean(evaluated.evaluation.manual?.required),
            submissionVerified: false,
            nextActions: evaluationNextActions(
              evaluated.gate,
              normalized.entity.id,
              evaluated.evaluation.fitRisks,
              evaluated.evaluation.evaluatedAt
            ),
          },
          now,
        });
      }

      questionCapture = await prepareApplicationQuestions({
        repoRoot,
        env,
        application,
        applicationId: normalized.entity.id,
        captureQuestionsImpl,
        fetchImpl: searchFetchImpl,
      });

      const { packet, questionCaptureDeferred } = await generateDocumentsWithQuestionFallback({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
        applyIntent: true,
        formats: ["pdf"],
        generateDocumentsImpl,
      });
      const gaps = packetGapsForApplication(packet.gaps, application, true);
      const blockingGapCount = blockingPacketGaps(gaps).length;
      if (blockingGapCount > 0) {
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text: `${evaluated.text} Generated the application packet. ${packetGapText(
            gaps,
            questionCaptureDeferred
          )}`,
          artifacts: [
            evaluated.artifact,
            {
              kind: "packet_generation",
              purpose: "application",
              title: `${applicationLabel(application)}: Documents`,
              applicationId: normalized.entity.id,
              status: packet.status || "reviewable",
              uploadReady: Boolean(packet.uploadReady),
              artifacts: packet.artifacts || {},
              gaps,
              blockingGapCount,
            },
          ],
          metadata: {
            state: packet.status || "reviewable",
            applicationId: normalized.entity.id,
            submissionVerified: false,
            uploadReady: Boolean(packet.uploadReady),
            gapCount: gaps.length,
            blockingGapCount,
            nextActions: [
              navigationAction("Review application", {
                surface: "job",
                entityType: "application",
                entityId: normalized.entity.id,
              }),
            ],
          },
          operationResult: { ...packet, gaps },
          now,
        });
      }
      application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      questionCapture = questionCaptureFromApplication(application) || questionCapture;
    } else {
      if (input.reviewApproved === true) {
        const evaluated = persistedEvaluationResult(application, normalized.entity.id);
        if (!reviewApprovalMatches(application, input)) {
          return appendActionResult({
            repoRoot,
            env,
            normalized,
            intentMessage,
            text: `The job evaluation changed since that approval action was created. Review the current verdict before CareerRat opens the application form.`,
            artifacts: [evaluated.artifact],
            metadata: {
              state: evaluated.gate,
              applicationId: normalized.entity.id,
              submissionVerified: false,
              nextActions: evaluationNextActions(
                evaluated.gate,
                normalized.entity.id,
                evaluated.evaluation.fitRisks,
                evaluated.evaluation.evaluatedAt
              ),
            },
            now,
          });
        }
        appApproveReview({
          repoRoot,
          env,
          id: normalized.entity.id,
          expectedEvaluatedAt: input.approvedEvaluationAt,
        });
        application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      }
      questionCapture = await prepareApplicationQuestions({
        repoRoot,
        env,
        application,
        applicationId: normalized.entity.id,
        captureQuestionsImpl,
        fetchImpl: searchFetchImpl,
      });
    }

    if (resumeApplicationSession && packetQuestionLineageIsStale(application)) {
      const { packet, questionCaptureDeferred } = await generateDocumentsWithQuestionFallback({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
        applyIntent: true,
        formats: ["pdf"],
        force: true,
        generateDocumentsImpl,
      });
      const gaps = packetGapsForApplication(packet.gaps, application, true);
      const blockingGapCount = blockingPacketGaps(gaps).length;
      if (blockingGapCount > 0) {
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text: `The captured application questions changed, so CareerRat rebuilt the packet. ${packetGapText(
            gaps,
            questionCaptureDeferred
          )} The application was not marked Applied.`,
          artifacts: [
            {
              kind: "packet_generation",
              purpose: "application",
              title: `${applicationLabel(application)}: Documents`,
              applicationId: normalized.entity.id,
              status: packet.status || "reviewable",
              uploadReady: Boolean(packet.uploadReady),
              artifacts: packet.artifacts || {},
              gaps,
              blockingGapCount,
            },
          ],
          metadata: {
            state: prepareSubmit ? "blocked" : "needs-input",
            applicationId: normalized.entity.id,
            submissionVerified: false,
            uploadReady: Boolean(packet.uploadReady),
            gapCount: gaps.length,
            blockingGapCount,
            nextActions: [
              navigationAction("Review application", {
                surface: "job",
                entityType: "application",
                entityId: normalized.entity.id,
              }),
            ],
          },
          operationResult: { ...packet, gaps },
          now,
        });
      }
      application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      questionCapture = questionCaptureFromApplication(application) || questionCapture;
    }

    const applySafetyBlockReason = resumeApplicationSession
      ? applicationApplySafetyBlockReason(application)
      : null;
    if (typeof applyJobImpl !== "function" && (!prepareSubmit || !applySafetyBlockReason)) {
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `CareerRat prepared the handoff for ${applicationLabel(application)}. ${questionCaptureText(questionCapture, application)} CareerRat couldn't connect to a supervised browser, so open the posting to submit it; this application was not marked Applied.`,
        artifacts: [
          {
            kind: "application_handoff",
            title: `${applicationLabel(application)}: Application site`,
            applicationId: normalized.entity.id,
            url: postingUrl,
            submissionVerified: false,
            questionCapture,
          },
        ],
        metadata: {
          state: "manual-handoff",
          applicationId: normalized.entity.id,
          submissionVerified: false,
          nextActions: [
            {
              label: "I applied",
              intent: {
                type: "application.record-external",
                entity: { type: "application", id: normalized.entity.id },
              },
            },
          ],
        },
        now,
      });
    }
    // A prepare-submit request always skips re-evaluation and regeneration.
    // Corroborate the saved gate and packet before opening the browser, even
    // when no executor is connected. job.apply keeps its existing no-executor
    // handoff behavior because its non-resume path can build those records.
    if (applySafetyBlockReason) {
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `${applySafetyBlockReason} CareerRat did not open the application form.`,
        artifacts: [
          {
            kind: "application_apply_blocked",
            title: `${applicationLabel(application)}: Not ready to apply`,
            applicationId: normalized.entity.id,
            code: "APPLY_SAFETY_CHECK_FAILED",
            reason: applySafetyBlockReason,
          },
        ],
        metadata: {
          state: "blocked",
          applicationId: normalized.entity.id,
          submissionVerified: false,
        },
        now,
      });
    }
    const executorInput = {
      ...input,
      ...(prepareSubmit ? { resumeSession: true } : {}),
      prepareOnly: true,
    };
    let execution = await applyJobImpl({
      repoRoot,
      env,
      applicationId: normalized.entity.id,
      application,
      postingUrl,
      questionCapture,
      input: executorInput,
      prepareOnly: true,
      ...(input.focusSession === true ? { focusSession: true } : {}),
    });
    if (execution?.state === "questions-captured" && execution?.questionCaptureUpdated === true) {
      application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      questionCapture = questionCaptureFromApplication(application) || questionCapture;
      const { packet, questionCaptureDeferred } = await generateDocumentsWithQuestionFallback({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
        applyIntent: true,
        formats: ["pdf"],
        force: true,
        generateDocumentsImpl,
      });
      const gaps = packetGapsForApplication(packet.gaps, application, true);
      const blockingGapCount = blockingPacketGaps(gaps).length;
      if (blockingGapCount > 0) {
        const sessionUrl = safeExternalHttpUrl(execution.currentUrl || postingUrl);
        return appendActionResult({
          repoRoot,
          env,
          normalized,
          intentMessage,
          text: `CareerRat captured the live application questions and rebuilt the packet. ${packetGapText(
            gaps,
            questionCaptureDeferred
          )} The application was not marked Applied.`,
          artifacts: [
            {
              kind: "packet_generation",
              purpose: "application",
              title: `${applicationLabel(application)}: Documents`,
              applicationId: normalized.entity.id,
              status: packet.status || "reviewable",
              uploadReady: Boolean(packet.uploadReady),
              artifacts: packet.artifacts || {},
              gaps,
              blockingGapCount,
            },
            {
              kind: "application_handoff",
              title: `${applicationLabel(application)}: Supervised application`,
              applicationId: normalized.entity.id,
              ...(sessionUrl ? { url: sessionUrl } : {}),
              submissionVerified: false,
              questionCapture,
              executorAvailable: true,
              session: execution.session || { provider: "session-browser" },
            },
          ],
          metadata: {
            state: prepareSubmit ? "blocked" : "needs-input",
            applicationId: normalized.entity.id,
            submissionVerified: false,
            uploadReady: Boolean(packet.uploadReady),
            gapCount: gaps.length,
            blockingGapCount,
            nextActions: [
              navigationAction("Review application", {
                surface: "job",
                entityType: "application",
                entityId: normalized.entity.id,
              }),
            ],
          },
          operationResult: { ...packet, gaps },
          now,
        });
      }
      application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      execution = await applyJobImpl({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
        application,
        postingUrl,
        questionCapture,
        input: {
          ...executorInput,
          resumeSession: true,
          renderedQuestionsReady: true,
          prepareOnly: true,
        },
        prepareOnly: true,
        ...(input.focusSession === true ? { focusSession: true } : {}),
      });
    }
    if (execution?.available === false || execution?.state === "unavailable") {
      const postingUrl = safeExternalHttpUrl(
        application.link || application.url || application.sourceUrl
      );
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `${String(execution?.reason || "The supervised browser is unavailable.")} Open the posting to finish the application; it was not marked Applied.`,
        artifacts: postingUrl
          ? [
              {
                kind: "application_handoff",
                title: `${applicationLabel(application)}: Application site`,
                applicationId: normalized.entity.id,
                url: postingUrl,
                submissionVerified: false,
                questionCapture,
                executorAvailable: false,
              },
            ]
          : undefined,
        metadata: {
          state: "manual-handoff",
          applicationId: normalized.entity.id,
          submissionVerified: false,
          nextActions: [
            {
              label: "I applied",
              intent: {
                type: "application.record-external",
                entity: { type: "application", id: normalized.entity.id },
              },
            },
          ],
        },
        now,
      });
    }
    if (execution?.verified !== true && ACTIVE_APPLICATION_SESSION_STATES.has(execution?.state)) {
      const sessionUrl = safeExternalHttpUrl(
        execution.currentUrl || application.link || application.url || application.sourceUrl
      );
      const permissionRequired = execution?.code === "APPLICATION_PREPARATION_PERMISSION_REQUIRED";
      const sessionState =
        prepareSubmit && execution.state === "questions-captured" ? "blocked" : execution.state;
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: applicationSessionText(execution),
        artifacts: [
          {
            kind: "application_handoff",
            title: `${applicationLabel(application)}: Supervised application`,
            applicationId: normalized.entity.id,
            ...(sessionUrl ? { url: sessionUrl } : {}),
            submissionVerified: false,
            questionCapture,
            executorAvailable: true,
            session: execution.session || { provider: "session-browser" },
          },
        ],
        metadata: {
          state: sessionState,
          applicationId: normalized.entity.id,
          submissionVerified: false,
          nextActions: [
            {
              label: permissionRequired ? "Prepare form" : "Return to supervised application",
              intent: {
                type: "job.prepare-submit",
                entity: { type: "application", id: normalized.entity.id },
                input: permissionRequired
                  ? carriedReviewApproval(input)
                  : {
                      resumeSession: true,
                      focusSession: true,
                      ...carriedReviewApproval(input),
                    },
              },
            },
            {
              label: "I applied",
              intent: {
                type: "application.record-external",
                entity: { type: "application", id: normalized.entity.id },
              },
            },
          ],
        },
        operationResult: execution,
        now,
      });
    }
    if (execution?.verified === true || execution?.state === "submitted") {
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `The supervised browser already shows a submission confirmation for ${applicationLabel(application)}. This application was not marked Applied; record it only after you confirm the submission.`,
        artifacts: [
          {
            kind: "application_handoff",
            title: `${applicationLabel(application)}: Submission confirmation needs review`,
            applicationId: normalized.entity.id,
            submissionVerified: false,
            executorAvailable: true,
            session: execution.session || { provider: "session-browser" },
          },
        ],
        metadata: {
          state: "manual-handoff",
          applicationId: normalized.entity.id,
          submissionVerified: false,
          nextActions: [
            {
              label: "I applied",
              intent: {
                type: "application.record-external",
                entity: { type: "application", id: normalized.entity.id },
              },
            },
          ],
        },
        operationResult: execution,
        now,
      });
    }
    if (execution?.verified !== true) {
      const detail = String(execution?.reason || "The supervised preparation could not continue.");
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `${detail} CareerRat stopped before submission and did not mark this application Applied.`,
        metadata: {
          state: "blocked",
          applicationId: normalized.entity.id,
          submissionVerified: false,
        },
        operationResult: execution,
        now,
      });
    }
    throw actionError(
      "The supervised preparation ended without a safe handoff. The application was not marked Applied.",
      "APPLICATION_PREPARATION_FAILED"
    );
  } catch (error) {
    const visibleError = visibleActionError(error, normalized.entity);
    workspaceMessageAppend({
      repoRoot,
      env,
      role: "assistant",
      kind: "action_error",
      text: visibleError,
      entity: normalized.entity,
      error: {
        code: error?.code || "ACTION_FAILED",
        message: visibleError,
      },
      metadata: { intentMessageId: intentMessage.message.id },
      now,
    });
    error.workspaceThreadId = WORKSPACE_THREAD_ID;
    throw error;
  }
}

export async function captureWorkspaceIntake({
  repoRoot,
  env = process.env,
  text,
  inputKind,
  requestedAction,
  captureIntakeImpl,
  now = () => new Date(),
} = {}) {
  const rawText = String(text || "");
  if (!rawText.trim()) throw actionError("Intake text is required.", "EMPTY_INTAKE");
  if (inputKind !== undefined && inputKind !== "text" && inputKind !== "url") {
    throw actionError('Intake kind must be "text" or "url".', "BAD_INTAKE_KIND");
  }
  const normalizedRequestedAction = normalizeIntakeRequestedAction(requestedAction);

  const intakeMessage = workspaceMessageAppend({
    repoRoot,
    env,
    role: "user",
    kind: "intake",
    text: rawText,
    metadata: { inputKind: inputKind || "auto", requestedAction: normalizedRequestedAction },
    now,
  });

  try {
    if (typeof captureIntakeImpl !== "function") {
      throw actionError(
        "The intake capture service is not connected. Your paste remains saved in this conversation.",
        "INTAKE_EXECUTOR_UNAVAILABLE"
      );
    }
    const item = await captureIntakeImpl({
      repoRoot,
      env,
      text: rawText,
      inputKind,
      ...(normalizedRequestedAction ? { requestedAction: normalizedRequestedAction } : {}),
    });
    const proposedAction = String(item?.classification?.proposedAction || "").trim();
    const needsReason = String(item?.classification?.needsUserReason || item?.error || "").trim();
    let detail = proposedAction;
    if (!detail && needsReason) detail = `It needs your review: ${needsReason}`;
    if (!detail && item?.dispatchSummary) detail = String(item.dispatchSummary);
    if (!detail) detail = "It is saved and ready for review.";

    workspaceMessageAppend({
      repoRoot,
      env,
      role: "assistant",
      kind: "action_result",
      text: `Captured this ${intakeLabel(item?.kind)}. ${detail}`,
      entity: { type: "intake", id: item.id },
      metadata: {
        intakeMessageId: intakeMessage.message.id,
        intakeStatus: item.status,
        intakeKind: item.kind,
        requestedAction: item.requestedAction || null,
        confidence: item.classification?.confidence ?? null,
        needsUser: Boolean(item.classification?.needsUser),
        dispatchSummary: item.dispatchSummary || null,
      },
      now,
    });
    return { ...workspaceThreadRead({ repoRoot, env }), intake: item };
  } catch (error) {
    workspaceMessageAppend({
      repoRoot,
      env,
      role: "assistant",
      kind: "action_error",
      text: String(error?.message || "The intake item could not be captured."),
      error: {
        code: error?.code || "INTAKE_CAPTURE_FAILED",
        message: String(error?.message || "The intake item could not be captured."),
      },
      metadata: { intakeMessageId: intakeMessage.message.id },
      now,
    });
    error.workspaceThreadId = WORKSPACE_THREAD_ID;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Ask bar preview (classify, don't execute) — W3. Cheap, deterministic, and
// side-effect-free: never writes to the thread, never calls the AI seam. Only
// a phrasing this can resolve to a concrete, safe intent WITHOUT guessing at
// a specific application/communication/sourced id is offered as an ACTION —
// "sweep my boards"-style requests map onto search.run, whose entity is the
// fixed workspace thread rather than a candidate-specific record. Every other
// phrasing (including anything that would need to resolve "my top role" to a
// real application id) previews as an ANSWER only; the free-text agent turn
// (runWorkspaceAgentTurn) is the one path that can safely interpret an
// arbitrary reference, since it answers in plain text rather than acting.
// ---------------------------------------------------------------------------

function firstHttpUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const candidate = match[0].replace(/[),.;!?\]}]+$/g, "");
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

function looksLikeJobUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (inferProvider({ careers_url: url.toString() })) return true;
    const platform = platformForHost(host);
    if (new Set(["linkedin", "wellfound"]).has(platform) && path.includes("/jobs/")) return true;
    return /\/(?:jobs?|careers?|positions?|openings?)\//.test(path) || /\/viewjob\b/.test(path);
  } catch {
    return false;
  }
}

function looksLikeCompanyDiscovery(text) {
  if (/\bcompany discovery\b/i.test(text)) return true;
  const match = String(text).match(
    /\b(?:find|discover|research|expand|refresh|look for)\b.{0,40}\bcompan(?:y|ies)\b/i
  );
  return Boolean(match && !/\b(?:jobs?|roles?|postings?|openings?)\b/i.test(match[0]));
}

function looksLikeBoardDiscovery(text) {
  if (/\b(?:job\s+)?board discovery\b/i.test(text)) return true;
  if (
    /\b(?:discover|research|add|expand)\b.{0,40}\b(?:job\s+)?(?:boards?|sources?)\b/i.test(text)
  ) {
    return true;
  }
  return /\b(?:find|look for)\b.{0,30}\b(?:more|new|additional|other|niche)\b.{0,30}\b(?:job\s+)?(?:boards?|sources?)\b/i.test(
    text
  );
}

function looksLikeSourceAdd(text) {
  return Boolean(
    firstHttpUrl(text) &&
      /\b(?:add|use|include|import|track)\b/i.test(text) &&
      /\b(?:job\s+)?(?:board|source)\b/i.test(text)
  );
}

function sourceQueryFromText(text) {
  const match = String(text || "").match(
    /\badd\s+(?:a\s+)?(?:new\s+)?(?:job\s+)?search\s+(?:source\s+)?(?:for|on)\s+(.+?)\s*[.?!]*$/i
  );
  return String(match?.[1] || "").trim() || null;
}

function sourceToggleFromText(text) {
  const match = String(text || "")
    .trim()
    .match(
      /^(?:please\s+)?(enable|disable)\s+(?:the\s+)?(.+?)\s+(?:(?:job\s+)?(?:board|source))\s*[.?!]*$/i
    );
  if (!match) return null;
  return {
    selector: String(match[2]).trim(),
    enabled: match[1].toLowerCase() === "enable",
  };
}

function looksLikeTailoringRequest(text) {
  const value = String(text || "");
  const document = /\b(?:resume|résumé|cover\s+letter|application\s+(?:materials|documents))\b/i;
  return (
    (/\b(?:tailor|customi[sz]e|rewrite|revise|adapt)\b/i.test(value) && document.test(value)) ||
    (/\b(?:write|draft|create)\b/i.test(value) && /\bcover\s+letter\b/i.test(value))
  );
}

function looksLikeApplicationPreparation(text) {
  const value = String(text || "");
  return (
    /\b(?:apply|submit)\b/i.test(value) ||
    /\b(?:prepare|build|generate)\b.{0,40}\b(?:the\s+)?application\b/i.test(value)
  );
}

function reportedOutcomeFromText(text) {
  const value = String(text || "").trim();
  let to = null;
  if (
    /\bi\s+(?:just\s+)?(?:got|was)\s+(?:rejected|declined)\b/i.test(value) ||
    /\bmy\s+application\s+(?:got|was)\s+(?:rejected|declined)\b/i.test(value) ||
    /\b(?:rejected|declined)\s+me\b/i.test(value)
  ) {
    to = "rejected";
  } else if (
    /\bi\s+(?:just\s+)?(?:got|received)\s+an?\s+offer\b/i.test(value) ||
    /\bmade\s+me\s+an?\s+offer\b/i.test(value)
  ) {
    to = "offer";
  } else if (/\bi\s+(?:just\s+)?withdrew\b|\bi\s+have\s+withdrawn\b/i.test(value)) {
    to = "withdrawn";
  } else if (
    /\bi\s+(?:just\s+)?(?:got|landed|have)\b.{0,50}\binterview\b/i.test(value) ||
    /\bi\s+was\s+invited\b.{0,50}\binterview\b/i.test(value)
  ) {
    to = "interview";
  } else if (/\bi(?:'m|\s+am)\s+(?:now\s+)?waiting\s+to\s+hear\s+back\b/i.test(value)) {
    to = "awaiting";
  }
  return to ? { to, note: value.slice(0, 120) } : null;
}

function looksLikeReportedApplication(text) {
  return /^\s*i\s+(?:just\s+)?(?:applied\b|submitted\s+(?:my\s+)?application\b)/i.test(
    String(text || "")
  );
}

function looksLikeInterviewPrep(text) {
  return (
    /\b(?:prepare|prep|get\s+ready)\b.{0,60}\binterview\b/i.test(String(text || "")) ||
    /\binterview\s+prep\b/i.test(String(text || ""))
  );
}

function communicationDraftRequestFromText(text) {
  const value = String(text || "").trim();
  const match = value.match(
    /^(?:(?:please\s+)?(?:can|could|would)\s+you\s+)?(?:draft|write|prepare)\s+(?:me\s+)?(?:a\s+)?(?:reply|response)\b(?:\s+to)?\s*(.*)$/i
  );
  if (!match) return null;
  const remainder = String(match[1] || "").trim();
  const split = remainder.match(/^(.*?)(?:\s+(?:saying|and\s+say|that\s+says?)\s+|:\s*)(.+)$/i);
  return {
    communicationReference: String(split?.[1] || remainder)
      .replace(/[.?!]+$/g, "")
      .trim(),
    instruction: String(split?.[2] || "").trim(),
  };
}

function communicationSentRequestFromText(text) {
  const value = String(text || "").trim();
  if (!/^i\s+(?:just\s+)?sent\s+/i.test(value)) return null;
  const communicationReference = value
    .replace(/^i\s+(?:just\s+)?sent\s+/i, "")
    .replace(/\s+(?:reply|response|message|email)[.?!]*$/i, "")
    .replace(/[.?!]+$/g, "")
    .trim();
  return { communicationReference };
}

// "add a note to/on the <ref> thread: <note>", "note on the <ref> thread:
// <note>", "log a note about <ref>: <note>". The leading verb is optional
// ("note on the Acme thread…" is valid on its own), tolerant of
// "thread"/"conversation" trailing the reference, and the note text can
// follow a colon or a comma + "saying". Anchored on the literal word "note"
// so it never shadows (or is shadowed by) the draft/sent matchers above,
// which require "draft/write/prepare … reply" or a leading "I sent".
function communicationNoteRequestFromText(text) {
  const value = String(text || "").trim();
  const match = value.match(
    /^(?:(?:please\s+)?(?:can|could|would)\s+you\s+)?((?:add|leave|log|jot\s+down|make)\s+)?a?\s*note\s+(?:to|on|about|for)\s+(?:the\s+)?(.+)$/i
  );
  if (!match) return null;
  const hasVerb = Boolean(match[1]);
  const remainder = String(match[2] || "").trim();
  // A verb-less "note to/on <x>" is ordinary chat ("Note to self: ...")
  // unless it names a thread or conversation explicitly.
  if (!hasVerb && !/\b(?:thread|conversation)\b/i.test(remainder)) return null;
  const split = remainder.match(
    /^(.*?)(?:\s+(?:saying|and\s+say|that\s+says?)\s+|,\s*saying\s+|:\s*)([\s\S]+)$/i
  );
  const reference = String(split ? split[1] : remainder)
    .replace(/\s+(?:thread|conversation)\s*$/i, "")
    .replace(/[.?!]+$/g, "")
    .trim();
  if (/^(?:self|myself|me|this)$/i.test(reference)) return null;
  const note = String(split?.[2] || "").trim();
  return { reference, note };
}

// "send my reply to <ref>", "send the <ref> reply", "send the reply to the
// <ref> thread", "help me send the <ref> email". Anchored on a leading
// send/help-me-send verb so it never matches communicationSentRequestFromText's
// past-tense "I sent …" self-report, or communicationDraftRequestFromText's
// "draft/write/prepare a reply" phrasing.
function communicationHandoffRequestFromText(text) {
  const value = String(text || "").trim();
  const lead = /^(?:(?:please\s+)?(?:can|could|would)\s+you\s+)?(?:help\s+me\s+)?send\s+/i;
  if (!lead.test(value)) return null;
  const remainder = value.replace(lead, "").trim();
  if (!remainder) return null;

  // "reply to <ref>" / "the reply to the <ref> thread" / "my reply to <ref>"
  let match = remainder.match(
    /^(?:me\s+)?(?:my\s+|the\s+)?(?:reply|response|email|message)\s+to\s+(?:the\s+)?(.+?)\s*(?:thread|conversation)?[.?!]*$/i
  );
  if (!match) {
    // "the <ref> reply" / "my <ref> email"
    match = remainder.match(
      /^(?:me\s+)?(?:the\s+|my\s+)?(.+?)\s+(?:reply|response|email|message)[.?!]*$/i
    );
  }
  if (!match) return null;
  const communicationReference = String(match[1] || "")
    .replace(/\s+(?:thread|conversation)\s*$/i, "")
    .replace(/[.?!]+$/g, "")
    .trim();
  return communicationReference ? { communicationReference } : null;
}

function schedulingRequestFromText(text) {
  const value = String(text || "").trim();
  const namesScheduling =
    /\b(?:availability|schedul(?:e|ing)|time\s+slots?|interview\s+times?|calendar\s+hold)\b/i.test(
      value
    );
  const acceptsDatedSlot =
    /\b(?:accept|confirm)(?:ing)?\b/i.test(value) &&
    /\b(?:recruiter|interview|call|meeting|slot)\b/i.test(value) &&
    (/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/i.test(
      value
    ) ||
      /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(value));
  if (!namesScheduling && !acceptsDatedSlot) {
    return null;
  }
  if (
    !/\b(?:accept|confirm|draft|handle|offer|plan|prepare|reply|respond|schedul(?:e|ing)|write)\b/i.test(
      value
    )
  ) {
    return null;
  }
  const reference = value.match(
    /\b(?:to|from)\s+(.+?)(?=\s+(?:with|about|for|regarding|saying|accepting|confirming|and\s+say)\b|[.?!]*$)/i
  )?.[1];
  return {
    communicationReference: String(reference || value)
      .replace(/[.?!]+$/g, "")
      .trim(),
    instruction: value,
  };
}

function screeningQuestionRequestFromText(text) {
  const value = String(text || "").trim();
  const patterns = [
    /^(?:(?:how\s+should\s+i|(?:can|could|would)\s+you|please)\s+)?(?:answer|respond\s+to)\s+(?:(?:this|these|the|an?)\s+)?(?:application|screening|form(?:[-\s]+form)?)\s+questions?\s*[:-]\s*([\s\S]+)$/i,
    /^what\s+should\s+i\s+say\s+(?:for|to)\s+(?:(?:this|these|the|an?)\s+)?(?:application|screening|form(?:[-\s]+form)?)\s+questions?\s*[:-]\s*([\s\S]+)$/i,
  ];
  for (const pattern of patterns) {
    const questionText = value.match(pattern)?.[1]?.trim();
    if (questionText) return { questionText };
  }
  return null;
}

// A captured "research <X>" tail that is itself about companies in the
// aggregate ("companies", "more companies", "new companies beyond my list")
// belongs to company.discover, not a single-company research request.
function looksLikeGenericCompanyDiscoveryPhrase(value) {
  return /^(?:more|new|additional|other|similar|matching)?\s*compan(?:y|ies)\b/i.test(
    String(value || "").trim()
  );
}

function looksLikeFuzzyCompanyReference(value) {
  return (
    /\b(?:role|job|position|posting)'?s\s+company\b/i.test(value) ||
    /^(?:this|that|the)\s+company\b/i.test(String(value || "").trim())
  );
}

function companyResearchRequestFromText(text) {
  const value = String(text || "").trim();
  // "research market comp for a nurse in Denver" etc. is a comp-research
  // request, not company research — this generic "^research (.+)$" match
  // below would otherwise swallow it before compResearchRequestFromText's
  // own ACTION_PREVIEW_RULES entry ever sees it.
  if (compResearchRequestFromText(value)) return null;
  let match =
    value.match(/^(?:please\s+)?research\s+(.+?)\s*[.?!]*$/i) ||
    value.match(/^(?:please\s+)?(?:dig into|look into)\s+(.+?)\s*[.?!]*$/i);
  if (!match) {
    match = value.match(
      /^what\s+should\s+i\s+know\s+about\s+(.+?)\s+before\s+(?:the|my|this)\s+interview\s*[.?!]*$/i
    );
    if (match) return { company: match[1].trim() };
    return null;
  }
  const captured = match[1].trim();
  if (!captured || looksLikeGenericCompanyDiscoveryPhrase(captured)) return null;
  if (/^(?:this|that|the)\s+company\b/i.test(captured)) return { thisCompany: true };
  if (looksLikeFuzzyCompanyReference(captured)) return { fuzzy: captured };
  return { company: captured };
}

// "market comp for a nurse in Denver" should benchmark "nurse", not "a
// nurse" — strip a leading article off the parsed role.
function stripLeadingArticle(text) {
  return String(text || "")
    .trim()
    .replace(/^(?:a|an|the)\s+/i, "");
}

function compResearchRequestFromText(text) {
  const value = String(text || "").trim();
  // Accept an optional leading "research " so "research market comp for a
  // nurse in Denver" routes here instead of being swallowed by
  // companyResearchRequestFromText's generic "^research (.+)$" match.
  const stripped = value.replace(/^(?:please\s+)?research\s+/i, "").trim();
  let match = stripped.match(/^market\s+comp\s+for\s+(.+?)\s+in\s+(.+?)\s*[.?!]*$/i);
  if (match) return { role: stripLeadingArticle(match[1]), location: match[2].trim() };
  match = stripped.match(/^what'?s\s+the\s+market\s+rate\s+for\s+(.+?)\s*[.?!]*$/i);
  if (match) return { role: stripLeadingArticle(match[1]) };
  // "what's market comp for X" / "what's the market comp for X" — the
  // question shape with no location clause. A bare "this/that/the
  // role/job/position" target resolves through the open job instead of a
  // literal role string (mirrors companyResearchRequestFromText's
  // thisCompany handling).
  match = stripped.match(
    /^(?:what'?s|what\s+is)\s+(?:the\s+)?market\s+comp\s+for\s+(.+?)\s*[.?!]*$/i
  );
  if (match) {
    const captured = match[1].trim();
    if (/^(?:this|that|the)\s+(?:role|job|position)\b/i.test(captured)) return { thisRole: true };
    return { role: stripLeadingArticle(captured) };
  }
  if (/^comp\s+benchmark\b/i.test(stripped)) return {};
  if (/\bsalary\s+research\b.*\b(?:this\s+)?(?:job|role)\b/i.test(stripped)) return {};
  // "what should/does/would this/that/the role/job/position pay/earn/make" —
  // pay-verb phrasing scoped to role/job/position vocabulary so it doesn't
  // over-trigger on unrelated "what should I pay for X" questions.
  //
  // Deliberately excludes "offer": a job offer covers PTO, growth, relocation
  // and start date, not just money, so "what does this job offer in terms of
  // career growth" is an ordinary question the user wants answered, not a comp
  // benchmark request. Hijacking normal Q&A is a worse failure than missing a
  // chip. "pay attention (to)" is excluded for the same reason.
  //
  // The tail is anchored rather than left open. Without it the prefix alone
  // matched regardless of what followed, so any sentence that merely started
  // this way was swallowed.
  //
  // The one trailing clause allowed is `in <somewhere>`, and it is CAPTURED,
  // not just tolerated. "what should this role pay in San Francisco?" carries a
  // location the user picked on purpose, usually because it differs from the
  // job's; matching and then dropping it would benchmark the job's own city and
  // hand back a confident wrong number, which is worse than not matching. The
  // executor already prefers an explicit input.location over the job row's, so
  // returning it here is all the override needs.
  //
  // Only `in`. "what would this position pay at a Series B" and "... for a
  // senior" are not locations, there is no executor field for them, and
  // silently discarding them is the same failure. They fall through to ordinary
  // chat, where the question can actually be answered.
  const payVerbMatch =
    /^what\s+(?:should|does|would)\s+(?:this|that|the)\s+(?:role|job|position)\s+(?:pay|earn|make)\b(?!\s+attention\b)(?:\s+in\s+([^?.!]{1,60}?))?\s*[.?!]*$/i.exec(
      stripped
    );
  if (payVerbMatch) {
    const location = (payVerbMatch[1] || "").trim();
    return location ? { thisRole: true, location } : { thisRole: true };
  }
  return null;
}

function companyHealthRequestFromText(text) {
  const value = String(text || "").trim();
  let match = value.match(/^is\s+(.+?)\s+a\s+safe\s+place\s+to\s+land\s*[.?!]*$/i);
  if (match) return { companyReference: match[1].trim() };
  match = value.match(/^how\s+(?:risky|stable|healthy)\s+is\s+(.+?)\s*[.?!]*$/i);
  if (match) return { companyReference: match[1].trim() };
  match = value.match(/^(?:are\s+there\s+any\s+|any\s+)?layoffs\s+at\s+(.+?)\s*[.?!]*$/i);
  if (match) return { companyReference: match[1].trim() };
  match = value.match(/^company\s+health\s+(?:for|on|at)\s+(.+?)\s*[.?!]*$/i);
  if (match) return { companyReference: match[1].trim() };
  return null;
}

// strategy.review phrasings — always targets the fixed workspace thread (no
// company/job/communication reference to resolve), so unlike research.company
// / company.health this normalizes straight to the executable intent, never a
// "-request" variant. Deliberately does NOT match a bare "research ..." lead-in
// (that belongs to companyResearchRequestFromText above).
function strategyReviewRequestFromText(text) {
  const value = String(text || "").trim();
  return (
    /\breview\s+my\s+(?:job[-\s]search\s+)?strategy\b/i.test(value) ||
    /\bstrategy\s+review\b/i.test(value) ||
    /\bwhat'?s\s+working\s+in\s+my\s+search\b/i.test(value) ||
    /\bwhy\s+am\s+i\s+getting\s+filtered(?:\s+out)?\b/i.test(value) ||
    /\bwhat\s+should\s+i\s+change\s+in\s+my\s+search\b/i.test(value) ||
    /\brun\s+a\s+strategy\s+review\b/i.test(value)
  );
}

// ---------------------------------------------------------------------------
// settings.explain / settings.apply phrasings — the free-text half of the
// Ask "configure" row. Anchored on words the terminal search.run catch-all
// below doesn't own (settings, mode, automation, consent, capability,
// polling, authenticated apply preparation, setup mode) — never the bare word "search",
// which is owned by the source/search intents above.
// ---------------------------------------------------------------------------

function settingsExplainFromText(text) {
  const value = String(text || "").trim();
  if (/^(?:please\s+)?what(?:\s+are)?\s+my\s+settings\s*[.?!]*$/i.test(value)) return {};
  if (/^(?:please\s+)?show\s+my\s+settings\s*[.?!]*$/i.test(value)) return {};
  if (/^(?:please\s+)?show\s+my\s+automation\s+permissions\s*[.?!]*$/i.test(value))
    return { domain: "automation" };
  if (/^what\s+automation\s+is\s+enabled\s*[.?!]*$/i.test(value)) return { domain: "automation" };
  if (/^what\s+mode\s+am\s+i\s+in\s*[.?!]*$/i.test(value)) return { domain: "modes" };
  return null;
}

// "$150k", "150000", "$150,000" → 150000. Returns null on anything that
// doesn't reduce to a finite non-negative number.
function parseSettingsCompAmount(text) {
  const match = String(text || "")
    .trim()
    .match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*$/i);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return match[2] ? n * 1000 : n;
}

// "set/change/raise/lower my comp floor|minimum|comp target|target comp|
// expected comp|expected base to <amount>" → one GATE_ROUTES comp type, with
// the raw (unparsed) value text so the caller can still detect a comp-leak
// phrase ("to match my current salary") before treating it as a number.
function settingsCompGateFromText(text) {
  const value = String(text || "").trim();
  const match = value.match(
    /^(?:please\s+)?(?:set|change|raise|lower)\s+my\s+(comp\s+floor|minimum|comp\s+target|target\s+comp|expected\s+comp|expected\s+base)\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (!match) return null;
  const noun = match[1].toLowerCase();
  const rawValue = match[2].trim();
  const type = /floor|minimum/.test(noun)
    ? "comp-floor"
    : /target/.test(noun)
      ? "comp-target"
      : "comp-expected";
  return { type, rawValue };
}

// "exclude <Company> from my search", "never claim <tool>", "add <x> as a
// cut/keep signal", "never fabricate <claim>" → one GATE_ROUTES signal type.
function settingsGateSignalFromText(text) {
  const value = String(text || "").trim();
  let match = value.match(/^(?:please\s+)?exclude\s+(.+?)\s+from\s+my\s+search\s*[.?!]*$/i);
  if (match) return { type: "exclude-company", rawValue: match[1].trim() };
  match = value.match(/^(?:please\s+)?never\s+claim\s+(.+?)\s*[.?!]*$/i);
  if (match) return { type: "do-not-claim", rawValue: match[1].trim() };
  match = value.match(/^(?:please\s+)?never\s+fabricate\s+(.+?)\s*[.?!]*$/i);
  if (match) return { type: "do-not-fabricate", rawValue: match[1].trim() };
  match = value.match(/^(?:please\s+)?add\s+(.+?)\s+as\s+a\s+cut\s+signal\s*[.?!]*$/i);
  if (match) return { type: "cut-signal", rawValue: match[1].trim() };
  match = value.match(/^(?:please\s+)?add\s+(.+?)\s+as\s+a\s+keep\s+signal\s*[.?!]*$/i);
  if (match) return { type: "keep-signal", rawValue: match[1].trim() };
  return null;
}

// "switch/set/change usage mode to <v>", "switch/set/change application mode
// to <v>".
function settingsModeFromText(text) {
  const value = String(text || "").trim();
  let match = value.match(
    /^(?:please\s+)?(?:switch|set|change)\s+(?:my\s+)?usage\s+mode\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (match) return { field: "usage_mode", value: match[1].trim().toLowerCase() };
  match = value.match(
    /^(?:please\s+)?(?:switch|set|change)\s+(?:my\s+)?application\s+mode\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (match) return { field: "application_mode", value: match[1].trim().toLowerCase() };
  return null;
}

function splitSettingsList(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/\s*(?:,|;|\band\b)\s*/i)
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ];
}

function settingsProfileFromText(text) {
  const value = String(text || "").trim();
  let match = value.match(
    /^(?:please\s+)?(?:add|include)\s+(.+?)\s+(?:to|in)\s+(?:my\s+)?(?:target roles|job targets|target titles)(?:\s*,?\s*(?:while\s+)?keeping\s+.+?)?\s*[.?!]*$/i
  );
  if (match) {
    const values = splitSettingsList(match[1]);
    return values.length ? { section: "targets", op: "append", values } : null;
  }
  match = value.match(
    /^(?:please\s+)?(?:set|change|update|replace)\s+(?:my\s+)?(?:target roles|job targets|target titles)\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (match) {
    const values = splitSettingsList(match[1]);
    return values.length ? { section: "targets", values } : null;
  }
  match = value.match(
    /^(?:please\s+)?(?:set|change|update)\s+(?:my\s+)?(?:home market|home location)\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (match) return { section: "home", value: match[1].trim() };
  match = value.match(
    /^(?:please\s+)?turn\s+(on|off)\s+(remote|hybrid|on[ -]?site)\s+roles\s*[.?!]*$/i
  );
  if (match) {
    return {
      section: "location-mode",
      field:
        match[2].toLowerCase().replace(/[ -]/g, "") === "onsite"
          ? "onsite"
          : match[2].toLowerCase(),
      value: match[1].toLowerCase() === "on",
    };
  }
  match = value.match(
    /^(?:please\s+)?(?:set|change|update)\s+(?:my\s+)?writing style\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (match) return { section: "writing-style", value: match[1].trim() };
  match = value.match(
    /^(?:please\s+)?(?:set|change|update)\s+(?:my\s+)?search cadence\s+to\s+(daily|every\s+3\s+days|weekly|manual)\s*[.?!]*$/i
  );
  if (match) {
    const cadence = match[1].toLowerCase();
    return {
      section: "search-cadence",
      value: cadence === "every 3 days" ? "every-3-days" : cadence,
    };
  }
  match = value.match(
    /^(?:please\s+)?(?:set|change|update)\s+(?:my\s+)?(?:minimum fit|fit floor)\s+to\s+(\d{1,3})\+?\s*[.?!]*$/i
  );
  if (match) return { section: "fit-floor", value: Number(match[1]) };
  match = value.match(
    /^(?:please\s+)?(?:set|change|update|replace)\s+(?:my\s+)?dealbreakers\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (match) {
    const values = splitSettingsList(match[1]);
    return values.length ? { section: "dealbreakers", values } : null;
  }
  match = value.match(
    /^(?:please\s+)?(?:set|change|update|replace)\s+(?:my\s+)?relocation markets\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (match) {
    const values = splitSettingsList(match[1]);
    return values.length ? { section: "relocation", values } : null;
  }
  match = value.match(
    /^(?:please\s+)?(?:set|change|update|replace)\s+(?:my\s+)?(?:positive fit signals|keep signals)\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (match) {
    const values = splitSettingsList(match[1]);
    return values.length ? { section: "keep-signals", values } : null;
  }
  return null;
}

// Human phrasings for a capability, mapped to the canonical CAPABILITIES key
// — used by the "turn on/off <capability> [on <platform>]" matcher below.
const AUTOMATION_CAPABILITY_PHRASES = {
  "status polling": "status_polling",
  "portal status polling": "status_polling",
  "authenticated search": "authenticated_search",
  "authenticated search scanning": "authenticated_search",
  messaging: "messaging",
  "in-platform messaging": "messaging",
  "authenticated apply preparation": "authenticated_apply_preparation",
  "apply preparation": "authenticated_apply_preparation",
  "profile optimize": "profile_optimize",
  "profile apply": "profile_apply",
  "mail access": "mail_access",
  "webmail access": "mail_access",
  "relationship sourcing": "relationship_sourcing",
  "calendar sync": "calendar_sync",
  "calendar read": "calendar_read",
};

function matchAutomationCapabilityPhrase(text) {
  const lower = String(text || "")
    .trim()
    .toLowerCase();
  for (const [phrase, key] of Object.entries(AUTOMATION_CAPABILITY_PHRASES)) {
    if (lower === phrase) return key;
  }
  return null;
}

function matchAutomationPlatformPhrase(text) {
  const lower = String(text || "")
    .trim()
    .toLowerCase();
  return PLATFORMS.find((platform) => lower === platform || lower === platform.replace(/_/g, " "));
}

// "turn off <capability> [on <platform>]" (any capability — disabling is
// always allowed), "turn on status polling / authenticated search [on
// <platform>]" (the ONLY capabilities allowed to enable from Ask — see the
// settings.apply handler's own capability-tier restriction, enforced there
// too since REST can call the intent directly), "set setup mode to
// advanced/basic", "use <provider> for browser sessions".
function settingsAutomationFromText(text) {
  const value = String(text || "").trim();

  let match = value.match(/^(?:please\s+)?set\s+setup\s+mode\s+to\s+(advanced|basic)\s*[.?!]*$/i);
  if (match) return { op: "setup_mode", value: match[1].toLowerCase() };

  match = value.match(/^(?:please\s+)?use\s+(.+?)\s+for\s+browser\s+sessions\s*[.?!]*$/i);
  if (match) {
    const provider = match[1].trim().toLowerCase();
    return Object.hasOwn(PROVIDERS, provider) ? { op: "session", value: provider } : null;
  }

  match = value.match(/^(?:please\s+)?turn\s+off\s+(.+?)(?:\s+on\s+(.+?))?\s*[.?!]*$/i);
  if (match) {
    const capability = matchAutomationCapabilityPhrase(match[1]);
    if (!capability) return null;
    return automationToggleChange(capability, match[2], false);
  }

  match = value.match(/^(?:please\s+)?turn\s+on\s+(.+?)(?:\s+on\s+(.+?))?\s*[.?!]*$/i);
  if (match) {
    const capability = matchAutomationCapabilityPhrase(match[1]);
    if (!capability || !new Set(["status_polling", "authenticated_search"]).has(capability))
      return null;
    return automationToggleChange(capability, match[2], true);
  }

  return null;
}

// Named a platform? It must be one this capability actually runs on (each
// capability has its own platform list in CAPABILITIES — status_polling is
// ATS portals, not linkedin). A platform phrase that doesn't fit the
// capability returns null so the user gets no chip (and falls through to
// chat) instead of a plausible-looking chip the handler is guaranteed to
// reject. No named platform means the capability-wide toggle.
function automationToggleChange(capability, platformPhrase, enabled) {
  if (!platformPhrase) return { op: "capability", capability, enabled };
  const platform = matchAutomationPlatformPhrase(platformPhrase);
  if (!platform || !CAPABILITIES[capability].platforms.includes(platform)) return null;
  return { op: "platform", capability, platform, enabled };
}

// Combines the four settings.apply sub-matchers above into one discriminated
// `change` object (or null when nothing matches). Runs the comp-leak
// backstop BEFORE parsing a comp gate's amount, so "raise my comp floor to
// match my current salary" never even reaches parseSettingsCompAmount.
function settingsApplyFromText(text) {
  const value = String(text || "").trim();

  const compGate = settingsCompGateFromText(value);
  if (compGate) {
    if (findCompLeak(value)) {
      return { kind: "gate", type: compGate.type, value: null, compReference: true };
    }
    const amount = parseSettingsCompAmount(compGate.rawValue);
    return amount === null ? null : { kind: "gate", type: compGate.type, value: amount };
  }

  const gateSignal = settingsGateSignalFromText(value);
  if (gateSignal) return { kind: "gate", type: gateSignal.type, value: gateSignal.rawValue };

  const mode = settingsModeFromText(value);
  if (mode) return { kind: "mode", field: mode.field, value: mode.value };

  const profile = settingsProfileFromText(value);
  if (profile) return { kind: "profile", ...profile };

  const automation = settingsAutomationFromText(value);
  if (automation) return { kind: "automation", ...automation };

  return null;
}

function formatSettingsUsd(amount) {
  return `$${Number(amount).toLocaleString("en-US")}`;
}

// Human-readable preview-chip label for a settings.apply change. Reuses
// GATE_APPLY_SUMMARIES formatting for the signal-append gate types (the same
// completed-tense sentence works fine as a preview here); comp/mode/
// automation changes get a present-tense action phrasing instead.
function settingsApplyPreviewLabel(change) {
  if (change.kind === "gate") {
    if (change.compReference) return "Update this comp setting";
    if (change.type === "comp-floor") return `Set comp floor to ${formatSettingsUsd(change.value)}`;
    if (change.type === "comp-target")
      return `Set comp target to ${formatSettingsUsd(change.value)}`;
    if (change.type === "comp-expected")
      return `Set expected comp to ${formatSettingsUsd(change.value)}`;
    if (change.type === "exclude-company") return `Exclude "${change.value}" from your search`;
    return GATE_APPLY_SUMMARIES[change.type]?.(change.value) || `Update ${change.type}`;
  }
  if (change.kind === "mode") {
    const label = change.field === "usage_mode" ? "usage mode" : "application mode";
    return `Set ${label} to ${change.value}`;
  }
  if (change.kind === "automation") {
    if (change.op === "setup_mode") return `Set automation setup mode to ${change.value}`;
    if (change.op === "session") return `Use ${change.value} for browser sessions`;
    const capabilityLabel = CAPABILITIES[change.capability]?.label || change.capability;
    const verb = change.enabled ? "Turn on" : "Turn off";
    return change.platform
      ? `${verb} ${capabilityLabel} on ${change.platform}`
      : `${verb} ${capabilityLabel}`;
  }
  if (change.kind === "profile") {
    if (change.section === "targets") {
      return change.op === "append"
        ? `Add target roles ${change.values.join(", ")}`
        : `Replace target roles with ${change.values.join(", ")}`;
    }
    if (change.section === "home") return `Set home market to ${change.value}`;
    if (change.section === "location-mode") {
      return `${change.value ? "Turn on" : "Turn off"} ${change.field} roles`;
    }
    if (change.section === "writing-style") return `Set writing style to ${change.value}`;
    if (change.section === "search-cadence") return `Set search cadence to ${change.value}`;
    if (change.section === "fit-floor") return `Set minimum fit to ${change.value}+`;
    if (change.section === "dealbreakers") {
      return `Replace dealbreakers with ${change.values.join(", ")}`;
    }
    if (change.section === "relocation") {
      return `Replace relocation markets with ${change.values.join(", ")}`;
    }
    if (change.section === "keep-signals") {
      return `Replace positive fit signals with ${change.values.join(", ")}`;
    }
  }
  return "Update this setting";
}

// "report a bug[: <desc>]", "file an issue[: <desc>]", "report an issue",
// "careerrat crashed[ ...]", "something went wrong with careerrat[ ...]",
// "careerrat/the app/this tool is broken". Every pattern is anchored on an
// explicit report/file verb or names careerrat/app/tool, so a bare "this is
// broken" (no product token) never matches — that's ordinary chat, not a bug
// report. Any trailing text becomes the free-text description.
function issueReportFromText(text) {
  const value = String(text || "").trim();
  const patterns = [
    /^(?:please\s+)?report\s+a\s+bug\b[:,]?\s*(.*)$/i,
    /^(?:please\s+)?file\s+an\s+issue\b[:,]?\s*(.*)$/i,
    /^(?:please\s+)?report\s+an\s+issue\b[:,]?\s*(.*)$/i,
    /^careerrat\s+(?:just\s+)?crashed\b[:,]?\s*(.*)$/i,
    /^something\s+went\s+wrong\s+with\s+careerrat\b[:,]?\s*(.*)$/i,
    /^careerrat\s+is\s+broken\b[:,]?\s*(.*)$/i,
    /^(?:the\s+)?app\s+is\s+broken\b[:,]?\s*(.*)$/i,
    /^this\s+tool\s+is\s+broken\b[:,]?\s*(.*)$/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return {
        description: String(match[1] || "")
          .replace(/^[.?!]+\s*/, "")
          .trim(),
      };
    }
  }
  return null;
}

function calendarWriteProviderFromText(value) {
  if (/\bgoogle\b/i.test(value)) return "google_calendar";
  if (/\boutlook\b/i.test(value)) return "outlook_calendar";
  if (/\bapple\b/i.test(value)) return "apple_calendar";
  return null;
}

// Grabs the object between the write verb and the "to/on/in(to) my ...
// calendar/google/outlook/apple" tail — e.g. "put the Acme interview on my
// calendar" -> "Acme interview". Pronoun-only fragments ("it", "that") and the
// generic nouns the regex itself anchors on are not company/role names, so
// those are dropped rather than surfaced as a bogus title.
function calendarWriteTitleFromText(value) {
  const match = value.match(
    /\b(?:added|put|created|entered|logged|synced)\s+(?:the\s+|an?\s+)?(.+?)\s+(?:to|on|in|into)\s+(?:my\s+)?(?:google|outlook|apple|calendar)\b/i
  );
  if (!match) return "";
  const fragment = match[1].trim().replace(/\s+/g, " ");
  if (!fragment || /^(?:it|that|this|them|event|calendar)$/i.test(fragment)) return "";
  return fragment.slice(0, 120);
}

// Past-tense self-reports of a calendar write the candidate already made in
// their own calendar app — "I added the interview to my Google calendar",
// "I put the Acme interview on my calendar", "added it to outlook", "I
// created the event in apple calendar". The write-verb requirement is what
// keeps read/query phrasings ("check my calendar", "what's on my calendar",
// "calendar sources") from ever matching — none of those contain a write verb.
// A phrasing with no provider name ("I added it to my calendar") still fires
// with provider null; the handler asks which calendar app rather than the
// matcher guessing.
function calendarRecordWriteFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  // This intent RECORDS a write the candidate already made themselves; it
  // never performs one. Forward-looking requests ("please put this on my
  // calendar", "can you add it") must not be offered a self-report chip, so
  // the verb needs a first-person past-tense anchor ("I added", "I put") or
  // an elliptical self-report opener ("added it to outlook"). Bare
  // imperatives ("put"/"create"/"enter"/"sync" without "I") never match.
  if (/\b(?:can|could|would|will)\s+you\b/i.test(value) || /^please\b/i.test(value)) return null;
  const firstPerson =
    /\bi(?:'ve)?\s+(?:already\s+|just\s+)?(?:added|put|created|entered|logged|synced)\b/i;
  const elliptical = /^(?:already\s+|just\s+)?(?:added|logged|synced)\b/i;
  if (!firstPerson.test(value) && !elliptical.test(value)) return null;
  if (!/\b(?:to|on|in|into)\b/i.test(value)) return null;
  const provider = calendarWriteProviderFromText(value);
  if (!provider && !/\bcalendar\b/i.test(value)) return null;
  const title = calendarWriteTitleFromText(value);
  return { provider, event: title ? { title } : {} };
}

function relationshipLeadTypeFromMatch(raw) {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (normalized === "hiring manager" || normalized === "decision maker") return "Decision maker";
  if (normalized === "recruiter") return "Recruiter";
  if (normalized === "referral") return "Referral";
  return "Contact";
}

// "found a recruiter at Acme, named Jordan Lee" / "add Jordan Lee as a
// recruiter at Acme" — a self-report of a contact the candidate already
// found, not a request for CareerRat to go find one. Returns null (rather
// than routing with a blank name) when a pattern matches but the name group
// comes back empty after trim, so it fails closed to other matchers/AI
// capture instead of ever recording an unnamed lead.
function relationshipRecordLeadFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;

  let match = value.match(
    /^(?:i\s+)?(?:just\s+)?found\s+(?:a\s+|an\s+)?(recruiter|hiring\s+manager|decision\s+maker|referral|contact)\s+at\s+(.+?)(?:\s+on\s+(linkedin|wellfound))?\s*[,:]?\s+named?\s+(.+?)\s*[.?!]*$/i
  );
  if (match) {
    const name = match[4].trim();
    if (!name) return null;
    return {
      input: {
        type: relationshipLeadTypeFromMatch(match[1]),
        company: match[2].trim(),
        platform: match[3] ? match[3].toLowerCase() : undefined,
        name,
      },
    };
  }

  match = value.match(
    /^add\s+(.+?)\s+as\s+(?:a\s+|an\s+)?(recruiter|hiring\s+manager|decision\s+maker|referral|contact)\s+at\s+(.+?)(?:\s+on\s+(linkedin|wellfound))?\s*[.?!]*$/i
  );
  if (match) {
    const name = match[1].trim();
    if (!name) return null;
    return {
      input: {
        name,
        type: relationshipLeadTypeFromMatch(match[2]),
        company: match[3].trim(),
        platform: match[4] ? match[4].toLowerCase() : undefined,
      },
    };
  }

  return null;
}

// "find a recruiter at Acme" / "who do I know at Acme" / "get me a warm
// intro to Acme" — a consent-checked request for the app-owned relationship
// sourcing controller.
function relationshipSourceRequestFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;

  let match = value.match(
    /^(?:please\s+)?(?:can\s+you\s+)?find\s+(?:me\s+)?(?:a\s+|an\s+)?(?:recruiter|hiring\s+manager|decision\s+maker|warm\s+(?:path|contact|intro)|contact|referral)\s+(?:at|for)\s+(.+?)\s*[.?!]*$/i
  );
  if (!match) {
    match = value.match(
      /^(?:please\s+)?who\s+(?:do\s+i\s+know|can\s+refer\s+me)\s+at\s+(.+?)\s*[.?!]*$/i
    );
  }
  if (!match) {
    match = value.match(
      /^(?:please\s+)?(?:get\s+(?:me\s+)?(?:a\s+)?)?warm\s+intro\s+(?:to|at|into)\s+(.+?)\s*[.?!]*$/i
    );
  }
  if (!match) return null;
  const company = match[1].trim();
  if (!company) return null;
  return { input: { company } };
}

// "Greenhouse says phone screen scheduled for Acme" / "the portal moved Acme
// to interview" — a self-report of a raw ATS-portal status label, not a
// request for CareerRat to go read the portal itself. Returns null (rather
// than routing with an empty capture) when a pattern matches but either
// group comes back empty after trim, so it fails closed to other
// matchers/AI capture instead of ever recording a blank status.
function statusRecordPortalFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;

  let match = value.match(
    /^(?:the\s+)?(greenhouse|workday|ashby|lever|portal)\s+(?:says|shows|lists)\s+['"“]?(.+?)['"”]?\s+for\s+(.+?)\s*[.?!]*$/i
  );
  if (match) {
    const rawStatus = match[2].trim();
    const jobReference = match[3].trim();
    if (!rawStatus || !jobReference) return null;
    return { input: { jobReference, rawStatus } };
  }

  match = value.match(
    /^(?:the\s+)?(greenhouse|workday|ashby|lever|portal)\s+moved\s+(.+?)\s+to\s+(.+?)\s*[.?!]*$/i
  );
  if (match) {
    const jobReference = match[2].trim();
    const rawStatus = match[3].trim();
    if (!rawStatus || !jobReference) return null;
    return { input: { jobReference, rawStatus } };
  }

  return null;
}

function statusConnectPortalFromText(text) {
  const value = String(text || "").trim();
  const url = firstHttpUrl(value);
  if (!url) return null;
  let match = value.match(/\b(?:status|application)\s+portal\s+for\s+(.+?)\s*[.?!]*$/i);
  if (!match) {
    match = value.match(/^(.+?)\s+(?:status|application)\s+portal\s+(?:is|=)\s+https?:\/\//i);
  }
  const jobReference = String(match?.[1] || "").trim();
  return jobReference ? { input: { jobReference, url } } : null;
}

// "check my application statuses" / "sync my portal status" — a
// consent-checked request for the app-owned status controller. Deliberately requires
// the word status/statuses so it never collides with the generic
// jobs/roles/postings/boards/sources vocabulary the terminal search.run
// catch-all owns.
function statusSyncRequestFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const match =
    /^(?:please\s+)?(?:can\s+you\s+)?(?:check|sync|refresh|update)\s+(?:my\s+)?(?:application|portal|ats|job)?\s*status(?:es)?\b(?:\s+(?:from|on)\s+(?:greenhouse|workday|ashby|lever))?\s*[.?!]*$/i.test(
      value
    );
  return match ? { input: {} } : null;
}

// "check my inbox" / "any new recruiter emails" — a consent-checked request
// for the app-owned mail controller. Anchored (^...$) like statusSyncRequestFromText
// so it never matches "email"/"mail" mentioned mid-sentence: drafting a
// reply, reporting a sent email, mail settings, or job/status vocabulary
// that happens to share the word "check".
function mailSyncRequestFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  // The qualifier loop between verb and noun accepts only mail-shaped filler
  // ("check for any new recruiter emails"); any other word there ("check my
  // email settings", "check my email for the Acme thread") breaks the match
  // and falls through.
  const match =
    /^(?:please\s+)?(?:can\s+you\s+)?(?:check|sync|scan|refresh)\s+(?:(?:for|my|any|new|recruiter)\s+)*(?:e-?mails?|inbox|mail(?:box)?)\s*[.?!]*$/i.test(
      value
    ) ||
    /^(?:any\s+)?new\s+(?:recruiter\s+)?(?:e-?mails?|mail)\s*[.?!]*$/i.test(value) ||
    /^(?:do\s+i\s+have|did\s+i\s+get|is\s+there|are\s+there)\s+(?:any\s+)?(?:new\s+)?(?:recruiter\s+)?(?:e-?mails?|mail)\s*[.?!]*$/i.test(
      value
    );
  return match ? { input: {} } : null;
}

// "check my messages" / "any new linkedin messages" — a consent-checked
// request for the app-owned messages controller. Anchored (^...$) like
// mailSyncRequestFromText so it never matches "message"/"dm" mentioned
// mid-sentence: sending a message, drafting a reply, messaging settings, or
// unrelated status/email checks that happen to share the word "check".
function messagesSyncRequestFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  // The qualifier loop between verb and noun accepts only messages-shaped
  // filler ("check for any new linkedin messages"); any other word there
  // ("check my message drafts", "check my application statuses") breaks the
  // match and falls through.
  const match =
    /^(?:please\s+)?(?:can\s+you\s+)?(?:check|sync|scan|refresh)\s+(?:(?:for|my|any|new|linkedin|wellfound|recruiter)\s+)*(?:messages?|dms?)\s*[.?!]*$/i.test(
      value
    ) ||
    /^(?:any\s+)?new\s+(?:(?:linkedin|wellfound|recruiter)\s+)*(?:messages?|dms?)\s*[.?!]*$/i.test(
      value
    ) ||
    /^(?:do\s+i\s+have|did\s+i\s+get|is\s+there|are\s+there)\s+(?:any\s+)?(?:new\s+)?(?:(?:linkedin|wellfound|recruiter)\s+)*(?:messages?|dms?)\s*[.?!]*$/i.test(
      value
    );
  return match ? { input: {} } : null;
}

// "optimize my linkedin" / "review my linkedin profile" / "make my linkedin
// profile read for staff roles" — a consent-checked request for the app-owned
// LinkedIn review controller. Anchored (^...$) and requires the literal token
// "linkedin" so it never matches "review my profile", "update my resume", or
// "review my search strategy" (which stays strategy.review), and the verb
// list (optimize/review/improve/update/polish) never overlaps
// "check"/"sync"/"scan"/"refresh", so "check my linkedin messages" still
// falls through to messagesSyncRequestFromText.
function linkedinOptimizeRequestFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const match =
    /^(?:please\s+)?(?:can\s+you\s+)?(?:optimize|review|improve|update|polish)\s+(?:my\s+)?linkedin(?:\s+profile)?\s*[.?!]*$/i.test(
      value
    ) || /^make\s+(?:my\s+)?linkedin(?:\s+profile)?\s+read\s+for\s+.{2,80}$/i.test(value);
  return match ? { input: {} } : null;
}

const ACTION_PREVIEW_RULES = [
  {
    test: (text) => Boolean(screeningQuestionRequestFromText(text)),
    label: "Draft an evidence-backed answer",
    intent: (text, context) => ({
      type: "screening.answer",
      entity: openJobId(context)
        ? { type: "application", id: openJobId(context) }
        : { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: screeningQuestionRequestFromText(text),
    }),
  },
  {
    test: looksLikeReportedApplication,
    label: "Record that I applied",
    intent: (text) => ({
      type: "application.record-external-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: text },
    }),
  },
  {
    test: (text) => Boolean(reportedOutcomeFromText(text)),
    label: (text) => `Record this application as ${reportedOutcomeFromText(text)?.to || "updated"}`,
    intent: (text) => ({
      type: "outcome.record-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: text, ...reportedOutcomeFromText(text) },
    }),
  },
  {
    test: (text) => Boolean(schedulingRequestFromText(text)),
    label: "Plan this interview scheduling reply",
    intent: (text) => ({
      type: "scheduling.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: schedulingRequestFromText(text),
    }),
  },
  {
    test: (text) => Boolean(communicationDraftRequestFromText(text)),
    label: "Draft this recruiter reply",
    intent: (text) => ({
      type: "communication.draft-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: communicationDraftRequestFromText(text),
    }),
  },
  {
    test: (text) => Boolean(communicationSentRequestFromText(text)),
    label: "Record that I sent this reply",
    intent: (text) => ({
      type: "communication.record-external-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: communicationSentRequestFromText(text),
    }),
  },
  {
    test: (text) => Boolean(communicationNoteRequestFromText(text)),
    label: "Add this note to the thread",
    intent: (text) => ({
      type: "communication.note-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: communicationNoteRequestFromText(text),
    }),
  },
  {
    test: (text) => Boolean(communicationHandoffRequestFromText(text)),
    label: "Prepare this reply to send",
    intent: (text) => ({
      type: "communication.handoff-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: communicationHandoffRequestFromText(text),
    }),
  },
  {
    test: (text, context) => Boolean(openJobId(context)) && looksLikeInterviewPrep(text),
    label: "Prepare this interview",
    intent: (_text, context) => ({
      type: "interview.prepare",
      entity: { type: "application", id: openJobId(context) },
    }),
  },
  {
    test: looksLikeInterviewPrep,
    label: "Prepare this interview",
    intent: (text) => ({
      type: "interview.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: text },
    }),
  },
  {
    test: looksLikeSourceAdd,
    label: "Add this job board",
    intent: (text) => ({
      type: "source.add",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { url: firstHttpUrl(text) },
    }),
  },
  {
    test: (text) => Boolean(sourceToggleFromText(text)),
    label: (text) =>
      sourceToggleFromText(text)?.enabled
        ? "Enable this search source"
        : "Disable this search source",
    intent: (text) => ({
      type: "source.set-enabled",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: sourceToggleFromText(text),
    }),
  },
  {
    test: (text) => Boolean(!firstHttpUrl(text) && sourceQueryFromText(text)),
    label: "Add a job search",
    intent: (text) => ({
      type: "source.query-add",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { query: sourceQueryFromText(text) },
    }),
  },
  {
    test: looksLikeBoardDiscovery,
    label: "Find and review new job boards",
    intent: (text) => ({
      type: "source.discover",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { request: text },
    }),
  },
  {
    test: (text) => Boolean(companyResearchRequestFromText(text)),
    label: "Research this company",
    intent: (text, context) => {
      const parsed = companyResearchRequestFromText(text);
      if (parsed.thisCompany) {
        return openJobId(context)
          ? {
              type: "research.company-request",
              entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
              input: { jobId: openJobId(context) },
            }
          : {
              type: "research.company-request",
              entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
              input: { companyReference: "" },
            };
      }
      if (parsed.fuzzy) {
        return {
          type: "research.company-request",
          entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
          input: { companyReference: parsed.fuzzy },
        };
      }
      return {
        type: "research.company",
        entity: { type: "company", id: slugifyCompany(parsed.company) },
        input: { company: parsed.company },
      };
    },
  },
  {
    test: (text) => Boolean(compResearchRequestFromText(text)),
    label: "Research market comp",
    intent: (text, context) => {
      const parsed = compResearchRequestFromText(text);
      if (parsed.thisRole) {
        // Bare "this role" reference — the executor already resolves
        // role/location from a plain jobId, so no new intent type is
        // needed. With no open job, fall through to {} so the existing
        // RESEARCH_COMP_INPUT_REQUIRED error path still applies on commit.
        //
        // A location the user named ("... pay in San Francisco") rides along
        // and wins: the executor fills location from the job row only when the
        // input didn't carry one.
        const jobId = openJobId(context);
        return {
          type: "research.comp",
          entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
          input: {
            ...(parsed.location ? { location: parsed.location } : {}),
            ...(jobId ? { jobId } : {}),
          },
        };
      }
      return {
        type: "research.comp",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: {
          ...parsed,
          ...(openJobId(context) ? { jobId: openJobId(context) } : {}),
        },
      };
    },
  },
  {
    test: (text) => Boolean(companyHealthRequestFromText(text)),
    label: "Check company health",
    intent: (text, context) => {
      const parsed = companyHealthRequestFromText(text);
      const isThisCompany = /^(?:this|that|the)\s+company\b/i.test(parsed.companyReference);
      if (isThisCompany && openJobId(context)) {
        return {
          type: "company.health-request",
          entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
          input: { jobId: openJobId(context) },
        };
      }
      return {
        type: "company.health-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { companyReference: parsed.companyReference },
      };
    },
  },
  {
    test: (text) => Boolean(strategyReviewRequestFromText(text)),
    label: "Review my search strategy",
    intent: () => ({
      type: "strategy.review",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    }),
  },
  {
    test: looksLikeCompanyDiscovery,
    label: "Discover more matching companies",
    intent: (text) => ({
      type: "company.discover",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { requestedCount: 12, request: text },
    }),
  },
  {
    test: (text) => {
      const jobUrl = firstHttpUrl(text);
      return looksLikeTailoringRequest(text) && Boolean(jobUrl) && looksLikeJobUrl(jobUrl);
    },
    label: "Evaluate and tailor this job",
    intent: (text) => ({
      type: "job.tailor-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl: firstHttpUrl(text) },
    }),
  },
  {
    test: (text) => {
      const jobUrl = firstHttpUrl(text);
      return looksLikeApplicationPreparation(text) && Boolean(jobUrl) && looksLikeJobUrl(jobUrl);
    },
    label: "Evaluate and prepare this application",
    intent: (text) => ({
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl: firstHttpUrl(text) },
    }),
  },
  {
    test: (text) => {
      const jobUrl = firstHttpUrl(text);
      return (
        /\b(rate|evaluate|review|assess)\b/i.test(text) &&
        Boolean(jobUrl) &&
        looksLikeJobUrl(jobUrl)
      );
    },
    label: "Capture and evaluate this job",
    intent: (text) => ({
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl: firstHttpUrl(text) },
    }),
  },
  {
    test: (text, context) =>
      Boolean(openJobId(context)) &&
      looksLikeApplicationPreparation(text) &&
      /\b(?:this|the)\s+(?:job|role|posting|application)\b/i.test(text),
    label: "Evaluate and prepare this saved job",
    intent: (_text, context) => ({
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobId: openJobId(context) },
    }),
  },
  {
    test: (text, context) =>
      Boolean(openJobId(context)) &&
      looksLikeTailoringRequest(text) &&
      /\b(?:this|the)\s+(?:job|role|posting)\b/i.test(text),
    label: "Evaluate and tailor this saved job",
    intent: (_text, context) => ({
      type: "job.tailor-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobId: openJobId(context) },
    }),
  },
  {
    test: (text, context) =>
      Boolean(openJobId(context)) &&
      /\b(rate|evaluate|review|assess)\b/i.test(text) &&
      (/\bevaluate\b/i.test(text) ||
        /\b(?:this|the|saved|current|exact)\s+(?:job|role|posting)\b/i.test(text)),
    label: "Evaluate this saved job",
    intent: (_text, context) => ({
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobId: openJobId(context) },
    }),
  },
  {
    test: (text) =>
      !firstHttpUrl(text) &&
      looksLikeApplicationPreparation(text) &&
      /\b(job|role|posting|opening|application)\b/i.test(text) &&
      jobReferenceTokens(text).length > 0,
    label: "Evaluate and prepare this saved job",
    intent: (text) => ({
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: text },
    }),
  },
  {
    test: (text) =>
      !firstHttpUrl(text) &&
      looksLikeTailoringRequest(text) &&
      /\b(job|role|posting|opening)\b/i.test(text) &&
      jobReferenceTokens(text).length > 0,
    label: "Evaluate and tailor this saved job",
    intent: (text) => ({
      type: "job.tailor-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: text },
    }),
  },
  {
    test: (text) =>
      !firstHttpUrl(text) &&
      /\b(rate|evaluate|review|assess)\b/i.test(text) &&
      /\b(job|role|posting|opening)\b/i.test(text) &&
      jobReferenceTokens(text).length > 0,
    label: "Evaluate this saved job",
    intent: (text) => ({
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: text },
    }),
  },
  {
    test: (text) => {
      const jobUrl = firstHttpUrl(text);
      return Boolean(jobUrl && text.trim() === jobUrl && looksLikeJobUrl(jobUrl));
    },
    label: "Capture and evaluate this job",
    intent: (text) => ({
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl: firstHttpUrl(text) },
    }),
  },
  // ORDERING REQUIREMENT: settings.explain / settings.apply / issue.report /
  // calendar.record-write / relationship.record-lead / relationship.source-request /
  // status.connect-portal-request / status.record-portal-request /
  // status.sync-request / mail.sync-request /
  // messages.sync-request / linkedin.optimize-request MUST stay above the
  // terminal search.run catch-all immediately below — that rule matches a
  // bare "check"/"search"/"find"/"run" verb near "jobs/roles/postings/boards/
  // sources" and would otherwise never let phrasings like "turn off status
  // polling", "check my settings", "report a bug", "I added the interview to
  // my calendar", "find a recruiter at Acme", "check my application
  // statuses", "check my inbox", "check my messages", or "optimize my
  // linkedin" reach these rules first.
  // relationship.record-lead MUST also stay above relationship.source-request:
  // both match "recruiter at <company>" vocabulary, but only record-lead's
  // patterns require a person's name, so the more specific self-report rule
  // has to win before the generic sourcing request rule gets a chance.
  // status.record-portal-request MUST stay above status.sync-request for the
  // same reason: both involve "check"/"status" vocabulary, but a future edit
  // to either regex could collide on those verbs, so the more specific
  // portal-label self-report has to win before the generic sync request gets
  // a chance.
  {
    test: (text) => Boolean(settingsExplainFromText(text)),
    label: "Show my settings",
    intent: (text) => ({
      type: "settings.explain",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: settingsExplainFromText(text),
    }),
  },
  {
    test: (text) => Boolean(settingsApplyFromText(text)),
    label: (text) => settingsApplyPreviewLabel(settingsApplyFromText(text)),
    intent: (text) => ({
      type: "settings.apply",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { change: settingsApplyFromText(text) },
    }),
  },
  {
    test: (text) => Boolean(issueReportFromText(text)),
    // Fixed label — the card shows the redacted report content, so the
    // description is never echoed into the preview chip itself.
    label: "Prepare a bug report",
    intent: (text) => ({
      type: "issue.report",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { description: issueReportFromText(text)?.description || "" },
    }),
  },
  {
    test: (text) => Boolean(calendarRecordWriteFromText(text)),
    // Never overpromise: this records the candidate's self-report, it does
    // not write anything to a calendar provider itself.
    label: "Record the calendar event you added",
    intent: (text) => ({
      type: "calendar.record-write",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: calendarRecordWriteFromText(text),
    }),
  },
  {
    test: (text) => Boolean(relationshipRecordLeadFromText(text)),
    label: "Record the contact you found",
    intent: (text) => ({
      type: "relationship.record-lead",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: relationshipRecordLeadFromText(text).input,
    }),
  },
  {
    test: (text) => Boolean(relationshipSourceRequestFromText(text)),
    label: "Request people sourcing",
    intent: (text) => ({
      type: "relationship.source-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: relationshipSourceRequestFromText(text).input,
    }),
  },
  {
    test: (text) => Boolean(statusConnectPortalFromText(text)),
    label: "Connect this status portal",
    intent: (text) => ({
      type: "status.connect-portal-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: statusConnectPortalFromText(text).input,
    }),
  },
  {
    test: (text) => Boolean(statusRecordPortalFromText(text)),
    label: "Record this portal status update",
    intent: (text) => ({
      type: "status.record-portal-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: statusRecordPortalFromText(text).input,
    }),
  },
  {
    test: (text) => Boolean(statusSyncRequestFromText(text)),
    label: "Check portal statuses",
    intent: (text) => ({
      type: "status.sync-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: statusSyncRequestFromText(text).input,
    }),
  },
  {
    test: (text) => Boolean(mailSyncRequestFromText(text)),
    label: "Check for new mail",
    intent: (text) => ({
      type: "mail.sync-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: mailSyncRequestFromText(text).input,
    }),
  },
  {
    test: (text) => Boolean(messagesSyncRequestFromText(text)),
    label: "Check for new messages",
    intent: (text) => ({
      type: "messages.sync-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: messagesSyncRequestFromText(text).input,
    }),
  },
  {
    test: (text) => Boolean(linkedinOptimizeRequestFromText(text)),
    label: "Optimize LinkedIn profile",
    intent: () => ({
      type: "linkedin.optimize-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {},
    }),
  },
  {
    test: (text) =>
      /\b(sweep|scan|run|check|refresh|search|find|look for)\b.{0,40}\b(jobs?|roles?|postings?|boards?|sources?)\b/i.test(
        text
      ),
    label: "Run a job search sweep",
    intent: () => ({
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose: "manual-search" },
    }),
  },
];

function openJobId(context) {
  if (context?.pathname !== "/jobs") return null;
  return String(context?.jobId || "").trim() || null;
}

function suppliedScreeningAnswerRequest({ repoRoot, env, text, context }) {
  const applicationId = openJobId(context);
  if (!applicationId) return null;
  let application;
  try {
    application = applicationForIntent({ repoRoot, env, id: applicationId });
  } catch (error) {
    if (error?.code === "NOT_FOUND") return null;
    throw error;
  }
  const matches = matchSuppliedScreeningAnswers({
    text,
    gaps: application.packetManifest?.gaps,
    confirmedAnswers: application.packetManifest?.confirmedAnswers,
  });
  return matches.length ? { applicationId, questionText: String(text || "").trim() } : null;
}

function canonicalJobContext({ repoRoot, env, context }) {
  const id = openJobId(context);
  if (!id) return null;
  const db = requireDb({ repoRoot, env });
  for (const [type, table] of [
    ["application", "applications"],
    ["sourced", "sourced"],
  ]) {
    const stored = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    if (!stored) continue;
    const row = JSON.parse(stored.data);
    return {
      type,
      id,
      company: String(row.company || "Unknown company"),
      role: String(row.role || row.title || "Unknown role"),
      status: String(row.status || type),
    };
  }
  return null;
}

function previewAnswerLabel(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
  return `Answer: “${preview}”`;
}

function isSearchStatusQuestion(text) {
  const value = String(text || "").trim();
  return (
    /^how(?:['’]?s|\s+is)\s+(?:(?:this|the|my|our)\s+)?(?:job\s+)?search\s+(?:going|doing|progressing)\s*[.?!]*$/i.test(
      value
    ) ||
    /^(?:is|are)\s+(?:(?:this|the|my|our)\s+)?(?:job\s+)?search\s+still\s+(?:going|running|searching)\s*[.?!]*$/i.test(
      value
    ) ||
    /^did\s+(?:(?:this|the|my|our)\s+)?(?:job\s+)?search\s+find\s+anything\s*[.?!]*$/i.test(
      value
    ) ||
    /^what(?:['’]?s|\s+is)\s+(?:happening|going\s+on)\s+with\s+(?:(?:this|the|my|our)\s+)?(?:job\s+)?search\s*[.?!]*$/i.test(
      value
    )
  );
}

function sourcingRunTime(state) {
  const run = state?.run || {};
  for (const value of [
    run.updatedAt,
    run.updated_at,
    run.startedAt,
    run.started_at,
    run.completedAt,
    run.completed_at,
  ]) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function latestDeterministicSearch({ repoRoot, env }) {
  const states = ["manual-search", "first-search"]
    .map((purpose) => sourcingRunLatest({ repoRoot, env, purpose }))
    .filter((state) => state?.run && state.run.status !== "not_started");
  const running = states.filter((state) => state.run.status === "running");
  return (running.length ? running : states).sort(
    (left, right) => sourcingRunTime(right) - sourcingRunTime(left)
  )[0];
}

function correlatedAiSearch(deterministic, ai) {
  if (!ai?.run || !deterministic?.run) return ai;
  const deterministicExecutionId = String(
    deterministic.run.metadata?.searchExecutionId || ""
  ).trim();
  const aiExecutionId = String(ai.run.metadata?.searchExecutionId || "").trim();
  return deterministicExecutionId && deterministicExecutionId !== aiExecutionId ? null : ai;
}

function countLabel(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function matchCountLabel(count, adjective = "") {
  const prefix = adjective ? `${adjective} ` : "";
  if (count === 0) return `no ${prefix}matches`;
  return `${count} ${prefix}${count === 1 ? "match" : "matches"}`;
}

function deterministicSearchStatusText(state) {
  const run = state?.run;
  if (!run) return "";
  if (run.status === "running") return "CareerRat is still searching your saved job sites.";
  if (run.status === "failed") {
    return "Your saved job-site search couldn't finish, so it needs another try.";
  }
  if (run.status !== "completed") return "";
  const summary = run.summary || {};
  const scanned = Number(summary.scanned);
  const matches = Number(summary.qualified ?? summary.presented ?? summary.new ?? 0);
  if (!Number.isFinite(scanned)) {
    return `Your saved job sites finished and found ${matchCountLabel(matches)}.`;
  }
  return `Your saved job sites finished. They scanned ${countLabel(scanned, "job")} and found ${matchCountLabel(matches)}.`;
}

function aiSearchStatusText(state) {
  const run = state?.run;
  if (!run) return "";
  if (run.status === "running") return "The AI search is still running.";
  if (run.status === "failed") return "The AI search couldn't finish, so it needs another try.";
  if (run.status !== "completed") return "";
  const summary = run.summary || {};
  const matches = Number(summary.new ?? summary.found ?? 0);
  return `The AI search finished and found ${matchCountLabel(matches, "new")}.`;
}

function currentSearchStatusText({ repoRoot, env }) {
  const deterministic = latestDeterministicSearch({ repoRoot, env });
  const ai = correlatedAiSearch(
    deterministic,
    sourcingRunLatest({ repoRoot, env, purpose: "ai-web-search" })
  );
  const parts = [deterministicSearchStatusText(deterministic), aiSearchStatusText(ai)].filter(
    Boolean
  );
  return parts.join(" ") || "No job search has run yet.";
}

// `text` is never persisted or sent anywhere here — this is pure
// classification against ACTION_PREVIEW_RULES above. `engineAvailable` lets
// the ask bar render the NO ENGINE receipt state up front (before a turn
// even runs) rather than only after a failed AI call.
export function previewWorkspaceIntent({ text, context, repoRoot, env = process.env } = {}) {
  const trimmed = String(text || "").trim();
  const engineAvailable = resolveAIRoute(env, { repoRoot }).type !== "none";
  if (!trimmed) {
    return { action: null, answer: { label: "Ask the workspace agent." }, engineAvailable };
  }
  const suppliedScreening = suppliedScreeningAnswerRequest({
    repoRoot,
    env,
    text: trimmed,
    context,
  });
  const rule = suppliedScreening
    ? null
    : ACTION_PREVIEW_RULES.find((candidate) => candidate.test(trimmed, context));
  const action = suppliedScreening
    ? {
        label: "Use these application answers",
        intent: {
          type: "screening.answer",
          entity: { type: "application", id: suppliedScreening.applicationId },
          input: { questionText: suppliedScreening.questionText },
        },
      }
    : rule
      ? {
          label: typeof rule.label === "function" ? rule.label(trimmed, context) : rule.label,
          intent: rule.intent(trimmed, context),
        }
      : null;
  return { action, answer: { label: previewAnswerLabel(trimmed) }, engineAvailable };
}

export async function runWorkspaceAgentTurn({
  repoRoot,
  env = process.env,
  text,
  context,
  choice,
  callAIImpl = callAI,
  signal,
  now = () => new Date(),
} = {}) {
  const jobContext = canonicalJobContext({ repoRoot, env, context });
  workspaceMessageAppend({
    repoRoot,
    env,
    role: "user",
    kind: "text",
    text,
    choice,
    ...(jobContext ? { metadata: { jobContext } } : {}),
    now,
  });
  if (isSearchStatusQuestion(text)) {
    workspaceMessageAppend({
      repoRoot,
      env,
      role: "assistant",
      kind: "text",
      text: currentSearchStatusText({ repoRoot, env }),
      metadata: { source: "search-status" },
      now,
    });
    return workspaceThreadRead({ repoRoot, env });
  }
  const history = workspaceThreadRead({ repoRoot, env });

  try {
    const response = await callAIImpl({
      root: repoRoot,
      env,
      system: buildWorkspaceAgentSystemPrompt({ repoRoot, env }),
      messages: history.messages.map(messageForModel),
      maxTokens: 2048,
      stream: false,
      feature: "workspace-agent",
      skill: "workspace-agent",
      action: "message",
      operation: "workspace:chat-turn",
      signal,
    });
    const parsedReply = parseChatAnswerMode(responseText(response));
    const reply = parsedReply.text;
    if (!reply) {
      const error = new Error("The selected AI runtime returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }
    workspaceMessageAppend({
      repoRoot,
      env,
      role: "assistant",
      kind: "text",
      text: reply,
      metadata: {
        ...(parsedReply.answerMode ? { answerMode: parsedReply.answerMode } : {}),
        model: response?.model || null,
        usage: response?.usage || null,
        engine: response?.engine || null,
        elapsedMs: response?.elapsedMs ?? null,
      },
      now,
    });
    return workspaceThreadRead({ repoRoot, env });
  } catch (error) {
    if (!error.code && /^no AI route configured:/i.test(String(error.message || ""))) {
      error.code = "NO_AI_ROUTE";
    }
    workspaceMessageAppend({
      repoRoot,
      env,
      role: "assistant",
      kind: "agent_error",
      text: String(error?.message || "The workspace agent could not answer."),
      error: {
        code: error?.code || "AGENT_FAILED",
        message: String(error?.message || "The workspace agent could not answer."),
      },
      now,
    });
    error.workspaceThreadId = WORKSPACE_THREAD_ID;
    throw error;
  }
}

export function createWorkspaceAgentRuntime({
  repoRoot,
  env = process.env,
  callAIImpl = callAI,
  buildInterviewDossierImpl = buildInterviewDossier,
  evaluateJobImpl = evaluateAndPersistPacketGate,
  resolveJobUrlImpl = resolveJobUrl,
  generateDocumentsImpl = generateApplicationPacket,
  exportDocumentsImpl = exportPacketArtifacts,
  packetExportArtifact,
  startFirstSearchImpl = startFirstSearchRun,
  startManualSearchImpl = startManualSearchRun,
  createCompanyProposalsImpl = createCompanyProposalBatch,
  decideCompanyProposalImpl = applyCompanyProposalDecision,
  getCompanyProposalBatchImpl = companyProposalBatchGet,
  companyDiscoveryCadenceImpl = companyDiscoveryCadenceState,
  addBoardSourceImpl,
  addSearchSourceQueryImpl,
  setSearchSourceEnabledImpl,
  startBoardDiscoveryImpl,
  startCompanyResearchImpl,
  startCompResearchImpl,
  startCompanyHealthImpl,
  runMailSyncImpl,
  runWebmailSyncImpl,
  runMessagesSyncImpl,
  runRelationshipSourcingImpl,
  runLinkedinOptimizeImpl,
  runStatusSyncImpl,
  runSearchInBackgroundImpl = runFirstSearchInBackground,
  searchFetchImpl = fetch,
  applyJobImpl,
  captureQuestionsImpl = capturePacketQuestions,
  answerScreeningQuestionsImpl = draftOneOffScreeningAnswers,
  saveScreeningAnswerImpl = saveOneOffScreeningAnswer,
  draftStrategyReviewImpl = draftStrategyReview,
  applyStrategyRecommendationImpl = applyStrategyRecommendation,
  stampStrategyReviewImpl = stampStrategyReview,
  captureIntakeImpl,
  sendCommunicationImpl,
} = {}) {
  let tail = Promise.resolve();
  let runtime;
  const sourcingWorkers = new Map();

  function enqueue(operation) {
    const current = tail.then(operation, operation);
    tail = current.then(
      () => undefined,
      () => undefined
    );
    return current;
  }

  function startSearchInBackground({ operation, run }) {
    if (operation?.reused === true || run?.status !== "running" || !run?.id) return;
    if (sourcingWorkers.has(run.id)) return;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() =>
        runSearchInBackgroundImpl({
          repoRoot,
          env,
          fetchImpl: searchFetchImpl,
          runId: run.id,
          signal: controller.signal,
        })
      )
      .then((terminalRun) => runtime.recordSearchCompletion({ run: terminalRun }))
      .catch((error) => {
        let terminalRun;
        try {
          terminalRun = sourcingRunFail({
            repoRoot,
            env,
            id: run.id,
            error: {
              code: error?.code || "SOURCING_SCAN_FAILED",
              message: error?.message || "The search stopped before it finished.",
            },
          }).run;
        } catch {
          return undefined;
        }
        return runtime.recordSearchCompletion({ run: terminalRun });
      })
      .finally(() => sourcingWorkers.delete(run.id));
    sourcingWorkers.set(run.id, { controller, promise });
  }

  function reconcileOrphanedSourcingRuns() {
    for (const purpose of ["first-search", "manual-search"]) {
      try {
        const run = sourcingRunLatest({ repoRoot, env, purpose }).run;
        if (run?.status !== "running" || sourcingWorkers.has(run.id)) continue;
        sourcingRunFail({
          repoRoot,
          env,
          id: run.id,
          error: {
            code: "SOURCING_RUN_SERVER_RESTARTED",
            message: "CareerRat restarted before this search finished. Start it again to continue.",
          },
        });
      } catch {
        // A workspace without a database has no durable sourcing runs to recover.
      }
    }
  }

  runtime = {
    startsSearchInBackground: true,
    ownsSourcingRun(runId) {
      return sourcingWorkers.has(runId);
    },
    async shutdownSourcingWorkers() {
      const stopped = new Error("CareerRat stopped this search because the app closed.");
      stopped.code = "SOURCING_RUN_SERVER_STOPPED";
      for (const { controller } of sourcingWorkers.values()) controller.abort(stopped);
      await Promise.allSettled([...sourcingWorkers.values()].map(({ promise }) => promise));
    },
    runTurn(input = {}) {
      return enqueue(() => runWorkspaceAgentTurn({ repoRoot, env, callAIImpl, ...input }));
    },
    executeIntent(input = {}) {
      return enqueue(() =>
        executeWorkspaceIntent({
          repoRoot,
          env,
          buildInterviewDossierImpl,
          evaluateJobImpl,
          resolveJobUrlImpl,
          generateDocumentsImpl,
          exportDocumentsImpl,
          packetExportArtifact,
          startFirstSearchImpl,
          startManualSearchImpl,
          createCompanyProposalsImpl,
          decideCompanyProposalImpl,
          getCompanyProposalBatchImpl,
          companyDiscoveryCadenceImpl,
          addBoardSourceImpl,
          addSearchSourceQueryImpl,
          setSearchSourceEnabledImpl,
          startBoardDiscoveryImpl,
          startCompanyResearchImpl,
          startCompResearchImpl,
          startCompanyHealthImpl,
          runMailSyncImpl,
          runWebmailSyncImpl,
          runMessagesSyncImpl,
          runRelationshipSourcingImpl,
          runLinkedinOptimizeImpl,
          runStatusSyncImpl,
          onSearchStarted: startSearchInBackground,
          searchFetchImpl,
          applyJobImpl,
          captureQuestionsImpl,
          answerScreeningQuestionsImpl,
          saveScreeningAnswerImpl,
          draftStrategyReviewImpl,
          applyStrategyRecommendationImpl,
          stampStrategyReviewImpl,
          callAIImpl,
          sendCommunicationImpl,
          ...input,
        })
      );
    },
    recordSearchCompletion(input = {}) {
      return enqueue(() => recordWorkspaceSearchCompletion({ repoRoot, env, ...input }));
    },
    recordSearchStart(input = {}) {
      return enqueue(() => recordWorkspaceSearchStart({ repoRoot, env, ...input }));
    },
    captureIntake(input = {}) {
      return enqueue(() => captureWorkspaceIntake({ repoRoot, env, captureIntakeImpl, ...input }));
    },
  };
  reconcileOrphanedSourcingRuns();
  return runtime;
}
