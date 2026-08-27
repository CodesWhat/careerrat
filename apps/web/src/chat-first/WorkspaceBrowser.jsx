import { errorState } from "../lib/errorCopy.js";
import {
  buildCartView,
  fitBarWidth,
  pipelineRowsWithWidths,
  selectedJobs,
  selectionIds,
} from "./browser-model.js";
import { RadarIcon, SearchIcon, SpinnerIcon } from "./chat-first-icons.jsx";
import "./workspace-browser.css";

const TAB_ORDER = ["search", "pipeline", "files", "people", "schedule"];
const TAB_LABELS = {
  search: "Search",
  pipeline: "Pipeline",
  files: "Files",
  people: "People",
  schedule: "Schedule",
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buttonLabel(label, count) {
  return Number.isFinite(Number(count)) ? `${label} · ${Number(count)}` : label;
}

function EmptyPanel({ children }) {
  return <div className="cf-browser__empty">{children}</div>;
}

function failedSearchLanes(sourceSweep) {
  return Object.values(sourceSweep?.lanes || {}).filter(
    (lane) => lane && typeof lane === "object" && lane.status === "failed"
  );
}

function searchWasCancelled(sourceSweep) {
  if (sourceSweep?.reason === "cancelled") return true;
  if (/search cancelle?d/i.test(String(sourceSweep?.summary || ""))) return true;
  return Object.values(sourceSweep?.lanes || {}).some(
    (lane) => lane && typeof lane === "object" && lane.reason === "cancelled"
  );
}

function searchHasNoConfiguredLane(sourceSweep) {
  if (sourceSweep?.reason === "no-configured-lane") return true;
  return /no (?:enabled|configured) search (?:sources?|lanes?)/i.test(
    String(sourceSweep?.summary || "")
  );
}

function searchNeedsRetry(sourceSweep) {
  if (failedSearchLanes(sourceSweep).length > 0) return true;
  return sourceSweep?.status === "error" && !searchHasNoConfiguredLane(sourceSweep);
}

function candidateLaneLabel(label) {
  if (label === "Configured sources") return "Saved job sites";
  if (label === "AI web search") return "AI search";
  return label || "Search";
}

function candidateSafeLaneError(lane) {
  const fallback = `${candidateLaneLabel(lane.label)} couldn't finish. Try again.`;
  const raw =
    typeof lane.error === "string" ? lane.error.trim() : String(lane.error?.message || "").trim();
  if (!raw) return fallback;

  if (/model output.*(?:route )?schema|schema.*(?:invalid|mismatch)/i.test(raw)) {
    return "The AI search returned something CareerRat couldn't use. Try again.";
  }
  if (/timed? out|timeout/i.test(raw)) {
    return lane.label === "AI web search"
      ? "The AI search took too long. Try again."
      : "One of your saved job sites took too long to respond. Try again.";
  }
  if (/could not be reached|couldn't be reached|unreachable/i.test(raw)) {
    return lane.label === "Configured sources"
      ? "CareerRat couldn't reach one of your saved job sites. Try again."
      : "CareerRat couldn't reach the AI search. Try again.";
  }

  const translated = errorState(new Error(raw), fallback).message;
  if (translated !== fallback) return translated;
  return fallback;
}

function laneStatusCopy(lane) {
  const label = candidateLaneLabel(lane.label);
  if (lane.status === "skipped") {
    const status = {
      cancelled: "stopped",
      "not-configured": "not set up",
      "not-consented": "permission needed",
      unavailable: "not available",
    }[lane.reason];
    return status ? `${label}: ${status}` : null;
  }
  const status = { succeeded: "finished", running: "searching" }[lane.status] || lane.status;
  if (lane.status !== "failed") return `${label}: ${status}`;
  return `${label}: ${candidateSafeLaneError(lane)}`;
}

function candidateRunningSearchCopy(lanes) {
  const runningLabels = new Set(
    lanes.filter((lane) => lane.status === "running").map((lane) => lane.label)
  );
  const savedSites = runningLabels.has("Configured sources");
  const aiWeb = runningLabels.has("AI web search");
  if (savedSites && aiWeb) return "Searching your saved job sites and the web";
  if (savedSites) return "Searching your saved job sites";
  if (aiWeb) return "Searching the web";
  return "Searching for jobs that match your preferences";
}

function candidateSearchSummary(sourceSweep, lanes) {
  const finished = lanes.filter((lane) => lane.status === "succeeded");
  const failed = lanes.filter((lane) => lane.status === "failed");
  const savedSitesFinished = finished.some((lane) => lane.label === "Configured sources");
  const savedSitesNeedRetry = failed.some((lane) => lane.label === "Configured sources");
  const aiFinished = finished.some((lane) => lane.label === "AI web search");
  const aiNeedsRetry = failed.some((lane) => lane.label === "AI web search");
  if (savedSitesFinished && aiNeedsRetry) {
    return "Your saved job sites finished. The AI search needs another try.";
  }
  if (aiFinished && savedSitesNeedRetry) {
    return "The AI search finished. Your saved job sites need another try.";
  }
  if (finished.length && failed.length) {
    return "Part of the search finished. The rest needs another try.";
  }
  if (failed.length && !finished.length) {
    if (failed.length > 1) return "The search needs another try.";
    return failed[0].label === "Configured sources"
      ? "Your saved job sites need another try."
      : "The AI search needs another try.";
  }
  if (!lanes.length && sourceSweep?.status === "error") {
    if (searchHasNoConfiguredLane(sourceSweep)) {
      return "CareerRat needs at least one job site or a connected AI before it can search.";
    }
    const fallback = "Search couldn't finish. Try again.";
    const raw = String(sourceSweep?.summary || "").trim();
    return raw ? errorState(new Error(raw), fallback).message : fallback;
  }
  return sourceSweep?.summary || "Ready to search";
}

export function BrowserTabs({
  activeTab,
  counts = {},
  pipelineView = "funnel",
  onTabChange,
  onPipelineViewChange,
}) {
  return (
    <div className="cf-browser__tabs-wrap">
      <div className="cf-browser__tabs" role="tablist" aria-label="Browse workspace">
        {TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className="cf-browser__tab"
            onClick={() => onTabChange?.(tab)}
          >
            {buttonLabel(TAB_LABELS[tab], counts?.[tab])}
          </button>
        ))}
      </div>
      {activeTab === "pipeline" ? (
        <button
          type="button"
          className="cf-browser__view-toggle"
          onClick={() => onPipelineViewChange?.(pipelineView === "funnel" ? "list" : "funnel")}
        >
          {pipelineView === "funnel" ? "List view" : "Funnel view"}
        </button>
      ) : null}
    </div>
  );
}

