import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Button } from "../components/Button.jsx";
import { Chip } from "../components/Chip.jsx";
import { CompanyAvatar } from "../components/CompanyAvatar.jsx";
import { Field, Select, TextField, Toggle } from "../components/form.jsx";
import { ChevronDownIcon, ListIcon, SearchIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  getRuntimeConfig,
  getSearchSources,
  getSourcingRun,
  setSourcedStatus,
} from "../lib/api.js";
import { GENERIC_ERROR_MESSAGE, resolveErrorCopy } from "../lib/errorCopy.js";
import { FunnelSankey } from "./FunnelSankey.jsx";
import { InterviewDossierCard } from "./InterviewDossierCard.jsx";
import { JobDrawer } from "./JobDrawer.jsx";
import {
  DEFAULT_EXPLORER_STATE,
  railActionToFilters,
  rowMatchesFilters,
  sanitizeExplorerState,
  sortRows,
  stageLabelFor,
} from "./jobsExplorer.js";
import { PREVIEW_JOBS } from "./jobsPreviewData.js";
import { hasDbSourceSetup, runAiWebSearchLane, runJobsPageSearch } from "./jobsSearch.js";
import { GateBadge } from "./PacketGateCard.jsx";
import { deriveJobCta, useApplicationGates } from "./useApplicationGates.js";

const STORAGE_KEY = "careerrat-jobs-next-explorer";

const TAB_OPTIONS = [
  { key: "pipeline", label: "Pipeline" },
  { key: "search", label: "Finder" },
];

const SEARCH_FILTERS = [
  { key: "review", label: "Review" },
  { key: "high", label: "High Fit" },
  { key: "fresh", label: "Fresh" },
  { key: "all", label: "All" },
];

const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "needs-action", label: "Needs action" },
  { value: "interview", label: "Interview path" },
  { value: "stale", label: "Stale applications" },
  { value: "ghosted", label: "Ghosted" },
  { value: "missing-comp", label: "Missing comp" },
  { value: "high-fit", label: "High fit" },
  { value: "watch", label: "Waiting" },
  { value: "review", label: "Needs review" },
];

const MODE_OPTIONS = [
  { value: "all", label: "All modes" },
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "On-site" },
  { value: "relo", label: "Relocation" },
];

const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "referral", label: "Referral" },
  { value: "recruiter", label: "Recruiter" },
  { value: "board", label: "Job board" },
  { value: "portal", label: "ATS portal" },
  { value: "sourced", label: "New sourced" },
];

const SORT_OPTIONS = [
  { value: "action", label: "Action" },
  { value: "company", label: "Company" },
  { value: "role", label: "Role" },
  { value: "base", label: "Base" },
  { value: "mode", label: "Mode" },
  { value: "fit", label: "Fit" },
  { value: "stage", label: "Stage" },
  { value: "applied", label: "Applied" },
];

const SORT_COLUMNS = [
  { key: "company", label: "Company / Role" },
  { key: "stage", label: "Stage" },
  { key: "action", label: "Next Action" },
  { key: "due", label: "Due", sortable: false },
  { key: "applied", label: "Last Touch" },
  { key: "fit", label: "Fit" },
];

function loadExplorerState() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return DEFAULT_EXPLORER_STATE;
    const raw = storage.getItem(STORAGE_KEY);
    return sanitizeExplorerState(JSON.parse(raw || "{}"));
  } catch (_error) {
    return DEFAULT_EXPLORER_STATE;
  }
}

