import { safeExternalHttpUrl } from "../lib/safeExternalUrl.js";
import { buildMissionPayload, resolveComposerCommit } from "./chat-first-controller.js";

function list(value) {
  return Array.isArray(value) ? value : [];
}

function firstCalendarExport(groups) {
  return list(groups)
    .flatMap((group) => list(group?.items))
    .find((item) => item?.export)?.export;
}

export function engineUnavailable(state) {
  if (state?.providerFallback === true) return false;
  const selectedId = String(state?.selectedId || "").trim();
  if (!selectedId) return true;
  const selected = list(state?.runtimes).find((runtime) => runtime?.id === selectedId);
  return selected?.ready !== true;
}

export function isEngineFailure(error) {
  const code = String(error?.body?.code || error?.code || "").toUpperCase();
  if (/AI|ENGINE|RUNTIME|MODEL|PROVIDER/.test(code)) return true;
  return [402, 501, 502, 503, 504].includes(Number(error?.status));
}

export function calendarAction(label, groups, options = {}) {
  const exportData = firstCalendarExport(groups);
  if (!exportData) return false;

  if (label === "Google" || label === "Outlook") {
    const value = label === "Google" ? exportData.googleUrl : exportData.outlookUrl;
    const url = safeExternalHttpUrl(value);
    const openWindow = options.openWindow || globalThis.window?.open?.bind(globalThis.window);
    if (!url || typeof openWindow !== "function") return false;
    openWindow(url, "_blank", "noopener,noreferrer");
    return true;
  }

  if (label !== "Download file") return false;
  const filename = String(exportData.filename || "").trim();
  const ics = String(exportData.ics || "");
  const documentRef = options.documentRef || globalThis.document;
  if (
    !/^[a-z0-9][a-z0-9._ -]{0,119}\.ics$/i.test(filename) ||
    !ics.startsWith("BEGIN:VCALENDAR") ||
    ics.length > 100_000 ||
    !documentRef?.body
  ) {
    return false;
  }
  const link = documentRef.createElement("a");
  link.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
  link.download = filename;
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}

export function downloadTextArtifact(file, documentRef = globalThis.document) {
  const text = String(file?.text || "");
  if (!text || !documentRef?.body) return false;
  const stem = String(file?.name || "careerrat-file")
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^a-z0-9._ -]+/gi, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 100);
  const link = documentRef.createElement("a");
  link.href = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  link.download = `${stem || "careerrat-file"}.txt`;
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}

export function downloadBinaryArtifact(
  result,
  { documentRef = globalThis.document, urlApi = globalThis.URL } = {}
) {
  if (!(result?.blob instanceof Blob) || !documentRef?.body || !urlApi?.createObjectURL) {
    return false;
  }
  const filename = String(result?.filename || "interview-dossier.pdf")
    .replace(/[^a-z0-9._ -]+/gi, "-")
    .slice(0, 120);
  const url = urlApi.createObjectURL(result.blob);
  const link = documentRef.createElement("a");
  link.href = url;
  link.download = filename || "interview-dossier.pdf";
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  urlApi.revokeObjectURL?.(url);
  return true;
}

