import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArtifactViewerModal } from "../jobs/ArtifactViewerModal.jsx";
import { runJobsPageSearch } from "../jobs/jobsSearch.js";
import { chatFirstApi } from "./api.js";
import { filterFiles, filterPeople, filterSearchJobs } from "./browser-model.js";
import {
  calendarAction,
  commitComposerTurn,
  createMissionAndStart,
  downloadBinaryArtifact,
  downloadTextArtifact,
  engineUnavailable,
  findGate,
  isEngineFailure,
  loadChatFirstArtifact,
  mapActivityItems,
  mapComposerChips,
  mapMockSession,
  mockStartContext,
  openApplicationHandoff,
  packetExportReceipt,
  resolveNeedDecision,
  resolvePersonAction,
  resumeHydratedMission,
  scheduleApplicationId,
  selectedSourcedDismissal,
  sourceSweepPresentation,
} from "./chat-first-app-controller.js";
import {
  artifactEmoji,
  buildChatFirstView,
  chatFirstReducer,
  createChatFirstState,
  filterPipelineJobs,
} from "./chat-first-model.js";
import {
  CanonicalJobConversation,
  ConversationPanel,
  DeepIngestContext,
  DeepIngestConversation,
  EngineDownCover,
  JobContextPanel,
  MockInterviewContext,
  MockInterviewConversation,
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
  files: "All",
  people: "all",
});

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
  return error?.body?.error || error?.message || "That run could not finish.";
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
    { id: "pipeline", label: "Pipeline", meta: `${view.counts.pipeline} in play` },
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
  const lines = [offerPosition, source?.statusNote, source?.nextAction, source?.compNote]
    .map(jobContextLine)
    .filter(Boolean)
    .slice(0, 3);
  const files = artifactRows(detail).map((file) => {
    const dossier = /interview dossier/i.test(String(file.kind || file.name || ""));
    return {
      ...file,
      onOpen: () => actions.openJobFile?.(thread.applicationId, file.id, file),
      ...(dossier ? { onExport: () => actions.exportJobFile?.(thread.applicationId, file) } : {}),
    };
  });
  const canRunMock =
    /screen|assessment|technical|hiring manager|interview|onsite|final/i.test(
      String(thread.stage || "")
    ) || files.some((file) => /interview dossier/i.test(String(file.kind || file.name || "")));
  const canContinueMock =
    Boolean(mockSession?.id) &&
    (!mockSession.applicationId || mockSession.applicationId === thread.applicationId);
  return (
    <JobContextPanel
      job={{
        company: thread.company || thread.title,
        role: thread.role || "Role",
        stage: titleCase(thread.stage),
        fit: Number.isFinite(Number(thread.fitScore)) ? Number(thread.fitScore) : "Fit pending",
        badge: source?.conversations?.length
          ? `${source.conversations.length} rounds logged`
          : "thread history saved",
      }}
      summary={
        lines.length
          ? {
              title:
                String(thread.stage).toLowerCase() === "offer"
                  ? "Negotiation position"
                  : "Current position",
              lines,
            }
          : null
      }
      files={files}
      note="Every run, draft, and round for this job lives here, not in the main chat."
      action={
        canRunMock
          ? {
              label: canContinueMock ? "Continue mock interview" : "Run mock interview",
              onAction: () =>
                (canContinueMock ? actions.openMock : actions.startMock)?.(thread.applicationId),
            }
          : null
      }
    />
  );
}

