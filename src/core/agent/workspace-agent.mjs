import { closeSync, openSync, readSync } from "node:fs";

import { callAI, resolveAIRoute } from "../ai/call-ai.mjs";
import { TRACK_OUTCOME_STATUSES } from "../ai/track-outcome-bounded.mjs";
import { buildQuestionsRequest } from "../apply/form-questions.mjs";
import {
  automationStatus,
  CAPABILITIES,
  CAPABILITY_KEYS,
  isCapability,
  loadAutomation,
  mergeAutomationDefaults,
  PLATFORMS,
} from "../automation/consent.mjs";
import { PROVIDERS } from "../automation/session.mjs";
import { buildSendLinks, resolveRecipient } from "../comms/recipient.mjs";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { activityAppend } from "../db/verbs/activity.mjs";
import {
  appCaptureInterviewIntake,
  appScheduleInterview,
  appSetFields,
  appSetStatus,
} from "../db/verbs/app.mjs";
import { candidateConfigGet, candidateConfigPatch } from "../db/verbs/candidate.mjs";
import {
  commAppendMessage,
  commCaptureInbound,
  commMarkSent,
  commSetDraft,
} from "../db/verbs/comm.mjs";
import { companyProposalBatchGet } from "../db/verbs/company-discovery.mjs";
import { companyHealthSet } from "../db/verbs/company-health.mjs";
import { intakeOne } from "../db/verbs/intake.mjs";
import { sourcedPromote, sourcedSetStatus, sourcedUpsertBatch } from "../db/verbs/sourced.mjs";
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
import { generateApplicationPacket } from "../packet/generate-operation.mjs";
import {
  draftOneOffScreeningAnswers,
  saveOneOffScreeningAnswer,
} from "../packet/one-off-answer.mjs";
import { capturePacketQuestions } from "../packet/questions.mjs";
import { userPath } from "../paths/workspace.mjs";
import { findCompLeak, findCurrentBaseToken } from "../profile/comp-guard.mjs";
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
import {
  normalizeWorkspaceIntent,
  WORKSPACE_THREAD_ID,
  workspaceIntentAppend,
  workspaceMessageAppend,
  workspaceThreadRead,
} from "./workspace-thread.mjs";

const EXECUTABLE_INTENTS = new Set([
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
  "strategy.review",
  "strategy.apply",
  "strategy.stamp",
  "settings.explain",
  "settings.apply",
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

export function buildWorkspaceAgentSystemPrompt({ repoRoot, env = process.env } = {}) {
  const snapshot = compactCandidateSnapshot({ repoRoot, env });
  return [
    "You are CareerRat, the one durable career-search workspace agent for this candidate.",
    "Continue the same relationship across onboarding, Ask, and every contextual button result.",
    "Use the complete conversation supplied with this turn and the canonical candidate snapshot below.",
    "Never invent candidate facts, job facts, completed actions, or evidence. If information is missing, say so plainly.",
    "Do not claim a product action ran merely because the user asked; deterministic app actions report their own completion in this conversation.",
    "Answer directly in clear plain text. Do not expose internal database ids unless the user asks for them.",
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
    const searchContext = search
      ? `\n[Job search state: ${JSON.stringify(search).slice(0, 8_000)}]`
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

function actionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function applicationForIntent({ repoRoot, env, id }) {
  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(String(id));
  if (!row) throw actionError(`Application not found: ${id}`, "NOT_FOUND");
  return JSON.parse(row.data);
}

function communicationForIntent({ repoRoot, env, id }) {
  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM communications WHERE id = ?").get(String(id));
  if (!row) throw actionError(`Communication not found: ${id}`, "NOT_FOUND");
  return JSON.parse(row.data);
}

function sourcedForIntent({ repoRoot, env, id }) {
  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM sourced WHERE id = ?").get(String(id));
  if (!row) throw actionError(`Sourced role not found: ${id}`, "NOT_FOUND");
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
  if (!item) throw actionError(`Intake item not found: ${intakeId}`, "NOT_FOUND");
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
  const matches = [...applications, ...sourced].filter((row) => {
    const candidateTokens = new Set(jobReferenceTokens(`${row.company || ""} ${row.role || ""}`));
    return tokens.every((token) => candidateTokens.has(token));
  });
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
    const choices = safeMatches.map((row) => `${row.company} — ${row.role}`).join("; ");
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
    const choices = safeMatches.map((row) => `${row.company} — ${row.role}`).join("; ");
    const error = actionError(
      `That matches more than one saved job: ${choices}. Name the company and role more specifically.`,
      "JOB_REFERENCE_AMBIGUOUS"
    );
    error.details = { matches: safeMatches };
    throw error;
  }
  return matches[0];
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
      .map((row) => `${row.company} — ${row.role} — ${row.subject}`)
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
      title: `${applicationLabel(application)} — ${gateLabel}`,
      applicationId,
      evaluation,
    },
  };
}

function evaluationNextActions(gate, applicationId) {
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
  return [
    {
      label: gate === "cut" ? "Review why this was cut" : "Review this job",
      href: `/jobs?open=${encodeURIComponent(applicationId)}`,
    },
  ];
}

const QUESTION_CAPTURE_DEFERRED = "QUESTION_CAPTURE_DEFERRED";

function isQuestionCaptureGap(gap) {
  return (
    String(gap?.kind || "").toLowerCase() === "answers" &&
    String(gap?.code || "").toUpperCase() === QUESTION_CAPTURE_DEFERRED
  );
}

function blockingPacketGaps(gaps) {
  return gaps.filter((gap) => !isQuestionCaptureGap(gap));
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
  };
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
    const answerableCount = Array.isArray(capture?.questions) ? capture.questions.length : 0;
    const excludedCount = Array.isArray(capture?.excluded) ? capture.excluded.length : 0;
    if (answerableCount + excludedCount === 0) {
      return siteRequiredQuestionCapture({ attempted: true });
    }
    return {
      state: "captured",
      source: String(capture?.source || request.provider),
      answerableCount,
      excludedCount,
      demographicSectionPresent: capture?.demographicSectionPresent === true,
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
    title: `${applicationLabel(application)} — Application site`,
    applicationId,
    url,
    submissionVerified: false,
    executorAvailable,
    ...(questionCapture ? { questionCapture } : {}),
  };
}