function normalizedArtifactKind(file) {
  return String(file?.kind || file?.name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export async function loadChatFirstArtifact({ api, applicationId, file } = {}) {
  if (file?.html || file?.binary || file?.text) return file;
  const id = String(applicationId || file?.applicationId || "").trim();
  if (!api || !id) return null;

  const kind = normalizedArtifactKind(file);
  const packetKind =
    file?.packetKind ||
    {
      resume: "resume",
      coverletter: "coverLetter",
      answers: "answers",
      applicationanswers: "answers",
    }[kind];
  if (packetKind) {
    const packet = await api.getPacket(id);
    return packet?.artifacts?.[packetKind] || null;
  }

  if (kind === "jobdescription") {
    const result = await api.getJobDescription({ source: "application", id });
    return result?.data?.artifact || null;
  }
  if (kind === "interviewdossier") {
    const result = await api.getInterviewDossier(id);
    return result?.data?.dossier || null;
  }
  return null;
}

export function scheduleApplicationId(item) {
  const id = String(item?.applicationId || item?.detailId || "").trim();
  return id || null;
}

export function resolvePersonAction(person) {
  const applicationId = String(person?.applicationId || "").trim() || null;
  return {
    applicationId,
    prompt: `Draft a nudge for ${person?.name || "this contact"}.`,
  };
}

function missionFromResponse(response) {
  return response?.data?.mission || response?.mission || null;
}

function clockLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "now";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function compactActivityTime(value) {
  const label = String(value || "").trim();
  const comma = label.lastIndexOf(",");
  const time = comma >= 0 ? label.slice(comma + 1).trim() : label;
  return time.replace(/\s+([ap])m$/i, (_, meridiem) => `${meridiem.toLowerCase()}m`);
}

export function mapActivityItems(items) {
  return list(items).map((item, index) => {
    const attention = item?.type === "error" || item?.tone === "attention";
    return {
      id: item?.id || `activity-${index + 1}`,
      time: compactActivityTime(
        item?.relTime || item?.time || clockLabel(item?.at || item?.createdAt)
      ),
      label: item?.title || item?.summary || item?.label || "Workspace updated",
      mark: attention ? "!" : item?.mark || "✓",
      tone: attention ? "attention" : item?.tone || "done",
    };
  });
}

export function mapComposerChips(selection, rows) {
  const selected = new Set(list(selection).map(String));
  return list(rows)
    .filter((row) => selected.has(String(row?.id)))
    .map((row) => ({ id: row.id, label: row.company || row.role || "Selected job" }));
}

export async function createMissionAndRun({ api, selection, rows, mode }) {
  const payload = buildMissionPayload(selection, rows, mode);
  const created = await api.createChatFirstMission(payload);
  const mission = missionFromResponse(created);
  if (!mission?.id) throw new Error("Mission did not return an id");
  const result = await api.runChatFirstMission(mission.id);
  return { kind: "mission", mission: missionFromResponse(result) || mission, payload };
}

export async function createMissionAndStart({ api, selection, rows, mode }) {
  const payload = buildMissionPayload(selection, rows, mode);
  const created = await api.createChatFirstMission(payload);
  const mission = missionFromResponse(created);
  if (!mission?.id) throw new Error("Mission did not return an id");
  const execution = api.runChatFirstMission(mission.id);
  return { kind: "mission", mission, payload, execution };
}

export async function commitComposerTurn({ api, text, preview }) {
  const commit = resolveComposerCommit(preview, text);
  if (commit.kind === "mission") {
    const entity = commit.jobs?.[0] || {};
    const row = {
      id: entity.id,
      source: entity.type === "sourced" ? "sourced" : "application",
      company: entity.company || "",
      role: entity.role || "",
      fit: Number.isFinite(entity.fit) ? entity.fit : null,
    };
    return createMissionAndRun({
      api,
      selection: [row.id],
      rows: [row],
      mode: "prepare-to-submit",
    });
  }
  if (commit.kind === "intent") {
    const { type, entity, input } = commit.intent;
    const response = await api.runWorkspaceIntent(type, entity, input || {});
    return { kind: "intent", response };
  }
  if (!commit.text) throw new Error("Write a message first");
  const response = await api.sendWorkspaceMessage(commit.text);
  return { kind: "message", response };
}

function applicationHandoff(detail, prepareStep) {
  const source = detail?.data || detail || {};
  const direct =
    source?.artifacts?.application_handoff ||
    source?.artifacts?.applicationHandoff ||
    prepareStep?.result?.artifact ||
    prepareStep?.result?.handoff ||
    null;
  if (direct) return direct;
  const artifacts = list(detail?.drawer?.artifacts).length
    ? list(detail.drawer.artifacts)
    : list(detail?.artifacts);
  return artifacts.find(
    (artifact) =>
      artifact?.kind === "application_handoff" || artifact?.kind === "Application handoff"
  );
}

export function findGate(missions, gateId, jobDetails = {}) {
  if (!gateId) return null;
  for (const mission of list(missions)) {
    for (const step of list(mission?.steps)) {
      if (`${mission.id}:${step.id}` !== gateId) continue;
      const applicationId = step?.result?.applicationId || step?.jobRef?.id || null;
      const prepareStep = list(mission.steps).find(
        (candidate) =>
          candidate?.action === "prepare-submit" && candidate?.jobRef?.id === step?.jobRef?.id
      );
      const detail = applicationId ? jobDetails?.[applicationId] : null;
      const handoff = applicationHandoff(detail, prepareStep);
      return {
        id: gateId,
        missionId: mission.id,
        stepId: step.id,
        applicationId,
        company: step?.jobRef?.company || detail?.company || detail?.data?.company || "Application",
        role: step?.jobRef?.role || detail?.role || detail?.data?.role || "Role",
        channel: handoff?.channel || handoff?.provider || "the job portal",
        handoffUrl: handoff?.url || null,
        answeredCount:
          Number(step?.result?.answeredCount) ||
          Number(detail?.answeredCount || detail?.data?.answeredCount) ||
          0,
        questionCount:
          Number(step?.result?.questionCount) ||
          Number(detail?.questionCount || detail?.data?.questionCount) ||
          0,
        expiryLabel: step?.result?.expiryLabel || null,
        deadline: step?.result?.deadline || null,
        packet: list(step?.result?.packet),
      };
    }
  }
  return null;
}

function needAction(item, decision) {
  const actions = list(item?.actions);
  if (decision === "secondary") {
    return (
      actions.find((action) => ["skip", "dismiss", "defer"].includes(action?.id)) ||
      actions.at(1) ||
      null
    );
  }
  return (
    actions.find((action) => ["apply", "draft", "open", "review-submit"].includes(action?.id)) ||
    item?.action ||
    actions[0] ||
    null
  );
}

export function resolveNeedDecision(item, decision = "primary") {
  const action = needAction(item, decision);
  const kind = String(item?.kind || "");
  if (kind === "submit" || kind === "submit-gate") {
    return decision === "primary" ? { kind: "open-gate", gateId: item?.id || null } : null;
  }
  if (kind === "sourced-decision") {
    const payload = action?.body || {
      id: item?.sourceId || item?.owner?.id,
      decision: decision === "secondary" ? "skip" : "apply",
    };
    return payload?.id ? { kind: "sourced-decision", payload } : null;
  }
  if (kind === "application-next-action") {
    const applicationId = item?.applicationId || item?.owner?.applicationId || item?.owner?.id;
    return applicationId ? { kind: "open-application", applicationId } : null;
  }
  if (kind === "touch" || kind === "touch-due") {
    if (decision === "secondary") {
      const payload = action?.body || {
        id: item?.touchId,
        source: item?.source || item?.owner?.type,
      };
      return payload?.id && payload?.source ? { kind: "dismiss-touch", payload } : null;
    }
    const contact = String(item?.title || "this contact")
      .replace(/^Nudge\s+/i, "")
      .replace(/\?$/, "");
    return {
      kind: "draft-touch",
      applicationId: item?.applicationId || item?.owner?.applicationId || null,
      prompt: `Draft a nudge for ${contact}.`,
    };
  }
  const applicationId = item?.applicationId || item?.owner?.applicationId;
  if (applicationId) return { kind: "open-application", applicationId };
  return null;
}

function plural(value, singular, pluralLabel = `${singular}s`) {
  return `${value} ${value === 1 ? singular : pluralLabel}`;
}

export function sourceSweepPresentation(value) {
  const run = value?.run && typeof value.run === "object" ? value.run : value;
  if (!run || run?.status === "not_started") {
    return { status: "idle", summary: "Ready to sweep configured sources" };
  }
  if (run.status === "running") {
    const completed = Number(run?.progress?.completedSources);
    const total = Number(run?.progress?.totalSources);
    const found = Number(run?.progress?.foundCount);
    const parts = [];
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
      parts.push(`${completed} of ${total} sources checked`);
    }
    if (Number.isFinite(found)) parts.push(`${found} found`);
    return {
      ...(run.id ? { id: run.id } : {}),
      status: "running",
      detail: parts.join(" · ") || run?.progress?.lastActivity || "Checking configured sources",
    };
  }
  if (run.status === "failed") {
    return { status: "error", summary: run?.error?.message || "Search failed." };
  }
  const summary = run?.summary || {};
  const fresh = Number(summary.new || 0);
  const qualified = Number(summary.qualified || 0);
  const scanned = Number(summary.scanned || 0);
  const sources = Number(summary.attemptedSources || summary?.deterministicSources?.attempted || 0);
  return {
    ...(run.id ? { id: run.id } : {}),
    status: "complete",
    summary: [
      `${fresh} new`,
      `${qualified} qualified`,
      `${scanned} scanned`,
      plural(sources, "source"),
    ].join(" · "),
    ...(run.completedAt || run.completed_at
      ? { completedAt: run.completedAt || run.completed_at }
      : {}),
  };
}

export function openApplicationHandoff(gate, openWindow = globalThis.window?.open) {
  const url = safeExternalHttpUrl(gate?.handoffUrl);
  if (!url || typeof openWindow !== "function") return false;
  openWindow(url, "_blank", "noopener,noreferrer");
  return true;
}

function latestForQuestion(messages, kind, questionNumber) {
  return list(messages)
    .filter((message) => message?.kind === kind && message?.questionNumber === questionNumber)
    .at(-1);
}

function displayLabel(value, fallback) {
  const text = String(value || "")
    .trim()
    .replace(/[\s_-]+/g, " ");
  if (!text) return fallback;
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

export function mockStartContext(thread, detail = {}) {
  const source = detail?.data || detail || {};
  const conversation = list(source?.conversations).at(-1) || null;
  const round = displayLabel(conversation?.kind || thread?.stage, "Interview");
  const interviewerName = String(conversation?.who || "").trim();
  const interviewerRole = String(conversation?.processNote || "").trim();
  const artifacts = list(source?.drawer?.artifacts).length
    ? list(source.drawer.artifacts)
    : list(source?.artifacts);
  const dossier = artifacts.find((artifact) =>
    /interview dossier/i.test(String(artifact?.kind || artifact?.name || ""))
  );
  return {
    title: `${round} practice`,
    context: {
      company: thread?.company || thread?.title || source?.company || null,
      role: thread?.role || source?.role || null,
      round,
      ...(interviewerName
        ? {
            interviewer: {
              name: interviewerName,
              ...(interviewerRole ? { role: interviewerRole } : {}),
            },
          }
        : {}),
      loadedContext: [
        dossier?.name || (dossier ? "Interview dossier" : null),
        "confirmed story bank",
      ]
        .filter(Boolean)
        .join(" · "),
    },
  };
}

export function mapMockSession(session) {
  const messages = list(session?.messages);
  const normalizedMessages = messages.map((message) => ({
    ...message,
    questionNumber: Number(message?.questionNumber),
  }));
  const context = session?.context || {};
  const questions = normalizedMessages.filter((message) => message?.kind === "question");
  const backendQuestionNumber = Number(session?.currentQuestion);
  const latestQuestionNumber = Number(questions.at(-1)?.questionNumber);
  const questionNumber =
    (backendQuestionNumber > 0 && backendQuestionNumber) ||
    (latestQuestionNumber > 0 && latestQuestionNumber) ||
    1;
  const question = latestForQuestion(normalizedMessages, "question", questionNumber);
  const answer = latestForQuestion(normalizedMessages, "answer", questionNumber);
  const feedbackItems = list(session?.feedback);
  const feedback = feedbackItems
    .filter((item) => Number(item?.questionNumber) === questionNumber)
    .at(-1);
  const previous = feedbackItems
    .filter((item) => Number(item?.questionNumber) < questionNumber)
    .at(-1);
  const interviewerValue = context?.interviewer ?? session?.interviewer;
  const interviewer =
    (typeof interviewerValue === "string" ? interviewerValue : interviewerValue?.name) || null;
  const interviewerRole =
    (typeof interviewerValue === "object" ? interviewerValue?.role : null) ||
    context?.interviewerRole ||
    null;
  const interviewerHint =
    context?.interviewerHint || [interviewer, interviewerRole].filter(Boolean).join(" · ") || null;
  return {
    id: session?.id || null,
    title: session?.title || context?.title || "Mock interview",
    company: context?.company || session?.company || null,
    round: context?.round || context?.interviewRound || session?.round || null,
    interviewer,
    interviewerHint,
    loadedContext: context?.loadedContext || session?.loadedContext || null,
    questionNumber,
    totalQuestions: Number(session?.questionTotal || session?.questionCount) || 1,
    question: question?.text || "Tell me about the experience most relevant to this role.",
    userAnswer: answer?.text || null,
    worked: feedback?.worked || null,
    tighten: feedback?.tighten || null,
    previousFeedback: previous
      ? {
          questionNumber: Number(previous.questionNumber),
          worked: previous.worked || null,
          tighten: previous.tighten || null,
        }
      : null,
    retryPrompt: null,
  };
}