function composerFor({ view, ui, composerValue, busy, actions }) {
  const chips = mapComposerChips(ui.composerChips, [
    ...view.browser.search,
    ...view.threads,
    ...view.archivedThreads,
  ]);
  return (
    <Composer
      agentName={view.agentName}
      value={composerValue}
      disabled={busy}
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
  engineDown = false,
  technicalDetails = null,
  busy = false,
  error = null,
  actions = {},
}) {
  const activeJob = threadForUi(view, ui);
  const activeMission = missionForView(view);
  const railActive =
    ui.activeThread === "mock" && activeJob ? activeJob.id : activeJob?.id || ui.activeThread;
  const composer = composerFor({ view, ui, composerValue, busy, actions });
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
            onDraftPackets={(ids) => actions.runCartMission?.(ids, "draft")}
            onDraftAndApply={(ids) => actions.runCartMission?.(ids, "prepare-to-submit")}
            onChatAbout={actions.chatAboutSelection}
            onDismissSelection={actions.dismissSelection}
          />
        </div>
        {overlays}
      </div>
    );
  }

  let conversation;
  let context;
  if (ui.activeThread === "ingest") {
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
    conversation = (
      <ConversationPanel composer={composer}>
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
        detail={`Question ${mapped.questionNumber} of ${mapped.totalQuestions}`}
        loadedContext={mapped.loadedContext || "Job description and confirmed story bank"}
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
  const missionExecutionRef = useRef(new Set());
  const [deepState, setDeepState] = useState(null);
  const [deepInputMode, setDeepInputMode] = useState(null);
  const [deepInputValue, setDeepInputValue] = useState("");
  const [deepEditingId, setDeepEditingId] = useState(null);
  const [deepEditDraft, setDeepEditDraft] = useState({});
  const [deepReceipt, setDeepReceipt] = useState(null);
  const [artifactViewer, setArtifactViewer] = useState(null);
  const [gatePacket, setGatePacket] = useState(null);

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
  const rawMock = list(view.mockSessions).find(
    (session) =>
      session?.status !== "ended" &&
      (!activeJob?.applicationId || session?.applicationId === activeJob.applicationId)
  );
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
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      await dashboard.refetch();
      setEngineDown(false);
      return result;
    } catch (cause) {
      setError(errorCopy(cause));
      if (isEngineFailure(cause)) setEngineDown(true);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function openThread(id) {
    dispatch({ type: "thread.open", id });
  }

  async function submitComposer(text) {
    const clean = String(text || "").trim();
    if (!clean || busy) return;
    const result = await run(async () => {
      if (ui.activeThread === "mock" && rawMock?.id) {
        return api.sendMockInterviewTurn({ sessionId: rawMock.id, text: clean });
      }
      if (ui.activeThread === "ingest") {
        return captureSourceAndRefresh({ api, kind: "paste", value: clean });
      }
      if (activeJob?.applicationId) {
        return api.sendJobThreadTurn({ applicationId: activeJob.applicationId, text: clean });
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
    if (ui.activeThread === "ingest" && result?.view) {
      setDeepState(result.view);
      const next = buildDeepIngestReview(result.view);
      setDeepReceipt(
        `Material saved locally. ${next.counts.reviewQueue} proposal${next.counts.reviewQueue === 1 ? "" : "s"} need review.`
      );
    }
  }

  async function runCartMission(ids, mode) {
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
    sweepBaselineRef.current = new Set(baseView.browser.search.map((row) => row.id));
    setNewSearchIds([]);
    const controller = new AbortController();
    const result = await runJobsPageSearch({
      startSearchRun: api.startSearchRun,
      getSourcingRun: api.getSourcingRun,
      refetch: dashboard.refetch,
      setSearchRun: (searchRun) => setSourceSweep(sourceSweepPresentation(searchRun)),
      setSearchError: (message) => {
        if (message) setSourceSweep({ status: "error", summary: message });
      },
      signal: controller.signal,
    });
    if (result?.ok) setSweepComparison((current) => current + 1);
    else if (!result?.timedOut) sweepBaselineRef.current = null;
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
    if (rawMock?.id) await run(() => api.endMockInterview({ sessionId: rawMock.id }));
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
    runSweep,
    setQuery,
    openSourceHealth: () => navigate("/settings", { state: { activeTab: "settings" } }),
    filterBrowser: (filter) => {
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
    openIngest: () => dispatch({ type: "ingest.open" }),
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
    openGateHandoff: () => {
      if (!openApplicationHandoff(activeGate))
        setError("The prepared application does not have a safe portal link yet.");
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
      actions={actions}
    />
  );
}
