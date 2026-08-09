import { callAI, resolveAIRoute } from "../ai/call-ai.mjs";
import { TRACK_OUTCOME_STATUSES } from "../ai/track-outcome-bounded.mjs";
import { requireDb } from "../db/connection.mjs";
import { appCaptureInterviewIntake, appScheduleInterview, appSetStatus } from "../db/verbs/app.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import {
  commAppendMessage,
  commCaptureInbound,
  commMarkSent,
  commSetDraft,
} from "../db/verbs/comm.mjs";
import { intakeOne } from "../db/verbs/intake.mjs";
import { sourcedPromote, sourcedSetStatus } from "../db/verbs/sourced.mjs";
import { buildInterviewDossier } from "../interview/dossier.mjs";
import { startFirstSearchRun, startManualSearchRun } from "../onboarding/first-search-run.mjs";
import { evaluateAndPersistPacketGate } from "../packet/evaluate.mjs";
import { exportPacketArtifacts } from "../packet/exports.mjs";
import { generateApplicationPacket } from "../packet/generate-operation.mjs";
import {
  normalizeWorkspaceIntent,
  WORKSPACE_THREAD_ID,
  workspaceIntentAppend,
  workspaceMessageAppend,
  workspaceThreadRead,
} from "./workspace-thread.mjs";

const EXECUTABLE_INTENTS = new Set([
  "interview.prepare",
  "interview.schedule",
  "interview.capture-context",
  "job.evaluate",
  "job.generate-documents",
  "job.export-documents",
  "search.run",
  "sourced.promote",
  "sourced.skip",
  "application.record-external",
  "job.apply",
  "communication.draft",
  "communication.send",
  "communication.add-note",
  "communication.record-external",
  "communication.capture-inbound",
  "outcome.record",
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
    targeting: {
      role_buckets: config.targeting?.role_buckets || [],
      keep_signals: config.targeting?.keep_signals || [],
      cut_signals: config.targeting?.cut_signals || [],
      tracked_companies: config.targeting?.tracked_companies || [],
      excluded_companies: config.targeting?.excluded_companies || [],
    },
    evidence: config.evidence?.claims || [],
    honesty: config.honesty || {},
    applications,
  };
}

