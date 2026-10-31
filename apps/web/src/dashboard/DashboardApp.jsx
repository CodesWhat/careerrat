import {
  ArrowLeft,
  ArrowUpRight,
  Calendar,
  Clock,
  FileText,
  History,
  LayoutList,
  Settings,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { loadChatFirstArtifact } from "../chat-first/chat-first-app-controller.js";
import { buildChatFirstView } from "../chat-first/chat-first-model.js";
import { MessageTranscript } from "../chat-first/conversation-surfaces.jsx";
import { useDashboardSnapshot } from "../chat-first/dashboard-context.jsx";
import { PipelinePanel } from "../chat-first/WorkspaceBrowser.jsx";
import { ArtifactViewerModal } from "../jobs/ArtifactViewerModal.jsx";
import {
  getInterviewDossier,
  getJobDescription,
  getPacket,
  revertKnowledgeChange,
} from "../lib/api.js";
import { resolveErrorCopy } from "../lib/errorCopy.js";
import "./dashboard.css";

const EMPTY = [];
const TABS = [
  ["today", "Today", Clock],
  ["pipeline", "Pipeline", LayoutList],
  ["changes", "Changes", History],
  ["files", "Documents", FileText],
];
const artifactApi = { getInterviewDossier, getJobDescription, getPacket };

export function dashboardHandoff(job) {
  return job?.id
    ? `Continue work on ${job.company || "this company"}'s ${job.role || "open role"} application (${job.id}). Read its saved job thread and record the result there.`
    : "Continue this workspace's job search. Read the current tracker and job threads, then run the next useful CareerRat skill and record the result.";
}

export function dashboardChanges(view) {
  const messages = view?.mainThread?.messages || EMPTY;
  const reverted = new Set(
    messages.flatMap((message) =>
      (message.artifacts || EMPTY)
        .filter((entry) => entry.revertOf)
        .map((entry) => `${entry.revertOf.messageId}:${entry.revertOf.index}`)
    )
  );
  return messages
    .flatMap((message) =>
      (message.artifacts || EMPTY).flatMap((entry, index) =>
        entry.kind === "knowledge_write" && !entry.revertOf
          ? [{ entry, message, index, reverted: reverted.has(`${message.id}:${index}`) }]
          : []
      )
    )
    .reverse();
}

function valueCopy(value, absent) {
  if (absent || value == null) return "Not set";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function ChangeCard({ change, actions, busy }) {
  const { entry, message, index, reverted } = change;
  return (
    <article className="cli-dashboard__change">
      {reverted ? (
        <span className="cli-dashboard__tag">Undone</span>
      ) : entry.revertible === true ? (
        <button
          type="button"
          className="cli-dashboard__secondary"
          disabled={busy}
          onClick={() => actions.undo?.(message.id, index)}
        >
          Undo
        </button>
      ) : null}
      <h3>{entry.label || entry.path || entry.target || "Saved change"}</h3>
      <dl>
        <div>
          <dt>Before</dt>
          <dd>{valueCopy(entry.before, entry.beforeAbsent)}</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd>{valueCopy(entry.after, entry.afterAbsent)}</dd>
        </div>
      </dl>
      <p className="cli-dashboard__muted">
        {entry.source?.label || entry.source?.kind || "Saved source"}
        {message.at ? ` · ${message.at}` : ""}
      </p>
      {!reverted && entry.revertNote ? <p>{entry.revertNote}</p> : null}
    </article>
  );
}

function JobRow({ job, onOpen }) {
  return (
    <button className="cli-dashboard__job" type="button" onClick={() => onOpen?.(job.id)}>
      <span className="cli-dashboard__monogram" aria-hidden="true">
        {String(job.company || "?").slice(0, 1)}
      </span>
      <span>
        <strong>{job.company || "Saved role"}</strong>
        <small>{job.role || "Open role"}</small>
      </span>
      {job.stage ? (
        <span className="cli-dashboard__tag">{job.stage}</span>
      ) : (
        <ArrowUpRight size={16} />
      )}
    </button>
  );
}

export function DashboardView({
  view,
  focus,
  tab = "today",
  applicationId,
  loading = false,
  noDatabase = false,
  error,
  notice,
  copiedPrompt,
  actions = {},
  busy = false,
  artifact,
  filters = {},
  person = null,
  startCommand,
  workspaceKnown = Boolean(startCommand),
}) {
  const data = view || {};
  const browser = data.browser || {};
  const jobs = browser.pipeline?.jobs || EMPTY;
  const threads = [...(data.threads || EMPTY), ...(data.archivedThreads || EMPTY)];
  const job = jobs.find((row) => row.id === applicationId);
  const thread = threads.find((row) => row.applicationId === applicationId);
  const changes = dashboardChanges(data);
  const scheduled = (browser.schedule || EMPTY).flatMap((group) => group.items || EMPTY);
  const launcher = startCommand;
  const label = TABS.find(([id]) => id === tab)?.[1] || "Job thread";
  const request = (item) => {
    const id = item.applicationId || item.detailId;
    if (id && jobs.some((row) => row.id === id)) actions.openJob?.(id);
    else actions.copy?.([item.title, item.detail].filter(Boolean).join(". ") || dashboardHandoff());
  };
  return (
    <div className="cli-dashboard">
      <header className="cli-dashboard__top">
        <Link to="/" className="cli-dashboard__brand">
          CareerRat
          <span aria-hidden="true" />
        </Link>
        <div className="cli-dashboard__top-actions">
          <span>{data.candidateName || person || "Your workspace"}</span>
          <Link to="/settings">
            <Settings size={16} /> Profile &amp; settings
          </Link>
        </div>
      </header>
      <div className="cli-dashboard__layout">
        <nav className="cli-dashboard__rail" aria-label="Dashboard">
          <p className="cli-dashboard__eyebrow">Workspace</p>
          {TABS.map(([id, name, Icon]) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id || (tab === "job" && id === "pipeline") ? "page" : undefined}
              onClick={() => actions.selectTab?.(id)}
            >
              <Icon size={18} />
              {name}
            </button>
          ))}
          <div className="cli-dashboard__handoff">
            <Terminal size={18} />
            <strong>The work happens in your CLI.</strong>
            <p>This is where you keep track of it.</p>
            <button
              type="button"
              disabled={!workspaceKnown}
              onClick={() => actions.copy?.(launcher)}
            >
              Copy start command <ArrowUpRight size={13} />
            </button>
          </div>
        </nav>
        <main className="cli-dashboard__main">
          {error ? (
            <div className="cli-dashboard__alert" role="alert">
              {typeof error === "string"
                ? error
                : error.message || error.title || "CareerRat couldn't refresh this workspace."}
              <button type="button" onClick={actions.retry}>
                Retry
              </button>
            </div>
          ) : null}
          {notice ? (
            <p className="cli-dashboard__notice" role="status">
              {notice}
            </p>
          ) : null}
          {copiedPrompt ? (
            <div className="cli-dashboard__copy-fallback">
              <p>Copy this into your CLI:</p>
              <pre>{copiedPrompt}</pre>
            </div>
          ) : null}
          {noDatabase ? (
            <section className="cli-dashboard__empty">
              <Terminal size={30} />
              <h1>Start your workspace</h1>
              <p>
                Open CareerRat in your CLI to set up your profile and begin your search. Your jobs
                and documents will appear here as you work.
              </p>
              <code>{workspaceKnown ? launcher : "Loading workspace command…"}</code>
              <button
                type="button"
                className="cli-dashboard__primary"
                disabled={!workspaceKnown}
                onClick={() => actions.copy?.(launcher)}
              >
                Copy start command
              </button>
            </section>
          ) : loading && !view ? (
            <p role="status">Loading your workspace…</p>
          ) : view ? (
            <>
              {tab !== "job" ? (
                <div className="cli-dashboard__heading">
                  <p className="cli-dashboard__eyebrow">
                    {data.candidateName ? `${data.candidateName}'s search` : "Your search"}
                  </p>
                  <h1>
                    {{
                      today: "Today, in focus.",
                      pipeline: "The whole picture.",
                      changes: "What changed.",
                      files: "Documents, in place.",
                    }[tab] || label}
                  </h1>
                  <p>
                    {
                      {
                        today: "Your next steps, with the context to pick them up.",
                        pipeline: "Every role, from the first look to the final conversation.",
                        changes: "What was written, where it came from, and what can be undone.",
                        files: "Saved with each role. Earlier versions stay available.",
                      }[tab]
                    }
                  </p>
                </div>
              ) : null}
              {tab === "today" ? (
                <>
                  <div className="cli-dashboard__stats">
                    <div>
                      <strong>{data.counts?.pipeline || 0}</strong>
                      <span>applications</span>
                    </div>
                    <div>
                      <strong>{scheduled.length}</strong>
                      <span>calendar items</span>
                    </div>
                    <div>
                      <strong>{data.counts?.search || 0}</strong>
                      <span>saved roles</span>
                    </div>
                  </div>
                  {focus?.kind === "interview" ? (
                    <article className="cli-dashboard__feature">
                      <span className="cli-dashboard__tag">
                        {focus.type || "Interview"} · {focus.dueText}
                      </span>
                      <h2>{focus.company}</h2>
                      <p>{focus.role}</p>
                      <p>{focus.meta}</p>
                      <button
                        type="button"
                        className="cli-dashboard__primary"
                        onClick={() =>
                          focus.hasDossier
                            ? actions.openFile?.({
                                applicationId: focus.detailId,
                                kind: "interviewDossier",
                                name: "Interview prep",
                              })
                            : actions.copy?.(
                                `Prepare the upcoming interview for ${focus.company} (${focus.detailId}). Save the dossier on its job thread.`
                              )
                        }
                      >
                        {focus.hasDossier ? "Open interview prep" : "Copy prep request"}
                        <ArrowUpRight size={14} />
                      </button>
                    </article>
                  ) : null}
                  <h2 className="cli-dashboard__section-title">Next steps</h2>
                  {(data.needsYou || EMPTY).slice(0, 6).map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className="cli-dashboard__next"
                      onClick={() => request(item)}
                    >
                      <span>
                        <strong>{item.title || item.company || "Review next step"}</strong>
                        <small>
                          {item.detail ||
                            item.description ||
                            "Continue with the context saved on the job."}
                        </small>
                      </span>
                      <ArrowUpRight size={17} />
                    </button>
                  ))}
                  {!data.needsYou?.length ? (
                    <p className="cli-dashboard__empty-note">
                      No next steps are waiting. Continue your search from the CLI.
                    </p>
                  ) : null}
                  <h2 className="cli-dashboard__section-title">In your pipeline</h2>
                  {jobs.slice(0, 4).map((row) => (
                    <JobRow key={row.id} job={row} onOpen={actions.openJob} />
                  ))}
                  {!jobs.length ? (
                    <p className="cli-dashboard__empty-note">
                      Your first saved applications will appear here.
                    </p>
                  ) : null}
                </>
              ) : null}
              {tab === "pipeline" ? (
                <PipelinePanel
                  pipeline={browser.pipeline}
                  view="list"
                  filters={filters}
                  onOpenJob={actions.openJob}
                  onFilter={actions.filter}
                />
              ) : null}
              {tab === "files" ? (
                <div className="cli-dashboard__files">
                  {(browser.files || EMPTY).map((file) => (
                    <article className="cli-dashboard__file" key={file.id}>
                      <FileText size={23} />
                      <span>
                        <strong>{file.name || "Saved document"}</strong>
                        <small>{file.meta || file.kind || "Saved locally"}</small>
                      </span>
                      <button
                        type="button"
                        className="cli-dashboard__secondary"
                        onClick={() => actions.openFile?.(file)}
                      >
                        Open <ArrowUpRight size={13} />
                      </button>
                    </article>
                  ))}
                  {!browser.files?.length ? (
                    <p className="cli-dashboard__empty-note">
                      Documents appear here when your CLI saves them.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {tab === "changes" ? (
                <>
                  {changes.map((change) => (
                    <ChangeCard
                      key={`${change.message.id}:${change.index}`}
                      change={change}
                      actions={actions}
                      busy={busy}
                    />
                  ))}
                  {!changes.length ? (
                    <p className="cli-dashboard__empty-note">No recorded knowledge changes yet.</p>
                  ) : null}
                </>
              ) : null}
              {tab === "job" ? (
                job || thread ? (
                  <>
                    <button
                      className="cli-dashboard__back"
                      type="button"
                      onClick={() => actions.selectTab?.("pipeline")}
                    >
                      <ArrowLeft size={15} />
                      Pipeline
                    </button>
                    <div className="cli-dashboard__job-heading">
                      <p className="cli-dashboard__eyebrow">{job?.company || thread?.company}</p>
                      <h1>{job?.role || thread?.role || "Saved application"}</h1>
                      <span className="cli-dashboard__tag">
                        {job?.stage || thread?.stage || "Saved"}
                      </span>
                      <p>{job?.statusNote || ""}</p>
                    </div>
                    <h2 className="cli-dashboard__section-title">The job thread</h2>
                    {thread?.messages?.length ? (
                      <MessageTranscript
                        messages={thread.messages}
                        agentName="CLI"
                        onArtifactAction={(file) => actions.openFile?.({ ...file, applicationId })}
                      />
                    ) : (
                      <p className="cli-dashboard__empty-note">
                        No saved thread messages yet. Your application details and documents are
                        still available.
                      </p>
                    )}
                    {(browser.files || EMPTY)
                      .filter((file) => file.applicationId === applicationId)
                      .map((file) => (
                        <button
                          className="cli-dashboard__document"
                          type="button"
                          key={file.id}
                          onClick={() => actions.openFile?.(file)}
                        >
                          <FileText size={15} />
                          {file.name}
                          <ArrowUpRight size={13} />
                        </button>
                      ))}
                    <button
                      type="button"
                      className="cli-dashboard__primary"
                      onClick={() =>
                        actions.copy?.(dashboardHandoff(job || { id: applicationId, ...thread }))
                      }
                    >
                      Copy context for CLI <ArrowUpRight size={14} />
                    </button>
                  </>
                ) : (
                  <p role="status">This job is no longer in this workspace.</p>
                )
              ) : null}
            </>
          ) : null}
        </main>
        <aside className="cli-dashboard__side">
          <h2>
            <Calendar size={17} />
            On your calendar
          </h2>
          {scheduled.slice(0, 4).map((item) => (
            <article key={item.id} className="cli-dashboard__event">
              <small>
                {[item.iso || item.date, item.time].filter(Boolean).join(" · ") ||
                  item.meta ||
                  "Scheduled"}
              </small>
              <strong>{item.title || item.company || "Saved event"}</strong>
              <p>{item.meta || item.detail || ""}</p>
            </article>
          ))}
          {!scheduled.length ? (
            <p className="cli-dashboard__muted">No upcoming calendar items.</p>
          ) : null}
          <div className="cli-dashboard__activity">
            <h2>Recent activity</h2>
            {(data.activity || EMPTY).slice(0, 5).map((item) => (
              <article key={item.id}>
                <p>{item.title || item.label}</p>
                <small>{item.relTime || item.time || item.at || ""}</small>
              </article>
            ))}
            {!data.activity?.length ? (
              <p className="cli-dashboard__muted">Activity appears here as you work.</p>
            ) : null}
          </div>
        </aside>
      </div>
      <ArtifactViewerModal
        title={artifact?.name || "Saved document"}
        artifact={artifact}
        onClose={actions.closeFile}
      />
    </div>
  );
}

export function DashboardApp() {
  const snapshot = useDashboardSnapshot();
  const workspaceId = snapshot.workspace?.id;
  const previousWorkspace = useRef(workspaceId);
  const clearSelection = Boolean(
    previousWorkspace.current && previousWorkspace.current !== workspaceId
  );
  useEffect(() => {
    if (workspaceId) previousWorkspace.current = workspaceId;
  }, [workspaceId]);
  return (
    <DashboardWorkspace
      key={workspaceId || "loading"}
      snapshot={snapshot}
      clearSelection={clearSelection}
    />
  );
}

function DashboardWorkspace({ snapshot, clearSelection }) {
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState({ sort: "all" });
  const person = snapshot.workspace?.current;
  const startCommand = snapshot.workspace?.startCommand;
  const [ignoreSelection, setIgnoreSelection] = useState(clearSelection);
  const [notice, setNotice] = useState("");
  const [copiedPrompt, setCopiedPrompt] = useState("");
  const [artifact, setArtifact] = useState(null);
  const [busy, setBusy] = useState(false);
  const artifactRequest = useRef(0);
  const alive = useRef(true);
  const view = useMemo(
    () => (snapshot.data ? buildChatFirstView(snapshot.data, snapshot.data.chatFirst) : null),
    [snapshot.data]
  );
  const applicationId = ignoreSelection ? undefined : params.get("application");
  const requestedTab = ignoreSelection ? null : params.get("view") || params.get("browse");
  const tab = applicationId
    ? "job"
    : TABS.some(([id]) => id === requestedTab)
      ? requestedTab
      : "today";

  useEffect(() => {
    if (ignoreSelection) {
      setParams({}, { replace: true });
      setIgnoreSelection(false);
    }
  }, [ignoreSelection, setParams]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      artifactRequest.current += 1;
    };
  }, []);

  function selectTab(next) {
    artifactRequest.current += 1;
    setArtifact(null);
    setParams(next === "today" ? {} : { view: next });
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPrompt("");
      setNotice("Copied for your CLI.");
    } catch {
      setCopiedPrompt(text);
      setNotice("Clipboard access is unavailable.");
    }
  }
  async function openFile(file) {
    const request = ++artifactRequest.current;
    setNotice("");
    try {
      const loaded = await loadChatFirstArtifact({
        api: artifactApi,
        applicationId: file.applicationId || applicationId,
        file,
      });
      if (!alive.current || request !== artifactRequest.current) return;
      if (!loaded) throw new Error("This saved document is not available to preview.");
      setArtifact({ ...loaded, name: file.name || file.label || "Saved document" });
    } catch (error) {
      if (alive.current && request === artifactRequest.current)
        setNotice(
          resolveErrorCopy(error).message || "This saved document is not available to preview."
        );
    }
  }
  async function undo(messageId, index) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await revertKnowledgeChange({ messageId, index });
      if (alive.current) {
        const message = result?.data?.messages?.at(-1);
        setNotice(message?.text || "The change was reviewed. The saved record shows the result.");
        await snapshot.refetch();
      }
    } catch (error) {
      if (alive.current)
        setNotice(resolveErrorCopy(error).message || "CareerRat couldn't undo this change.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <DashboardView
      view={view}
      focus={snapshot.data?.focus}
      tab={tab}
      applicationId={applicationId}
      loading={snapshot.loading}
      noDatabase={snapshot.noDatabase}
      error={snapshot.error}
      notice={notice}
      copiedPrompt={copiedPrompt}
      artifact={artifact}
      busy={busy}
      filters={filters}
      person={person}
      startCommand={startCommand}
      workspaceKnown={Boolean(startCommand)}
      actions={{
        selectTab,
        openFile,
        copy,
        undo,
        retry: () => {
          snapshot.refetch();
        },
        filter: (key, value) => setFilters((current) => ({ ...current, [key]: value })),
        openJob: (id) => {
          artifactRequest.current += 1;
          setArtifact(null);
          setParams({ application: id });
        },
        closeFile: () => {
          artifactRequest.current += 1;
          setArtifact(null);
        },
      }}
    />
  );
}