export function JobsPage() {
  const { data, loading, error, noDatabase, refetch } = useDashboardSnapshot();
  const [loadedSearchSources, setLoadedSearchSources] = useState(null);
  const [sourceSetupError, setSourceSetupError] = useState(null);
  const [manualSearchError, setManualSearchError] = useState(null);
  const [manualSearchRun, setManualSearchRun] = useState(null);
  const [manualSearchPending, setManualSearchPending] = useState(false);
  const manualSearchAbortRef = useRef(null);
  const [runtimeConfig, setRuntimeConfig] = useState(null);
  const [aiSearchStatus, setAiSearchStatus] = useState("idle"); // idle | running | results | error
  const [aiSearchActivity, setAiSearchActivity] = useState(null);
  const [aiSearchCounts, setAiSearchCounts] = useState(null);
  const [aiSearchError, setAiSearchError] = useState(null);
  const [aiSearchElapsedMs, setAiSearchElapsedMs] = useState(null);
  const aiSearchAbortRef = useRef(null);
  const [explorerState, setExplorerState] = useState(loadExplorerState);
  const [queryDraft, setQueryDraft] = useState(explorerState.query);
  const [searchParams, setSearchParams] = useSearchParams();
  const [skippingId, setSkippingId] = useState(null);
  const [skipError, setSkipError] = useState(null);
  const gatesByAppId = useApplicationGates();

  const snapshot = data ? jobsForPage(data) : null;
  const model = useMemo(
    () => buildJobsModel(snapshot, loadedSearchSources, manualSearchRun),
    [snapshot, loadedSearchSources, manualSearchRun]
  );
  const tab = normalizeTab(searchParams.get("tab"));
  const searchFilter = normalizeSearchFilter(searchParams.get("queue"));
  const openId = searchParams.get("open");
  const dossierId = searchParams.get("dossier");
  const openSection = searchParams.get("section") || null;
  const openRow = openId ? model.rows.find((row) => row.id === openId) : null;
  const dossierRow = dossierId ? model.rows.find((row) => row.id === dossierId) : null;
  const sourceSetupReady = hasDbSourceSetup(model.sourceSetup);
  const manualSearchRunning = manualSearchPending || model.manualSearchRun?.status === "running";
  const visibleManualSearchError =
    manualSearchError || snapshot?.sourcing?.manualSearchError || null;
  const aiWebSearchAvailable = runtimeConfig?.aiWebSearch?.available === true;
  const aiSearchRunning = aiSearchStatus === "running";
  const aiSearchReady = aiWebSearchAvailable;
  const aiSearchDisabled = aiSearchRunning ? false : !aiSearchReady;
  const aiSearchStatusText = describeAiSearchStatusText(
    aiSearchStatus,
    aiSearchActivity,
    aiSearchCounts
  );
  const visibleAiSearchError = aiSearchStatus === "error" ? aiSearchError : null;
  const aiRetryPromptIds = Array.isArray(aiSearchCounts?.failedPromptIds)
    ? aiSearchCounts.failedPromptIds
    : [];
  const aiSearchAttached = Boolean(aiSearchAbortRef.current);
  // Tab labels carry live counts per the canvas ("Pipeline · 6" / "Finder ·
  // 7 new") — Pipeline counts committed, non-terminal work; Finder counts
  // sourced roles still in the default review queue (filterSearchRows below).
  const pipelineCount = model.rows.filter(
    (row) => row.source !== "sourced" && !row.terminal
  ).length;
  const finderNewCount = filterSearchRows(model.sourcedRoles, "review").length;
  // Sweep-line receipt (design handoff 3b): the free-board lane uses the
  // deterministic coarse-triage score shown with a ~ prefix. The AI lane's chip names the
  // real configured route (never a hardcoded CLI name — runtime/config only
  // exposes route type, not a specific tool) and a client-measured elapsed
  // time, shown once a run completes.
  const aiSearchElapsedS = Number.isFinite(aiSearchElapsedMs)
    ? Math.max(0, Math.round(aiSearchElapsedMs / 1000))
    : null;
  const aiSearchReceipt =
    aiSearchStatus === "results" && aiSearchElapsedS !== null
      ? `AI · ${describeAiRouteLabel(runtimeConfig?.ai?.route)} · ${aiSearchElapsedS}S`
      : null;

  useEffect(() => {
    let cancelled = false;
    getRuntimeConfig()
      .then((config) => {
        if (!cancelled) setRuntimeConfig(config);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // AI-search runs live in the same durable sourcing ledger as free-board
  // sweeps. Restore the latest terminal result after navigation/restart and
  // briefly poll a detached running record until its server-side run settles.
  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const loadLatest = async () => {
      try {
        const body = await getSourcingRun({ purpose: "ai-web-search" });
        if (cancelled || aiSearchAbortRef.current) return;
        const run = body?.run;
        if (!run) return;
        if (run.status === "running") {
          setAiSearchStatus("running");
          setAiSearchActivity(run.progress?.lastActivity || "AI web search is still running…");
          timer = globalThis.setTimeout(loadLatest, 1500);
          return;
        }
        if (run.status === "completed") {
          setAiSearchCounts(run.summary || null);
          setAiSearchStatus("results");
          setAiSearchActivity(null);
          return;
        }
        if (run.status === "failed") {
          setAiSearchCounts(run.error || null);
          setAiSearchError(run.error?.message || "AI web search failed.");
          setAiSearchStatus("error");
          setAiSearchActivity(null);
        }
      } catch {
        // This restore path is advisory; runtime availability and the normal
        // search controls remain usable when no durable ledger can be read.
      }
    };

    void loadLatest();
    return () => {
      cancelled = true;
      if (timer) globalThis.clearTimeout(timer);
    };
  }, []);

  // Abort any in-flight AI web-search stream on unmount — a navigation away
  // mid-run must not leave a stream updating state on a detached component
  // (same discipline as ResumeStep's streamAbortRef cleanup).
  useEffect(() => {
    return () => {
      aiSearchAbortRef.current?.abort();
    };
  }, []);

  // Same discipline for the free-board search's poll loop (see
  // pollManualSearchRun in jobsSearch.js) — that loop can run for minutes, so
  // navigating away mid-poll must not keep setting state on a detached page.
  useEffect(() => {
    return () => {
      manualSearchAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!snapshot || snapshot.searchSources || snapshot.sourceSetup || model.preview)
      return undefined;

    let cancelled = false;
    function retryLoadSearchSources() {
      if (cancelled) return;
      loadSearchSources();
    }
    function loadSearchSources() {
      setSourceSetupError(null);
      getSearchSources()
        .then((body) => {
          if (cancelled) return;
          setLoadedSearchSources(body);
          setSourceSetupError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setSourceSetupError(describeJobsSearchError(err, retryLoadSearchSources));
        });
    }
    loadSearchSources();

    return () => {
      cancelled = true;
    };
  }, [snapshot, model.preview]);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(
        STORAGE_KEY,
        JSON.stringify(sanitizeExplorerState(explorerState))
      );
    } catch (_error) {}
  }, [explorerState]);

  useEffect(() => {
    const normalized = queryDraft.trim().toLowerCase().slice(0, 120);
    const timer = setTimeout(() => {
      setExplorerState((prev) =>
        prev.query === normalized ? prev : sanitizeExplorerState({ ...prev, query: normalized })
      );
    }, 160);
    return () => clearTimeout(timer);
  }, [queryDraft]);

  useEffect(() => {
    setQueryDraft(explorerState.query);
  }, [explorerState.query]);

  function setTab(nextTab) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", nextTab);
      if (nextTab !== "search") next.delete("queue");
      return next;
    });
  }

  function setSearchQueue(nextQueue) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", "search");
      next.set("queue", nextQueue);
      return next;
    });
  }

  // `section` deep-links into one of the drawer's new sections (Phase D's
  // derived CTA) — optional, so every existing onOpen(id) call site (row
  // click, "Open" button) keeps working unchanged.
  function openDrawer(id, section) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("open", id);
      next.delete("dossier");
      if (section) next.set("section", section);
      else next.delete("section");
      return next;
    });
  }

  function closeDrawer() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("open");
      next.delete("section");
      return next;
    });
  }

  function closeDossier() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("dossier");
      return next;
    });
  }

  // Skip a sourced role — taxonomy's archived/recoverable "cut" state (see
  // track-outcomes SKILL.md's canonical status vocabulary; there's no
  // separate "park"/"hold" sourced[] state to distinguish from this).
  async function handleSkipSourced(id) {
    setSkippingId(id);
    setSkipError(null);
    try {
      await setSourcedStatus({ id, to: "cut" });
      await refetch();
    } catch (err) {
      const resolved = resolveErrorCopy(err);
      setSkipError(
        resolved.action?.retry
          ? { ...resolved, action: { ...resolved.action, onRetry: () => handleSkipSourced(id) } }
          : resolved
      );
    } finally {
      setSkippingId(null);
    }
  }

  async function handleManualSearch() {
    const controller = new AbortController();
    manualSearchAbortRef.current = controller;
    setManualSearchPending(true);
    try {
      await runJobsPageSearch({
        refetch,
        setSearchError: setManualSearchError,
        setSearchRun: setManualSearchRun,
        signal: controller.signal,
      });
    } finally {
      setManualSearchPending(false);
      if (manualSearchAbortRef.current === controller) manualSearchAbortRef.current = null;
    }
  }

  async function handleAiWebSearch(promptIds) {
    const controller = new AbortController();
    aiSearchAbortRef.current = controller;
    await runAiWebSearchLane({
      promptIds: Array.isArray(promptIds) ? promptIds : undefined,
      refetch,
      signal: controller.signal,
      setStatus: setAiSearchStatus,
      setActivity: setAiSearchActivity,
      setCounts: setAiSearchCounts,
      setError: setAiSearchError,
      setElapsedMs: setAiSearchElapsedMs,
    });
    if (aiSearchAbortRef.current === controller) aiSearchAbortRef.current = null;
  }

  function handleAiWebSearchAbort() {
    aiSearchAbortRef.current?.abort();
  }

  function updateExplorer(patch) {
    setExplorerState((prev) => sanitizeExplorerState({ ...prev, ...patch }));
  }

  function selectStage(filter) {
    const selected = filter || "all";
    setExplorerState((prev) =>
      sanitizeExplorerState({
        ...prev,
        stage: prev.stage === selected ? "all" : selected,
        showTerminal: false,
      })
    );
  }

  function applyRailAction(action) {
    setExplorerState(railActionToFilters(action));
  }

  function clearFilters() {
    setQueryDraft("");
    setExplorerState((prev) =>
      sanitizeExplorerState({
        ...DEFAULT_EXPLORER_STATE,
        sortKey: prev.sortKey,
        sortDir: prev.sortDir,
        view: prev.view,
      })
    );
  }

  if (noDatabase) {
    return (
      <div className="jobs">
        <InlineAlert message="This workspace hasn't finished setup yet. Finish setup, then reload." />
      </div>
    );
  }

  return (
    <div className="jobs">
      <header className="jobs__hero">
        <div className="jobs__title-block">
          {model.preview ? <span className="jobs__eyebrow">Preview Data</span> : null}
          <h1 className="jobs__title">Jobs</h1>
        </div>
        <div className="jobs__tabs" role="tablist" aria-label="Jobs view mode">
          {TAB_OPTIONS.map((option) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === option.key}
              className={`jobs__tab${tab === option.key ? " jobs__tab--active" : ""}`}
              key={option.key}
              onClick={() => setTab(option.key)}
            >
              {option.key === "pipeline"
                ? `${option.label} · ${pipelineCount}`
                : `${option.label} · ${finderNewCount} new`}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <InlineAlert message={error.message} action={error.action} detail={error.detail} />
      ) : null}
      {sourceSetupError ? (
        <InlineAlert
          message={sourceSetupError.message}
          action={sourceSetupError.action}
          detail={sourceSetupError.detail}
        />
      ) : null}
      {visibleManualSearchError ? <InlineAlert message={visibleManualSearchError} /> : null}
      {visibleAiSearchError ? <InlineAlert message={visibleAiSearchError} /> : null}
      {skipError ? (
        <InlineAlert
          message={skipError.message}
          action={skipError.action}
          detail={skipError.detail}
        />
      ) : null}
      {loading ? <p className="dashboard-home__loading">Loading…</p> : null}

      {snapshot && tab === "pipeline" ? (
        <PipelineView
          gatesByAppId={gatesByAppId}
          model={model}
          queryDraft={queryDraft}
          state={explorerState}
          onApplyRailAction={applyRailAction}
          onClear={clearFilters}
          onOpen={openDrawer}
          onQueryDraft={setQueryDraft}
          onSelectStage={selectStage}
          onUpdate={updateExplorer}
        />
      ) : null}
      {snapshot && tab === "search" ? (
        <SearchView
          aiSearch={{
            actionLabel: aiSearchRunning
              ? aiSearchAttached
                ? "Cancel search"
                : "Search running…"
              : aiRetryPromptIds.length
                ? `Retry ${aiRetryPromptIds.length} failed ${aiRetryPromptIds.length === 1 ? "query" : "queries"}`
                : "Run AI Web Search",
            body: describeAiSearchBody({
              status: aiSearchStatus,
              activity: aiSearchActivity,
              available: aiWebSearchAvailable,
            }),
            disabled: aiSearchDisabled || (aiSearchRunning && !aiSearchAttached),
            extra: <AiSearchFailureDetails counts={aiSearchCounts} />,
            meta: aiSearchMetaLabel({
              running: aiSearchRunning,
              available: aiWebSearchAvailable,
            }),
            onAction: aiSearchRunning
              ? handleAiWebSearchAbort
              : () => handleAiWebSearch(aiRetryPromptIds),
            receipt: aiSearchReceipt,
            statusText: aiSearchStatusText,
            title: aiSearchTitleLabel({ available: aiWebSearchAvailable }),
          }}
          filter={searchFilter}
          manualSearchRunning={manualSearchRunning}
          model={model}
          onFilter={setSearchQueue}
          onOpen={openDrawer}
          onSearch={handleManualSearch}
          onSkip={handleSkipSourced}
          skippingId={skippingId}
          sourceSetupReady={sourceSetupReady}
        />
      ) : null}

      {openRow && !dossierRow ? (
        <JobDrawer row={openRow} onClose={closeDrawer} initialSection={openSection} />
      ) : null}
      {dossierRow ? (
        <InterviewDossierCard applicationId={dossierRow.id} fullPage onClose={closeDossier} />
      ) : null}
    </div>
  );
}