export function SearchToolbar({ sourceSweep = {}, onRunSweep, onOpenSourceHealth }) {
  const running = sourceSweep?.status === "running";
  const hydrating = sourceSweep?.status === "hydrating";
  const busy = running || hydrating;
  const lanes = Object.values(sourceSweep?.lanes || {}).filter(
    (lane) => lane && typeof lane === "object"
  );
  const laneCopies = lanes.map(laneStatusCopy).filter(Boolean);
  const needsRetry = searchNeedsRetry(sourceSweep);
  return (
    <div className="cf-search__sweep" aria-live="polite" aria-busy={busy}>
      {busy ? (
        <span className="cf-search__sweep-running">
          <SpinnerIcon className="cf-search__spinner" />
          {hydrating ? "Loading saved search…" : "Searching for jobs…"}
        </span>
      ) : (
        <button type="button" className="cf-button cf-button--lime" onClick={() => onRunSweep?.()}>
          <RadarIcon />
          {needsRetry ? "Retry search" : "Search for jobs"}
        </button>
      )}
      <span className="cf-search__sweep-copy">
        {hydrating
          ? "Loading your saved search"
          : running
            ? candidateRunningSearchCopy(lanes)
            : candidateSearchSummary(sourceSweep, lanes)}
      </span>
      {laneCopies.length ? (
        <span className="cf-search__lane-status" role="status" aria-label="Search lane status">
          {laneCopies.join(" · ")}
        </span>
      ) : null}
      <button
        type="button"
        className="cf-link cf-search__source-health"
        onClick={() => onOpenSourceHealth?.()}
      >
        Check job sites
      </button>
    </div>
  );
}

function filterKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function filterChoices(jobs, valueFor) {
  const choices = new Map();
  for (const job of safeArray(jobs)) {
    const label = String(valueFor(job) || "").trim();
    const value = filterKey(label);
    if (label && value && !choices.has(value)) choices.set(value, label);
  }
  return [...choices].map(([value, label]) => ({ value, label }));
}

function FilterSelect({ label, value = "all", options, onChange }) {
  return (
    <select
      className={`cf-filter cf-filter--select${value !== "all" ? " cf-filter--active" : ""}`}
      value={value}
      aria-label={`Filter by ${label.toLowerCase()}`}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function FilterBar({ jobs = [], eyebrow, query = "", filters = {}, onQueryChange, onFilter }) {
  const stages = filterChoices(jobs, (job) => job?.stage || job?.stageLabel || job?.status);
  const sources = filterChoices(jobs, (job) => job?.sourceLabel || job?.channel || job?.source);
  return (
    <div className="cf-search__filters">
      <span className="cf-eyebrow">{eyebrow}</span>
      <label className="cf-search__query">
        <span className="cf-sr-only">Search sourced jobs</span>
        <SearchIcon />
        <input
          type="search"
          value={query}
          placeholder="title, company, skill…"
          onChange={(event) => onQueryChange?.(event.target.value)}
        />
      </label>
      <button
        type="button"
        className={`cf-filter${filters.fit80 ? " cf-filter--active" : ""}`}
        aria-pressed={filters.fit80 === true}
        onClick={() => onFilter?.("fit80")}
      >
        Fit 80+
      </button>
      <FilterSelect
        label="Stage"
        value={filters.stage}
        options={[{ value: "all", label: "Stage" }, ...stages]}
        onChange={(value) => onFilter?.("stage", value)}
      />
      <button
        type="button"
        className={`cf-filter${filters.comp ? " cf-filter--active" : ""}`}
        aria-pressed={filters.comp === true}
        onClick={() => onFilter?.("comp")}
      >
        Comp ✓
      </button>
      <button
        type="button"
        className={`cf-filter${filters.remote ? " cf-filter--active" : ""}`}
        aria-pressed={filters.remote === true}
        onClick={() => onFilter?.("remote")}
      >
        Remote
      </button>
      <FilterSelect
        label="Source"
        value={filters.source}
        options={[{ value: "all", label: "Source" }, ...sources]}
        onChange={(value) => onFilter?.("source", value)}
      />
      <FilterSelect
        label="Posted date"
        value={filters.posted}
        options={[
          { value: "all", label: "Posted" },
          { value: "7d", label: "Posted · 7 days" },
          { value: "30d", label: "Posted · 30 days" },
        ]}
        onChange={(value) => onFilter?.("posted", value)}
      />
    </div>
  );
}

function LocationScope({ policy = {} }) {
  if (!policy?.summary) return null;
  return (
    <section className="cf-search__location-scope" aria-label="Active location policy">
      <span className="cf-search__location-label">SEARCHING</span>
      <strong>{policy.summary}</strong>
      {policy.boundary ? <span>{policy.boundary}</span> : null}
    </section>
  );
}

export function SearchJobRow({ job, selected, onToggleSelection }) {
  const width = fitBarWidth(job?.fit);
  const label = `Select ${job?.company || "job"}, ${job?.role || "role not provided"}`;
  return (
    <label className={`cf-job-row${selected ? " cf-job-row--selected" : ""}`}>
      <input
        className="cf-job-row__check"
        type="checkbox"
        checked={selected}
        aria-label={label}
        onChange={() => onToggleSelection?.(job?.id)}
      />
      <div className="cf-job-row__identity">
        <div className="cf-job-row__company">
          {job?.isNew ? <span className="cf-new-badge">NEW</span> : null}
          {job?.aiDiscovered ? (
            <span
              className="cf-capture-badge"
              title="Found by AI on the open web. Evaluate it to verify the posting and capture the full job description."
            >
              AI · unverified
            </span>
          ) : job?.descriptionPartial ? (
            <span
              className="cf-capture-badge"
              title="CareerRat only captured part of this job description."
            >
              Partial description
            </span>
          ) : null}
          {job?.company || "Unknown company"}
        </div>
        <div className="cf-job-row__role">{job?.role || "Role not provided"}</div>
      </div>
      <div className="cf-job-row__meta">
        {job?.stage && job.stage !== job?.location ? (
          <span className="cf-job-row__stage">{job.stage}</span>
        ) : null}
        <strong>{job?.modeLabel || job?.mode || "Location"}</strong>
        <span>{job?.location || "Location not provided"}</span>
      </div>
      <div className="cf-job-row__fit">
        <strong>{Number(job?.fit) || 0}</strong>
        <span className="cf-job-row__fit-track">
          <span className="cf-job-row__fit-fill" style={{ "--cf-fit-width": `${width}%` }} />
        </span>
      </div>
    </label>
  );
}

export function SearchPanel({
  jobs = [],
  filterJobs = jobs,
  selection = [],
  sourceSweep = {},
  onboardingHandoff = false,
  locationPolicy = {},
  query = "",
  filters = {},
  onQueryChange,
  onFilter,
  onToggleSelection,
  onRunSweep,
  onOpenSourceHealth,
  onClearFilters,
}) {
  const selected = new Set(selectionIds(selection));
  const rows = safeArray(jobs);
  const unfilteredRows = safeArray(filterJobs);
  const filtersHideJobs = rows.length === 0 && unfilteredRows.length > 0;
  const noConfiguredLane = searchHasNoConfiguredLane(sourceSweep);
  const cancelled = searchWasCancelled(sourceSweep);
  const hydrating = sourceSweep?.status === "hydrating";
  const needsRetry = searchNeedsRetry(sourceSweep);
  const completed = ["complete", "completed"].includes(sourceSweep?.status);
  const availableCart = buildCartView(unfilteredRows);
  const selectedCart = buildCartView(selectedJobs(unfilteredRows, selection));
  const eyebrow = rows.length
    ? "FOUND · NEEDS TRIAGE"
    : filtersHideJobs
      ? "MATCHES HIDDEN BY FILTERS"
      : hydrating
        ? "LOADING SAVED SEARCH"
        : needsRetry
          ? "SEARCH NEEDS ATTENTION"
          : noConfiguredLane
            ? "SEARCH SETUP NEEDED"
            : cancelled
              ? "SEARCH CANCELLED"
              : sourceSweep?.status === "running"
                ? "SEARCHING"
                : completed
                  ? "NO NEW MATCHES"
                  : "READY TO SEARCH";
  const onboardingTitle = needsRetry
    ? "Search needs attention"
    : hydrating
      ? "Loading your search"
      : sourceSweep?.status === "running"
        ? "Search is running"
        : availableCart.count > 0
          ? "Next step"
          : completed
            ? "Search again"
            : "Start search";
  const onboardingCopy = needsRetry
    ? "Your setup is saved. The first search needs another try. Use Retry search above."
    : hydrating
      ? "Your setup is saved. CareerRat is loading the search already in progress."
      : sourceSweep?.status === "running"
        ? "You're all set. Your first job search is running now. Matches will appear here as they're found."
        : availableCart.count > 0
          ? `Your first ${
              availableCart.count === 1 ? "match is" : `${availableCart.count} matches are`
            } ready. ${
              selectedCart.count > 0
                ? `Review the selected ${selectedCart.count === 1 ? "job" : "jobs"}, then use ${
                    selectedCart.applyLabel
                  } on the right.`
                : "Select the jobs you want. The Apply action will appear on the right."
            }`
          : completed
            ? "You're all set. The first search finished without a match. Use Search for jobs to try again."
            : "You're all set. Start your first job search with Search for jobs above.";
  return (
    <section className="cf-browser__panel" role="tabpanel" aria-label="Search">
      <SearchToolbar
        sourceSweep={sourceSweep}
        onRunSweep={onRunSweep}
        onOpenSourceHealth={onOpenSourceHealth}
      />
      {onboardingHandoff ? (
        <div className="cf-search__onboarding-handoff" role="status">
          <strong>{onboardingTitle}</strong>
          <span>{onboardingCopy}</span>
          {filtersHideJobs ? (
            <button
              type="button"
              className="cf-button cf-button--lime cf-search__show-matches"
              onClick={() => onClearFilters?.()}
            >
              Show matches
            </button>
          ) : null}
        </div>
      ) : null}
      <LocationScope policy={locationPolicy} />
      <FilterBar
        jobs={filterJobs}
        eyebrow={eyebrow}
        query={query}
        filters={filters}
        onQueryChange={onQueryChange}
        onFilter={onFilter}
      />
      <div className="cf-search__results">
        {rows.length > 0 ? (
          rows.map((job) => (
            <SearchJobRow
              key={job.id}
              job={job}
              selected={selected.has(String(job.id))}
              onToggleSelection={onToggleSelection}
            />
          ))
        ) : (
          <EmptyPanel>
            {needsRetry ? (
              <>
                Search didn't finish. Review the error above, then retry.
                {filtersHideJobs ? (
                  <>
                    {" "}
                    Jobs were found, but these filters hide them.{" "}
                    <button type="button" className="cf-link" onClick={() => onClearFilters?.()}>
                      Clear filters
                    </button>
                  </>
                ) : null}
              </>
            ) : filtersHideJobs ? (
              <>
                No jobs match these filters.{" "}
                <button type="button" className="cf-link" onClick={() => onClearFilters?.()}>
                  Clear filters
                </button>
              </>
            ) : noConfiguredLane ? (
              <>
                No search sources are ready yet.{" "}
                <button type="button" className="cf-link" onClick={() => onOpenSourceHealth?.()}>
                  Check job sites
                </button>
              </>
            ) : cancelled ? (
              "Search cancelled. Run it again whenever you're ready."
            ) : completed ? (
              "No new matches this time."
            ) : hydrating ? (
              "Loading saved search…"
            ) : sourceSweep?.status === "running" ? (
              "Searching for matches…"
            ) : (
              "Search for jobs to start building your list."
            )}
          </EmptyPanel>
        )}
      </div>
    </section>
  );
}

function PipelineFunnel({ pipeline = {}, onStageSelect }) {
  const rows = pipelineRowsWithWidths(pipeline?.rows);
  const leaks = pipelineRowsWithWidths(pipeline?.leaks);
  const applicationCount = Number(pipeline?.applicationCount) || 0;
  return (
    <div className="cf-pipeline__funnel">
      <div className="cf-pipeline__summary">
        {applicationCount} application{applicationCount === 1 ? "" : "s"} · where{" "}
        {applicationCount === 1 ? "it stands" : "they stand"}
      </div>
      {rows.map((row) => (
        <button
          key={row.id || row.label}
          type="button"
          className="cf-pipeline__funnel-row"
          aria-label={`${row.label}: ${row.count}`}
          onClick={() => onStageSelect?.(row.id)}
        >
          <span className="cf-pipeline__label">{row.label}</span>
          <span className="cf-pipeline__track">
            <span
              className={`cf-pipeline__bar${row.highlight ? " cf-pipeline__bar--offer" : ""}`}
              style={{ "--cf-pipeline-width": `${row.width}%` }}
            >
              {row.count}
            </span>
          </span>
        </button>
      ))}
      {leaks.length > 0 ? (
        <div className="cf-pipeline__leaks">
          {leaks.map((row) => (
            <button
              key={row.id || row.label}
              type="button"
              className="cf-pipeline__funnel-row cf-pipeline__funnel-row--leak"
              aria-label={`${row.label}: ${row.count}`}
              onClick={() => onStageSelect?.(row.id)}
            >
              <span className="cf-pipeline__label">{row.label}</span>
              <span className="cf-pipeline__track">
                <span
                  className="cf-pipeline__bar"
                  style={{ "--cf-pipeline-width": `${row.width}%` }}
                >
                  {row.count}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <p className="cf-browser__footnote">
        Every stage is filterable. Click a bar to see those jobs in the list.
      </p>
    </div>
  );
}

function PipelineList({ jobs = [], onOpenJob }) {
  const rows = safeArray(jobs);
  if (rows.length === 0) return <EmptyPanel>No actioned jobs yet.</EmptyPanel>;
  return (
    <div className="cf-pipeline__list">
      {rows.map((job) => (
        <button
          key={job.id}
          type="button"
          className="cf-pipeline__job"
          onClick={() => onOpenJob?.(job.id)}
        >
          <span className="cf-pipeline__job-name">
            <strong>{job.company || "Unknown company"}</strong>
            <span>{job.role || "Role not provided"}</span>
          </span>
          <span
            className={`cf-stage cf-stage--${String(job.stage || "applied")
              .toLowerCase()
              .replaceAll(" ", "-")}`}
          >
            {job.stage || "Applied"}
          </span>
          <span className="cf-pipeline__job-note">{job.statusNote || ""}</span>
          <strong>{Number(job.fit) || 0}</strong>
        </button>
      ))}
    </div>
  );
}

export function PipelinePanel({ pipeline = {}, view = "funnel", onStageSelect, onOpenJob }) {
  return (
    <section className="cf-browser__panel cf-pipeline" role="tabpanel" aria-label="Pipeline">
      {view === "list" ? (
        <PipelineList jobs={pipeline?.jobs} onOpenJob={onOpenJob} />
      ) : (
        <PipelineFunnel pipeline={pipeline} onStageSelect={onStageSelect} />
      )}
    </section>
  );
}

export function FilesPanel({
  files = [],
  agentName = "Paul",
  activeFilter = "All",
  onOpenFile,
  onExportFile,
  onFilter,
}) {
  const rows = safeArray(files);
  return (
    <section className="cf-browser__panel cf-resource" role="tabpanel" aria-label="Files">
      <div className="cf-resource__filters">
        {["All", "Resumes", "Cover letters", "Stories", "Evidence", "Job ▾"].map((label) => (
          <button
            key={label}
            type="button"
            className={`cf-filter${activeFilter === label ? " cf-filter--active" : ""}`}
            aria-pressed={activeFilter === label}
            onClick={() => onFilter?.(label)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="cf-resource__rows">
        {rows.length > 0 ? (
          rows.map((file) => (
            <article key={file.id} className="cf-resource__row">
              <span className="cf-resource__thumb" aria-hidden="true">
                {file.emoji || "📄"}
              </span>
              <span className="cf-resource__identity">
                <strong>{file.name || "Untitled file"}</strong>
                <span>{file.meta || ""}</span>
              </span>
              <span className="cf-kind">{file.kind || "File"}</span>
              <button
                type="button"
                className="cf-button cf-button--lime"
                onClick={() => onOpenFile?.(file.id)}
              >
                Open
              </button>
              <button
                type="button"
                className="cf-button cf-button--outline"
                onClick={() => onExportFile?.(file.id)}
              >
                Export
              </button>
            </article>
          ))
        ) : (
          <EmptyPanel>No files yet. Artifacts appear here as {agentName} builds them.</EmptyPanel>
        )}
      </div>
      <p className="cf-browser__footnote">every claim in these traces to your evidence bank</p>
    </section>
  );
}

function initials(name) {
  return (
    String(name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

export function PeoplePanel({
  people = [],
  activeFilter = "all",
  onOpenPerson,
  onDraftNudge,
  onFilter,
}) {
  const rows = safeArray(people);
  const dueCount = rows.filter((person) => person?.needsTouch).length;
  return (
    <section className="cf-browser__panel cf-resource" role="tabpanel" aria-label="People">
      <div className="cf-resource__filters">
        <button
          type="button"
          className={`cf-filter${activeFilter === "all" ? " cf-filter--active" : ""}`}
          aria-pressed={activeFilter === "all"}
          onClick={() => onFilter?.("all")}
        >
          All
        </button>
        <button
          type="button"
          className={`cf-filter cf-filter--attention${activeFilter === "needs-touch" ? " cf-filter--active" : ""}`}
          aria-pressed={activeFilter === "needs-touch"}
          onClick={() => onFilter?.("needs-touch")}
        >
          Needs a touch · {dueCount}
        </button>
      </div>
      <div className="cf-resource__rows">
        {rows.length > 0 ? (
          rows.map((person) => (
            <article
              key={person.id}
              className={`cf-resource__row${person.needsTouch ? " cf-resource__row--attention" : ""}`}
            >
              <span className="cf-person__avatar" aria-hidden="true">
                {initials(person.name)}
              </span>
              <span className="cf-resource__identity">
                <strong>{person.name || "Unknown person"}</strong>
                <span>{person.role || ""}</span>
              </span>
              <span className="cf-person__dates">
                <span>last: {person.last || "not recorded"}</span>
                <strong>next: {person.next || "none"}</strong>
              </span>
              <button
                type="button"
                className="cf-button cf-button--lime"
                onClick={() =>
                  person.needsTouch ? onDraftNudge?.(person.id) : onOpenPerson?.(person.id)
                }
              >
                {person.actionLabel || (person.needsTouch ? "Draft a nudge" : "Open thread")}
              </button>
            </article>
          ))
        ) : (
          <EmptyPanel>No real conversations are tracked yet.</EmptyPanel>
        )}
      </div>
      <p className="cf-browser__footnote">
        people you've actually talked to. Application-portal noise is excluded.
      </p>
    </section>
  );
}

export function SchedulePanel({ groups = [], onAction, onCalendarAction }) {
  const days = safeArray(groups);
  const canExportCalendar = days.some((group) =>
    safeArray(group?.items).some((item) => item?.export)
  );
  return (
    <section className="cf-browser__panel cf-schedule" role="tabpanel" aria-label="Schedule">
      <div className="cf-schedule__days">
        {days.length > 0 ? (
          days.map((group) => (
            <section key={group.day} className="cf-schedule__day">
              <h3>{group.day}</h3>
              {safeArray(group.items).map((item) => (
                <article
                  key={item.id}
                  className={`cf-schedule__row${item.kind === "interview" ? " cf-schedule__row--interview" : ""}`}
                >
                  <strong className="cf-schedule__time">{item.time || ""}</strong>
                  <span className="cf-resource__identity">
                    <strong>{item.title || "Scheduled item"}</strong>
                    <span>{item.meta || ""}</span>
                  </span>
                  {item.actionLabel ? (
                    <button
                      type="button"
                      className="cf-button cf-button--ink"
                      onClick={() => onAction?.(item.id)}
                    >
                      {item.actionLabel}
                    </button>
                  ) : null}
                </article>
              ))}
            </section>
          ))
        ) : (
          <EmptyPanel>Nothing is scheduled.</EmptyPanel>
        )}
      </div>
      <div className="cf-schedule__calendar-actions">
        <span>Add to calendar:</span>
        {["Google", "Outlook", "Download file"].map((label) => (
          <button
            key={label}
            type="button"
            className="cf-button cf-button--outline"
            disabled={!canExportCalendar}
            onClick={() => onCalendarAction?.(label)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="cf-browser__footnote">
        {canExportCalendar
          ? "These create events in your calendar app. Nothing stays in sync."
          : "Calendar exports appear when something is scheduled."}
      </p>
    </section>
  );
}

export function SelectionCart({
  jobs = [],
  selection = [],
  agentName = "Paul",
  onDraftAndApply,
  onDismissSelection,
}) {
  const chosen = selectedJobs(jobs, selection);
  const ids = chosen.map((job) => job.id);
  const cart = buildCartView(chosen);
  const canDismissAll = chosen.every((job) => job?.source === "sourced");
  return (
    <aside className="cf-cart" aria-label="Selected jobs cart">
      <div className="cf-eyebrow cf-cart__title">{cart.title}</div>
      {cart.count === 0 ? (
        <div className="cf-cart__empty">
          Select jobs on the left. The cart fills with what {agentName} can do to all of them at
          once.
        </div>
      ) : cart.count === 1 ? (
        <div className="cf-cart__detail">
          <strong>{chosen[0]?.company || "Unknown company"}</strong>
          <span>{chosen[0]?.role || "Role not provided"}</span>
          <div className="cf-cart__fit">
            <strong>{Number(chosen[0]?.fit) || 0}</strong>
            <span>
              {chosen[0]?.compStatus || "comp pending"} · skills ✓ ·{" "}
              {[chosen[0]?.modeLabel || chosen[0]?.mode, chosen[0]?.location]
                .filter(Boolean)
                .join(" · ") || "location not provided"}
            </span>
          </div>
          {safeArray(chosen[0]?.sourceHistory).map((line) => (
            <span key={line}>✓ {line}</span>
          ))}
        </div>
      ) : (
        <div className="cf-cart__summary">
          Avg fit <strong>{cart.averageFit}</strong> ·{" "}
          {cart.compPendingCount > 0 ? `${cart.compPendingCount} comp pending` : "all comp ✓"}
          <span>{cart.evaluationCount} need evaluation first</span>
        </div>
      )}
      {cart.count > 0 ? (
        <div className="cf-cart__actions cf-cart__actions--collapsed">
          <button
            type="button"
            className="cf-button cf-button--lime"
            onClick={() => onDraftAndApply?.(ids)}
          >
            {cart.applyLabel}
          </button>
          <button
            type="button"
            className="cf-button cf-button--ghost"
            onClick={() => onDismissSelection?.(ids)}
          >
            {canDismissAll ? "Dismiss all" : "Clear selection"}
          </button>
        </div>
      ) : null}
      {cart.count > 0 ? (
        <div className="cf-cart__consequence">
          Starts one mission. {agentName} reads every posting, builds each packet, fills each form,
          and brings every final submit back to you.
        </div>
      ) : null}
    </aside>
  );
}

export function WorkspaceBrowser({
  activeTab = "search",
  counts = {},
  pipelineView = "funnel",
  jobs = [],
  cartJobs = jobs,
  selection = [],
  sourceSweep = {},
  onboardingHandoff = false,
  locationPolicy = {},
  pipeline = {},
  files = [],
  people = [],
  schedule = [],
  agentName = "Paul",
  expiringCount = 1,
  query = "",
  filters = {},
  onClose,
  onTabChange,
  onPipelineViewChange,
  onToggleSelection,
  onRunSweep,
  onOpenSourceHealth,
  onClearFilters,
  onQueryChange,
  onFilter,
  onStageSelect,
  onOpenJob,
  onOpenFile,
  onExportFile,
  onOpenPerson,
  onDraftNudge,
  onScheduleAction,
  onCalendarAction,
  onDraftAndApply,
  onDismissSelection,
}) {
  return (
    <section
      className={`cf-browser${activeTab === "search" ? " cf-browser--with-cart" : ""}`}
      aria-label="Workspace browser"
    >
      <button
        type="button"
        className="cf-browser__thread-strip"
        onClick={() => onClose?.()}
        aria-label="Return to threads"
      >
        <span aria-hidden="true">‹</span>
        <span>THREADS · {expiringCount} EXPIRING</span>
        <span className="cf-browser__needs-dot" aria-hidden="true" />
      </button>
      <main className="cf-browser__main">
        <BrowserTabs
          activeTab={activeTab}
          counts={counts}
          pipelineView={pipelineView}
          onTabChange={onTabChange}
          onPipelineViewChange={onPipelineViewChange}
        />
        {activeTab === "pipeline" ? (
          <PipelinePanel
            pipeline={pipeline}
            view={pipelineView}
            onStageSelect={onStageSelect}
            onOpenJob={onOpenJob}
          />
        ) : activeTab === "files" ? (
          <FilesPanel
            files={files}
            agentName={agentName}
            activeFilter={filters.files}
            onOpenFile={onOpenFile}
            onExportFile={onExportFile}
            onFilter={onFilter}
          />
        ) : activeTab === "people" ? (
          <PeoplePanel
            people={people}
            activeFilter={filters.people}
            onOpenPerson={onOpenPerson}
            onDraftNudge={onDraftNudge}
            onFilter={onFilter}
          />
        ) : activeTab === "schedule" ? (
          <SchedulePanel
            groups={schedule}
            onAction={onScheduleAction}
            onCalendarAction={onCalendarAction}
          />
        ) : (
          <SearchPanel
            jobs={jobs}
            filterJobs={cartJobs}
            selection={selection}
            sourceSweep={sourceSweep}
            onboardingHandoff={onboardingHandoff}
            agentName={agentName}
            locationPolicy={locationPolicy}
            query={query}
            filters={filters}
            onQueryChange={onQueryChange}
            onFilter={onFilter}
            onToggleSelection={onToggleSelection}
            onRunSweep={onRunSweep}
            onOpenSourceHealth={onOpenSourceHealth}
            onClearFilters={onClearFilters}
          />
        )}
      </main>
      {activeTab === "search" ? (
        <SelectionCart
          jobs={cartJobs}
          selection={selection}
          agentName={agentName}
          onDraftAndApply={onDraftAndApply}
          onDismissSelection={onDismissSelection}
        />
      ) : null}
    </section>
  );
}