export function buildWorkspaceAgentSystemPrompt({ repoRoot, env = process.env } = {}) {
  const snapshot = compactCandidateSnapshot({ repoRoot, env });
  return [
    "You are Rolester, the one durable career-search workspace agent for this candidate.",
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
    content = `[Action completed: ${message.artifacts?.map((artifact) => artifact.title || artifact.kind).join(", ") || "completed"}] ${content}${draftContext}${evaluationContext}${packetContext}${packetExportContext}${searchContext}`;
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
  generateDocumentsImpl = generateApplicationPacket,
  exportDocumentsImpl = exportPacketArtifacts,
  packetExportArtifact,
  startFirstSearchImpl = startFirstSearchRun,
  startManualSearchImpl = startManualSearchRun,
  searchFetchImpl,
  applyJobImpl,
  callAIImpl = callAI,
  sendCommunicationImpl,
  now = () => new Date(),
} = {}) {
  const normalized = normalizeWorkspaceIntent(intent);
  if (!EXECUTABLE_INTENTS.has(normalized.type)) throw unsupported(normalized.type);

  const intentMessage = workspaceIntentAppend({ repoRoot, env, intent: normalized, now });
  try {
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
      const application = applicationForIntent({ repoRoot, env, id: normalized.entity.id });
      const body = { applicationId: normalized.entity.id };
      if (input.jobBody) body.jobBody = String(input.jobBody);
      if (input.jobUrl) body.jobUrl = String(input.jobUrl);
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
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Evaluated ${applicationLabel(application)}: ${gateLabel}${evaluation.fitScore == null ? "" : ` (${evaluation.fitScore}/100 fit)`}.`,
        artifacts: [
          {
            kind: "job_evaluation",
            title: `${applicationLabel(application)} — ${gateLabel}`,
            applicationId: normalized.entity.id,
            evaluation,
          },
        ],
        metadata: {
          state: gate,
          fitScore: evaluation.fitScore ?? null,
          manualRequired: Boolean(evaluation.manual?.required),
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
      const operation = await generateDocumentsImpl({
        repoRoot,
        env,
        body: {
          applicationId: normalized.entity.id,
          applyIntent: input.applyIntent === true,
          formats: formats.length ? formats : ["pdf"],
        },
      });
      const gaps = Array.isArray(operation.gaps) ? operation.gaps : [];
      const gapText = gaps.length
        ? `${gaps.length} item${gaps.length === 1 ? "" : "s"} needs review before the packet is submission-ready.`
        : "No review gaps remain.";
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Generated documents for ${applicationLabel(application)}. ${gapText}`,
        artifacts: [
          {
            kind: "packet_generation",
            title: `${applicationLabel(application)} — Documents`,
            applicationId: normalized.entity.id,
            status: operation.status || "reviewable",
            uploadReady: Boolean(operation.uploadReady),
            artifacts: operation.artifacts || {},
            gaps,
          },
        ],
        metadata: {
          state: operation.status || "reviewable",
          uploadReady: Boolean(operation.uploadReady),
          gapCount: gaps.length,
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
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: searchResultText({ ...run, purpose: run.purpose || purpose }),
        artifacts: [artifact],
        metadata: {
          state: artifact.status,
          purpose: artifact.purpose,
          searchRunId: artifact.runId,
          searchTerminal: ["completed", "failed"].includes(artifact.status),
          reused: artifact.reused,
          parked: artifact.parked,
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
        text: `Recorded that you sent the response for ${communicationLabel(communication)} outside Rolester.`,
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
        note: "Applied outside Rolester — reported by user.",
        appliedAt,
      });
      return appendActionResult({
        repoRoot,
        env,
        normalized,
        intentMessage,
        text: `Recorded that you applied outside Rolester: ${applicationLabel(application)}.`,
        metadata: {
          state: "recorded",
          recordingMode: "external_report",
          submissionVerified: false,
          appliedAt,
        },
        now,
      });
    }

    if (typeof applyJobImpl !== "function") {
      throw actionError(
        "The authenticated Apply on site executor is not connected, so this application was not marked Applied.",
        "APPLICATION_EXECUTOR_UNAVAILABLE"
      );
    }
    const execution = await applyJobImpl({
      repoRoot,
      env,
      applicationId: normalized.entity.id,
      application,
      postingUrl: application.link || application.url || application.sourceUrl || null,
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
  captureIntakeImpl,
  now = () => new Date(),
} = {}) {
  const rawText = String(text || "");
  if (!rawText.trim()) throw actionError("Intake text is required.", "EMPTY_INTAKE");
  if (inputKind !== undefined && inputKind !== "text" && inputKind !== "url") {
    throw actionError('Intake kind must be "text" or "url".', "BAD_INTAKE_KIND");
  }

  const intakeMessage = workspaceMessageAppend({
    repoRoot,
    env,
    role: "user",
    kind: "intake",
    text: rawText,
    metadata: { inputKind: inputKind || "auto" },
    now,
  });

  try {
    if (typeof captureIntakeImpl !== "function") {
      throw actionError(
        "The intake capture service is not connected. Your paste remains saved in this conversation.",
        "INTAKE_EXECUTOR_UNAVAILABLE"
      );
    }
    const item = await captureIntakeImpl({ repoRoot, env, text: rawText, inputKind });
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

const ACTION_PREVIEW_RULES = [
  {
    test: /\b(sweep|scan|run|check|refresh|search|find|look for)\b.{0,40}\b(jobs?|roles?|postings?|boards?|sources?)\b/i,
    label: "Run a job search sweep",
    intent: () => ({
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose: "manual-search" },
    }),
  },
];

function previewAnswerLabel(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
  return `Answer: “${preview}”`;
}

// `text` is never persisted or sent anywhere here — this is pure
// classification against ACTION_PREVIEW_RULES above. `engineAvailable` lets
// the ask bar render the NO ENGINE receipt state up front (before a turn
// even runs) rather than only after a failed AI call.
export function previewWorkspaceIntent({ text, repoRoot, env = process.env } = {}) {
  const trimmed = String(text || "").trim();
  const engineAvailable = resolveAIRoute(env, { repoRoot }).type !== "none";
  if (!trimmed) {
    return { action: null, answer: { label: "Ask the workspace agent." }, engineAvailable };
  }
  const rule = ACTION_PREVIEW_RULES.find((candidate) => candidate.test.test(trimmed));
  const action = rule ? { label: rule.label, intent: rule.intent() } : null;
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
  generateDocumentsImpl = generateApplicationPacket,
  exportDocumentsImpl = exportPacketArtifacts,
  packetExportArtifact,
  startFirstSearchImpl = startFirstSearchRun,
  startManualSearchImpl = startManualSearchRun,
  searchFetchImpl = fetch,
  applyJobImpl,
  captureIntakeImpl,
  sendCommunicationImpl,
} = {}) {
  let tail = Promise.resolve();

  function enqueue(operation) {
    const current = tail.then(operation, operation);
    tail = current.then(
      () => undefined,
      () => undefined
    );
    return current;
  }

  return {
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
          generateDocumentsImpl,
          exportDocumentsImpl,
          packetExportArtifact,
          startFirstSearchImpl,
          startManualSearchImpl,
          searchFetchImpl,
          applyJobImpl,
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
}
