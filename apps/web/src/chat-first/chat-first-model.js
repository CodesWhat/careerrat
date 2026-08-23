import { buildLocationPolicy } from "./location-policy.js";

const SUBMIT_POLICY = Object.freeze({
  automatic: false,
  actionLabel: "Open form and submit",
  note: "Nothing sends until you press submit.",
});

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSearchRow(row, source) {
  return {
    ...row,
    id: row?.id || row?.detailId || "",
    stage: row?.stage || row?.status || row?.location || "Needs triage",
    evaluationRequired: source === "sourced",
    compStatus: row?.compStatus || "comp pending",
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

function normalizeThread(thread, nextActionIds) {
  const last = list(thread?.messages).at(-1);
  const stage = titleCase(thread?.stage);
  const communicationNeedsAction = list(thread?.communications).some((communication) =>
    ["needs-reply", "drafted", "blocked"].includes(String(communication?.status || ""))
  );
  return {
    ...thread,
    title: thread?.company || thread?.role || "Job conversation",
    subtitle: last?.text || stage,
    needsAction:
      Boolean(thread?.needsAction) ||
      nextActionIds.has(thread?.applicationId) ||
      communicationNeedsAction,
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
      };
    });
  });
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

function reachedPipelineMilestone(row, milestone) {
  const stage = pipelineStageKey(row);
  if (milestone === "applied") return true;
  if (milestone === "heard-back") {
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
        const stage = String(row?.stage || row?.stageLabel || row?.stageGroupLabel || "")
          .toLowerCase()
          .replaceAll(" ", "-");
        return stage === id || (id === "going-stale" && stage === "stale");
      }).length;
      return { id, label: titleCase(id), count };
    })
    .filter((row) => row.count > 0);
  return {
    applicationCount: applicationRows.length,
    rows,
    leaks,
    jobs: applicationRows
      .filter((row) => !row?.terminal)
      .map((row) => ({
        ...row,
        stageId: row?.stage || "",
        stage: row?.stageLabel || row?.stageGroupLabel || titleCase(row?.stage),
      })),
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
  return missions.flatMap((mission) =>
    list(mission?.steps)
      .filter(
        (step) =>
          step?.action === "submit-gate" &&
          step?.status === "blocked" &&
          step?.result?.requiresUserSubmit === true
      )
      .map((step) => ({
        ...(step?.result?.expiryLabel ? { eyebrow: step.result.expiryLabel } : {}),
        id: `${mission.id}:${step.id}`,
        kind: "submit",
        missionId: mission.id,
        stepId: step.id,
        applicationId: step?.result?.applicationId || step?.jobRef?.id || null,
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
      }))
  );
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

function flattenPeople(network) {
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
      });
    }
  }
  return people;
}

export function buildChatFirstView(dashboardInput, runtimeInput) {
  const dashboard = dashboardInput || {};
  const runtime = runtimeInput || {};
  const allThreads = list(runtime.jobThreads).length
    ? list(runtime.jobThreads)
    : list(runtime.threads);
  const nextActionIds = new Set(
    list(dashboard.allNextSteps)
      .map((item) => item?.applicationId || item?.detailId)
      .filter(Boolean)
  );
  const threads = allThreads
    .filter((thread) => !thread.archived)
    .map((thread) => normalizeThread(thread, nextActionIds));
  const archivedThreads = (
    list(runtime.archivedThreads).length
      ? list(runtime.archivedThreads)
      : allThreads.filter((thread) => thread.archived)
  ).map((thread) => normalizeThread(thread, nextActionIds));
  const search = [
    ...list(dashboard.sourcedRoles).map((row) => normalizeSearchRow(row, "sourced")),
    ...list(dashboard.reviewHoldRoles).map((row) => normalizeSearchRow(row, "reviewed-hold")),
  ];
  const pipelineRows = list(dashboard.jobs?.rows).filter((row) => row?.source !== "sourced");
  const rawFiles = list(dashboard.library?.cards).length
    ? list(dashboard.library.cards)
    : list(dashboard.library?.index);
  const files = [...rawFiles.map(normalizeFile), ...jobArtifactFiles(dashboard.jobs?.details)];
  const people = flattenPeople(dashboard.network);
  const missions = list(runtime.missions);
  const gates = submitGates(missions);
  const hasCanonicalNeeds = list(runtime.needsYou).length > 0;
  const canonicalNeeds = hasCanonicalNeeds
    ? list(runtime.needsYou)
    : list(dashboard.allNextSteps).map(normalizeNextStep);
  const needsYou = [
    ...gates,
    ...canonicalNeeds.filter(
      (item) =>
        !gates.some((gate) => gate.applicationId && gate.applicationId === item.applicationId)
    ),
    ...(hasCanonicalNeeds ? [] : touchNeeds(runtime.touchDue)),
  ];

  return {
    agentName: runtime.agentName || "Paul",
    candidateName: dashboard.settings?.profile?.candidate || "",
    locationPolicy: buildLocationPolicy(dashboard.settings?.profile?.location),
    mainThread: runtime.mainThread || { id: "workspace-main", messages: [] },
    threads,
    archivedThreads,
    needsYou,
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
      pipeline: dashboard.jobs?.visibleCount ?? pipelineRows.length,
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
    composerChips: [],
    gateId: null,
    activityOpen: false,
    archiveOpen: false,
  };
}

export function chatFirstReducer(state, action) {
  switch (action?.type) {
    case "browser.open":
      return { ...state, browse: action.tab || "search" };
    case "browser.close":
      return { ...state, browse: false };
    case "browser.pipeline-view":
      return { ...state, pipeView: action.view === "list" ? "list" : "funnel" };
    case "selection.toggle": {
      const selected = state.selection.includes(action.id);
      return {
        ...state,
        selection: selected
          ? state.selection.filter((id) => id !== action.id)
          : [...state.selection, action.id],
      };
    }
    case "selection.clear":
      return { ...state, selection: [] };
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
    case "composer.remove-context":
      return {
        ...state,
        composerChips: state.composerChips.filter((id) => id !== action.id),
      };
    case "thread.open":
      return {
        ...state,
        activeThread: action.id || "today",
        activeApplicationId: action.id && action.id !== "today" ? action.id : null,
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
