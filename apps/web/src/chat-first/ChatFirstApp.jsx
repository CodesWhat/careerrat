import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArtifactViewerModal } from "../jobs/ArtifactViewerModal.jsx";
import {
  jobSearchCapabilities,
  runAiWebSearchLane,
  runCoordinatedJobSearch,
  runJobsPageSearch,
} from "../jobs/jobsSearch.js";
import { resolveErrorCopy } from "../lib/errorCopy.js";
import { useEventSource } from "../lib/sse.js";
import { chatFirstApi } from "./api.js";
import { filterFiles, filterPeople, filterSearchJobs } from "./browser-model.js";
import {
  calendarAction,
  commitComposerTurn,
  commitJobThreadComposer,
  createMissionAndStart,
  downloadBinaryArtifact,
  downloadTextArtifact,
  engineUnavailable,
  findGate,
  focusApplicationHandoff,
  isEngineFailure,
  isMockInterviewStartRequest,
  loadChatFirstArtifact,
  mapActivityItems,
  mapComposerChips,
  mapMockSession,
  mockStartContext,
  openApplicationHandoff,
  packetExportReceipt,
  projectWorkspaceResultToJobThread,
  resolveNeedDecision,
  resolvePersonAction,
  resumeHydratedMission,
  scheduleApplicationId,
  selectedSourcedDismissal,
  selectMockSession,
  sourceSweepPresentation,
  startMockFromJobThread,
} from "./chat-first-app-controller.js";
import {
  artifactEmoji,
  buildChatFirstView,
  chatFirstReducer,
  createChatFirstState,
  filterPipelineJobs,
} from "./chat-first-model.js";
import {
  CompanyProposalReview,
  companyProposalReviewForArtifact,
  companyProposalReviewFromResult,
} from "./company-proposal-review.jsx";
import {
  CanonicalJobConversation,
  ConversationPanel,
  DeepIngestContext,
  DeepIngestConversation,
  EngineDownCover,
  JobContextPanel,
  MockInterviewContext,
  MockInterviewConversation,
  SkillChatContext,
  SkillChatConversation,
  SubmitGateModal,
  TodayConversation,
} from "./conversation-surfaces.jsx";
import { useDashboardSnapshot } from "./dashboard-context.jsx";
import {
  buildDeepIngestReview,
  buildProposalsAndRefresh,
  captureSourceAndRefresh,
  decideProposalAndRefresh,
} from "./deep-ingest-controller.js";
import {
  commitSkillChatCompletion,
  commitSkillChatDecision,
  hydrateSkillChatMessages,
  reduceSkillChatEvent,
  resolveSkillChatSession,
  skillChatEventNeedsHydration,
  skillChatFromWorkspaceResult,
  skillChatStreamUrl,
  skillChatSubmitBlocked,
} from "./skill-chat-model.js";
import { SourceReview } from "./source-review.jsx";
import { WorkspaceBrowser } from "./WorkspaceBrowser.jsx";
import {
  ChatFirstWorkspace,
  Composer,
  NeedsYouPanel,
  ThreadRail,
  TopBar,
} from "./workspace-shell.jsx";

const EMPTY_LIST = [];
const DEFAULT_BROWSER_FILTERS = Object.freeze({
  fit80: true,
  comp: false,
  remote: false,
  stage: "all",
  source: "all",
  posted: "all",
  files: "All",
  people: "all",
});

export async function runChatFirstJobSearch({
  api,
  refetch,
  setSearchState,
  signal,
  runCoordinator = runCoordinatedJobSearch,
  runDeterministicLane = runJobsPageSearch,
  runAiLane = runAiWebSearchLane,
} = {}) {
  const [sourceStatusResult, runtimeConfigResult] = await Promise.allSettled([
    typeof api?.getSearchSourceStatus === "function"
      ? api.getSearchSourceStatus()
      : Promise.reject(new Error("Search source status is unavailable")),
    typeof api?.getRuntimeConfig === "function"
      ? api.getRuntimeConfig()
      : Promise.reject(new Error("AI runtime configuration is unavailable")),
  ]);
  const sourceStatus = sourceStatusResult.status === "fulfilled" ? sourceStatusResult.value : null;
  const runtimeConfig =
    runtimeConfigResult.status === "fulfilled" ? runtimeConfigResult.value : null;
  const aiConfigured = runtimeConfig?.ai?.available === true;
  const capabilities = jobSearchCapabilities({
    sourceStatus,
    ai: {
      configured: aiConfigured,
      executable: aiConfigured,
      consented: aiConfigured,
    },
  });

  return runCoordinator({
    capabilities,
    refetch,
    setSearchState,
    signal,
    runDeterministic: ({ signal: laneSignal, onLaneState }) =>
      runDeterministicLane({
        startSearchRun: api.startSearchRun,
        getSourcingRun: api.getSourcingRun,
        setSearchRun: (run) => {
          const presentation = sourceSweepPresentation(run);
          onLaneState?.({
            ...(presentation.detail || presentation.summary
              ? { detail: presentation.detail || presentation.summary }
              : {}),
            ...(presentation.providers ? { providers: presentation.providers } : {}),
          });
        },
        setSearchError: (error) => {
          if (error) onLaneState?.({ error });
        },
        signal: laneSignal,
      }),
    runAiWeb: ({ signal: laneSignal, onLaneState }) =>
      runAiLane({
        signal: laneSignal,
        setStatus: () => undefined,
        setActivity: (detail) => {
          if (detail) onLaneState?.({ detail });
        },
        setCounts: (counts) => {
          if (counts) onLaneState?.({ counts });
        },
        setError: (error) => {
          if (error) onLaneState?.({ error });
        },
      }),
  });
}
const SKILL_CHAT_EVENT_TYPES = [
  "assistant",
  "chat_state",
  "error",
  "result",
  "system",
  "tool_result",
  "tool_use",
];

