import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Button } from "../components/Button.jsx";
import { CompanyAvatar } from "../components/CompanyAvatar.jsx";
import { Field, Select, TextField } from "../components/form.jsx";
import { ChevronDownIcon, ListIcon, SearchIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { getSearchSources } from "../lib/api.js";
import { FunnelSankey } from "./FunnelSankey.jsx";
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
import { hasDbSourceSetup, runJobsPageSearch } from "./jobsSearch.js";

const STORAGE_KEY = "rolester-jobs-next-explorer";

const TAB_OPTIONS = [
  { key: "pipeline", label: "Pipeline" },
  { key: "search", label: "Search" },
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
  { key: "company", label: "Company" },
  { key: "role", label: "Role" },
  { key: "fit", label: "Fit" },
  { key: "base", label: "Base" },
  { key: "stage", label: "Stage" },
  { key: "applied", label: "Applied" },
  { key: "action", label: "Action" },
];

function loadExplorerState() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return DEFAULT_EXPLORER_STATE;
    return sanitizeExplorerState(JSON.parse(storage.getItem(STORAGE_KEY) || "{}"));
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
  const [explorerState, setExplorerState] = useState(loadExplorerState);
  const [queryDraft, setQueryDraft] = useState(explorerState.query);
  const [searchParams, setSearchParams] = useSearchParams();

  const snapshot = data ? jobsForPage(data) : null;
  const model = useMemo(
    () => buildJobsModel(snapshot, loadedSearchSources, manualSearchRun),
    [snapshot, loadedSearchSources, manualSearchRun]
  );
  const tab = normalizeTab(searchParams.get("tab"));
  const searchFilter = normalizeSearchFilter(searchParams.get("queue"));
  const openId = searchParams.get("open");
  const openRow = openId ? model.rows.find((row) => row.id === openId) : null;
  const sourceSetupReady = hasDbSourceSetup(model.sourceSetup);
  const manualSearchRunning = manualSearchPending || model.manualSearchRun?.status === "running";
  const visibleManualSearchError =
    manualSearchError || snapshot?.sourcing?.manualSearchError || null;

  useEffect(() => {
    if (!snapshot || snapshot.searchSources || snapshot.sourceSetup || model.preview)
      return undefined;

    let cancelled = false;
    getSearchSources()
      .then((body) => {
        if (cancelled) return;
        setLoadedSearchSources(body);
        setSourceSetupError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setSourceSetupError(describeJobsSearchError(err));
      });

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
    if (queryDraft.trim().toLowerCase() !== explorerState.query) {
      setQueryDraft(explorerState.query);
    }
  }, [explorerState.query, queryDraft]);

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

  function openDrawer(id) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("open", id);
      return next;
    });
  }

  function closeDrawer() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("open");
      return next;
    });
  }

  async function handleManualSearch() {
    setManualSearchPending(true);
    try {
      await runJobsPageSearch({
        refetch,
        setSearchError: setManualSearchError,
        setSearchRun: setManualSearchRun,
      });
    } finally {
      setManualSearchPending(false);
    }
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
        <InlineAlert message="No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload." />
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
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {error ? <InlineAlert message={error} /> : null}
      {sourceSetupError ? <InlineAlert message={sourceSetupError} /> : null}
      {visibleManualSearchError ? <InlineAlert message={visibleManualSearchError} /> : null}
      {loading ? <p className="dashboard-home__loading">Loading…</p> : null}

      {snapshot && tab === "pipeline" ? (
        <PipelineView
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
          filter={searchFilter}
          manualSearchRunning={manualSearchRunning}
          model={model}
          onFilter={setSearchQueue}
          onOpen={openDrawer}
          onSearch={handleManualSearch}
          sourceSetupReady={sourceSetupReady}
        />
      ) : null}

      {openRow ? <JobDrawer row={openRow} onClose={closeDrawer} /> : null}
    </div>
  );
}

