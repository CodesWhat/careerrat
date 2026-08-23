import {
  buildCartView,
  fitBarWidth,
  pipelineRowsWithWidths,
  selectedJobs,
  selectionIds,
} from "./browser-model.js";
import { ArrowLeftIcon, RadarIcon, SearchIcon, SpinnerIcon } from "./chat-first-icons.jsx";
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
  const providers = safeArray(sourceSweep?.providers);
  const providerCopy = providers.length > 0 ? providers.join(" · ") : "configured boards";
  return (
    <div className="cf-search__sweep" aria-live="polite">
      {running ? (
        <span className="cf-search__sweep-running">
          <SpinnerIcon className="cf-search__spinner" />
          Sweeping {providerCopy}…
        </span>
      ) : (
        <button type="button" className="cf-button cf-button--lime" onClick={() => onRunSweep?.()}>
          <RadarIcon />
          Sweep boards now
        </button>
      )}
      <span className="cf-search__sweep-copy">
        {running
          ? sourceSweep?.detail || "reading postings against your rules"
          : sourceSweep?.summary || "No sweep yet"}
      </span>
      <button
        type="button"
        className="cf-link cf-search__source-health"
        onClick={() => onOpenSourceHealth?.()}
      >
        source health
      </button>
    </div>
  );
}

function FilterBar({ query = "", filters = {}, onQueryChange, onFilter }) {
  const options = [
    { label: "Fit 80+", key: "fit80", supported: true },
    { label: "Stage ▾", supported: false },
    { label: "Comp ✓", key: "comp", supported: true },
    { label: "Remote ▾", key: "remote", supported: true },
    { label: "Source ▾", supported: false },
    { label: "Posted ▾", supported: false },
  ];
  return (
    <div className="cf-search__filters">
      <span className="cf-eyebrow">FOUND · NEEDS TRIAGE</span>
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
      {options.map((filter) => {
        const active = filter.key ? filters[filter.key] === true : false;
        return (
          <button
            key={filter.label}
            type="button"
            className={`cf-filter${active ? " cf-filter--active" : ""}`}
            aria-pressed={active}
            disabled={!filter.supported}
            title={
              filter.supported
                ? undefined
                : "This filter needs source metadata that is not available yet."
            }
            onClick={() => onFilter?.(filter.key)}
          >
            {filter.label}
          </button>
        );
      })}
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
  return (
    <article className={`cf-job-row${selected ? " cf-job-row--selected" : ""}`}>
      <input
        className="cf-job-row__check"
        type="checkbox"
        checked={selected}
        aria-label={`Select ${job?.company || "job"}`}
        aria-checked={selected}
        onChange={() => onToggleSelection?.(job?.id)}
      />
      <div className="cf-job-row__identity">
        <div className="cf-job-row__company">
          {job?.isNew ? <span className="cf-new-badge">NEW</span> : null}
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
          <span className="cf-job-row__fit-fill" style={{ width: `${width}%` }} />
        </span>
      </div>
    </article>
  );
}

export function SearchPanel({
  jobs = [],
  selection = [],
  sourceSweep = {},
  locationPolicy = {},
  query = "",
  filters = {},
  onQueryChange,
  onFilter,
  onToggleSelection,
  onRunSweep,
  onOpenSourceHealth,
}) {
  const selected = new Set(selectionIds(selection));
  const rows = safeArray(jobs);
  return (
    <section className="cf-browser__panel" role="tabpanel" aria-label="Search">
      <SearchToolbar
        sourceSweep={sourceSweep}
        onRunSweep={onRunSweep}
        onOpenSourceHealth={onOpenSourceHealth}
      />
      <LocationScope policy={locationPolicy} />
      <FilterBar
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
          <EmptyPanel>No jobs need triage right now.</EmptyPanel>
        )}
      </div>
    </section>
  );
}

function PipelineFunnel({ pipeline = {}, onStageSelect }) {
  const rows = pipelineRowsWithWidths(pipeline?.rows);
  const leaks = pipelineRowsWithWidths(pipeline?.leaks);
  return (
    <div className="cf-pipeline__funnel">
      <div className="cf-pipeline__summary">
        {Number(pipeline?.applicationCount) || 0} applications · where they stand
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
              style={{ width: `${row.width}%` }}
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
                <span className="cf-pipeline__bar" style={{ width: `${row.width}%` }}>
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
          <span className="cf-pipeline__job-note">{job.note || ""}</span>
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
          <EmptyPanel>No files yet. Artifacts appear here as Paul builds them.</EmptyPanel>
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
            onClick={() => onCalendarAction?.(label)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="cf-browser__footnote">
        These create events in your calendar app. Nothing stays in sync.
      </p>
    </section>
  );
}

export function SelectionCart({
  jobs = [],
  selection = [],
  agentName = "Paul",
  onDraftPackets,
  onDraftAndApply,
  onChatAbout,
  onDismissSelection,
}) {
  const chosen = selectedJobs(jobs, selection);
  const ids = chosen.map((job) => job.id);
  const cart = buildCartView(chosen);
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
        <div className="cf-cart__actions">
          <button
            type="button"
            className="cf-button cf-button--ink"
            onClick={() => onDraftPackets?.(ids)}
          >
            {cart.draftLabel}
          </button>
          <button
            type="button"
            className="cf-button cf-button--lime"
            onClick={() => onDraftAndApply?.(ids)}
          >
            {cart.applyLabel}
          </button>
          <button
            type="button"
            className="cf-button cf-button--outline"
            onClick={() => onChatAbout?.(ids)}
          >
            {cart.chatLabel}
          </button>
          <button
            type="button"
            className="cf-button cf-button--ghost"
            onClick={() => onDismissSelection?.(ids)}
          >
            Dismiss all
          </button>
        </div>
      ) : null}
      {cart.count > 0 ? (
        <div className="cf-cart__consequence">
          Committing spawns a mission in Today. Each packet comes from a full read of the posting,
          matched to its language and backed by your evidence, and each submit gates back to you in
          Today.
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
  onDraftPackets,
  onDraftAndApply,
  onChatAbout,
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
        <ArrowLeftIcon />
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
            selection={selection}
            sourceSweep={sourceSweep}
            locationPolicy={locationPolicy}
            query={query}
            filters={filters}
            onQueryChange={onQueryChange}
            onFilter={onFilter}
            onToggleSelection={onToggleSelection}
            onRunSweep={onRunSweep}
            onOpenSourceHealth={onOpenSourceHealth}
          />
        )}
      </main>
      {activeTab === "search" ? (
        <SelectionCart
          jobs={cartJobs}
          selection={selection}
          agentName={agentName}
          onDraftPackets={onDraftPackets}
          onDraftAndApply={onDraftAndApply}
          onChatAbout={onChatAbout}
          onDismissSelection={onDismissSelection}
        />
      ) : null}
    </section>
  );
}