function list(value) {
  return Array.isArray(value) ? value : EMPTY_LIST;
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

export function dispatchChatFirstMessageIntent(
  intent,
  { openJob, openBrowser, openSettings, openArtifact, openSourced, runWorkspaceIntent } = {}
) {
  if (!intent?.type || !intent?.entity) return null;
  if (intent.type !== "ui.navigate") return runWorkspaceIntent?.(intent) ?? null;

  const surface = String(intent.input?.surface || "").trim();
  if (surface === "job") return openJob?.(intent.entity.id) ?? null;
  if (surface === "files" && intent.input?.artifactKind) {
    return openArtifact?.(intent.entity, intent.input.artifactKind) ?? null;
  }
  if (surface === "search" && intent.entity.type === "sourced") {
    return openSourced?.(intent.entity.id) ?? null;
  }
  if (["search", "files", "schedule", "people", "pipeline"].includes(surface)) {
    return openBrowser?.(surface) ?? null;
  }
  if (surface === "settings") return openSettings?.(intent.input?.section) ?? null;
  return null;
}

export function revealSourcedTarget(id, { dispatch, setQuery, setBrowserFilters } = {}) {
  const targetId = String(id || "").trim();
  if (!targetId) return null;
  setQuery?.("");
  setBrowserFilters?.((current) => ({
    ...current,
    fit80: false,
    comp: false,
    remote: false,
    stage: "all",
    source: "all",
    posted: "all",
  }));
  dispatch?.({ type: "selection.replace", ids: [targetId] });
  dispatch?.({ type: "browser.open", tab: "search" });
  return targetId;
}

export async function loadChatFirstNavigationArtifact({ api, entity, artifactKind, files = [] }) {
  if (!entity?.id || !artifactKind) return null;
  const expectedKind = String(artifactKind).replaceAll("-", " ").toLowerCase();
  const file = list(files).find(
    (candidate) =>
      candidate.applicationId === entity.id &&
      String(candidate.kind || candidate.name || "")
        .toLowerCase()
        .includes(expectedKind)
  );
  const artifact = await loadChatFirstArtifact({
    api,
    applicationId: entity.id,
    file: file || { kind: artifactKind, applicationId: entity.id },
  });
  return artifact ? { title: file?.name || "Interview dossier", artifact } : null;
}

function threadForUi(view, ui) {
  const all = [...list(view?.threads), ...list(view?.archivedThreads)];
  const id = ui?.activeThread;
  const applicationId = ui?.activeApplicationId;
  return (
    all.find(
      (thread) =>
        thread?.id === id ||
        thread?.applicationId === id ||
        (applicationId && thread?.applicationId === applicationId)
    ) || null
  );
}

function missionForView(view) {
  return (
    view?.activeMission ||
    list(view?.missions).find((mission) => ["running", "paused"].includes(mission?.status)) ||
    null
  );
}

function missionPresentation(mission, { onPause, onResume } = {}) {
  if (!mission) return null;
  const marks = { completed: "✓", running: "◐", blocked: "•", failed: "!", pending: "○" };
  const hasRemainingWork = list(mission.steps).some((step) =>
    ["pending", "running"].includes(step?.status)
  );
  return {
    title: mission.title,
    steps: list(mission.steps).map(
      (step) =>
        `${marks[step?.status] || "○"} ${step?.label || titleCase(step?.action, "Mission step")}`
    ),
    footnote: "Packets are built from the full posting. Every submit gates back here.",
    onPause: mission.status === "running" ? onPause : null,
    onResume: mission.status === "paused" && hasRemainingWork ? onResume : null,
  };
}

function artifactRows(detail) {
  const source = detail?.data || detail || {};
  const drawer = list(detail?.drawer?.artifacts).length
    ? list(detail.drawer.artifacts)
    : list(detail?.artifacts);
  if (drawer.length) {
    return drawer.map((artifact, index) => ({
      ...artifact,
      id: artifact.id || artifact.kind || `artifact-${index + 1}`,
      name: artifact.name || artifact.label || titleCase(artifact.kind, "Saved file"),
      meta: artifact.meta || artifact.status || "Saved locally",
      icon: artifact.icon || artifactEmoji(artifact.kind || artifact.name),
    }));
  }
  const artifacts = source?.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return [];
  return Object.entries(artifacts).flatMap(([kind, artifact]) => {
    if (!artifact || typeof artifact !== "object") return [];
    return [
      {
        ...artifact,
        id: kind,
        name: artifact.name || titleCase(kind),
        meta: artifact.path || artifact.status || "Saved locally",
        icon: artifact.icon || artifactEmoji(kind),
      },
    ];
  });
}

export function packetRows(packet) {
  const artifacts = packet?.artifacts || {};
  return [
    ["resume", "resume.pdf", "📄"],
    ["coverLetter", "cover-letter.pdf", "✉️"],
  ].flatMap(([id, name, icon]) =>
    artifacts[id] ? [{ id, name, icon, artifact: artifacts[id] }] : []
  );
}

function errorCopy(error) {
  return resolveErrorCopy(error).message;
}

export async function runChatFirstOperation(
  operation,
  { refetch, setBusy, setError, setEngineDown } = {}
) {
  setBusy?.(true);
  setError?.(null);
  try {
    const result = await operation();
    await refetch?.();
    setEngineDown?.(false);
    return result;
  } catch (cause) {
    setError?.(errorCopy(cause));
    if (isEngineFailure(cause)) setEngineDown?.(true);
    return null;
  } finally {
    setBusy?.(false);
  }
}

function browserLaunchers(view) {
  const nextSchedule = list(view?.browser?.schedule).find((group) => list(group?.items).length);
  const nextDay = nextSchedule?.day
    ? `${String(nextSchedule.day).slice(0, 1).toUpperCase()}${String(nextSchedule.day)
        .slice(1, 3)
        .toLowerCase()}`
    : null;
  return [
    { id: "search", label: "Search", meta: `${view.counts.search} need action`, tone: "lime" },
    { id: "pipeline", label: "Pipeline", meta: `${view.counts.pipeline} tracked` },
    { id: "files", label: "Files", meta: String(view.counts.files) },
    {
      id: "people",
      label: "People",
      meta: view.counts.touchDue ? `${view.counts.touchDue} touch due` : String(view.counts.people),
      tone: view.counts.touchDue ? "attention" : "plain",
    },
    { id: "schedule", label: "Schedule", meta: nextDay ? `next: ${nextDay}` : null },
  ];
}

function jobContextLine(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return [value.summary, value.title, value.label, value.meta, value.dueText].find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );
}