function PipelineView({
  gatesByAppId,
  model,
  queryDraft,
  state,
  onApplyRailAction,
  onClear,
  onOpen,
  onQueryDraft,
  onSelectStage,
  onUpdate,
}) {
  const filteredRows = useMemo(
    () =>
      sortRows(
        model.rows.filter((row) => rowMatchesFilters(row, state)),
        state.sortKey,
        state.sortDir
      ),
    [model.rows, state]
  );
  const stageLabel = stageLabelFor(state.stage, model.sankey);
  const denominator =
    state.stage === "all" && !state.showTerminal
      ? model.rows.filter((row) => !row.terminal).length
      : model.rows.length;
  const chips = filterChips(state, stageLabel);

  function setSort(key) {
    if (state.sortKey === key) {
      onUpdate({ sortDir: state.sortDir === 1 ? -1 : 1 });
    } else {
      onUpdate({ sortKey: key, sortDir: key === "company" || key === "role" ? 1 : -1 });
    }
  }

  function removeFilter(key) {
    if (key === "query") {
      onQueryDraft("");
      onUpdate({ query: "" });
    } else if (key === "stage") {
      onUpdate({ stage: "all", showTerminal: false });
    } else if (key === "action") {
      onUpdate({ action: "all", reviewOnly: false });
    } else if (key === "reviewOnly") {
      onUpdate({ reviewOnly: false });
    } else if (key === "showTerminal") {
      onUpdate({ showTerminal: false });
    } else {
      onUpdate({ [key]: DEFAULT_EXPLORER_STATE[key] });
    }
  }

  return (
    <>
      <FunnelSankey
        sankey={model.sankey}
        activeFilter={state.stage}
        onSelectStage={onSelectStage}
      />

      {model.nextDecision?.hasWork ? (
        <section className="jobs__decision-strip">
          <div>
            <span className="jobs__eyebrow">Next decision</span>
            <h2>{model.nextDecision.title}</h2>
            <p>{model.nextDecision.summary}</p>
          </div>
          <Button onClick={() => onApplyRailAction(model.nextDecision.action)}>
            {decisionActionLabel(model.nextDecision.action)}
          </Button>
        </section>
      ) : null}

      <section className="jobs__panel">
        <ExplorerToolbar
          queryDraft={queryDraft}
          sankey={model.sankey}
          state={state}
          onClear={onClear}
          onQueryDraft={onQueryDraft}
          onUpdate={onUpdate}
        />
        <div className="jobs__summary-row">
          <span>
            Showing {filteredRows.length} of {denominator} jobs · {stageLabel}
          </span>
          {chips.length ? <span>{chips.length} active filters</span> : null}
        </div>
        {chips.length ? (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: labeled chip group, not a form control group
          <div aria-label="Active job filters" className="jobs__chip-row">
            {chips.map((chip) => (
              <Chip key={chip.key} onRemove={() => removeFilter(chip.key)}>
                {chip.label}
              </Chip>
            ))}
          </div>
        ) : null}

        {filteredRows.length ? (
          state.view === "table" ? (
            <JobsTable
              gatesByAppId={gatesByAppId}
              rows={filteredRows}
              state={state}
              onOpen={onOpen}
              onSort={setSort}
            />
          ) : (
            <div className="jobs__cards">
              {filteredRows.map((row) => (
                <JobsCard key={row.id} gate={gatesByAppId[row.id]} row={row} onOpen={onOpen} />
              ))}
            </div>
          )
        ) : (
          <div className="jobs__empty">No jobs match these filters.</div>
        )}
      </section>
    </>
  );
}