function packetNextActions(gaps, applicationId, hasHandoff, executorAvailable = false) {
  const blockingGaps = gaps.filter((gap) => !isQuestionCaptureGap(gap));
  if (blockingGaps.length === 0 && hasHandoff) {
    if (executorAvailable) {
      return [
        {
          label: "Start supervised apply",
          intent: {
            type: "job.apply",
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
    {
      label: "Review application",
      href: `/jobs?open=${encodeURIComponent(applicationId)}`,
    },
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
    {
      label: "Review documents",
      href: `/jobs?open=${encodeURIComponent(applicationId)}`,
    },
  ];
}

function packetGapText(gaps, questionCaptureDeferred, { tailoring = false } = {}) {
  const blockingCount = blockingPacketGaps(gaps).length;
  const questionsPending = questionCaptureDeferred || gaps.some(isQuestionCaptureGap);
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
  return `${app.company || "this company"} — ${app.role || "this role"}`;
}

function communicationLabel(comm) {
  return [comm.company, comm.role, comm.subject].filter(Boolean).join(" — ") || "this thread";
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
  const titlePrefix = purpose === "first-search" ? "First job search" : "Job search";
  return {
    kind: "search_run",
    title: `${titlePrefix} — ${searchStatusLabel(run)}`,
    purpose,
    runId: run?.id ? String(run.id) : null,
    status: String(run?.status || "not_started"),
    reused: Boolean(reused),
    parked: Boolean(parked),
    sources: sources && typeof sources === "object" ? JSON.parse(JSON.stringify(sources)) : null,
    summary: compactSearchSummary(run?.summary),
    error: compactSearchError(run?.error),
  };
}

function searchResultText(run) {
  if (run?.status === "failed") {
    return `The job search stopped: ${run.error?.message || "the search could not be completed."}`;
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
  return { label: "Review the current job search", href: "/jobs?tab=search" };
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

export function recordWorkspaceSearchStart({
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

export async function executeWorkspaceIntent({
  repoRoot,
  env = process.env,
  intent,
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
  onSearchStarted,
  searchFetchImpl,
  applyJobImpl,
  captureQuestionsImpl = capturePacketQuestions,
  answerScreeningQuestionsImpl = draftOneOffScreeningAnswers,
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
              ? `${operation.company || "Application"} — Screening answers`
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
          ...(reusableAnswers.length
            ? {
                nextActions: reusableAnswers.map((answer) => ({
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
                })),
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
      if (!item) throw actionError(`Intake item not found: ${normalized.entity.id}`, "NOT_FOUND");
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
            title: [company, role, subject].filter(Boolean).join(" — ") || "Recruiter message",
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
      if (!item) throw actionError(`Intake item not found: ${normalized.entity.id}`, "NOT_FOUND");
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
            title: [match.company, match.role].filter(Boolean).join(" — ") || "Interview context",
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
        text: `Prepared the interview packet for ${operation.company} — ${operation.role}.`,
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
            {
              label: "Open dossier",
              href: `/jobs?dossier=${encodeURIComponent(normalized.entity.id)}`,
            },
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
            nextActions: evaluationNextActions(evaluated.gate, captured.applicationId),
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
        title: `${applicationLabel(evaluated.application)} — Documents`,
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
          nextActions: evaluationNextActions(evaluated.gate, normalized.entity.id),
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
            title: `${applicationLabel(application)} — Documents`,
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
            title: `${applicationLabel(application)} — Exported files`,
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
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: added
          ? `Added ${label} to your search sources.${
              authPending
                ? " It stays off until you enable browser access for this provider."
                : " It is enabled for future searches."
            }`
          : `${label} is already in your search sources. Nothing changed.`,
        artifacts: [
          {
            kind: "search_source",
            title: `${label} — ${added ? "Added" : "Already configured"}`,
            added,
            index: source.index ?? null,
            provider: source.provider || null,
            label,
            target: source.target || url,
            sourceType: source.sourceType || source.source_type || null,
            enabled,
            auth: source.auth === true,
          },
        ],
        metadata: {
          state: added ? "added" : "existing",
          nextActions: [
            { label: "Search jobs", href: "/jobs?tab=search" },
            { label: "Manage sources", href: "/settings" },
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
            title: `${label} — ${added ? "Added" : "Already configured"}`,
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
            { label: "Search jobs", href: "/jobs?tab=search" },
            { label: "Manage sources", href: "/settings" },
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
            title: `${label} — ${stateLabel}`,
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
            { label: "Search jobs", href: "/jobs?tab=search" },
            { label: "Manage sources", href: "/settings" },
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
            { label: "Search jobs", href: "/jobs?tab=search" },
            { label: "Manage sources", href: "/settings" },
          ],
        },
        operationResult: operation,
        now,
      });
    }

    if (normalized.type === "company.discover") {
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
                : `Comp benchmark — ${artifact.role}${artifact.location ? ` (${artifact.location})` : ""}`,
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
                { label: "Open in Jobs", href: `/jobs?open=${encodeURIComponent(row.id)}` },
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
        { skill: "company-health", title: `Company health — ${company}` }
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
            { label: "Open in Jobs", href: `/jobs?open=${encodeURIComponent(row.id)}` },
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
            ? `${draft.headline} The AI reviewer wasn't available, so this is the deterministic read — review it, then finish the review.`
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
        const enabling = change.enabled === true || change.value === true;
        if ((op === "capability" || op === "platform") && enabling) {
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
          const value = change.enabled === true;
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
          const value = change.enabled === true;
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
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: remaining
          ? `${decisionText} ${remaining} compan${remaining === 1 ? "y still needs" : "ies still need"} review.`
          : `${decisionText} All company proposals are reviewed.`,
        artifacts: [artifact],
        metadata: {
          state: remaining ? "needs-review" : "complete",
          proposalCount: remaining,
          decision: action,
          ...(remaining
            ? {}
            : {
                nextActions: [
                  returnToCurrentSearch ? currentSearchAction() : searchExpandedCompaniesAction(),
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
          : await startManualSearchImpl({ repoRoot, env, fetchImpl: searchFetchImpl });
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
          if (cadence?.status === "needs-review" && cadence.batchId) {
            const batch = getCompanyProposalBatchImpl({
              repoRoot,
              env,
              batchId: cadence.batchId,
            })?.batch;
            if (batch) {
              companyArtifact = companyProposalArtifact(batch, {
                trigger: { kind: "search-run", id: artifact.runId },
              });
            }
          } else if (cadence?.due === true) {
            const trigger = { kind: "search-run", id: artifact.runId };
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
        companyReviewCount
          ? `Company discovery also found ${companyReviewCount} compan${companyReviewCount === 1 ? "y" : "ies"}; ${companyReviewCount === 1 ? "it needs" : "they need"} review.`
          : null,
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
            title: `${applicationLabel(application)} — ${round}`,
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
            {
              label: "Review job and reply",
              href: `/jobs?open=${encodeURIComponent(application.id)}`,
            },
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
        text: `Noted on ${company} — ${role}.`,
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
      // the private current_base figure never leaves, and an unfinished draft
      // with placeholder brackets goes back for editing instead of out.
      const leak = findCurrentBaseToken(`${subject}\n${body}`);
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
        note: "Applied outside CareerRat — reported by user.",
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
            title: `${applicationLabel(application)} — Application link needed`,
            applicationId: normalized.entity.id,
            code: "APPLICATION_URL_REQUIRED",
          },
        ],
        metadata: {
          state: "needs-input",
          applicationId: normalized.entity.id,
          submissionVerified: false,
        },
        now,
      });
    }

    let questionCapture = null;

    if (input.resumeSession !== true) {
      const evaluated = await evaluateApplicationRequest({
        repoRoot,
        env,
        applicationId: normalized.entity.id,
        evaluateJobImpl,
      });
      if (evaluated.gate !== "keep") {
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
            nextActions: evaluationNextActions(evaluated.gate, normalized.entity.id),
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
              title: `${applicationLabel(application)} — Documents`,
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
              {
                label: "Review application",
                href: `/jobs?open=${encodeURIComponent(normalized.entity.id)}`,
              },
            ],
          },
          operationResult: { ...packet, gaps },
          now,
        });
      }
      application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      questionCapture = questionCaptureFromApplication(application) || questionCapture;
    } else {
      questionCapture = await prepareApplicationQuestions({
        repoRoot,
        env,
        application,
        applicationId: normalized.entity.id,
        captureQuestionsImpl,
        fetchImpl: searchFetchImpl,
      });
    }

    if (typeof applyJobImpl !== "function") {
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `CareerRat prepared the handoff for ${applicationLabel(application)}. ${questionCaptureText(questionCapture, application)} CareerRat couldn't connect to a supervised browser, so open the posting to submit it; this application was not marked Applied.`,
        artifacts: [
          {
            kind: "application_handoff",
            title: `${applicationLabel(application)} — Application site`,
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
    let execution = await applyJobImpl({
      repoRoot,
      env,
      applicationId: normalized.entity.id,
      application,
      postingUrl,
      questionCapture,
      input,
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
              title: `${applicationLabel(application)} — Documents`,
              applicationId: normalized.entity.id,
              status: packet.status || "reviewable",
              uploadReady: Boolean(packet.uploadReady),
              artifacts: packet.artifacts || {},
              gaps,
              blockingGapCount,
            },
            {
              kind: "application_handoff",
              title: `${applicationLabel(application)} — Supervised application`,
              applicationId: normalized.entity.id,
              ...(sessionUrl ? { url: sessionUrl } : {}),
              submissionVerified: false,
              questionCapture,
              executorAvailable: true,
              session: execution.session || { provider: "session-browser" },
            },
          ],
          metadata: {
            state: "needs-input",
            applicationId: normalized.entity.id,
            submissionVerified: false,
            uploadReady: Boolean(packet.uploadReady),
            gapCount: gaps.length,
            blockingGapCount,
            nextActions: [
              {
                label: "Review application",
                href: `/jobs?open=${encodeURIComponent(normalized.entity.id)}`,
              },
              {
                label: "Resume supervised apply",
                intent: {
                  type: "job.apply",
                  entity: { type: "application", id: normalized.entity.id },
                  input: { resumeSession: true },
                },
              },
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
        input: { ...input, resumeSession: true, renderedQuestionsReady: true },
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
                title: `${applicationLabel(application)} — Application site`,
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
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: applicationSessionText(execution),
        artifacts: [
          {
            kind: "application_handoff",
            title: `${applicationLabel(application)} — Supervised application`,
            applicationId: normalized.entity.id,
            ...(sessionUrl ? { url: sessionUrl } : {}),
            submissionVerified: false,
            questionCapture,
            executorAvailable: true,
            session: execution.session || { provider: "session-browser" },
          },
        ],
        metadata: {
          state: execution.state,
          applicationId: normalized.entity.id,
          submissionVerified: false,
          nextActions: [
            {
              label: "Rescan and verify",
              intent: {
                type: "job.apply",
                entity: { type: "application", id: normalized.entity.id },
                input: { resumeSession: true },
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
    if (execution?.verified !== true) {
      const detail = String(
        execution?.reason || "No verified submission confirmation was returned."
      );
      throw actionError(
        `${detail} The application was not marked Applied.`,
        "APPLICATION_NOT_VERIFIED"
      );
    }

    const appliedAt = resolvedDate(execution.submittedAt, now);
    appSetStatus({
      repoRoot,
      env,
      id: normalized.entity.id,
      to: "applied",
      note: "Applied on site — submission verified.",
      appliedAt,
    });
    const confirmation = execution.confirmation
      ? String(execution.confirmation)
      : "Verified submission confirmation";
    return appendActionResult({
      repoRoot,
      env,
      normalized,
      intentMessage,
      text: `Submitted and verified the application for ${applicationLabel(application)}.`,
      artifacts: Array.isArray(execution.artifacts) ? execution.artifacts : undefined,
      metadata: {
        state: "submitted",
        submissionVerified: true,
        appliedAt,
        confirmation,
      },
      now,
    });
  } catch (error) {
    workspaceMessageAppend({
      repoRoot,
      env,
      role: "assistant",
      kind: "action_error",
      text: String(error?.message || "The action could not be completed."),
      entity: normalized.entity,
      error: {
        code: error?.code || "ACTION_FAILED",
        message: String(error?.message || "The action could not be completed."),
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
    /^(?:(?:how\s+should\s+i|(?:can|could|would)\s+you|please)\s+)?(?:answer|respond\s+to)\s+(?:(?:this|the|an?)\s+)?(?:application|screening|form(?:[-\s]+form)?)\s+questions?\s*[:-]\s*([\s\S]+)$/i,
    /^what\s+should\s+i\s+say\s+(?:for|to)\s+(?:(?:this|the|an?)\s+)?(?:application|screening|form(?:[-\s]+form)?)\s+questions?\s*[:-]\s*([\s\S]+)$/i,
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
  if (/^comp\s+benchmark\b/i.test(stripped)) return {};
  if (/\bsalary\s+research\b.*\b(?:this\s+)?(?:job|role)\b/i.test(stripped)) return {};
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
// polling, one-click apply, setup mode) — never the bare word "search",
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

// Human phrasings for a capability, mapped to the canonical CAPABILITIES key
// — used by the "turn on/off <capability> [on <platform>]" matcher below.
const AUTOMATION_CAPABILITY_PHRASES = {
  "status polling": "status_polling",
  "portal status polling": "status_polling",
  "authenticated search": "authenticated_search",
  "authenticated search scanning": "authenticated_search",
  messaging: "messaging",
  "in-platform messaging": "messaging",
  "one-click apply": "one_click_apply",
  "one click apply": "one_click_apply",
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
  return "Update this setting";
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
    intent: (text, context) => ({
      type: "research.comp",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        ...compResearchRequestFromText(text),
        ...(openJobId(context) ? { jobId: openJobId(context) } : {}),
      },
    }),
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
      /\b(?:this|the)\s+(?:job|role|posting)\b/i.test(text),
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
      /\b(?:this|the)\s+(?:job|role|posting)\b/i.test(text),
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
  // ORDERING REQUIREMENT: settings.explain / settings.apply MUST stay above
  // the terminal search.run catch-all immediately below — that rule matches
  // a bare "check"/"search"/"find"/"run" verb near "jobs/roles/postings/
  // boards/sources" and would otherwise never let phrasings like "turn off
  // status polling" or "check my settings" reach these rules first.
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

function previewAnswerLabel(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
  return `Answer: “${preview}”`;
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
  const rule = ACTION_PREVIEW_RULES.find((candidate) => candidate.test(trimmed, context));
  const action = rule
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
  callAIImpl = callAI,
  signal,
  now = () => new Date(),
} = {}) {
  workspaceMessageAppend({ repoRoot, env, role: "user", kind: "text", text, now });
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
    const reply = responseText(response);
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
    void Promise.resolve()
      .then(() =>
        runSearchInBackgroundImpl({
          repoRoot,
          env,
          fetchImpl: searchFetchImpl,
          runId: run.id,
        })
      )
      .then((terminalRun) => runtime.recordSearchCompletion({ run: terminalRun }))
      .catch(() => {});
  }

  runtime = {
    startsSearchInBackground: true,
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
  return runtime;
}