const JOB_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function jobDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return null;
  return `${JOB_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function jobSourceLine(source) {
  const date = jobDate(source?.postedAt || source?.sourcedAt || source?.appliedAt);
  const timing = source?.postedAt ? "posted" : source?.sourcedAt ? "found" : "applied";
  return [source?.sourceLabel, date ? `${timing} ${date}` : null].filter(Boolean).join(" · ");
}

function offerPositionLine(source) {
  const amount = (value, label) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? `${label} $${Math.round(number)}k` : null;
  };
  const parts = [
    amount(source?.floor, "your floor"),
    amount(source?.marketP50, "market midpoint"),
    amount(source?.ask, "target"),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function jobContext(view, thread, mockSession, actions) {
  if (!thread) return null;
  const detail = view.jobDetails?.[thread.applicationId] || {};
  const source = detail?.data || detail;
  const offerPosition =
    String(thread.stage || "").toLowerCase() === "offer" ? offerPositionLine(source) : null;
  const lines = [offerPosition, source?.statusNote, source?.nextAction]
    .map(jobContextLine)
    .filter(Boolean)
    .filter(
      (line, index, all) =>
        all.findIndex(
          (candidate) => candidate.trim().toLowerCase() === line.trim().toLowerCase()
        ) === index
    )
    .slice(0, 3);
  const compensation = [source?.compSummary, source?.comp, source?.base, thread?.comp]
    .map(jobContextLine)
    .find(Boolean);
  const files = artifactRows(detail).map((file) => {
    const dossier = /interview dossier/i.test(String(file.kind || file.name || ""));
    return {
      ...file,
      onOpen: () => actions.openJobFile?.(thread.applicationId, file.id, file),
      ...(dossier ? { onExport: () => actions.exportJobFile?.(thread.applicationId, file) } : {}),
    };
  });
  const canRunMock =
    /review|saved|ready to apply|screen|assessment|technical|hiring manager|interview|onsite|final/i.test(
      String(thread.stage || "")
    ) || files.some((file) => /interview dossier/i.test(String(file.kind || file.name || "")));
  const matchingMock =
    Boolean(mockSession?.id) &&
    (!mockSession.applicationId || mockSession.applicationId === thread.applicationId);
  const mockAction = matchingMock
    ? mockSession.status === "ended"
      ? {
          label: "Review mock interview",
          onAction: () => actions.openMock?.(thread.applicationId),
        }
      : mockSession.questionReady
        ? {
            label: "Continue mock interview",
            onAction: () => actions.openMock?.(thread.applicationId),
          }
        : {
            label: "Preparing first question…",
            disabled: true,
          }
    : null;
  return (
    <JobContextPanel
      job={{
        company: thread.company || thread.title,
        role: thread.role || "Role",
        stage: titleCase(thread.stage),
        fit: Number.isFinite(Number(thread.fitScore)) ? Number(thread.fitScore) : "Fit pending",
        compensation,
        compensationNote: source?.compNote || source?.compStateLabel || null,
        location: thread.location || source?.location || null,
        mode: thread.modeLabel || thread.mode || source?.modeLabel || source?.mode || null,
        source: jobSourceLine(source) || null,
        fitReasons: source?.roleFit?.why || [],
        risks: source?.roleFit?.risks || [],
      }}
      summary={
        lines.length
          ? {
              title: String(thread.stage).toLowerCase() === "offer" ? "NEGOTIATION" : "STATUS",
              lines,
            }
          : null
      }
      files={files}
      note="Every run, draft, and round for this job lives here, not in the main chat."
      action={
        mockAction ||
        (canRunMock
          ? {
              label: "Run mock interview",
              onAction: () => actions.startMock?.(thread.applicationId),
            }
          : null)
      }
    />
  );
}

function composerFor({ view, ui, composerValue, busy, activeSkillChat, actions }) {
  const chips = mapComposerChips(ui.composerChips, [
    ...view.browser.search,
    ...view.threads,
    ...view.archivedThreads,
  ]);
  return (
    <Composer
      agentName={view.agentName}
      value={composerValue}
      disabled={busy || skillChatSubmitBlocked(activeSkillChat)}
      chips={chips}
      onChange={actions.setComposer}
      onSubmit={actions.submitComposer}
      onRemoveChip={actions.removeComposerChip}
      onClearChips={actions.clearComposerChips}
    />
  );
}

export function ChatFirstAppView({
  view,
  ui,
  composerValue,
  query = "",
  pipelineStage = null,
  browserFilters = DEFAULT_BROWSER_FILTERS,
  sourceSweep = {},
  deepIngest,
  mockSession,
  activeGate,
  artifactViewer,
  companyProposalReview,
  sourceReview,
  engineDown = false,
  technicalDetails = null,
  busy = false,
  error = null,
  activeSkillChat = null,
  actions = {},
}) {
  const activeJob = threadForUi(view, ui);
  const activeMission = missionForView(view);
  const railActive =
    ui.activeThread === "mock" && activeJob ? activeJob.id : activeJob?.id || ui.activeThread;
  const composer = composerFor({ view, ui, composerValue, busy, activeSkillChat, actions });
  const topBar = (
    <TopBar
      agentName={view.agentName}
      activityItems={mapActivityItems(view.activity)}
      activityOpen={ui.activityOpen}
      missionLive={Boolean(activeMission?.status === "running")}
      onOpenProfile={actions.openSettings}
      onToggleActivity={actions.toggleActivity}
    />
  );
  const overlays = (
    <>
      <SubmitGateModal
        open={Boolean(activeGate)}
        agentName={view.agentName}
        gate={activeGate}
        onClose={actions.closeGate}
        onReviewAnswers={() => actions.viewGateArtifact?.("answers")}
        onViewPacket={actions.viewGateArtifact}
        onRequestChanges={actions.requestGateChanges}
        onSubmit={actions.openGateHandoff}
      />
      <ArtifactViewerModal
        title={artifactViewer?.title || "Artifact preview"}
        artifact={artifactViewer?.artifact || null}
        onClose={actions.closeArtifact}
      />
      <CompanyProposalReview
        artifact={companyProposalReview}
        busy={busy}
        onIntent={actions.decideCompanyProposal}
        onClose={actions.closeCompanyProposalReview}
      />
      <SourceReview
        artifact={sourceReview}
        busy={busy}
        onDecision={actions.decideSkillChatDiscovery}
        onComplete={actions.completeSkillChatDiscovery}
        onClose={actions.closeSourceReview}
      />
      <EngineDownCover
        open={engineDown}
        agentName={view.agentName}
        onRetry={actions.retryEngine}
        onOpenSettings={actions.openSettings}
        onShowTechnical={actions.showTechnical}
        technicalDetails={technicalDetails}
      />
    </>
  );

  if (ui.browse) {
    const jobs = filterSearchJobs(view.browser.search, { ...browserFilters, query });
    const pipeline = {
      ...view.browser.pipeline,
      jobs: filterPipelineJobs(view.browser.pipeline?.jobs, pipelineStage),
    };
    return (
      <div className="chat-first-workspace">
        {topBar}
        {error ? (
          <div className="chat-first-controller-alert" role="alert">
            {error}
          </div>
        ) : null}
        <div className="chat-first-workspace__browser">
          <WorkspaceBrowser
            activeTab={ui.browse}
            counts={view.counts}
            pipelineView={ui.pipeView}
            jobs={jobs}
            cartJobs={view.browser.search}
            selection={ui.selection}
            sourceSweep={sourceSweep}
            locationPolicy={view.locationPolicy}
            pipeline={pipeline}
            files={filterFiles(view.browser.files, browserFilters.files)}
            people={filterPeople(view.browser.people, browserFilters.people)}
            schedule={view.browser.schedule}
            agentName={view.agentName}
            expiringCount={view.needsYou.filter((item) => item.tone === "attention").length}
            query={query}
            filters={browserFilters}
            onClose={actions.closeBrowser}
            onTabChange={actions.openBrowser}
            onPipelineViewChange={actions.changePipelineView}
            onToggleSelection={actions.toggleSelection}
            onRunSweep={actions.runSweep}
            onOpenSourceHealth={actions.openSourceHealth}
            onQueryChange={actions.setQuery}
            onFilter={actions.filterBrowser}
            onStageSelect={actions.selectPipelineStage}
            onOpenJob={actions.openJob}
            onOpenFile={actions.openFile}
            onExportFile={actions.exportFile}
            onOpenPerson={actions.openPerson}
            onDraftNudge={actions.draftNudge}
            onScheduleAction={actions.openScheduleItem}
            onCalendarAction={actions.calendarAction}
            onDraftAndApply={(ids) => actions.runCartMission?.(ids, "prepare-to-submit")}
            onDismissSelection={actions.dismissSelection}
          />
        </div>
        {overlays}
      </div>
    );
  }

  let conversation;
  let context;
  if (activeSkillChat) {
    conversation = (
      <ConversationPanel composer={composer}>
        <SkillChatConversation
          thread={activeSkillChat}
          messages={activeSkillChat.messages}
          agentName={view.agentName}
          busy={busy}
          onDecision={actions.decideSkillChatDiscovery}
          onComplete={actions.completeSkillChatDiscovery}
          onReviewSources={actions.openSourceReview}
          onAnswer={actions.submitComposer}
        />
      </ConversationPanel>
    );
    context = <SkillChatContext thread={activeSkillChat} />;
  } else if (ui.activeThread === "ingest") {
    conversation = (
      <ConversationPanel composer={composer}>
        <DeepIngestConversation
          agentName={view.agentName}
          intro="Feed me the work history that never fit on a resume. I will turn it into reusable evidence and stories."
          lastSession={deepIngest?.lastSession}
          counts={deepIngest?.counts}
          sources={deepIngest?.sources}
          proposals={deepIngest?.proposals}
          receipt={deepIngest?.receipt}
          inputMode={deepIngest?.inputMode}
          inputValue={deepIngest?.inputValue}
          editingId={deepIngest?.editingId}
          editDraft={deepIngest?.editDraft}
          busy={busy}
          onFiles={actions.ingestFiles}
          onPaste={actions.ingestPaste}
          onLinkRepo={actions.ingestLink}
          onInputChange={actions.setDeepInput}
          onInputSubmit={actions.submitDeepInput}
          onInputCancel={actions.cancelDeepInput}
          onAnalyze={actions.analyzeDeepSource}
          onStartEdit={actions.editDeepProposal}
          onEditChange={actions.changeDeepProposalEdit}
          onSaveEdit={actions.saveDeepProposalEdit}
          onConfirm={actions.confirmDeepProposal}
          onDefer={actions.deferDeepProposal}
          onReject={actions.rejectDeepProposal}
        />
      </ConversationPanel>
    );
    context = (
      <DeepIngestContext
        evidenceItems={deepIngest?.evidenceItems || []}
        unlockSummary="Stronger matching, sharper resumes, and interview stories grounded in work you actually did."
        onPause={actions.closeIngest}
      />
    );
  } else if (ui.activeThread === "mock") {
    const mapped = mockSession || mapMockSession({});
    const mockComposer =
      mapped.status === "ended"
        ? null
        : mapped.questionReady
          ? composer
          : composerFor({
              view,
              ui,
              composerValue,
              busy: true,
              activeSkillChat,
              actions,
            });
    conversation = (
      <ConversationPanel composer={mockComposer}>
        <MockInterviewConversation
          {...mapped}
          company={activeJob?.company || activeJob?.title}
          agentName={view.agentName}
        />
      </ConversationPanel>
    );
    context = (
      <MockInterviewContext
        title={`${activeJob?.role || "Role"} practice`}
        detail={
          mapped.status === "ended"
            ? `${mapped.turns.length} questions completed`
            : mapped.questionReady
              ? `Question ${mapped.questionNumber} of ${mapped.totalQuestions}`
              : "Preparing first question"
        }
        loadedContext={mapped.loadedContext || "Job description and confirmed story bank"}
        status={mapped.status}
        onEnd={actions.endMock}
      />
    );
  } else if (activeJob) {
    const communication =
      list(activeJob.communications).find((item) => item?.draft) ||
      list(activeJob.communications).at(-1) ||
      null;
    conversation = (
      <ConversationPanel composer={composer}>
        <CanonicalJobConversation
          eyebrow={`${activeJob.company || activeJob.title} · ${activeJob.role || "Role"} · ${titleCase(activeJob.stage)}`.toUpperCase()}
          agentName={view.agentName}
          communication={communication}
          threadMessages={activeJob.messages}
          onApproveAndCopy={actions.copyCommunicationDraft}
          onEditDraft={actions.editCommunicationDraft}
          onCoach={actions.coachCommunication}
          onArtifactAction={(artifact) => actions.openThreadArtifact?.(activeJob, artifact)}
          onMessageAction={actions.openActivity}
          onIntentAction={(intent) => actions.runMessageIntent?.(intent)}
          intentBusy={busy}
          onAnswer={actions.submitComposer}
          answerBusy={busy}
        />
      </ConversationPanel>
    );
    context = jobContext(view, activeJob, mockSession, actions);
  } else {
    conversation = (
      <ConversationPanel composer={composer}>
        <TodayConversation
          agentName={view.agentName}
          intro={
            list(view.mainThread?.messages).length
              ? null
              : "I’m ready. Tell me what you want to move forward today."
          }
          messages={view.mainThread?.messages || []}
          onArtifactAction={(artifact) => actions.openThreadArtifact?.(null, artifact)}
          onMessageAction={actions.openActivity}
          onIntentAction={(intent) => actions.runMessageIntent?.(intent)}
          intentBusy={busy}
          onAnswer={actions.submitComposer}
          answerBusy={busy}
          mission={missionPresentation(activeMission, {
            onPause: () => actions.pauseMission?.(activeMission.id),
            onResume: () => actions.resumeMission?.(activeMission.id),
          })}
        />
      </ConversationPanel>
    );
    context = (
      <NeedsYouPanel
        items={view.needsYou.map((item) => ({
          ...item,
          onPrimary: () => actions.decideNeed?.(item, "primary"),
          onSecondary: () => actions.decideNeed?.(item, "secondary"),
        }))}
        deepIngestPrompt={view.deepIngestPrompt}
        deepIngestStarted={Boolean(view.deepIngestThread)}
        onStartIngest={actions.openIngest}
        onDismissIngest={actions.dismissIngestPrompt}
      />
    );
  }

  return (
    <ChatFirstWorkspace
      topBar={topBar}
      rail={
        <ThreadRail
          agentName={view.agentName}
          activeThread={railActive}
          needsAction={view.needsYou.length > 0}
          deepIngestThread={view.deepIngestThread}
          skillThreads={view.skillChats}
          threads={view.threads}
          browserLaunchers={browserLaunchers(view)}
          archiveThreads={view.archivedThreads}
          archiveTotal={view.counts.archived}
          archiveOpen={ui.archiveOpen}
          onSelectThread={actions.openThread}
          onOpenBrowser={actions.openBrowser}
          onToggleArchive={actions.toggleArchive}
        />
      }
      conversation={
        <>
          {error ? (
            <div className="chat-first-controller-alert" role="alert">
              {error}
            </div>
          ) : null}
          {conversation}
        </>
      }
      context={context}
      overlays={overlays}
    />
  );
}

export function ChatFirstApp({ api = chatFirstApi }) {
  const dashboard = useDashboardSnapshot();
  const location = useLocation();
  const navigate = useNavigate();
  const [ui, dispatch] = useReducer(chatFirstReducer, undefined, createChatFirstState);
  const [composerValue, setComposerValue] = useState("");
  const [query, setQuery] = useState("");
  const [pipelineStage, setPipelineStage] = useState(null);
  const [browserFilters, setBrowserFilters] = useState(() => ({ ...DEFAULT_BROWSER_FILTERS }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [engineDown, setEngineDown] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [sourceSweep, setSourceSweep] = useState(() => sourceSweepPresentation(null));
  const [newSearchIds, setNewSearchIds] = useState([]);
  const [sweepComparison, setSweepComparison] = useState(0);
  const sweepBaselineRef = useRef(null);
  const sweepAbortRef = useRef(null);
  const missionExecutionRef = useRef(new Set());
  const [deepState, setDeepState] = useState(null);
  const [deepInputMode, setDeepInputMode] = useState(null);
  const [deepInputValue, setDeepInputValue] = useState("");
  const [deepEditingId, setDeepEditingId] = useState(null);
  const [deepEditDraft, setDeepEditDraft] = useState({});
  const [deepReceipt, setDeepReceipt] = useState(null);
  const [artifactViewer, setArtifactViewer] = useState(null);
  const [companyProposalReview, setCompanyProposalReview] = useState(null);
  const [sourceReview, setSourceReview] = useState(null);
  const [gatePacket, setGatePacket] = useState(null);
  const [skillChatState, setSkillChatState] = useState(null);
  const skillChatCursorsRef = useRef(new Map());

  const baseView = useMemo(
    () => buildChatFirstView(dashboard.data || {}, dashboard.data?.chatFirst || {}),
    [dashboard.data]
  );
  const view = useMemo(() => {
    if (!newSearchIds.length) return baseView;
    const ids = new Set(newSearchIds);
    return {
      ...baseView,
      browser: {
        ...baseView.browser,
        search: baseView.browser.search.map((row) => ({ ...row, isNew: ids.has(row.id) })),
      },
    };
  }, [baseView, newSearchIds]);
  const activeJob = threadForUi(view, ui);
  const persistedSkillChat = list(view.skillChats).find((thread) => thread.id === ui.activeThread);
  const activeSkillChat = persistedSkillChat
    ? skillChatState?.id === persistedSkillChat.id
      ? { ...persistedSkillChat, ...skillChatState }
      : { ...persistedSkillChat, messages: hydrateSkillChatMessages(persistedSkillChat) }
    : null;
  const rawGate = useMemo(
    () => findGate(view.missions, ui.gateId, view.jobDetails),
    [ui.gateId, view.jobDetails, view.missions]
  );
  const activeGate = rawGate
    ? {
        ...rawGate,
        answeredCount: gatePacket?.answeredCount ?? rawGate.answeredCount ?? 0,
        questionCount: gatePacket?.questionCount ?? rawGate.questionCount ?? 0,
        packet: packetRows(gatePacket).length ? packetRows(gatePacket) : list(rawGate.packet),
      }
    : null;
  const rawMock = selectMockSession(view.mockSessions, activeJob?.applicationId);
  const mockSession = rawMock ? mapMockSession(rawMock) : null;
  const deepReview = buildDeepIngestReview(deepState);
  const deepIngest = {
    ...deepReview,
    inputMode: deepInputMode,
    inputValue: deepInputValue,
    editingId: deepEditingId,
    editDraft: deepEditDraft,
    receipt: deepReceipt,
  };

  useEffect(() => {
    if (dashboard.loading || ui.searchSelectionSeeded || !baseView.browser.search.length) return;
    dispatch({ type: "selection.seed-search", rows: baseView.browser.search });
  }, [baseView.browser.search, dashboard.loading, ui.searchSelectionSeeded]);

  useEffect(
    () => () => {
      sweepAbortRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    const next = location.state || {};
    if (next.browse) dispatch({ type: "browser.open", tab: next.browse });
    if (next.composerDraft) setComposerValue(String(next.composerDraft));
    if (next.browse || next.composerDraft)
      navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  useEffect(() => {
    if (typeof api.getSourcingRun !== "function") return;
    const controller = new AbortController();
    void (async () => {
      try {
        const latest = await api.getSourcingRun({ purpose: "manual-search" });
        if (controller.signal.aborted) return;
        setSourceSweep(sourceSweepPresentation(latest));
        if (latest?.run?.status !== "running") return;
        await runJobsPageSearch({
          startSearchRun: async () => latest,
          getSourcingRun: api.getSourcingRun,
          refetch: dashboard.refetch,
          setSearchRun: (run) => setSourceSweep(sourceSweepPresentation(run)),
          setSearchError: (message) => {
            if (message) setSourceSweep({ status: "error", summary: message });
          },
          signal: controller.signal,
        });
      } catch (cause) {
        if (!controller.signal.aborted) {
          setSourceSweep({ status: "error", summary: errorCopy(cause) });
        }
      }
    })();
    return () => controller.abort();
  }, [api, dashboard.refetch]);

  useEffect(() => {
    const baseline = sweepBaselineRef.current;
    if (!baseline || sweepComparison < 1) return;
    setNewSearchIds(
      baseView.browser.search.map((row) => row.id).filter((id) => id && !baseline.has(id))
    );
    sweepBaselineRef.current = null;
    setSweepComparison(0);
  }, [baseView.browser.search, sweepComparison]);

  useEffect(() => {
    if (!rawGate?.applicationId) {
      setGatePacket(null);
      return;
    }
    let cancelled = false;
    api
      .getPacket(rawGate.applicationId)
      .then((packet) => {
        if (!cancelled) setGatePacket(packet);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorCopy(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, rawGate?.applicationId]);

  useEffect(() => {
    if (ui.activeThread !== "ingest") return;
    let cancelled = false;
    api
      .getDeepIngestState()
      .then((state) => {
        if (!cancelled) setDeepState(state);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorCopy(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, ui.activeThread]);

  useEffect(() => {
    if (typeof api.getInstalledAiRuntimes !== "function") return;
    let cancelled = false;
    api
      .getInstalledAiRuntimes()
      .then((state) => {
        if (!cancelled) setEngineDown(engineUnavailable(state));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!persistedSkillChat) {
      setSkillChatState(null);
      return;
    }
    let cancelled = false;
    setSkillChatState({
      ...persistedSkillChat,
      messages: hydrateSkillChatMessages(persistedSkillChat),
      cursor: 0,
      streamAfter: 0,
    });
    void resolveSkillChatSession(api, persistedSkillChat)
      .then((session) => {
        if (cancelled) return;
        const cursor = skillChatCursorsRef.current.get(session.chatId) || 0;
        setSkillChatState((current) =>
          current?.id === persistedSkillChat.id
            ? {
                ...current,
                chatId: session.chatId,
                state: session.state,
                cursor,
                streamAfter: cursor,
              }
            : current
        );
      })
      .catch((cause) => {
        if (cancelled) return;
        const message = errorCopy(cause);
        setSkillChatState((current) =>
          current?.id === persistedSkillChat.id
            ? {
                ...current,
                state: "idle",
                messages: [
                  ...list(current.messages),
                  {
                    id: `skill-session-error:${persistedSkillChat.id}`,
                    role: "assistant",
                    kind: "agent_error",
                    text: message,
                  },
                ],
              }
            : current
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, persistedSkillChat]);

  const handleSkillChatEvent = useCallback(
    (type, raw, metadata) => {
      const eventId = Number(metadata?.lastEventId);
      setSkillChatState((current) => {
        if (!current?.chatId) return current;
        const next = reduceSkillChatEvent(current, {
          chatId: current.chatId,
          type,
          raw,
          eventId,
        });
        if (next !== current) skillChatCursorsRef.current.set(current.chatId, next.cursor);
        return next;
      });
      if (skillChatEventNeedsHydration(type)) void dashboard.refetch();
    },
    [dashboard.refetch]
  );

  const activeSkillChatStreamUrl = skillChatStreamUrl(activeSkillChat);
  useEventSource(activeSkillChatStreamUrl, {
    types: SKILL_CHAT_EVENT_TYPES,
    onEvent: handleSkillChatEvent,
    enabled: Boolean(activeSkillChat?.chatId),
  });

  useEffect(() => {
    const mission = missionForView(view);
    const execution = resumeHydratedMission({
      api,
      mission,
      inFlight: missionExecutionRef.current,
    });
    if (!execution) return;
    void execution
      .then(() => dashboard.refetch())
      .catch((cause) => {
        setError(errorCopy(cause));
        if (isEngineFailure(cause)) setEngineDown(true);
      });
  }, [api, dashboard.refetch, view]);

  async function run(operation) {
    return runChatFirstOperation(operation, {
      refetch: dashboard.refetch,
      setBusy,
      setError,
      setEngineDown,
    });
  }

  function openThread(id) {
    dispatch({ type: "thread.open", id });
  }

  async function submitComposer(text) {
    const clean = String(text || "").trim();
    if (!clean || busy) return;
    if (persistedSkillChat && skillChatSubmitBlocked(activeSkillChat)) return;
    if (activeJob?.applicationId && isMockInterviewStartRequest(clean)) {
      if (rawMock?.applicationId === activeJob.applicationId) {
        setComposerValue("");
        dispatch({ type: "mock.open", applicationId: activeJob.applicationId });
        return;
      }
      const setup = mockStartContext(activeJob, view.jobDetails?.[activeJob.applicationId]);
      const mockResult = await run(() =>
        startMockFromJobThread({
          api,
          applicationId: activeJob.applicationId,
          text: clean,
          title: setup.title,
          context: setup.context,
        })
      );
      if (mockResult) {
        setComposerValue("");
        dispatch({ type: "mock.open", applicationId: activeJob.applicationId });
      }
      return;
    }
    const result = await run(async () => {
      if (activeSkillChat?.chatId) {
        return api.sendChatMessage(activeSkillChat.chatId, clean);
      }
      if (ui.activeThread === "mock" && rawMock?.id && rawMock.status !== "ended") {
        return api.sendMockInterviewTurn({ sessionId: rawMock.id, text: clean });
      }
      if (ui.activeThread === "ingest") {
        return captureSourceAndRefresh({ api, kind: "paste", value: clean });
      }
      if (activeJob?.applicationId) {
        return commitJobThreadComposer({
          api,
          applicationId: activeJob.applicationId,
          text: clean,
        });
      }
      const contextId = ui.composerChips[0];
      const context = contextId ? { pathname: "/jobs", jobId: contextId } : undefined;
      const preview = await api.previewWorkspaceQuery(clean, context);
      return commitComposerTurn({
        api,
        text: clean,
        preview: preview?.data || preview,
        context,
      });
    });
    if (result) setComposerValue("");
    const launchedSkillChat = skillChatFromWorkspaceResult(result);
    if (launchedSkillChat) dispatch({ type: "thread.open", id: launchedSkillChat.id });
    if (ui.activeThread === "ingest" && result?.view) {
      setDeepState(result.view);
      const next = buildDeepIngestReview(result.view);
      setDeepReceipt(
        `Material saved locally. ${next.counts.reviewQueue} proposal${next.counts.reviewQueue === 1 ? "" : "s"} need review.`
      );
    }
  }

  async function runCartMission(ids, mode) {
    if (busy) return;
    const result = await run(() =>
      createMissionAndStart({
        api,
        selection: ids,
        rows: view.browser.search,
        mode,
        onExecutionStart: (id) => missionExecutionRef.current.add(id),
      })
    );
    if (!result) return;
    dispatch({ type: "browser.close" });
    dispatch({ type: "thread.open", id: "today" });
    void result.execution
      .then(() => dashboard.refetch())
      .catch((cause) => {
        setError(errorCopy(cause));
        if (isEngineFailure(cause)) setEngineDown(true);
      })
      .finally(() => missionExecutionRef.current.delete(result.mission.id));
  }

  async function runSweep() {
    if (sourceSweep?.status === "running") return;
    sweepBaselineRef.current = new Set(baseView.browser.search.map((row) => row.id));
    setNewSearchIds([]);
    const controller = new AbortController();
    sweepAbortRef.current = controller;
    try {
      const result = await runChatFirstJobSearch({
        api,
        refetch: dashboard.refetch,
        setSearchState: setSourceSweep,
        signal: controller.signal,
      });
      if (result?.ok) setSweepComparison((current) => current + 1);
      else if (!result?.timedOut) sweepBaselineRef.current = null;
    } finally {
      if (sweepAbortRef.current === controller) sweepAbortRef.current = null;
    }
  }

  async function openJob(applicationId) {
    const existing = [...view.threads, ...view.archivedThreads].find(
      (thread) => thread.applicationId === applicationId || thread.id === applicationId
    );
    if (existing) {
      openThread(existing.id);
      return;
    }
    const result = await run(() => api.pinJobThread({ applicationId, pinned: true }));
    if (result) openThread(`job:${applicationId}`);
  }

  async function startMock(applicationId) {
    if (rawMock?.applicationId === applicationId) {
      dispatch({ type: "mock.open", applicationId });
      return;
    }
    const thread = [...view.threads, ...view.archivedThreads].find(
      (candidate) => candidate.applicationId === applicationId
    );
    const setup = mockStartContext(thread, view.jobDetails?.[applicationId]);
    const result = await run(() =>
      api.startMockInterview({
        applicationId,
        questionTotal: 6,
        title: setup.title,
        context: setup.context,
      })
    );
    if (result) dispatch({ type: "mock.open", applicationId });
  }

  async function endMock() {
    if (rawMock?.id && rawMock.status !== "ended") {
      await run(() => api.endMockInterview({ sessionId: rawMock.id }));
    }
    dispatch({ type: "mock.close" });
  }

  async function ingestFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const result = await run(async () => {
      for (const file of files) await api.uploadDeepIngestFile(file, { targetShape: "auto" });
      return api.getDeepIngestState();
    });
    if (result) {
      setDeepState(result);
      const next = buildDeepIngestReview(result);
      setDeepReceipt(
        `${files.length} file${files.length === 1 ? "" : "s"} saved locally. ${next.counts.sources} source${next.counts.sources === 1 ? "" : "s"} total.`
      );
    }
  }

  function openDeepInput(kind) {
    setDeepInputMode(kind);
    setDeepInputValue("");
    setError(null);
  }

  function cancelDeepInput() {
    setDeepInputMode(null);
    setDeepInputValue("");
  }

  async function submitDeepInput() {
    if (!deepInputMode || !deepInputValue.trim()) return;
    const result = await run(() =>
      captureSourceAndRefresh({ api, kind: deepInputMode, value: deepInputValue })
    );
    if (!result?.view) return;
    setDeepState(result.view);
    const next = buildDeepIngestReview(result.view);
    setDeepReceipt(
      `Source saved locally. ${next.counts.sources} source${next.counts.sources === 1 ? "" : "s"} ready for deep ingest.`
    );
    cancelDeepInput();
  }

  async function analyzeDeepSource(source) {
    const result = await run(() =>
      buildProposalsAndRefresh({ api, source: source?.raw || source })
    );
    if (!result?.view) return;
    setDeepState(result.view);
    const next = buildDeepIngestReview(result.view);
    setDeepReceipt(
      `Analysis complete. ${next.counts.reviewQueue} proposal${next.counts.reviewQueue === 1 ? "" : "s"} need review.`
    );
  }

  function editDeepProposal(proposal) {
    setDeepEditingId(proposal.id);
    setDeepEditDraft({
      title: proposal.title || "",
      summary: proposal.summary || "",
      supportingQuote: proposal.supportingQuote || "",
    });
  }

  function changeDeepProposalEdit(field, value) {
    setDeepEditDraft((current) => ({ ...current, [field]: value }));
  }

  async function decideDeepProposal(proposal, decision) {
    const edits = deepEditingId === proposal.id ? deepEditDraft : {};
    const result = await run(() =>
      decideProposalAndRefresh({
        api,
        proposal: proposal?.raw || proposal,
        decision,
        edits,
      })
    );
    if (!result?.view) return;
    setDeepState(result.view);
    const next = buildDeepIngestReview(result.view);
    const labels = {
      save_edits: "Edits saved.",
      confirm: "Proposal confirmed.",
      defer: "Proposal deferred.",
      reject: "Proposal rejected.",
    };
    setDeepReceipt(
      `${labels[decision]} ${next.counts.reviewQueue} proposal${next.counts.reviewQueue === 1 ? "" : "s"} still need review.`
    );
    if (decision !== "save_edits") {
      setDeepEditingId(null);
      setDeepEditDraft({});
    }
  }

  async function openFile(id) {
    const file = view.browser.files.find((candidate) => String(candidate.id) === String(id));
    if (!file) return;
    if (file.html || file.binary || file.text) {
      setArtifactViewer({ title: file.name, artifact: file });
      return;
    }
    if (file.url) {
      if (!openApplicationHandoff({ handoffUrl: file.url })) {
        setError("That saved link is not safe to open.");
      }
      return;
    }
    if (file.applicationId) {
      const artifact = await run(() =>
        loadChatFirstArtifact({ api, applicationId: file.applicationId, file })
      );
      if (artifact) setArtifactViewer({ title: file.name, artifact });
      else setError(`${file.name || "This file"} is not ready to preview yet.`);
    }
  }

  async function exportJobFile(applicationId, file) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.exportInterviewDossierPdf({
        applicationId,
        ...(file?.path ? { artifactPath: file.path } : {}),
      });
      if (!downloadBinaryArtifact(result)) {
        setError("The dossier PDF could not be downloaded in this window.");
      }
    } catch (cause) {
      setError(errorCopy(cause));
    } finally {
      setBusy(false);
    }
  }

  async function viewGateArtifact(id) {
    const artifact = gatePacket?.artifacts?.[id];
    if (artifact)
      setArtifactViewer({
        title: packetRows(gatePacket).find((item) => item.id === id)?.name || titleCase(id),
        artifact,
      });
  }

  async function decideNeed(item, decision) {
    const resolved = resolveNeedDecision(item, decision);
    if (!resolved) return;
    if (resolved.kind === "open-gate") {
      dispatch({ type: "gate.open", id: resolved.gateId });
      return;
    }
    if (resolved.kind === "open-application") {
      await openJob(resolved.applicationId);
      return;
    }
    if (resolved.kind === "dismiss-touch") {
      await run(() => api.dismissTouchDue(resolved.payload));
      return;
    }
    if (resolved.kind === "draft-touch") {
      setComposerValue(resolved.prompt);
      if (resolved.applicationId) await openJob(resolved.applicationId);
      else dispatch({ type: "thread.open", id: "today" });
      return;
    }
    if (resolved.kind === "sourced-decision") {
      const result = await run(() => api.decideChatFirstSourced(resolved.payload));
      const mission = result?.data?.mission || result?.mission;
      if (!mission?.id) return;
      dispatch({ type: "browser.close" });
      dispatch({ type: "thread.open", id: "today" });
      void api
        .runChatFirstMission(mission.id)
        .then(() => dashboard.refetch())
        .catch((cause) => {
          setError(errorCopy(cause));
          if (isEngineFailure(cause)) setEngineDown(true);
        });
      return;
    }
    if (resolved.kind === "sourced-batch-apply") {
      await runCartMission(resolved.ids, "prepare-to-submit");
      return;
    }
    if (resolved.kind === "review-sourced-batch") {
      dispatch({ type: "selection.replace", ids: resolved.ids });
      dispatch({ type: "browser.open", tab: "search" });
    }
  }

  async function dismissSelection(ids) {
    const plan = selectedSourcedDismissal(view.browser.search, ids);
    if (plan.sourcedIds.length) {
      const result = await run(() =>
        Promise.all(
          plan.sourcedIds.map((id) => api.decideChatFirstSourced({ id, decision: "skip" }))
        )
      );
      if (!result) return;
    }
    dispatch({ type: "selection.clear" });
    if (plan.unsupportedCount > 0) {
      setError(
        `${plan.unsupportedCount} existing application${plan.unsupportedCount === 1 ? " was" : "s were"} removed from this selection without changing pipeline status.`
      );
    }
  }

  async function runMessageIntent(intent) {
    const result = await dispatchChatFirstMessageIntent(intent, {
      openJob,
      openBrowser: (surface) => dispatch({ type: "browser.open", tab: surface }),
      openArtifact: async (entity, artifactKind) => {
        const result = await run(() =>
          loadChatFirstNavigationArtifact({
            api,
            entity,
            artifactKind,
            files: view.browser.files,
          })
        );
        if (result) setArtifactViewer(result);
        return result;
      },
      openSourced: (id) => revealSourcedTarget(id, { dispatch, setQuery, setBrowserFilters }),
      openSettings: (section) =>
        navigate("/settings", {
          state: { activeTab: "settings", ...(section ? { section } : {}) },
        }),
      runWorkspaceIntent: (typedIntent) =>
        run(async () => {
          const response = await api.runWorkspaceIntent(
            typedIntent.type,
            typedIntent.entity,
            typedIntent.input || {}
          );
          if (
            activeJob?.applicationId &&
            typedIntent.entity?.type === "application" &&
            typedIntent.entity.id === activeJob.applicationId
          ) {
            await projectWorkspaceResultToJobThread({
              api,
              applicationId: activeJob.applicationId,
              response,
              fallbackText: "That application action is complete.",
            });
          }
          return response;
        }),
    });
    const launchedSkillChat = skillChatFromWorkspaceResult(result);
    if (launchedSkillChat) dispatch({ type: "thread.open", id: launchedSkillChat.id });
    return result;
  }

  async function decideCompanyProposal(intent) {
    if (intent?.type !== "company.proposal-decide") return;
    const response = await run(() =>
      api.runWorkspaceIntent(intent.type, intent.entity, intent.input || {})
    );
    if (!response) return;
    const refreshed = companyProposalReviewFromResult(response);
    if (refreshed?.proposals.length) setCompanyProposalReview(refreshed);
    else setCompanyProposalReview(null);
  }

  async function decideSkillChatDiscovery(item, action) {
    if (!activeSkillChat?.skill || !item?.id || !["save", "discard"].includes(action)) return;
    setBusy(true);
    setError(null);
    try {
      await commitSkillChatDecision({
        api,
        skill: activeSkillChat.skill,
        item,
        action,
      });
      setSourceReview((current) =>
        current
          ? {
              ...current,
              candidates: list(current.candidates).map((candidate) =>
                candidate?.id === item.id
                  ? { ...candidate, decision: { action, status: "completed" } }
                  : candidate
              ),
            }
          : current
      );
    } catch (cause) {
      const resultText = errorCopy(cause);
      setSkillChatState((current) =>
        current?.id === activeSkillChat.id
          ? {
              ...current,
              messages: [
                ...list(current.messages),
                {
                  id: `decision-error:${item.id}:${Date.now()}`,
                  role: "assistant",
                  kind: "action_error",
                  text: resultText,
                },
              ],
            }
          : current
      );
      setError(resultText);
    } finally {
      await dashboard.refetch().catch(() => undefined);
      setBusy(false);
    }
  }

  async function completeSkillChatDiscovery(item) {
    if (!activeSkillChat?.skill || !item?.id) return;
    setBusy(true);
    setError(null);
    try {
      await commitSkillChatCompletion({ api, skill: activeSkillChat.skill, item });
      setSourceReview(null);
    } catch (cause) {
      setError(errorCopy(cause));
    } finally {
      await dashboard.refetch().catch(() => undefined);
      setBusy(false);
    }
  }

  const actions = {
    setComposer: setComposerValue,
    submitComposer,
    removeComposerChip: (id) => dispatch({ type: "composer.remove-context", id }),
    clearComposerChips: () => dispatch({ type: "composer.clear-context" }),
    toggleActivity: () => dispatch({ type: "activity.toggle" }),
    openActivity: () => {
      if (!ui.activityOpen) dispatch({ type: "activity.toggle" });
    },
    toggleArchive: () => dispatch({ type: "archive.toggle" }),
    openThread,
    openBrowser: (tab) => dispatch({ type: "browser.open", tab }),
    closeBrowser: () => dispatch({ type: "browser.close" }),
    changePipelineView: (viewName) => dispatch({ type: "browser.pipeline-view", view: viewName }),
    toggleSelection: (id) => dispatch({ type: "selection.toggle", id }),
    clearSelection: () => dispatch({ type: "selection.clear" }),
    dismissSelection,
    chatAboutSelection: () => dispatch({ type: "selection.chat" }),
    runCartMission,
    runMessageIntent,
    decideSkillChatDiscovery,
    completeSkillChatDiscovery,
    openSourceReview: (artifact) => setSourceReview(artifact),
    closeSourceReview: () => setSourceReview(null),
    runSweep,
    setQuery,
    openSourceHealth: () => navigate("/settings", { state: { activeTab: "settings" } }),
    filterBrowser: (filter, value) => {
      if (ui.browse === "files") {
        setBrowserFilters((current) => ({ ...current, files: filter }));
        return;
      }
      if (ui.browse === "people") {
        setBrowserFilters((current) => ({ ...current, people: filter }));
        return;
      }
      if (["fit80", "comp", "remote"].includes(filter)) {
        setBrowserFilters((current) => ({ ...current, [filter]: !current[filter] }));
        return;
      }
      if (["stage", "source", "posted"].includes(filter)) {
        setBrowserFilters((current) => ({ ...current, [filter]: value || "all" }));
      }
    },
    selectPipelineStage: (stageId) => {
      setPipelineStage(stageId);
      dispatch({ type: "browser.pipeline-view", view: "list" });
    },
    openJob,
    copyCommunicationDraft: async (draft) => {
      const body = String(draft?.body || "").trim();
      const clipboard = globalThis.navigator?.clipboard;
      if (!body || typeof clipboard?.writeText !== "function") {
        setError("Copy is not available in this window. The draft is still saved here.");
        return;
      }
      try {
        await clipboard.writeText(body);
      } catch {
        setError("The draft could not be copied. It is still saved here.");
      }
    },
    editCommunicationDraft: (draft) => {
      setComposerValue(String(draft?.body || ""));
    },
    coachCommunication: (communication) => {
      setComposerValue(
        `Coach me through this ${communication?.channel || "recruiter"} conversation before I reply.`
      );
    },
    openThreadArtifact: async (thread, artifact) => {
      const proposalReview = companyProposalReviewForArtifact(artifact);
      if (proposalReview) {
        setCompanyProposalReview(proposalReview);
        return;
      }
      if (artifact?.html || artifact?.binary || artifact?.text || artifact?.markdown) {
        setArtifactViewer({
          title: artifact?.title || artifact?.name || titleCase(artifact?.kind, "Artifact"),
          artifact: artifact?.text ? artifact : { ...artifact, text: artifact?.markdown },
        });
        return;
      }
      const nested = artifact?.artifacts;
      const nestedArtifact = nested?.resume || nested?.coverLetter || nested?.answers;
      if (nestedArtifact) {
        setArtifactViewer({
          title: artifact?.title || "Application documents",
          artifact: nestedArtifact,
        });
        return;
      }
      const kind = String(artifact?.kind || "").toLowerCase();
      if (kind.includes("search")) {
        dispatch({ type: "browser.open", tab: "search" });
        return;
      }
      if (["research_chat", "board_discovery_chat"].includes(artifact?.kind)) {
        const launched = skillChatFromWorkspaceResult({ messages: [{ artifacts: [artifact] }] });
        if (launched) dispatch({ type: "thread.open", id: launched.id });
        return;
      }
      if (kind.includes("evidence") || kind.includes("story")) {
        dispatch({ type: "browser.open", tab: "files" });
        return;
      }
      const applicationId = thread?.applicationId || artifact?.applicationId;
      if (applicationId) {
        await actions.openJobFile?.(applicationId, artifact?.id, artifact);
      }
    },
    openFile,
    exportFile: async (id) => {
      const file = view.browser.files.find((candidate) => String(candidate.id) === String(id));
      if (file?.applicationId && file?.packetKind) {
        const result = await run(() =>
          api.exportPacketDocuments({ applicationId: file.applicationId, formats: ["pdf"] })
        );
        const receipt = packetExportReceipt(result);
        if (receipt) setArtifactViewer(receipt);
        else if (result) setError("The export finished without returning a saved file path.");
      } else if (
        file?.applicationId &&
        /interview dossier/i.test(String(file.kind || file.name || ""))
      ) {
        await exportJobFile(file.applicationId, file);
      } else if (file && !downloadTextArtifact(file)) {
        setError("This file does not have exportable content yet.");
      }
    },
    exportJobFile,
    openPerson: (id) => {
      const person = view.browser.people.find((candidate) => candidate.id === id);
      if (!person) return;
      if (person.applicationId) {
        void openJob(person.applicationId);
        return;
      }
      setComposerValue(
        `Help me with ${person.name || "this contact"}${person.company ? ` at ${person.company}` : ""}.`
      );
      dispatch({ type: "browser.close" });
      dispatch({ type: "thread.open", id: "today" });
    },
    draftNudge: (id) => {
      const person = view.browser.people.find((candidate) => candidate.id === id);
      const decision = resolvePersonAction(person);
      setComposerValue(decision.prompt);
      if (decision.applicationId) void openJob(decision.applicationId);
      else {
        dispatch({ type: "browser.close" });
        dispatch({ type: "thread.open", id: "today" });
      }
    },
    openScheduleItem: (id) => {
      const item = view.browser.schedule
        .flatMap((group) => group.items)
        .find((event) => event.id === id);
      const applicationId = scheduleApplicationId(item);
      if (applicationId) {
        void openJob(applicationId);
        return;
      }
      if (!item) return;
      setComposerValue(
        item.actionLabel === "Get script"
          ? `Draft the script for ${item.title || "this follow-up"}.`
          : `Help me with ${item.title || "this scheduled item"}.`
      );
      dispatch({ type: "browser.close" });
      dispatch({ type: "thread.open", id: "today" });
    },
    calendarAction: (label) => {
      if (!calendarAction(label, view.browser.schedule)) {
        setError("No calendar event is ready to export yet.");
      }
    },
    openIngest: async () => {
      if (typeof api.openDeepIngestThread !== "function") return;
      const result = await run(() => api.openDeepIngestThread());
      if (result) dispatch({ type: "ingest.open" });
    },
    dismissIngestPrompt: async () => {
      if (typeof api.dismissDeepIngestPrompt !== "function") return;
      await run(() => api.dismissDeepIngestPrompt());
    },
    closeIngest: () => dispatch({ type: "ingest.close" }),
    ingestFiles,
    ingestPaste: () => openDeepInput("paste"),
    ingestLink: () => openDeepInput("repo"),
    setDeepInput: setDeepInputValue,
    submitDeepInput,
    cancelDeepInput,
    analyzeDeepSource,
    editDeepProposal,
    changeDeepProposalEdit,
    saveDeepProposalEdit: (proposal) => decideDeepProposal(proposal, "save_edits"),
    confirmDeepProposal: (proposal) => decideDeepProposal(proposal, "confirm"),
    deferDeepProposal: (proposal) => decideDeepProposal(proposal, "defer"),
    rejectDeepProposal: (proposal) => decideDeepProposal(proposal, "reject"),
    startMock,
    openMock: (applicationId) => dispatch({ type: "mock.open", applicationId }),
    endMock,
    pauseMission: (id) => run(() => api.setChatFirstMissionStatus({ id, status: "paused" })),
    resumeMission: (id) => run(() => api.resumeChatFirstMission(id)),
    decideNeed,
    closeGate: () => dispatch({ type: "gate.close" }),
    viewGateArtifact,
    requestGateChanges: () => {
      setComposerValue(`Change the application packet for ${activeGate?.company || "this job"}.`);
      dispatch({ type: "gate.close" });
      dispatch({ type: "thread.open", id: "today" });
      dispatch({
        type: "composer.set-context",
        ids: activeGate?.applicationId ? [activeGate.applicationId] : [],
      });
    },
    openGateHandoff: async () => {
      const focused = await run(() =>
        focusApplicationHandoff(activeGate, (type, entity, input) =>
          api.runWorkspaceIntent(type, entity, input)
        )
      );
      if (focused === false) {
        setError("The prepared application session is not available yet.");
      }
    },
    openJobFile: async (applicationId, _id, file) => {
      const normalizedFile = {
        ...file,
        packetKind:
          file?.packetKind ||
          { Resume: "resume", "Cover letter": "coverLetter", Answers: "answers" }[file?.kind],
      };
      const artifact = await run(() =>
        loadChatFirstArtifact({ api, applicationId, file: normalizedFile })
      );
      if (artifact) setArtifactViewer({ title: file.name, artifact });
      else setError(`${file?.name || "This file"} is not ready to preview yet.`);
    },
    closeArtifact: () => setArtifactViewer(null),
    decideCompanyProposal,
    closeCompanyProposalReview: () => setCompanyProposalReview(null),
    retryEngine: async () => {
      const [runtimeState] = await Promise.all([
        typeof api.getInstalledAiRuntimes === "function"
          ? api.getInstalledAiRuntimes().catch(() => null)
          : Promise.resolve(null),
        dashboard.refetch(),
      ]);
      setEngineDown(runtimeState ? engineUnavailable(runtimeState) : false);
      setTechnicalOpen(false);
    },
    openSettings: () => navigate("/settings"),
    showTechnical: () => setTechnicalOpen((current) => !current),
  };

  return (
    <ChatFirstAppView
      view={view}
      ui={ui}
      composerValue={composerValue}
      query={query}
      pipelineStage={pipelineStage}
      browserFilters={browserFilters}
      sourceSweep={sourceSweep}
      deepIngest={deepIngest}
      mockSession={mockSession}
      activeGate={activeGate}
      artifactViewer={artifactViewer}
      companyProposalReview={companyProposalReview}
      sourceReview={sourceReview}
      engineDown={engineDown}
      technicalDetails={
        technicalOpen
          ? error || "The selected local AI runtime did not return a usable response."
          : null
      }
      busy={busy || dashboard.loading}
      error={
        error ||
        (dashboard.noDatabase ? "CareerRat needs local setup before the workspace can open." : null)
      }
      activeSkillChat={activeSkillChat}
      actions={actions}
    />
  );
}