function ExplorerToolbar({ queryDraft, sankey, state, onClear, onQueryDraft, onUpdate }) {
  return (
    <>
      <header className="jobs__panel-header">
        <h2>
          <span className="jobs__panel-icon">
            <ListIcon />
          </span>
          <span>Jobs Explorer</span>
        </h2>
        <div className="jobs__header-controls">
          <Toggle
            id="jobs-show-ghosted"
            checked={!!state.showGhosted}
            onChange={(value) => onUpdate({ showGhosted: value })}
            label="Show ghosted"
          />
          <Toggle
            id="jobs-hide-stale"
            checked={!!state.hideStale}
            onChange={(value) => onUpdate({ hideStale: value })}
            label="Hide stale"
          />
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: labeled toggle-button group, not a form control group */}
          <div aria-label="Explorer view" className="jobs__view-toggle">
            {["table", "cards"].map((view) => (
              <button
                type="button"
                key={view}
                aria-pressed={state.view === view}
                className={state.view === view ? "is-active" : ""}
                onClick={() => onUpdate({ view })}
              >
                {view === "table" ? "Table" : "Cards"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="jobs__toolbar">
        <div className="jobs__search">
          <SearchIcon className="jobs__search-icon" />
          <input
            id="jobs-query"
            className="jobs__search-input"
            type="search"
            placeholder="Company, role, location, source"
            value={queryDraft}
            onChange={(event) => onQueryDraft(event.target.value)}
            aria-label="Search jobs"
          />
        </div>
        <details className="jobs__filters">
          <summary className="jobs__filters-trigger">
            <span>Filters</span>
            <ChevronDownIcon />
          </summary>
          <div className="jobs__filters-panel">
            <div className="jobs__filters-grid">
              <Field label="Stage" htmlFor="jobs-stage">
                <Select
                  id="jobs-stage"
                  value={state.stage}
                  onChange={(value) => onUpdate({ stage: value, showTerminal: false })}
                  options={stageOptions(sankey)}
                />
              </Field>
              <Field label="Action" htmlFor="jobs-action">
                <Select
                  id="jobs-action"
                  value={state.action}
                  onChange={(value) => onUpdate({ action: value, reviewOnly: value === "review" })}
                  options={ACTION_OPTIONS}
                />
              </Field>
              <Field label="Mode" htmlFor="jobs-mode">
                <Select
                  id="jobs-mode"
                  value={state.mode}
                  onChange={(value) => onUpdate({ mode: value })}
                  options={MODE_OPTIONS}
                />
              </Field>
              <Field label="Source" htmlFor="jobs-source">
                <Select
                  id="jobs-source"
                  value={state.source}
                  onChange={(value) => onUpdate({ source: value })}
                  options={SOURCE_OPTIONS}
                />
              </Field>
              <Field label="Min base" htmlFor="jobs-min-comp">
                <TextField
                  id="jobs-min-comp"
                  type="number"
                  min="0"
                  max="2000"
                  value={state.minComp}
                  onChange={(value) => onUpdate({ minComp: value })}
                />
              </Field>
              <Field label="Min fit" htmlFor="jobs-min-fit">
                <TextField
                  id="jobs-min-fit"
                  type="number"
                  min="0"
                  max="100"
                  value={state.minFit}
                  onChange={(value) => onUpdate({ minFit: value })}
                />
              </Field>
              <Field label="Sort" htmlFor="jobs-sort">
                <div className="jobs__sort-control">
                  <Select
                    id="jobs-sort"
                    value={state.sortKey}
                    onChange={(value) => onUpdate({ sortKey: value })}
                    options={SORT_OPTIONS}
                  />
                  <button
                    type="button"
                    className="jobs__icon-button"
                    aria-label={state.sortDir === 1 ? "Sort descending" : "Sort ascending"}
                    onClick={() => onUpdate({ sortDir: state.sortDir === 1 ? -1 : 1 })}
                  >
                    {state.sortDir === 1 ? "↑" : "↓"}
                  </button>
                </div>
              </Field>
            </div>
            <div className="jobs__filters-actions">
              <button type="button" className="jobs__clear" onClick={onClear}>
                Clear
              </button>
            </div>
          </div>
        </details>
      </div>
    </>
  );
}

function JobsTable({ gatesByAppId, rows, state, onOpen, onSort }) {
  return (
    <div className="jobs__table-wrap">
      <table className="jobs__table">
        <thead>
          <tr>
            {SORT_COLUMNS.map((column) =>
              column.sortable === false ? (
                <th key={column.key}>{column.label}</th>
              ) : (
                <SortHeader
                  key={column.key}
                  column={column}
                  state={state}
                  onSort={() => onSort(column.key)}
                />
              )
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cta = deriveJobCta(row, gatesByAppId[row.id]);
            return (
              // biome-ignore lint/a11y/useSemanticElements: a <tr> can't be replaced with <button> without breaking table semantics; role+tabIndex+onKeyDown make it keyboard-operable
              <tr
                key={row.id}
                role="button"
                tabIndex={0}
                aria-label={`Open ${row.company} ${row.role}`}
                onClick={() => onOpen(row.id, cta?.section)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(row.id, cta?.section);
                  }
                }}
              >
                <td>
                  <span className="jobs__company-cell">
                    <CompanyAvatar name={row.company} domain={row.domain} size={34} />
                    <span>
                      <span className="jobs__company-name">{row.company}</span>
                      <span className="jobs__subline">{row.role}</span>
                    </span>
                    <HealthBadge badge={row.healthBadge} />
                  </span>
                </td>
                <td>
                  <span className="jobs__stage-cell">
                    <span className="jobs__stage-pill">{row.stageLabel || row.stage}</span>
                    <DecayPill row={row} />
                  </span>
                </td>
                <td>
                  <span className="jobs__next-action">
                    {cta?.label || row.action?.cta || "Open details"}
                    <span aria-hidden="true" className="jobs__next-action-arrow">
                      →
                    </span>
                  </span>
                </td>
                <td className="jobs__num">
                  {row.action?.dueText ? (
                    <span
                      className={
                        /today|overdue/i.test(row.action.dueText) ? "jobs__due-urgent" : undefined
                      }
                    >
                      {row.action.dueText}
                    </span>
                  ) : (
                    "–"
                  )}
                </td>
                <td className="jobs__num">{row.appliedLabel || row.appliedAt || "–"}</td>
                <td className="jobs__num">
                  <FitValue row={row} />
                  <GateBadge gate={gatesByAppId[row.id]?.gate} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({ column, state, onSort }) {
  const active = state.sortKey === column.key;
  const ariaSort = active ? (state.sortDir === 1 ? "ascending" : "descending") : "none";
  return (
    <th aria-sort={ariaSort}>
      <button type="button" className="jobs__sort-header" onClick={onSort}>
        <span>{column.label}</span>
        <span aria-hidden="true">{active ? (state.sortDir === 1 ? "↑" : "↓") : ""}</span>
      </button>
    </th>
  );
}

function JobsCard({ gate, row, onOpen }) {
  const cta = deriveJobCta(row, gate);
  return (
    <article className="jobs__card">
      <button type="button" className="jobs__card-button" onClick={() => onOpen(row.id)}>
        <span className="jobs__card-head">
          <CompanyAvatar name={row.company} domain={row.domain} size={38} />
          <span className="jobs__card-title">
            <strong>{row.company}</strong>
            <span>{row.role}</span>
          </span>
          <HealthBadge badge={row.healthBadge} />
        </span>
        <span className="jobs__card-meta">
          {row.location ? <span>{row.location}</span> : null}
          {row.comp ? <span>{row.comp}</span> : null}
          <span>
            Fit <FitValue row={row} />
          </span>
          <GateBadge gate={gate?.gate} />
        </span>
        <span className="jobs__card-footer">
          <span className="jobs__stage-cell">
            <span className="jobs__stage-pill">{row.stageLabel || row.stage}</span>
            <DecayPill row={row} />
          </span>
          <span className="jobs__action-cell">
            <span>{row.action?.cta || "Open details"}</span>
            {row.action?.dueText ? <small>{row.action.dueText}</small> : null}
          </span>
        </span>
      </button>
      {cta ? (
        <button
          type="button"
          className="jobs__cta-button jobs__cta-button--card"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(row.id, cta.section);
          }}
        >
          {cta.label}
        </button>
      ) : null}
    </article>
  );
}

function SearchView({
  aiSearch,
  filter,
  manualSearchRunning,
  model,
  onFilter,
  onOpen,
  onSearch,
  onSkip,
  skippingId,
  sourceSetupReady,
}) {
  const filteredRoles = filterSearchRows(model.sourcedRoles, filter);
  return (
    <>
      <section className="jobs__search-launcher" aria-label="Search launchers">
        <SearchModeCard
          actionLabel={manualSearchRunning ? "Searching…" : "Search Free Boards"}
          disabled={!sourceSetupReady || manualSearchRunning}
          eyebrow="Free boards"
          meta={sourceSetupReady ? "Ready" : "Setup needed"}
          onAction={onSearch}
          title={sourceSetupReady ? "Free Job Board Search" : "Finish Search Setup"}
        >
          {sourceSetupSummary(model.sourceSetup, sourceSetupReady)}
        </SearchModeCard>
        <SearchModeCard
          actionLabel={aiSearch.actionLabel}
          disabled={aiSearch.disabled}
          eyebrow="AI web search"
          meta={aiSearch.meta}
          onAction={aiSearch.onAction}
          title={aiSearch.title}
          extra={aiSearch.extra}
        >
          {aiSearch.body}
        </SearchModeCard>
      </section>

      {!sourceSetupReady ? (
        <section className="jobs__setup-inline" aria-live="polite">
          No search sources set up yet. Add tracked companies or a job board in Settings or
          Onboarding, then reload this page.
        </section>
      ) : null}

      <section className="jobs__panel">
        <PanelHeader
          icon={<SearchIcon />}
          title="Found Roles"
          meta={`${filteredRoles.length} roles`}
        />
        <LaneReceipt
          engine="RULES · APPROXIMATE TRIAGE"
          label={
            manualSearchRunning
              ? "Finding roles…"
              : describeManualRunSummary(model.manualSearchRun) ||
                sourceSetupSummary(model.sourceSetup, sourceSetupReady)
          }
        />
        <LaneReceipt engine={aiSearch.receipt} label={aiSearch.statusText || aiSearch.body} />
        <div className="jobs__filter-bar">
          <fieldset className="jobs__filter-group">
            <legend>Found Role Filters</legend>
            {SEARCH_FILTERS.map((option) => (
              <button
                type="button"
                className={`jobs__filter${filter === option.key ? " jobs__filter--active" : ""}`}
                aria-pressed={filter === option.key}
                key={option.key}
                onClick={() => onFilter(option.key)}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
          <span className="jobs__applied-filter">
            {SEARCH_FILTERS.find((option) => option.key === filter)?.label || "Review"}
          </span>
        </div>
        <div className="jobs__row-list">
          {filteredRoles.length ? (
            filteredRoles.map((row) => (
              <SearchResultRow
                key={row.id}
                row={row}
                onOpen={onOpen}
                onSkip={onSkip}
                skipping={skippingId === row.id}
              />
            ))
          ) : (
            <div className="jobs__empty">No sourced roles match this queue.</div>
          )}
        </div>
      </section>
    </>
  );
}

function SearchModeCard({
  actionLabel,
  children,
  disabled,
  eyebrow,
  extra,
  meta,
  onAction,
  title,
}) {
  return (
    <article className="jobs__search-mode">
      <div className="jobs__search-mode-head">
        <span className="jobs__search-kicker">{eyebrow}</span>
        {meta ? <span className="jobs__source-pill">{meta}</span> : null}
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {extra}
      <Button className="jobs__search-button" disabled={disabled} onClick={onAction}>
        {actionLabel}
      </Button>
    </article>
  );
}

// A completed run's `summary` (src/cli/sourcing-route.mjs) is a structured
// object — { attemptedSources, scanned, new, errorCount, offerCount,
// zeroResults, deterministicSources } — not the plain string preview/demo
// data uses. Rendering the object directly as a React child would crash, so
// format it into a sentence here; strings pass through unchanged.
export function describeManualRunSummary(run) {
  const summary = run?.summary;
  if (run?.status === "failed" || !summary) return null;
  if (typeof summary === "string") return summary;
  if (summary.zeroResults) return "Free-board sweep finished. No new roles this pass.";
  const scanned = Number(summary.scanned || 0);
  const newRoles = Number(summary.new || 0);
  const attemptedSources = Number(summary.attemptedSources || 0);
  const errorCount = Number(summary.errorCount || 0);
  let text = `Free-board sweep: ${scanned} scanned, ${newRoles} new roles from ${attemptedSources} sources.`;
  if (errorCount > 0) text += ` ${errorCount} source errors.`;
  return text;
}

// One receipt strip per lane (design handoff 3b) — the free-board lane's
// engine chip names its deterministic approximate triage; the AI lane's chip
// only appears once a run has actually completed (see aiSearchReceipt in
// JobsPage above), so nothing here ever fabricates an engine name or time.
function LaneReceipt({ engine, label }) {
  return (
    <div className="jobs__search-status" aria-live="polite">
      <span>{label}</span>
      {engine ? <span className="jobs__search-status-engine">{engine}</span> : null}
    </div>
  );
}

function SearchResultRow({ row, onOpen, onSkip, skipping }) {
  const actionable =
    !row.terminal &&
    !["cut", "skipped", "dismissed", "ignored", "withdrawn"].includes(
      String(row.status || "").toLowerCase()
    );
  return (
    <div className="jobs__row jobs__result-row">
      <CompanyAvatar name={row.company} domain={row.domain} size={38} />
      <span className="jobs__row-main">
        <strong>{row.company}</strong>
        <small>{row.role || "Open Role"}</small>
      </span>
      <span className="jobs__row-meta">
        {row.location ? <span>{row.location}</span> : null}
        {row.comp ? <span>{row.comp}</span> : null}
      </span>
      <span className="jobs__stage-pill">{row.stageLabel || row.stage || "Tracked"}</span>
      <span className="jobs__fit">
        <FitValue row={row} />
      </span>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: labeled action-button group, not a form control group */}
      <span aria-label={`Actions for ${row.company}`} className="jobs__result-actions">
        {actionable ? (
          <>
            <Button
              variant="primary"
              className="jobs__result-button jobs__result-button--primary"
              onClick={() => onOpen(row.id)}
            >
              Open
            </Button>
            <Button
              variant="secondary"
              className="jobs__result-button"
              disabled={skipping}
              onClick={() => onSkip(row.id)}
            >
              {skipping ? "Skipping…" : "Skip"}
            </Button>
          </>
        ) : (
          <span className="jobs__stage-pill">Skipped</span>
        )}
      </span>
    </div>
  );
}

function PanelHeader({ icon, title, meta }) {
  return (
    <header className="jobs__panel-header">
      <h2>
        <span className="jobs__panel-icon">{icon}</span>
        <span>{title}</span>
      </h2>
      {meta ? <span className="jobs__panel-meta">{meta}</span> : null}
    </header>
  );
}

function HealthBadge({ badge }) {
  if (!badge) return null;
  return (
    <span
      className={`jobs__health jobs__health--${badge.rating || "watch"}`}
      title={badge.title || badge.label}
    >
      {badge.label || badge.rating}
    </span>
  );
}

function FitValue({ row }) {
  const fit = formatFit(row.fit);
  if (!fit) return "";
  return `${isTriageFit(row) ? "~" : ""}${fit}`;
}

function DecayPill({ row }) {
  if (row.ghosted || row.decayState === "ghosted") {
    return <span className="jobs__decay-pill">Ghosted</span>;
  }
  if (row.stale || row.decayState === "stale") {
    return <span className="jobs__decay-pill">Going stale</span>;
  }
  return null;
}

function filterSearchRows(rows, filter) {
  if (filter === "all") return rows;
  const active = rows.filter((row) => !row.terminal);
  if (filter === "high") return active.filter((row) => Number(row.fit) >= 80);
  if (filter === "fresh") {
    return active.filter(
      (row) => !row.stale && !row.ghosted && !["stale", "ghosted"].includes(row.decayState)
    );
  }
  return active.filter((row) => row.needsReview);
}

function filterChips(state, stageLabel) {
  const chips = [];
  if (state.stage !== "all") chips.push({ key: "stage", label: `Stage: ${stageLabel}` });
  if (state.mode !== "all")
    chips.push({ key: "mode", label: `Mode: ${labelFor(MODE_OPTIONS, state.mode)}` });
  if (state.source !== "all") {
    chips.push({ key: "source", label: `Source: ${labelFor(SOURCE_OPTIONS, state.source)}` });
  }
  if (state.action !== "all") {
    chips.push({ key: "action", label: `Action: ${labelFor(ACTION_OPTIONS, state.action)}` });
  }
  if (state.minComp) chips.push({ key: "minComp", label: `Comp >= $${state.minComp}K` });
  if (state.minFit) chips.push({ key: "minFit", label: `Fit >= ${state.minFit}` });
  if (state.reviewOnly && state.action !== "review") {
    chips.push({ key: "reviewOnly", label: "Needs review" });
  }
  if (state.query) chips.push({ key: "query", label: `Search: ${state.query}` });
  if (state.showTerminal && state.stage === "all") {
    chips.push({ key: "showTerminal", label: "Show rejected" });
  }
  return chips;
}

function stageOptions(sankey) {
  const options = [{ value: "all", label: "All active" }];
  const seen = new Set(["all"]);
  for (const node of Array.isArray(sankey?.nodes) ? sankey.nodes : []) {
    const value = node.filter || node.id;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: node.label || value });
  }
  for (const option of [
    { value: "terminal", label: "Rejected / withdrawn" },
    { value: "stale", label: "Going stale" },
    { value: "ghosted", label: "Ghosted" },
  ]) {
    if (!seen.has(option.value)) options.push(option);
  }
  return options;
}

function labelFor(options, value) {
  return options.find((option) => option.value === value)?.label || value;
}

function jobsForPage(data) {
  if (hasJobsContent(data)) return data;
  return import.meta.env.DEV ? PREVIEW_JOBS : data;
}

function hasJobsContent(data) {
  if (!data) return false;
  if ((data.jobs?.rows || []).length > 0) return true;
  if (Number(data.jobs?.visibleCount || 0) > 0) return true;
  const rail = data.jobs?.rail || {};
  return ["manualReview", "highFit", "screenPlus", "fresh", "terminal"].some(
    (key) => Number(rail[key] || 0) > 0
  );
}

function buildJobsModel(data, loadedSearchSources, manualSearchRun) {
  const rows = Array.isArray(data?.jobs?.rows) ? data.jobs.rows : [];
  const sourcedRoles = rows.filter((row) => row.source === "sourced");
  const sourceSetup = data?.searchSources || data?.sourceSetup || loadedSearchSources || null;
  const run =
    manualSearchRun ||
    unwrapRun(data?.sourcing?.manualSearchRun) ||
    unwrapRun(data?.manualSearchRun) ||
    unwrapRun(data?.searchRun);

  return {
    rows,
    sourcedRoles,
    sourceSetup,
    manualSearchRun: run,
    preview: data === PREVIEW_JOBS,
    sankey: data?.jobs?.sankey || { nodes: [], links: [], total: 0 },
    nextDecision: data?.jobs?.rail?.nextDecision || {
      title: "Queue is clear",
      summary: "No job-board decision is waiting right now.",
      hasWork: false,
    },
  };
}

export function sourceSetupSummary(sourceSetup, ready) {
  if (!ready) return "Search is available after source setup has at least one deterministic board.";
  const searches = Number(sourceSetup?.searches?.enabled || sourceSetup?.enabledSearches || 0);
  const companies = Number(
    sourceSetup?.enabledTrackedCompanies ??
      sourceSetup?.deterministicSources?.supportedAtsCompanies ??
      sourceSetup?.trackedCompanies ??
      sourceSetup?.companies ??
      0
  );
  const attempted = Number(sourceSetup?.deterministicSources?.attempted || 0);
  const parts = [];
  if (searches) parts.push(`${searches} broad ${searches === 1 ? "search" : "searches"}`);
  if (companies) parts.push(`${companies} company ${companies === 1 ? "board" : "boards"}`);
  if (attempted && !parts.length) parts.push(`${attempted} deterministic sources`);
  return parts.length
    ? `${parts.join(" / ")} ready for the next sweep.`
    : "Sources are ready for the next sweep.";
}

// Only caller is the search-sources load effect above — sourceSetupError
// renders straight through InlineAlert (message/action/detail), so this
// keeps the same resolveErrorCopy() shape every other catch site in this
// file uses instead of a bespoke string. The old fallback wording survives
// as the unmapped case only (resolveErrorCopy's own GENERIC_ERROR_MESSAGE),
// same as errorState()'s pattern in JobDrawer.jsx/InterviewSurface.jsx.
// Exported (like describeAiSearchStatusText/describeManualRunSummary below)
// so it's directly unit-testable — JobsPage.test.jsx renders through
// renderToStaticMarkup, which never runs effects, so the load effect that
// calls this can't be exercised end to end.
export function describeJobsSearchError(error, onRetry) {
  const resolved = resolveErrorCopy(error);
  const withFallback =
    resolved.message === GENERIC_ERROR_MESSAGE
      ? {
          ...resolved,
          message: "Search setup could not be read. Review Search setup, then try again.",
        }
      : resolved;
  return withFallback.action?.retry
    ? { ...withFallback, action: { ...withFallback.action, onRetry } }
    : withFallback;
}

// Status text for the AI lane, rendered through the SAME SearchStatusStrip
// the free-board lane uses (see SearchStatusStrip above) — the AI Web Search
// card itself never grows its own results panel. Returns null outside a
// running/just-finished run so the strip falls back to its normal
// manualSearchRunning/runSummary/sourceSummary text.
export function describeAiSearchStatusText(status, activity, counts) {
  if (status === "running") return activity || "Running AI web search…";
  if (status === "results" && counts) {
    const parts = [
      `${counts.found ?? 0} found`,
      `${counts.new ?? 0} new`,
      `${counts.duplicates ?? 0} duplicates`,
    ];
    const failedCount = Array.isArray(counts.failedPromptIds)
      ? counts.failedPromptIds.length
      : Array.isArray(counts.errors)
        ? counts.errors.length
        : Number(counts.errors || 0);
    if (failedCount > 0)
      parts.push(`${failedCount} failed ${failedCount === 1 ? "query" : "queries"}`);
    return `AI web search: ${parts.join(", ")}.`;
  }
  return null;
}

function AiSearchFailureDetails({ counts }) {
  const failed = Array.isArray(counts?.queryResults)
    ? counts.queryResults.filter((item) => item?.status === "failed")
    : [];
  if (!failed.length) return null;
  return (
    <div className="jobs__ai-failures" role="status">
      <strong>Queries needing a retry</strong>
      <ul>
        {failed.map((item) => (
          <li key={item.promptId}>
            <span>{item.prompt}</span>
            <small>{item.error || "No query coverage was reported."}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Names the configured AI route for the sweep-line receipt without ever
// hardcoding a specific CLI — GET /api/runtime/config only reports the route
// TYPE (installed / byok / proxy / none), never which tool is installed, so
// that's the most specific real data available client-side.
function describeAiRouteLabel(route) {
  if (route === "installed") return "Installed CLI";
  if (route === "byok") return "API Key";
  if (route === "proxy") return "Hosted AI";
  return "AI Engine";
}

function aiSearchTitleLabel({ available }) {
  return available ? "AI Web Search" : "AI Web Search Unavailable";
}

function aiSearchMetaLabel({ available, running }) {
  if (running) return "Running";
  return available ? "Ready" : "Unavailable";
}

// Plain-English description only — no prompt-count/dirty language. What
// prompts to run and whether they need regenerating is handled invisibly by
// jobsSearch.js's runAiWebSearchLane before the run starts (see that file's
// header comment); this card only ever shows Unavailable/Ready/Running.
function describeAiSearchBody({ status, activity, available }) {
  if (status === "running") return activity || "Starting AI web search…";
  if (!available) return "Configure an AI key in Settings to enable this lane.";
  return "Searches company career pages, search results, and curated role lists for openings that match your saved job preferences.";
}

function unwrapRun(value) {
  if (!value || typeof value !== "object") return null;
  if (value.run && typeof value.run === "object") return value.run;
  return value;
}

function normalizeTab(value) {
  return value === "search" ? "search" : "pipeline";
}

function normalizeSearchFilter(value) {
  return SEARCH_FILTERS.some((option) => option.key === value) ? value : "review";
}

function formatFit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  if (numeric > 5) return String(Math.round(numeric));
  return numeric.toFixed(2);
}

function isTriageFit(row) {
  const basis = String(row?.fitBasis || "").toLowerCase();
  return basis.startsWith("triage") || basis.includes("guess");
}

function decisionActionLabel(action) {
  if (action === "manual-review") return "Review queue";
  if (action === "high-fit") return "Show high fit";
  if (action === "needs-action") return "Show actions";
  if (action === "interview-path") return "Show interviews";
  if (action === "stale-applications") return "Show stale";
  if (action === "missing-comp") return "Find comp";
  if (action === "terminal") return "Show closed";
  return "Open explorer";
}
