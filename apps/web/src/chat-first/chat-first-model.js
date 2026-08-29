import { cleanAgentCopy } from "./agent-copy.js";
import { buildLocationPolicy } from "./location-policy.js";

const SUBMIT_POLICY = Object.freeze({
  automatic: false,
  actionLabel: "Open form and submit",
  note: "Nothing sends until you press submit.",
});

import { buildSkillChatThreads } from "./skill-chat-model.js";

function list(value) {
  return Array.isArray(value) ? value : [];
}

const BROWSER_TABS = new Set(["search", "pipeline", "files", "people", "schedule"]);
const MAX_FOREGROUND_IDS = 24;
const WORKSPACE_OPERATION_STORAGE_KEY = "careerrat:operation:workspace";

function stableIds(value) {
  return [
    ...new Set(
      list(value)
        .map(String)
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ].slice(0, MAX_FOREGROUND_IDS);
}

function setParam(params, name, value, fallback = null) {
  const clean = String(value ?? "").trim();
  if (clean && clean !== fallback) params.set(name, clean);
}

function reviewTarget(value) {
  const [kind, ...idParts] = String(value || "").split(":");
  const id = idParts.join(":").trim();
  return ["source", "company"].includes(kind) && id
    ? { reviewKind: kind, reviewId: id }
    : { reviewKind: null, reviewId: null };
}

function privateOperationId(value) {
  const id = String(value || "").trim();
  return /^app-operation-[a-z0-9-]{1,140}$/i.test(id) ? id : null;
}

export function rememberWorkspaceOperation(storage, value) {
  const id = privateOperationId(value);
  if (!storage || !id) return null;
  try {
    storage.setItem(WORKSPACE_OPERATION_STORAGE_KEY, id);
    return id;
  } catch {
    return null;
  }
}

export function readWorkspaceOperationId(storage) {
  if (!storage) return null;
  try {
    return privateOperationId(storage.getItem(WORKSPACE_OPERATION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearWorkspaceOperation(storage, expectedId) {
  if (!storage) return false;
  const current = readWorkspaceOperationId(storage);
  if (expectedId && current !== privateOperationId(expectedId)) return false;
  try {
    storage.removeItem(WORKSPACE_OPERATION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function parseChatFirstForeground(search = "") {
  const params = new URLSearchParams(String(search).replace(/^\?/, ""));
  const browse = params.get("browse");
  const deepInputMode = params.get("ingest");
  const selection = stableIds(params.getAll("selected"));
  const selectionState = params.get("selection");
  const review = reviewTarget(params.get("review"));
  return {
    activeThread: params.get("thread") || "today",
    activeApplicationId: params.get("application") || null,
    browse: BROWSER_TABS.has(browse) ? browse : false,
    pipeView: params.get("pipe") === "list" ? "list" : "funnel",
    selection,
    searchSelectionSeeded: selection.length > 0 || ["seeded", "cleared"].includes(selectionState),
    composerChips: stableIds(params.getAll("context")),
    gateId: params.get("gate") || null,
    ...review,
    packetGapId: params.get("answer") || null,
    deepEditId: params.get("edit") || null,
    deepInputMode: ["paste", "repo"].includes(deepInputMode) ? deepInputMode : null,
    operationId: privateOperationId(params.get("work")),
    query: params.get("q") || "",
    pipelineStage: params.get("pipeline") || null,
    filters: {
      fit80: params.get("fit") !== "all",
      comp: params.get("comp") === "1",
      remote: params.get("remote") === "1",
      stage: params.get("stage") || "all",
      source: params.get("source") || "all",
      posted: params.get("posted") || "all",
      files: params.get("files") || "All",
      people: params.get("people") || "all",
    },
  };
}

export function serializeChatFirstForeground(foreground = {}) {
  const params = new URLSearchParams();
  setParam(params, "thread", foreground.activeThread, "today");
  setParam(params, "application", foreground.activeApplicationId);
  if (BROWSER_TABS.has(foreground.browse)) params.set("browse", foreground.browse);
  setParam(params, "pipe", foreground.pipeView, "funnel");
  const selection = stableIds(foreground.selection);
  if (foreground.searchSelectionSeeded === true || selection.length) {
    params.set("selection", selection.length ? "seeded" : "cleared");
  }
  for (const id of selection) params.append("selected", id);
  for (const id of stableIds(foreground.composerChips)) params.append("context", id);
  setParam(params, "gate", foreground.gateId);
  if (["source", "company"].includes(foreground.reviewKind) && foreground.reviewId) {
    params.set("review", `${foreground.reviewKind}:${foreground.reviewId}`);
  }
  setParam(params, "answer", foreground.packetGapId);
  setParam(params, "edit", foreground.deepEditId);
  if (["paste", "repo"].includes(foreground.deepInputMode)) {
    params.set("ingest", foreground.deepInputMode);
  }
  setParam(params, "work", privateOperationId(foreground.operationId));
  setParam(params, "q", foreground.query);
  setParam(params, "pipeline", foreground.pipelineStage);
  const filters = foreground.filters || {};
  if (filters.fit80 === false) params.set("fit", "all");
  if (filters.comp) params.set("comp", "1");
  if (filters.remote) params.set("remote", "1");
  setParam(params, "stage", filters.stage, "all");
  setParam(params, "source", filters.source, "all");
  setParam(params, "posted", filters.posted, "all");
  if (String(filters.files || "").toLowerCase() !== "all") {
    setParam(params, "files", filters.files);
  }
  setParam(params, "people", filters.people, "all");
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function replaceForegroundOperation(search, nextId, options = {}) {
  const foreground = parseChatFirstForeground(search);
  if (
    Object.hasOwn(options, "expectedId") &&
    foreground.operationId !== privateOperationId(options.expectedId)
  ) {
    return search;
  }
  return serializeChatFirstForeground({
    ...foreground,
    operationId: privateOperationId(nextId),
  });
}

export function foregroundDraftKey({ activeThread = "today", browse = false, packetGapId } = {}) {
  const surface = browse ? `browser:${browse}` : encodeURIComponent(activeThread || "today");
  const focus = packetGapId ? `:${encodeURIComponent(packetGapId)}` : "";
  return `careerrat:draft:${surface}${focus}`;
}

export function resolveForegroundStorage(scope = globalThis) {
  try {
    return scope?.localStorage || null;
  } catch {
    return null;
  }
}

export function readForegroundDraft(storage, key) {
  if (!storage || !key) return "";
  try {
    return String(storage.getItem(key) || "").slice(0, 12_000);
  } catch {
    return "";
  }
}

export function writeForegroundDraft(storage, key, value) {
  if (!storage || !key) return;
  try {
    const draft = String(value || "").slice(0, 12_000);
    if (draft) storage.setItem(key, draft);
    else storage.removeItem(key);
  } catch {
    // Private browsing and managed desktops can reject local storage writes.
  }
}

export function reconcileChatFirstForeground(foreground, view = {}) {
  const threadIds = new Set([
    "today",
    "ingest",
    ...list(view.threads).map((thread) => String(thread?.id || "")),
    ...list(view.archivedThreads).map((thread) => String(thread?.id || "")),
    ...list(view.skillChats).map((thread) => String(thread?.id || "")),
  ]);
  const searchIds = new Set(list(view.browser?.search).map((row) => String(row?.id || "")));
  const applicationIds = new Set(
    [...list(view.threads), ...list(view.archivedThreads)]
      .map((thread) => String(thread?.applicationId || ""))
      .filter(Boolean)
  );
  const state = { ...foreground };
  let missing = false;
  let threadMissing = false;
  if (state.activeThread === "mock") {
    if (!state.activeApplicationId || !applicationIds.has(String(state.activeApplicationId))) {
      state.activeThread = "today";
      state.activeApplicationId = null;
      missing = true;
      threadMissing = true;
    }
  } else if (!threadIds.has(String(state.activeThread || "today"))) {
    state.activeThread = "today";
    state.activeApplicationId = null;
    missing = true;
    threadMissing = true;
  } else if (!["today", "ingest"].includes(state.activeThread)) {
    const thread = [...list(view.threads), ...list(view.archivedThreads)].find(
      (candidate) => String(candidate?.id || "") === state.activeThread
    );
    state.activeApplicationId = thread?.applicationId || null;
  } else {
    state.activeApplicationId = null;
  }
  if (state.activeThread !== "ingest") {
    if ("deepEditId" in state) state.deepEditId = null;
    if ("deepInputMode" in state) state.deepInputMode = null;
  }
  const selection = stableIds(state.selection).filter((id) => searchIds.has(id));
  const composerChips = stableIds(state.composerChips).filter(
    (id) => searchIds.has(id) || applicationIds.has(id)
  );
  if (selection.length !== stableIds(state.selection).length) missing = true;
  if (composerChips.length !== stableIds(state.composerChips).length) missing = true;
  state.selection = selection;
  state.composerChips = composerChips;
  if (state.gateId) {
    const gateExists =
      list(view.needsYou).some((need) => String(need?.id || "") === state.gateId) ||
      list(view.missions).some((mission) =>
        list(mission?.steps).some(
          (step) => `${String(mission?.id || "")}:${String(step?.id || "")}` === state.gateId
        )
      );
    if (!gateExists) {
      state.gateId = null;
      missing = true;
    }
  }
  return {
    state,
    notice: threadMissing
      ? "That saved workspace item no longer exists. You're back in Today."
      : missing
        ? "Some saved workspace items no longer exist. The rest of your work is still here."
        : null,
  };
}

export function artifactEmoji(kind) {
  const value = String(kind || "").toLowerCase();
  if (value.includes("cover")) return "✉️";
  if (value.includes("dossier") || value.includes("interview prep")) return "📕";
  if (value.includes("story")) return "⭐";
  if (value.includes("evidence")) return "🧾";
  return "📄";
}

function normalizeSearchRow(row, source) {
  const compensationState = String(row?.evaluation?.compensation?.status || "").toLowerCase();
  const compactComp = String(row?.comp || row?.base || "").trim();
  const finitePresent = (value) =>
    value !== null && value !== undefined && Number.isFinite(Number(value));
  const hasResolvedComp =
    finitePresent(row?.compMidpointK) ||
    finitePresent(row?.baseK) ||
    Boolean(compactComp && !/^(?:verify|unknown|pending|n\/a)$/i.test(compactComp));
  const compStatus =
    row?.compStatus ||
    (compensationState === "clears-floor" ||
    (hasResolvedComp && row?.actionState !== "missing-comp")
      ? "comp ✓"
      : compensationState === "below-floor"
        ? "comp below floor"
        : "comp pending");
  return {
    ...row,
    id: row?.id || row?.detailId || "",
    stage: row?.stage || row?.status || row?.location || "Needs triage",
    evaluationRequired: source === "sourced",
    descriptionPartial: row?.descriptionPartial === true,
    compStatus,
    source,
  };
}

function titleCase(value, fallback = "In play") {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function normalizeThread(thread, nextActionIds, applicationRow) {
  const last = list(thread?.messages).at(-1);
  const stage = applicationRow?.stageLabel
    ? String(applicationRow.stageLabel).trim()
    : titleCase(thread?.stage);
  const lastText =
    last?.role === "user" ? String(last?.text || "").trim() : cleanAgentCopy(last?.text);
  const communicationNeedsAction = list(thread?.communications).some((communication) =>
    ["needs-reply", "drafted", "blocked"].includes(String(communication?.status || ""))
  );
  return {
    ...thread,
    stage,
    title: thread?.company || thread?.role || "Job conversation",
    subtitle: lastText || stage,
    needsAction:
      Boolean(thread?.needsAction) ||
      nextActionIds.has(thread?.applicationId) ||
      communicationNeedsAction ||
      Boolean(thread?.packetReview?.questionCaptureRequired) ||
      list(thread?.packetReview?.gaps).length > 0,
  };
}

function normalizeFile(file, index) {
  const text = [file?.title, file?.summary || file?.note, ...list(file?.tags)]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...file,
    id: file?.id || file?.path || `file-${index + 1}`,
    name: file?.name || file?.title || file?.label || "Untitled file",
    kind: file?.kind || file?.type || "File",
    meta:
      file?.meta ||
      [file?.status, file?.updated, file?.link].filter(Boolean).join(" · ") ||
      "Saved locally",
    text: file?.text || text || null,
    emoji: file?.emoji || artifactEmoji(file?.kind || file?.type || file?.title),
  };
}

function packetKind(kind) {
  const value = String(kind || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (value === "resume") return "resume";
  if (value === "coverletter") return "coverLetter";
  if (value === "answers" || value === "applicationanswers") return "answers";
  return null;
}

function jobArtifactFiles(details) {
  return Object.entries(details || {}).flatMap(([applicationId, detail]) => {
    const artifacts = list(detail?.drawer?.artifacts).length
      ? list(detail.drawer.artifacts)
      : list(detail?.artifacts);
    return artifacts.map((artifact, index) => {
      const kind = artifact?.kind || "Job file";
      const forPacket = packetKind(kind);
      const path = String(artifact?.path || "");
      const fallbackName = `${detail?.company || detail?.data?.company || "Job"} ${kind}`;
      return {
        ...artifact,
        id: `${applicationId}:${forPacket || String(kind).toLowerCase().replaceAll(" ", "-") || index + 1}`,
        applicationId,
        packetKind: forPacket,
        name: artifact?.name || path.split("/").at(-1) || fallbackName,
        kind,
        meta: artifact?.note || "Saved locally",
        emoji: artifact?.emoji || artifactEmoji(kind),
      };
    });
  });
}

function canonicalArtifactPath(path) {
  if (typeof path !== "string") return "";
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return trimmed
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/(^|\/)\.\//g, "$1");
}

function dedupeArtifactFiles(files) {
  const deduped = [];
  const indexesByPath = new Map();
  for (const file of list(files)) {
    const path = canonicalArtifactPath(file?.path);
    if (!path || !indexesByPath.has(path)) {
      if (path) indexesByPath.set(path, deduped.length);
      deduped.push(file);
      continue;
    }

    const index = indexesByPath.get(path);
    const merged = { ...deduped[index] };
    for (const [key, value] of Object.entries(file || {})) {
      const missing = merged[key] === undefined || merged[key] === null || merged[key] === "";
      if (missing && value != null) {
        merged[key] = value;
      }
    }
    deduped[index] = merged;
  }
  return deduped;
}

function scheduleEvents(calendar) {
  const primary = list(calendar?.upcoming?.events);
  const fallback = list(calendar?.thisWeek?.events);
  const source = primary.length ? primary : fallback;
  const seen = new Set();
  return source.filter((event) => {
    const id = event?.id || `${event?.iso || event?.date}:${event?.time}:${event?.title}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function scheduleActionLabel(event) {
  if (event?.actionLabel) return event.actionLabel;
  if (event?.kind === "interview" || /\b(?:interview|panel|screen)\b/i.test(event?.title || "")) {
    return "Open prep";
  }
  if (event?.kind === "prep") return "Start";
  if (event?.kind === "follow-up") return "Get script";
  return "Open";
}

function groupSchedule(calendar) {
  const groups = new Map();
  for (const event of scheduleEvents(calendar)) {
    const iso = event?.iso || event?.date || "";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : null;
    const day =
      date && Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" })
            .format(date)
            .toUpperCase()
        : "UPCOMING";
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push({
      ...event,
      id: event?.id || `${iso}:${event?.time || ""}:${event?.title || "event"}`,
      meta: event?.meta || event?.label || "",
      actionLabel: scheduleActionLabel(event),
    });
  }
  return [...groups].map(([day, items]) => ({ day, items }));
}

function pipelineStageKey(row) {
  return String(
    row?.terminalExitStage || row?.sankeyStage || row?.stage || row?.stageLabel || row?.status || ""
  )
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-");
}

function pipelineOutcomeStageKey(row) {
  return String(row?.stage || row?.status || row?.stageLabel || row?.stageGroupLabel || "")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-");
}

function reachedPipelineMilestone(row, milestone) {
  const stage = pipelineStageKey(row);
  if (milestone === "applied") {
    return !["", "application", "manual-apply", "prospect", "reviewed-hold", "sourced"].includes(
      stage
    );
  }
  if (milestone === "heard-back") {
    if (!reachedPipelineMilestone(row, "applied")) return false;
    if (
      row?.terminal &&
      !row?.terminalExitStage &&
      ["rejected", "withdrawn", "ghosted", "closed", "cut", "skipped"].includes(stage)
    ) {
      return false;
    }
    return !["", "applied", "application", "submitted", "sourced", "prospect"].includes(stage);
  }
  if (milestone === "onsite") {
    return ["onsite", "final", "offer", "accepted", "hired"].includes(stage);
  }
  if (milestone === "final") {
    return ["final", "offer", "accepted", "hired"].includes(stage);
  }
  return ["offer", "accepted", "hired"].includes(stage);
}

function cumulativePipelineRows(applicationRows) {
  const milestones = [
    ["applied", "Applied"],
    ["heard-back", "Heard back"],
    ["onsite", "Onsite"],
    ["final", "Final"],
    ["offer", "Offer"],
  ];
  const total = applicationRows.length;
  return milestones.map(([id, label]) => {
    const count = applicationRows.filter((row) => reachedPipelineMilestone(row, id)).length;
    return {
      id,
      label,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
      highlight: id === "offer",
    };
  });
}

function buildPipeline(applicationRows) {
  const rows = cumulativePipelineRows(applicationRows);
  const leakOrder = ["going-stale", "ghosted", "rejected", "withdrawn"];
  const leaks = leakOrder
    .map((id) => {
      const count = applicationRows.filter((row) => {
        const stage = pipelineOutcomeStageKey(row);
        return stage === id || (id === "going-stale" && stage === "stale");
      }).length;
      return { id, label: titleCase(id), count };
    })
    .filter((row) => row.count > 0);
  return {
    applicationCount: applicationRows.length,
    rows,
    leaks,
    jobs: applicationRows.map((row) => {
      const stageId = pipelineOutcomeStageKey(row);
      return {
        ...row,
        stageId,
        stage: row?.stageLabel || row?.stageGroupLabel || titleCase(stageId),
      };
    }),
  };
}

export function filterPipelineJobs(jobs, stageId) {
  const selected = String(stageId || "").trim();
  if (!selected || selected === "all") return list(jobs);
  return list(jobs).filter((job) => {
    const ownStage = String(job?.stageId || job?.stage || "")
      .trim()
      .toLowerCase()
      .replaceAll(" ", "-");
    return ownStage === selected;
  });
}

function submitGates(missions) {
  const gates = [];
  const seenApplications = new Set();
  for (const mission of list(missions)) {
    for (const step of list(mission?.steps)) {
      if (
        step?.action !== "submit-gate" ||
        step?.status !== "blocked" ||
        step?.result?.requiresUserSubmit !== true
      ) {
        continue;
      }
      const applicationId = step?.result?.applicationId || step?.jobRef?.id || null;
      const identity = applicationId
        ? `application:${applicationId}`
        : `gate:${mission.id}:${step.id}`;
      if (seenApplications.has(identity)) continue;
      seenApplications.add(identity);
      gates.push({
        ...(step?.result?.expiryLabel ? { eyebrow: step.result.expiryLabel } : {}),
        id: `${mission.id}:${step.id}`,
        kind: "submit",
        missionId: mission.id,
        stepId: step.id,
        applicationId,
        company: step?.jobRef?.company || "Application",
        role: step?.jobRef?.role || "Role",
        title: `${step?.jobRef?.company || "Application"} application ready`,
        detail: "The form is filled. You press submit.",
        tone: step?.result?.expiryLabel || step?.result?.deadline ? "attention" : "plain",
        primaryLabel: "Review & submit",
        expiryLabel: step?.result?.expiryLabel || null,
        deadline: step?.result?.deadline || null,
        answeredCount: Number(step?.result?.answeredCount) || 0,
        questionCount: Number(step?.result?.questionCount) || 0,
        packet: list(step?.result?.packet),
      });
    }
  }
  return gates;
}

function normalizeNextStep(item, index) {
  return {
    ...item,
    id: item?.id || item?.detailId || `next-step-${index + 1}`,
    applicationId: item?.applicationId || item?.detailId || null,
    title: item?.title || item?.nextAction || "Review next step",
    detail: item?.detail || item?.supportingText || item?.dueText || "",
    primaryLabel: item?.primaryLabel || item?.actionLabel || "Open",
    secondaryLabel: item?.secondaryLabel,
    tone: item?.tone === "error" ? "attention" : item?.tone || "plain",
  };
}

function touchNeeds(items) {
  return list(items).map((item, index) => ({
    ...item,
    id: `touch:${item?.id || index + 1}`,
    touchId: item?.id || null,
    kind: "touch",
    title: `Nudge ${item?.name || "this contact"}?`,
    detail: [item?.role, item?.company, item?.dueAt ? `touch due ${item.dueAt}` : null]
      .filter(Boolean)
      .join(" · "),
    primaryLabel: "Draft it",
    secondaryLabel: "Skip",
    tone: "plain",
  }));
}

function collapseSourcedDecisions(items, agentName) {
  const needs = list(items);
  const sourced = needs.filter((item) => item?.kind === "sourced-decision");
  if (sourced.length < 2) return needs;
  const sourceIds = [
    ...new Set(
      sourced
        .map((item) => item?.sourceId || item?.owner?.id)
        .filter(Boolean)
        .map(String)
    ),
  ];
  if (sourceIds.length < 2) return needs;
  const firstIndex = needs.findIndex((item) => item?.kind === "sourced-decision");
  const remaining = needs.filter((item) => item?.kind !== "sourced-decision");
  remaining.splice(firstIndex, 0, {
    id: `sourced-batch:${sourceIds.join(":")}`,
    kind: "sourced-decision-group",
    sourceIds,
    items: sourced,
    title: `${sourceIds.length} qualified jobs are ready`,
    detail: `Review them together before ${agentName} prepares each application.`,
    primaryLabel: `Apply to ${sourceIds.length} jobs`,
    secondaryLabel: "Review",
    tone: "plain",
  });
  return remaining;
}

function collapseSubmitGates(items) {
  const needs = list(items);
  const gates = needs.filter((item) => item?.kind === "submit");
  if (gates.length < 2) return needs;
  const gateIds = gates.map((item) => String(item.id)).filter(Boolean);
  if (gateIds.length < 2) return needs;
  const firstIndex = needs.findIndex((item) => item?.kind === "submit");
  const remaining = needs.filter((item) => item?.kind !== "submit");
  const urgent = gates.filter((item) => item?.tone === "attention");
  remaining.splice(firstIndex, 0, {
    ...(urgent.length ? { eyebrow: `${urgent.length} time-sensitive` } : {}),
    id: `submit-batch:${gateIds.join(":")}`,
    kind: "submit-gate-group",
    gateIds,
    items: gates,
    title: `${gates.length} applications are ready`,
    detail: "Each form is filled. Review them one at a time and press submit.",
    primaryLabel: `Apply to ${gates.length} jobs`,
    tone: urgent.length ? "attention" : "plain",
  });
  return remaining;
}

function flattenPeople(network, agentName) {
  const people = [];
  for (const company of list(network?.companies)) {
    for (const contact of list(company?.contacts)) {
      people.push({
        ...contact,
        id:
          contact.id ||
          `${company.applicationId || company.company}:${contact.name || contact.type}`,
        applicationId: company.applicationId || null,
        company: company.company || "",
        name: contact.name || contact.type || "Contact",
        role: contact.title || contact.type || "",
        last: company.latestAt || null,
        next: company.nextTouch || null,
        needsTouch: Boolean(company.nextTouch),
        actionLabel:
          contact.actionLabel ||
          (!company.applicationId && !company.nextTouch ? `Ask ${agentName}` : null),
      });
    }
  }
  return people;
}

export function buildChatFirstView(dashboardInput, runtimeInput) {
  const dashboard = dashboardInput || {};
  const runtime = runtimeInput || {};
  const agentName = runtime.agentName || "Paul";
  const savedFitFloor = Number(dashboard.settings?.targeting?.fitFloor);
  const fitFloor = Number.isFinite(savedFitFloor)
    ? Math.max(0, Math.min(100, savedFitFloor))
    : null;
  const allThreads = list(runtime.jobThreads).length
    ? list(runtime.jobThreads)
    : list(runtime.threads);
  const nextActionIds = new Set(
    list(dashboard.allNextSteps)
      .map((item) => item?.applicationId || item?.detailId)
      .filter(Boolean)
  );
  const dashboardJobRows = list(dashboard.jobs?.rows);
  const applicationRowsById = new Map(
    dashboardJobRows
      .filter((row) => row?.source !== "sourced")
      .map((row) => [String(row?.id || ""), row])
  );
  const threads = allThreads
    .filter((thread) => !thread.archived)
    .map((thread) =>
      normalizeThread(thread, nextActionIds, applicationRowsById.get(String(thread?.applicationId)))
    );
  const archivedThreads = (
    list(runtime.archivedThreads).length
      ? list(runtime.archivedThreads)
      : allThreads.filter((thread) => thread.archived)
  ).map((thread) =>
    normalizeThread(thread, nextActionIds, applicationRowsById.get(String(thread?.applicationId)))
  );
  const dashboardSearchRows = dashboardJobRows.filter((row) => row?.source === "sourced");
  const richSearchRows = new Map(dashboardSearchRows.map((row) => [String(row.id), row]));
  const searchSeeds = [
    ...list(dashboard.sourcedRoles).map((row) => ({ row, source: "sourced" })),
    ...list(dashboard.reviewHoldRoles).map((row) => ({ row, source: "reviewed-hold" })),
  ];
  const seenSearchIds = new Set();
  const search = searchSeeds.length
    ? searchSeeds.flatMap(({ row, source }) => {
        const id = String(row?.id || row?.detailId || "");
        if (seenSearchIds.has(id)) return [];
        seenSearchIds.add(id);
        return [normalizeSearchRow({ ...row, ...(richSearchRows.get(id) || {}) }, source)];
      })
    : dashboardSearchRows.map((row) => normalizeSearchRow(row, "sourced"));
  const pipelineRows = dashboardJobRows.filter((row) => row?.source !== "sourced");
  const rawFiles = list(dashboard.library?.cards).length
    ? list(dashboard.library.cards)
    : list(dashboard.library?.index);
  const files = dedupeArtifactFiles([
    ...rawFiles.map(normalizeFile),
    ...jobArtifactFiles(dashboard.jobs?.details),
  ]);
  const people = flattenPeople(dashboard.network, agentName);
  const missions = list(runtime.missions);
  const gates = submitGates(missions);
  const hasCanonicalNeeds = list(runtime.needsYou).length > 0;
  const canonicalNeeds = hasCanonicalNeeds
    ? list(runtime.needsYou)
    : list(dashboard.allNextSteps).map(normalizeNextStep);
  const needsYou = collapseSubmitGates(
    collapseSourcedDecisions(
      [
        ...gates,
        ...canonicalNeeds.filter(
          (item) =>
            !gates.some((gate) => gate.applicationId && gate.applicationId === item.applicationId)
        ),
        ...(hasCanonicalNeeds ? [] : touchNeeds(runtime.touchDue)),
      ],
      agentName
    )
  );

  return {
    agentName,
    candidateName: dashboard.settings?.profile?.candidate || "",
    fitFloor,
    locationPolicy: buildLocationPolicy(dashboard.settings?.profile?.location),
    mainThread: runtime.mainThread || { id: "workspace-main", messages: [] },
    skillChats: buildSkillChatThreads(runtime.mainThread, runtime.skillChats),
    threads,
    archivedThreads,
    needsYou,
    deepIngestPrompt: runtime.deepIngestPrompt || { visible: false },
    deepIngestThread: runtime.deepIngestThread || null,
    missions,
    activeMission:
      missions.find((mission) => mission.status === "running" || mission.status === "paused") ||
      null,
    mockSessions: list(runtime.mockSessions),
    touchDue: list(runtime.touchDue),
    activity: list(runtime.activity).length ? list(runtime.activity) : list(dashboard.activity),
    submitPolicy: SUBMIT_POLICY,
    counts: {
      search: search.length,
      pipeline: pipelineRows.length,
      files: files.length,
      people: people.length,
      touchDue: list(runtime.touchDue).length,
      archived: archivedThreads.length,
    },
    browser: {
      search,
      pipeline: buildPipeline(pipelineRows),
      files,
      people,
      schedule: groupSchedule(dashboard.calendar),
    },
    jobDetails: dashboard.jobs?.details || {},
  };
}

export function createChatFirstState() {
  return {
    activeThread: "today",
    activeApplicationId: null,
    browse: false,
    pipeView: "funnel",
    selection: [],
    searchSelectionSeeded: false,
    composerChips: [],
    gateId: null,
    activityOpen: false,
    archiveOpen: false,
  };
}

export function chatFirstReducer(state, action) {
  switch (action?.type) {
    case "foreground.hydrate":
      return { ...state, ...(action.foreground || {}) };
    case "browser.open":
      return { ...state, browse: action.tab || "search" };
    case "browser.close":
      return { ...state, browse: false };
    case "browser.pipeline-view":
      return { ...state, pipeView: action.view === "list" ? "list" : "funnel" };
    case "selection.seed-search":
      if (state.searchSelectionSeeded) return state;
      return {
        ...state,
        selection: highFitSearchIds(action.rows, action.minimumFit),
        searchSelectionSeeded: true,
      };
    case "selection.toggle": {
      const selected = state.selection.includes(action.id);
      return {
        ...state,
        selection: selected
          ? state.selection.filter((id) => id !== action.id)
          : [...state.selection, action.id],
        searchSelectionSeeded: true,
      };
    }
    case "selection.replace":
      return {
        ...state,
        selection: [...new Set(list(action.ids).filter(Boolean).map(String))],
        searchSelectionSeeded: true,
      };
    case "selection.clear":
      return { ...state, selection: [], searchSelectionSeeded: true };
    case "selection.chat":
      return {
        ...state,
        activeThread: "today",
        activeApplicationId: null,
        browse: false,
        composerChips: [...state.selection],
      };
    case "composer.clear-context":
      return { ...state, composerChips: [] };
    case "composer.set-context":
      return {
        ...state,
        composerChips: [...new Set(list(action.ids).filter(Boolean).map(String))],
      };
    case "composer.remove-context":
      return {
        ...state,
        composerChips: state.composerChips.filter((id) => id !== action.id),
      };
    case "thread.open":
      return {
        ...state,
        activeThread: action.id || "today",
        activeApplicationId:
          action.id && !["today", "ingest"].includes(action.id) ? action.id : null,
        browse: false,
      };
    case "ingest.open":
      return { ...state, activeThread: "ingest", activeApplicationId: null, browse: false };
    case "ingest.close":
      return { ...state, activeThread: "today" };
    case "mock.open":
      return {
        ...state,
        activeThread: "mock",
        activeApplicationId: action.applicationId || state.activeApplicationId,
        browse: false,
      };
    case "mock.close":
      return {
        ...state,
        activeThread: state.activeApplicationId || "today",
      };
    case "gate.open":
      return { ...state, gateId: action.id || null };
    case "gate.close":
      return { ...state, gateId: null };
    case "activity.toggle":
      return { ...state, activityOpen: !state.activityOpen };
    case "archive.toggle":
      return { ...state, archiveOpen: !state.archiveOpen };
    default:
      return state;
  }
}

export function highFitSearchIds(rows, minimumFit = null) {
  const floor = minimumFit == null ? 0 : Number(minimumFit);
  const safeFloor = Number.isFinite(floor) ? floor : 0;
  return [
    ...new Set(
      list(rows)
        .filter((row) => {
          const fit = Number(row?.fitScore ?? row?.fit);
          return Number.isFinite(fit) && fit >= safeFloor;
        })
        .map((row) => row?.id)
        .filter(Boolean)
        .map(String)
    ),
  ];
}