function PipelineView({
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
              <button
                type="button"
                className="jobs__filter-chip"
                key={chip.key}
                onClick={() => removeFilter(chip.key)}
              >
                <span>{chip.label}</span>
                <span aria-hidden="true">x</span>
              </button>
            ))}
          </div>
        ) : null}

        {filteredRows.length ? (
          state.view === "table" ? (
            <JobsTable rows={filteredRows} state={state} onOpen={onOpen} onSort={setSort} />
          ) : (
            <div className="jobs__cards">
              {filteredRows.map((row) => (
                <JobsCard key={row.id} row={row} onOpen={onOpen} />
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
          <label className="jobs__checkbox">
            <input
              type="checkbox"
              checked={!!state.showGhosted}
              onChange={(event) => onUpdate({ showGhosted: event.target.checked })}
            />
            <span>Show ghosted</span>
          </label>
          <label className="jobs__checkbox">
            <input
              type="checkbox"
              checked={!!state.hideStale}
              onChange={(event) => onUpdate({ hideStale: event.target.checked })}
            />
            <span>Hide stale</span>
          </label>
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

function JobsTable({ rows, state, onOpen, onSort }) {
  return (
    <div className="jobs__table-wrap">
      <table className="jobs__table">
        <thead>
          <tr>
            {SORT_COLUMNS.map((column) => (
              <SortHeader
                key={column.key}
                column={column}
                state={state}
                onSort={() => onSort(column.key)}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            // biome-ignore lint/a11y/useSemanticElements: a <tr> can't be replaced with <button> without breaking table semantics; role+tabIndex+onKeyDown make it keyboard-operable
            <tr
              key={row.id}
              role="button"
              tabIndex={0}
              aria-label={`Open ${row.company} ${row.role}`}
              onClick={() => onOpen(row.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpen(row.id);
                }
              }}
            >
              <td>
                <span className="jobs__company-cell">
                  <CompanyAvatar name={row.company} domain={row.domain} size={34} />
                  <span>
                    <span className="jobs__company-name">{row.company}</span>
                    <span className="jobs__subline">{row.location || row.domain}</span>
                  </span>
                  <HealthBadge badge={row.healthBadge} />
                </span>
              </td>
              <td>{row.role}</td>
              <td className="jobs__num">
                <FitValue row={row} />
              </td>
              <td className="jobs__num">{formatCompK(row)}</td>
              <td>
                <span className="jobs__stage-cell">
                  <span className="jobs__stage-pill">{row.stageLabel || row.stage}</span>
                  <DecayPill row={row} />
                </span>
              </td>
              <td className="jobs__num">{row.appliedLabel || row.appliedAt || ""}</td>
              <td>
                <span className="jobs__action-cell">
                  <span>{row.action?.cta || "Open details"}</span>
                  {row.action?.dueText ? <small>{row.action.dueText}</small> : null}
                </span>
              </td>
            </tr>
          ))}
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

function JobsCard({ row, onOpen }) {
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
    </article>
  );
}

function SearchView({
  filter,
  manualSearchRunning,
  model,
  onFilter,
  onOpen,
  onSearch,
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
          actionLabel="Run Primary Lane"
          disabled
          eyebrow="AI web search"
          meta="Primary Role Lane"
          title="AI Web Search"
        >
          Primary lane across public company pages, search results, and curated role lists.
        </SearchModeCard>
      </section>

      {!sourceSetupReady ? (
        <section className="jobs__setup-inline" aria-live="polite">
          Add RSS sources or tracked company boards first.
        </section>
      ) : null}

      <section className="jobs__panel">
        <PanelHeader
          icon={<SearchIcon />}
          title="Found Roles"
          meta={`${filteredRoles.length} roles`}
        />
        <SearchStatusStrip
          manualSearchRunning={manualSearchRunning}
          model={model}
          sourceSetupReady={sourceSetupReady}
        />
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
            filteredRoles.map((row) => <SearchResultRow key={row.id} row={row} onOpen={onOpen} />)
          ) : (
            <div className="jobs__empty">No sourced roles match this queue.</div>
          )}
        </div>
      </section>
    </>
  );
}

function SearchModeCard({ actionLabel, children, disabled, eyebrow, meta, onAction, title }) {
  return (
    <article className="jobs__search-mode">
      <div className="jobs__search-mode-head">
        <span className="jobs__search-kicker">{eyebrow}</span>
        {meta ? <span className="jobs__source-pill">{meta}</span> : null}
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      <Button className="jobs__search-button" disabled={disabled} onClick={onAction}>
        {actionLabel}
      </Button>
    </article>
  );
}

function SearchStatusStrip({ manualSearchRunning, model, sourceSetupReady }) {
  const runSummary = model.manualSearchRun?.summary;
  const sourceSummary = sourceSetupSummary(model.sourceSetup, sourceSetupReady);
  return (
    <div className="jobs__search-status" aria-live="polite">
      <span>{manualSearchRunning ? "Finding roles…" : runSummary || sourceSummary}</span>
      <span>
        {model.sourcedRoles.length
          ? `${model.sourcedRoles.length} sourced`
          : "No sourced roles yet"}
      </span>
    </div>
  );
}

function SearchResultRow({ row, onOpen }) {
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
        <button
          type="button"
          className="jobs__result-button jobs__result-button--primary"
          onClick={() => onOpen(row.id)}
        >
          Evaluate
        </button>
        <button type="button" className="jobs__result-button">
          Skip
        </button>
        <button type="button" className="jobs__result-button">
          Park
        </button>
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
  if (filter === "high") return rows.filter((row) => Number(row.fit) >= 80);
  if (filter === "fresh") {
    return rows.filter(
      (row) => !row.stale && !row.ghosted && !["stale", "ghosted"].includes(row.decayState)
    );
  }
  return rows.filter((row) => row.needsReview);
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

function sourceSetupSummary(sourceSetup, ready) {
  if (!ready) return "Search is available after source setup has at least one deterministic board.";
  const searches = Number(sourceSetup?.searches?.enabled || sourceSetup?.enabledSearches || 0);
  const companies = Number(sourceSetup?.trackedCompanies || sourceSetup?.companies || 0);
  const attempted = Number(sourceSetup?.deterministicSources?.attempted || 0);
  const parts = [];
  if (searches) parts.push(`${searches} broad searches`);
  if (companies) parts.push(`${companies} company boards`);
  if (attempted && !parts.length) parts.push(`${attempted} deterministic sources`);
  return parts.length
    ? `${parts.join(" / ")} ready for the next sweep.`
    : "Sources are ready for the next sweep.";
}

function describeJobsSearchError(error) {
  return (
    error?.body?.error ||
    error?.body?.message ||
    error?.message ||
    "Search setup could not be read. Review Search setup, then try again."
  );
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

function formatCompK(row) {
  const value = Number(row?.baseK || row?.compMidpointK || 0);
  return Number.isFinite(value) && value > 0 ? `$${Math.round(value)}K` : "No comp";
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
