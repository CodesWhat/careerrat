import { closeSync, openSync, readSync } from "node:fs";

import { callAI, resolveAIRoute } from "../ai/call-ai.mjs";
import { TRACK_OUTCOME_STATUSES } from "../ai/track-outcome-bounded.mjs";
import { buildQuestionsRequest } from "../apply/form-questions.mjs";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import {
  appCaptureInterviewIntake,
  appScheduleInterview,
  appSetFields,
  appSetStatus,
} from "../db/verbs/app.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import {
  commAppendMessage,
  commCaptureInbound,
  commMarkSent,
  commSetDraft,
} from "../db/verbs/comm.mjs";
import { companyProposalBatchGet } from "../db/verbs/company-discovery.mjs";
import { intakeOne } from "../db/verbs/intake.mjs";
import { sourcedPromote, sourcedSetStatus, sourcedUpsertBatch } from "../db/verbs/sourced.mjs";
import { companyDiscoveryCadenceState } from "../discovery/company-discovery-cadence.mjs";
import { applyCompanyProposalDecision } from "../discovery/company-proposal-decisions.mjs";
import { createCompanyProposalBatch } from "../discovery/company-proposals.mjs";
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
import { capturePacketQuestions } from "../packet/questions.mjs";
import { userPath } from "../paths/workspace.mjs";
import { platformForHost } from "../providers/search-sources.mjs";
import { planSchedulingReply } from "../scheduling/plan.mjs";
import {
  offersWithCapturedJobs,
  sourcedRowsFromScanOffers,
} from "../scoring/sourced-persistence.mjs";
import { inferProvider } from "../scoring/sourced-scanner.mjs";
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
  "job.apply",
  "communication.draft",
  "communication.draft-request",
  "communication.send",
  "communication.add-note",
  "communication.record-external",
  "communication.record-external-request",
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
    content = `[Action completed: ${message.artifacts?.map((artifact) => artifact.title || artifact.kind).join(", ") || "completed"}] ${content}${draftContext}${evaluationContext}${packetContext}${packetExportContext}${searchContext}${companyContext}${sourceContext}${schedulingContext}`;
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
            : "communication.record-external",
      entity: { type: "communication", id: communication.id },
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

function questionCaptureText(questionCapture) {
  if (!questionCapture) return "";
  if (questionCapture.state === "captured") {
    const count = questionCapture.answerableCount;
    return `Captured ${count} application question${count === 1 ? "" : "s"} before generating the packet.`;
  }
  return "Open the site, then paste the questions here so CareerRat can rebuild the answers.";
}

function applicationHandoffArtifact(application, applicationId, questionCapture) {
  const url = safeExternalHttpUrl(application.link || application.url || application.sourceUrl);
  if (!url) return null;
  return {
    kind: "application_handoff",
    title: `${applicationLabel(application)} — Application site`,
    applicationId,
    url,
    submissionVerified: false,
    ...(questionCapture ? { questionCapture } : {}),
  };
}

function packetNextActions(gaps, applicationId, hasHandoff) {
  const blockingGaps = gaps.filter((gap) => !isQuestionCaptureGap(gap));
  if (blockingGaps.length === 0 && hasHandoff) {
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
  onSearchStarted,
  searchFetchImpl,
  applyJobImpl,
  captureQuestionsImpl = capturePacketQuestions,
  prepareSchedulingPlanImpl = planSchedulingReply,
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
      const gaps = Array.isArray(packet.gaps) ? packet.gaps : [];
      const blockingGapCount = blockingPacketGaps(gaps).length;
      const handoffArtifact =
        applyIntent && blockingGapCount === 0
          ? applicationHandoffArtifact(
              evaluated.application,
              captured.applicationId,
              questionCapture
            )
          : null;
      const packetArtifact = {
        kind: "packet_generation",
        title: `${applicationLabel(evaluated.application)} — Documents`,
        applicationId: captured.applicationId,
        status: packet.status || "reviewable",
        uploadReady: Boolean(packet.uploadReady),
        artifacts: packet.artifacts || {},
        gaps,
        blockingGapCount,
      };
      const nextActions = applyIntent
        ? packetNextActions(gaps, captured.applicationId, Boolean(handoffArtifact))
        : tailoredPacketNextActions(captured.applicationId);
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `${evaluated.text} ${questionCaptureText(questionCapture)} Generated the ${
          applyIntent ? "application" : "tailored application"
        } packet. ${packetGapText(gaps, questionCaptureDeferred, { tailoring: !applyIntent })}`,
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
        operationResult: packet,
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
      const gaps = Array.isArray(operation.gaps) ? operation.gaps : [];
      const blockingGapCount = blockingPacketGaps(gaps).length;
      const handoffArtifact =
        blockingGapCount === 0
          ? applicationHandoffArtifact(application, normalized.entity.id, questionCapture)
          : null;
      const gapText = packetGapText(gaps, questionCaptureDeferred);
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `${questionCaptureText(questionCapture)} Generated documents for ${applicationLabel(application)}. ${gapText}`.trim(),
        artifacts: [
          {
            kind: "packet_generation",
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
          nextActions: packetNextActions(gaps, normalized.entity.id, Boolean(handoffArtifact)),
        },
        operationResult: operation,
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
      commMarkSent({
        repoRoot,
        env,
        id: normalized.entity.id,
        at: sentAt,
        summary: execution.summary,
      });
      const confirmation = execution.confirmation
        ? String(execution.confirmation)
        : "Verified delivery confirmation";
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
      const summary = String(input.summary || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!summary) {
        throw actionError("Enter a note before saving it.", "EMPTY_COMMUNICATION_NOTE");
      }
      const at = resolvedCommunicationDate(input.at, now);
      const operation = commAppendMessage({
        repoRoot,
        env,
        id: normalized.entity.id,
        message: { direction: "note", summary: summary.slice(0, 200), at },
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Added a note to ${communicationLabel(communication)}.`,
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
      const operation = commMarkSent({
        repoRoot,
        env,
        id: normalized.entity.id,
        at: sentAt,
        summary: input.summary,
        verification: "user_report",
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

    const application = applicationForIntent({
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

    const questionCapture = await prepareApplicationQuestions({
      repoRoot,
      env,
      application,
      applicationId: normalized.entity.id,
      captureQuestionsImpl,
      fetchImpl: searchFetchImpl,
    });

    if (typeof applyJobImpl !== "function") {
      const postingUrl = safeExternalHttpUrl(
        application.link || application.url || application.sourceUrl
      );
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `CareerRat prepared the handoff for ${applicationLabel(application)}. ${questionCaptureText(questionCapture)} The authenticated submission executor is not connected, so open the posting to submit it; this application was not marked Applied.`,
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
    const execution = await applyJobImpl({
      repoRoot,
      env,
      applicationId: normalized.entity.id,
      application,
      postingUrl: application.link || application.url || application.sourceUrl || null,
      questionCapture,
      input,
    });
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

const ACTION_PREVIEW_RULES = [
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
      return /\b(apply|submit)\b/i.test(text) && Boolean(jobUrl) && looksLikeJobUrl(jobUrl);
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
      /\b(apply|submit)\b/i.test(text) &&
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
      /\b(apply|submit)\b/i.test(text) &&
      /\b(job|role|posting|opening)\b/i.test(text) &&
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
  runSearchInBackgroundImpl = runFirstSearchInBackground,
  searchFetchImpl = fetch,
  applyJobImpl,
  captureQuestionsImpl = capturePacketQuestions,
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
          onSearchStarted: startSearchInBackground,
          searchFetchImpl,
          applyJobImpl,
          captureQuestionsImpl,
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
