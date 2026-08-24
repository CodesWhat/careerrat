import { UploadIcon } from "./chat-first-icons.jsx";
import { artifactEmoji } from "./chat-first-model.js";
import "./chat-first.css";

const EMPTY_LIST = [];

function AgentBubble({ agentName = "Paul", children }) {
  return (
    <div className="chat-first-message chat-first-message--agent">
      <span className="chat-first-avatar" role="img" aria-label={agentName}>
        🐀
      </span>
      <div className="chat-first-bubble">{children}</div>
    </div>
  );
}

function UserBubble({ children }) {
  return <div className="chat-first-bubble chat-first-bubble--user">{children}</div>;
}

function RunReceipt({ receipt }) {
  if (!receipt) return null;
  return (
    <div
      className={`chat-first-run-receipt${receipt.tone ? ` chat-first-run-receipt--${receipt.tone}` : ""}`}
    >
      <span className="chat-first-run-receipt__mark">{receipt.mark || "✓"}</span>
      <span>{receipt.label}</span>
      {receipt.actionLabel ? (
        <button type="button" onClick={receipt.onAction}>
          {receipt.actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function artifactTitle(artifact) {
  if (artifact?.title || artifact?.name || artifact?.label) {
    return artifact.title || artifact.name || artifact.label;
  }
  const kind = String(artifact?.kind || "artifact").replaceAll("_", " ");
  return kind.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function artifactSubtitle(artifact) {
  const value = artifact?.subtitle || artifact?.summary || artifact?.description || artifact?.note;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const summary = [
    Number.isFinite(Number(value.qualified)) ? `${Number(value.qualified)} qualified` : null,
    Number.isFinite(Number(value.scanned)) ? `${Number(value.scanned)} scanned` : null,
    Number.isFinite(Number(value.attemptedSources))
      ? `${Number(value.attemptedSources)} sources`
      : null,
  ].filter(Boolean);
  if (summary.length) return summary.join(" · ");

  return [value.text, value.label, value.title, value.description].find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );
}

function artifactView(artifact, message, onArtifactAction) {
  const ownAction = artifact?.onAction;
  const canOpen = typeof ownAction === "function" || typeof onArtifactAction === "function";
  const title = artifactTitle(artifact);
  return {
    ...artifact,
    title,
    icon: artifact?.icon || artifactEmoji(artifact?.kind || title),
    subtitle: artifactSubtitle(artifact),
    actionLabel: artifact?.actionLabel || artifact?.primaryLabel || (canOpen ? "Open" : null),
    onAction: canOpen
      ? () => {
          if (typeof ownAction === "function") ownAction(artifact, message);
          else onArtifactAction(artifact, message);
        }
      : undefined,
  };
}

function AttachedArtifacts({ message, onArtifactAction }) {
  const artifacts = Array.isArray(message?.artifacts) ? message.artifacts : EMPTY_LIST;
  if (!artifacts.length) return null;
  return artifacts.map((artifact, index) => (
    <div
      className="chat-first-indented-card"
      key={artifact?.id || `${message.id}:artifact-${index + 1}`}
    >
      <ArtifactCard artifact={artifactView(artifact, message, onArtifactAction)} />
    </div>
  ));
}

function ArtifactCard({ artifact }) {
  return (
    <article className="chat-first-artifact-card">
      <span className="chat-first-artifact-card__icon" aria-hidden="true">
        {artifact.icon || "📄"}
      </span>
      <div className="chat-first-artifact-card__copy">
        <strong>{artifact.title}</strong>
        {artifact.subtitle ? <span>{artifact.subtitle}</span> : null}
      </div>
      {artifact.actionLabel ? (
        <button
          className="chat-first-pill chat-first-pill--lime"
          type="button"
          onClick={artifact.onAction}
        >
          {artifact.actionLabel}
        </button>
      ) : null}
      {(artifact.secondaryActions || EMPTY_LIST).map((action) => (
        <button
          className="chat-first-pill chat-first-pill--outline"
          type="button"
          key={action.id}
          onClick={action.onAction}
        >
          {action.label}
        </button>
      ))}
    </article>
  );
}

export function MessageTranscript({
  messages = EMPTY_LIST,
  agentName = "Paul",
  onArtifactAction,
  onMessageAction,
}) {
  return (
    <div className="chat-first-conversation-flow">
      {messages.map((message, index) => {
        if (!message || message.kind === "gate" || message.kind === "decision") return null;
        const key = message.id || `message-${index + 1}`;
        const isError = message.kind === "action_error" || message.kind === "agent_error";
        const isReceipt =
          isError ||
          message.kind === "action_result" ||
          message.kind === "run" ||
          message.kind === "status" ||
          message.role === "system";
        let content;
        if (isReceipt) {
          const action = message.onAction || onMessageAction;
          content = (
            <RunReceipt
              receipt={{
                mark: message.metadata?.mark || (isError ? "!" : undefined),
                label: message.text || message.error?.message || "Action updated",
                tone: isError ? "error" : undefined,
                actionLabel:
                  message.metadata?.actionLabel ||
                  (typeof onMessageAction === "function" && message.kind === "action_result"
                    ? "activity"
                    : undefined),
                onAction:
                  typeof action === "function"
                    ? () => {
                        if (message.onAction) message.onAction(message);
                        else onMessageAction(message);
                      }
                    : undefined,
              }}
            />
          );
        } else if (message.kind === "artifact") {
          content = (
            <div className="chat-first-indented-card">
              <ArtifactCard
                artifact={artifactView(
                  {
                    id: key,
                    kind: message.metadata?.kind,
                    title: message.text,
                    icon: message.metadata?.icon,
                    subtitle: message.metadata?.subtitle,
                    actionLabel: message.metadata?.actionLabel,
                    onAction: message.onAction,
                    secondaryActions: message.metadata?.secondaryActions,
                  },
                  message,
                  onArtifactAction
                )}
              />
            </div>
          );
        } else if (message.role === "user") {
          content = <UserBubble>{message.text}</UserBubble>;
        } else {
          content = <AgentBubble agentName={agentName}>{message.text}</AgentBubble>;
        }
        return (
          <div className="chat-first-transcript-entry" key={key}>
            {content}
            <AttachedArtifacts message={message} onArtifactAction={onArtifactAction} />
          </div>
        );
      })}
    </div>
  );
}

export function ConversationPanel({ children, composer }) {
  return (
    <section className="chat-first-conversation-panel" aria-label="Conversation">
      <div className="chat-first-conversation-panel__scroll">{children}</div>
      {composer ? <div className="chat-first-conversation-panel__composer">{composer}</div> : null}
    </section>
  );
}

export function TodayConversation({
  agentName = "Paul",
  dateLabel = "TODAY",
  intro,
  run,
  messages = EMPTY_LIST,
  artifacts = EMPTY_LIST,
  mission,
  userMessages = EMPTY_LIST,
  onArtifactAction,
  onMessageAction,
}) {
  return (
    <div className="chat-first-conversation-flow">
      <div className="chat-first-conversation-eyebrow">{dateLabel}</div>
      {intro ? <AgentBubble agentName={agentName}>{intro}</AgentBubble> : null}
      <RunReceipt receipt={run} />
      {messages.length ? (
        <MessageTranscript
          messages={messages}
          agentName={agentName}
          onArtifactAction={onArtifactAction}
          onMessageAction={onMessageAction}
        />
      ) : null}
      {artifacts.map((artifact) => (
        <div className="chat-first-indented-card" key={artifact.id}>
          <ArtifactCard artifact={artifact} />
        </div>
      ))}
      {mission ? (
        <div className="chat-first-indented-card">
          <article className="chat-first-mission">
            <div className="chat-first-mission__header">
              <span className="chat-first-eyebrow">MISSION</span>
              <strong>{mission.title}</strong>
              {mission.onPause ? (
                <button type="button" onClick={mission.onPause}>
                  pause
                </button>
              ) : null}
              {mission.onResume ? (
                <button type="button" onClick={mission.onResume}>
                  resume
                </button>
              ) : null}
            </div>
            <div className="chat-first-mission__steps">
              {(mission.steps || EMPTY_LIST).map((step) => {
                const text = typeof step === "object" ? step.text : step;
                const key = typeof step === "object" ? step.id : step;
                return <div key={key}>{text}</div>;
              })}
              {mission.footnote ? <small>{mission.footnote}</small> : null}
            </div>
          </article>
        </div>
      ) : null}
      {userMessages.map((message) => (
        <UserBubble key={message.id}>{message.text}</UserBubble>
      ))}
    </div>
  );
}

export function JobConversation({
  eyebrow,
  inbound,
  agentName = "Paul",
  agentReply,
  actions = EMPTY_LIST,
  artifacts = EMPTY_LIST,
  receipt,
  userMessage,
  finalReply,
  messages = EMPTY_LIST,
  onArtifactAction,
  onMessageAction,
}) {
  return (
    <div className="chat-first-conversation-flow">
      <div className="chat-first-conversation-eyebrow">{eyebrow}</div>
      {inbound ? (
        <blockquote className="chat-first-inbound">
          <strong>✉ {inbound.sender}</strong>
          <span>{inbound.body}</span>
        </blockquote>
      ) : null}
      {agentReply ? (
        <AgentBubble agentName={agentName}>
          <span>{agentReply}</span>
          {actions.length ? (
            <div className="chat-first-inline-actions">
              {actions.map((action) => (
                <button
                  className={`chat-first-pill chat-first-pill--${action.tone === "primary" ? "lime" : "outline"}`}
                  type="button"
                  key={action.id}
                  onClick={action.onAction}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </AgentBubble>
      ) : null}
      {artifacts.map((artifact) => (
        <div className="chat-first-indented-card" key={artifact.id}>
          <ArtifactCard artifact={artifact} />
        </div>
      ))}
      <RunReceipt receipt={receipt} />
      {userMessage ? <UserBubble>{userMessage}</UserBubble> : null}
      {finalReply ? <AgentBubble agentName={agentName}>{finalReply}</AgentBubble> : null}
      {messages.length ? (
        <MessageTranscript
          messages={messages}
          agentName={agentName}
          onArtifactAction={onArtifactAction}
          onMessageAction={onMessageAction}
        />
      ) : null}
    </div>
  );
}

function canonicalInbound(communication) {
  const inbound = (communication?.messages || EMPTY_LIST)
    .filter((message) => message?.direction === "inbound")
    .at(-1);
  if (!inbound) return null;
  const participant = (communication?.participants || EMPTY_LIST).find(
    (person) => person?.name || person?.email
  );
  const senderName = inbound.from || participant?.name || participant?.email || "Recruiter";
  const sender = participant?.role ? `${senderName} · ${participant.role}` : senderName;
  return { sender, body: inbound.body || inbound.summary || communication?.summary || "" };
}

export function CanonicalJobConversation({
  eyebrow,
  agentName = "Paul",
  communication,
  threadMessages = EMPTY_LIST,
  onApproveAndCopy,
  onEditDraft,
  onCoach,
  onArtifactAction,
  onMessageAction,
}) {
  const draft = communication?.draft;
  const actions = draft
    ? [
        {
          id: "approve-copy",
          label: "Approve & copy",
          tone: "primary",
          onAction: () => onApproveAndCopy?.(draft, communication),
        },
        { id: "edit", label: "Edit", onAction: () => onEditDraft?.(draft, communication) },
        { id: "coach", label: "Coach me live", onAction: () => onCoach?.(communication) },
      ]
    : EMPTY_LIST;
  return (
    <JobConversation
      eyebrow={eyebrow}
      inbound={canonicalInbound(communication)}
      agentName={agentName}
      agentReply={draft?.body || null}
      actions={actions}
      messages={threadMessages}
      onArtifactAction={onArtifactAction}
      onMessageAction={onMessageAction}
    />
  );
}

export function JobContextPanel({
  job,
  summary,
  summaryPosition = "before-files",
  files = EMPTY_LIST,
  note,
  action,
}) {
  const summaryCard = summary ? (
    <section className="chat-first-context-card chat-first-context-card--cream">
      <strong>{summary.title}</strong>
      {(summary.lines || EMPTY_LIST).map((line) => (
        <span key={line}>{line}</span>
      ))}
    </section>
  ) : null;

  return (
    <aside className="chat-first-context-stack" aria-label="This job">
      <div className="chat-first-eyebrow chat-first-context-stack__heading">THIS JOB</div>
      {job ? (
        <section className="chat-first-context-card">
          <strong className="chat-first-context-card__title">{job.company}</strong>
          <span className="chat-first-context-card__meta">
            {job.role} · {job.stage}
          </span>
          <div className="chat-first-context-card__score">
            <strong>{job.fit}</strong>
            {job.badge ? <span>{job.badge}</span> : null}
          </div>
        </section>
      ) : null}
      {summaryPosition === "after-files" ? null : summaryCard}
      {files.map((file) => (
        <section className="chat-first-file-card" key={file.id}>
          <span aria-hidden="true">{file.icon || "📄"}</span>
          <div>
            <strong>{file.name}</strong>
            {file.meta ? <small>{file.meta}</small> : null}
          </div>
          {file.onOpen || file.onExport ? (
            <span className="chat-first-file-card__actions">
              {file.onOpen ? (
                <button type="button" onClick={file.onOpen}>
                  Open
                </button>
              ) : null}
              {file.onExport ? (
                <button type="button" onClick={file.onExport}>
                  Export PDF
                </button>
              ) : null}
            </span>
          ) : null}
        </section>
      ))}
      {summaryPosition === "after-files" ? summaryCard : null}
      {note ? <div className="chat-first-dashed-note">{note}</div> : null}
      {action ? (
        <button className="chat-first-context-action" type="button" onClick={action.onAction}>
          {action.label}
        </button>
      ) : null}
    </aside>
  );
}

export function MockInterviewConversation({
  company,
  round,
  questionNumber,
  totalQuestions,
  question,
  interviewer,
  interviewerHint,
  userAnswer,
  worked,
  tighten,
  previousFeedback,
  retryPrompt,
  agentName = "Paul",
}) {
  const contextLabel = round
    ? `${String(company || "JOB").toUpperCase()} · ${String(round).toUpperCase()}`
    : `${String(company || "JOB").toUpperCase()} CONTEXT`;
  const currentFeedback = worked || tighten ? { questionNumber, worked, tighten } : null;

  function feedbackCard(feedback) {
    if (!feedback?.worked && !feedback?.tighten) return null;
    return (
      <div className="chat-first-indented-card">
        <section className="chat-first-feedback">
          <div className="chat-first-eyebrow">
            FEEDBACK
            {feedback.questionNumber ? ` · QUESTION ${feedback.questionNumber}` : ""}
          </div>
          {feedback.worked ? (
            <p>
              <strong>Worked:</strong> {feedback.worked}
            </p>
          ) : null}
          {feedback.tighten ? (
            <p>
              <strong>Tighten:</strong> {feedback.tighten}
            </p>
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="chat-first-conversation-flow">
      <div className="chat-first-conversation-eyebrow">
        MOCK INTERVIEW · {contextLabel} · QUESTION {questionNumber} OF {totalQuestions}
      </div>
      {feedbackCard(previousFeedback)}
      <AgentBubble agentName={agentName}>
        {question}{" "}
        {interviewerHint || interviewer ? (
          <span className="chat-first-muted">({interviewerHint || interviewer})</span>
        ) : null}
      </AgentBubble>
      {userAnswer ? <UserBubble>{userAnswer}</UserBubble> : null}
      {feedbackCard(currentFeedback)}
      {retryPrompt ? <AgentBubble agentName={agentName}>{retryPrompt}</AgentBubble> : null}
    </div>
  );
}

export function MockInterviewContext({ title, detail, loadedContext, onEnd }) {
  return (
    <aside className="chat-first-context-stack" aria-label="Live session">
      <div className="chat-first-eyebrow chat-first-context-stack__heading">LIVE SESSION</div>
      <section className="chat-first-context-card chat-first-context-card--ink">
        <div className="chat-first-eyebrow">MOCK INTERVIEW</div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </section>
      <section className="chat-first-context-card">
        <strong>Context loaded</strong>
        <span>{loadedContext}</span>
      </section>
      <button
        className="chat-first-context-action chat-first-context-action--outline"
        type="button"
        onClick={onEnd}
      >
        End session → back to thread
      </button>
    </aside>
  );
}

export function DeepIngestConversation({
  agentName = "Paul",
  intro,
  lastSession,
  counts = {},
  sources = EMPTY_LIST,
  proposals = EMPTY_LIST,
  receipt,
  inputMode = null,
  inputValue = "",
  editingId = null,
  editDraft = {},
  busy = false,
  onFiles,
  onPaste,
  onLinkRepo,
  onInputChange,
  onInputSubmit,
  onInputCancel,
  onAnalyze,
  onStartEdit,
  onEditChange,
  onSaveEdit,
  onConfirm,
  onDefer,
  onReject,
}) {
  const reviewCount = Number(counts.reviewQueue || 0);
  const sourceCount = Number(counts.sources || 0);
  const confirmedCount = Number(counts.confirmed || 0);
  return (
    <div className="chat-first-conversation-flow">
      <div className="chat-first-conversation-eyebrow">
        DEEP INGEST · PICKS UP WHERE YOU LEFT OFF
      </div>
      <AgentBubble agentName={agentName}>{intro}</AgentBubble>
      <div className="chat-first-indented-card">
        <fieldset
          className="chat-first-drop-card"
          aria-label="Files to ingest"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (event.dataTransfer?.files?.length) onFiles?.(event.dataTransfer.files);
          }}
        >
          <label>
            <span aria-hidden="true" className="chat-first-drop-card__icon">
              <UploadIcon />
            </span>
            <strong>drop files here</strong>
            <small>or choose them</small>
            <input
              type="file"
              multiple
              aria-label="Choose files to ingest"
              onChange={(event) => onFiles?.(event.target.files)}
            />
          </label>
          <div className="chat-first-inline-actions chat-first-inline-actions--centered">
            <button
              className="chat-first-pill chat-first-pill--outline"
              type="button"
              onClick={onPaste}
            >
              Paste text
            </button>
            <button
              className="chat-first-pill chat-first-pill--outline"
              type="button"
              onClick={onLinkRepo}
            >
              Link a repo
            </button>
          </div>
        </fieldset>
      </div>
      {inputMode ? (
        <form
          className="chat-first-deep-input"
          onSubmit={(event) => {
            event.preventDefault();
            onInputSubmit?.();
          }}
        >
          <div className="chat-first-eyebrow">
            {inputMode === "repo" ? "REPOSITORY" : "PASTE MATERIAL"}
          </div>
          {inputMode === "repo" ? (
            <input
              aria-label="Repository URL or local path"
              value={inputValue}
              placeholder="https://github.com/you/project or /local/path"
              onChange={(event) => onInputChange?.(event.target.value)}
            />
          ) : (
            <textarea
              aria-label="Career material to ingest"
              rows={6}
              value={inputValue}
              placeholder="Paste project notes, work history, wins, or context your resume left out."
              onChange={(event) => onInputChange?.(event.target.value)}
            />
          )}
          <div className="chat-first-inline-actions">
            <button
              className="chat-first-pill chat-first-pill--lime"
              type="submit"
              disabled={busy || !String(inputValue).trim()}
            >
              {busy ? "Saving…" : inputMode === "repo" ? "Add repository" : "Add material"}
            </button>
            <button
              className="chat-first-pill chat-first-pill--outline"
              type="button"
              disabled={busy}
              onClick={onInputCancel}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {sourceCount || confirmedCount || reviewCount ? (
        <div className="chat-first-deep-counts">
          <span>{sourceCount} sources</span>
          <span>{confirmedCount} confirmed</span>
          <span className={reviewCount ? "chat-first-deep-counts__attention" : undefined}>
            {reviewCount} to review
          </span>
        </div>
      ) : null}
      {receipt ? (
        <RunReceipt
          receipt={typeof receipt === "string" ? { label: receipt } : { mark: "✓", ...receipt }}
        />
      ) : null}
      {sources.length ? (
        <section className="chat-first-deep-sources" aria-label="Ingested sources">
          <div className="chat-first-eyebrow">SOURCES</div>
          {sources.map((source) => (
            <div className="chat-first-deep-source" key={source.id}>
              <div>
                <strong>{source.label}</strong>
                <small>{source.statusLabel}</small>
              </div>
              {source.canAnalyze ? (
                <button
                  className="chat-first-pill chat-first-pill--ink"
                  type="button"
                  disabled={busy}
                  onClick={() => onAnalyze?.(source)}
                >
                  {busy ? "Analyzing…" : "Analyze"}
                </button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {proposals.length ? (
        <section className="chat-first-deep-review" aria-label="Proposal review queue">
          <div className="chat-first-eyebrow">REVIEW QUEUE</div>
          {proposals.map((proposal) => {
            const editing = editingId === proposal.id;
            const title = editing ? editDraft.title : proposal.title;
            const summary = editing ? editDraft.summary : proposal.summary;
            const quote = editing ? editDraft.supportingQuote : proposal.supportingQuote;
            return (
              <article className="chat-first-deep-proposal" key={proposal.id}>
                <div className="chat-first-deep-proposal__lane">
                  {String(proposal.lane || "proposal").replaceAll("_", " ")}
                </div>
                {editing ? (
                  <div className="chat-first-deep-proposal__fields">
                    <input
                      aria-label="Proposal title"
                      value={title || ""}
                      onChange={(event) => onEditChange?.("title", event.target.value)}
                    />
                    <textarea
                      aria-label="Proposal summary"
                      rows={3}
                      value={summary || ""}
                      onChange={(event) => onEditChange?.("summary", event.target.value)}
                    />
                    <textarea
                      aria-label="Supporting quote"
                      rows={2}
                      value={quote || ""}
                      onChange={(event) => onEditChange?.("supportingQuote", event.target.value)}
                    />
                    <button
                      className="chat-first-pill chat-first-pill--outline"
                      type="button"
                      disabled={busy}
                      onClick={() => onSaveEdit?.(proposal)}
                    >
                      Save changes
                    </button>
                  </div>
                ) : (
                  <div className="chat-first-deep-proposal__copy">
                    <strong>{title || "Untitled proposal"}</strong>
                    {summary ? <p>{summary}</p> : null}
                    {quote ? <blockquote>“{quote}”</blockquote> : null}
                    <button type="button" disabled={busy} onClick={() => onStartEdit?.(proposal)}>
                      Edit
                    </button>
                  </div>
                )}
                <div className="chat-first-deep-proposal__actions">
                  <button
                    className="chat-first-pill chat-first-pill--lime"
                    type="button"
                    disabled={busy}
                    onClick={() => onConfirm?.(proposal)}
                  >
                    Confirm
                  </button>
                  <button
                    className="chat-first-pill chat-first-pill--outline"
                    type="button"
                    disabled={busy}
                    onClick={() => onDefer?.(proposal)}
                  >
                    Defer
                  </button>
                  <button
                    className="chat-first-deep-proposal__reject"
                    type="button"
                    disabled={busy}
                    onClick={() => onReject?.(proposal)}
                  >
                    Reject
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      ) : sourceCount ? (
        <div className="chat-first-dashed-note">
          No proposals need review right now. Analyze a ready source or add more material.
        </div>
      ) : null}
      {lastSession ? <RunReceipt receipt={{ label: `Last session: ${lastSession}` }} /> : null}
    </div>
  );
}

export function DeepIngestContext({ evidenceItems = EMPTY_LIST, unlockSummary, onPause }) {
  return (
    <aside className="chat-first-context-stack" aria-label="Evidence bank">
      <div className="chat-first-eyebrow chat-first-context-stack__heading">EVIDENCE BANK</div>
      <section className="chat-first-context-card chat-first-evidence-list">
        {evidenceItems.map((item) => (
          <strong key={item}>✓ {item}</strong>
        ))}
        <span>+ grows with every doc you feed in</span>
      </section>
      <section className="chat-first-context-card chat-first-context-card--cream">
        <strong>What this unlocks</strong>
        <span>{unlockSummary}</span>
      </section>
      <button
        className="chat-first-context-action chat-first-context-action--outline"
        type="button"
        onClick={onPause}
      >
        Pause → back to Today
      </button>
    </aside>
  );
}

function gateDeadlineCopy(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const deadline = new Date(value);
  if (Number.isNaN(deadline.getTime())) return value;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const deadlineDay = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
  const dayOffset = Math.round((deadlineDay.getTime() - today.getTime()) / 86_400_000);
  const hours = deadline.getHours();
  const minutes = deadline.getMinutes();
  const clock = `${hours % 12 || 12}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}${
    hours >= 12 ? "pm" : "am"
  }`;
  const day =
    dayOffset === 0
      ? "today"
      : dayOffset === 1
        ? "tomorrow"
        : deadline.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `closes ${clock} ${day}`;
}

export function SubmitGateModal({
  open,
  agentName = "Paul",
  gate,
  onClose,
  onReviewAnswers,
  onViewPacket,
  onRequestChanges,
  onSubmit,
}) {
  if (!open) return null;

  const packet = gate?.packet || EMPTY_LIST;
  const company = gate?.company || "this company";
  const role = gate?.role || "role";
  const channel = gate?.channel || "the job portal";

  return (
    <div className="chat-first-cover chat-first-cover--gate">
      <section
        className="chat-first-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-first-gate-title"
      >
        <header className="chat-first-gate__header">
          <div>
            <h2 id="chat-first-gate-title">
              Submit to {company} · {role}
            </h2>
            <p>
              via {channel}
              {gate?.deadline ? ` · ${gateDeadlineCopy(gate.deadline)}` : ""}
            </p>
          </div>
          {gate?.expiryLabel ? (
            <span className="chat-first-gate__expiry">{gate.expiryLabel}</span>
          ) : null}
          <button
            className="chat-first-icon-button"
            type="button"
            aria-label="Close submit review"
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className="chat-first-gate__body">
          <div className="chat-first-gate__column">
            <div className="chat-first-eyebrow">WHAT {String(agentName).toUpperCase()} FILLED</div>
            <div className="chat-first-gate-row">
              <strong>✓</strong>
              <span>
                <strong>Contact &amp; work authorization</strong>
                <small>from your profile</small>
              </span>
            </div>
            <div className="chat-first-gate-row">
              <strong>✓</strong>
              <span>
                <strong>{gate?.answeredCount || 0} application questions answered</strong>
                <small>
                  every claim traces to your evidence ·{" "}
                  <button type="button" onClick={onReviewAnswers}>
                    review answers
                  </button>
                </small>
              </span>
            </div>
            <div className="chat-first-gate-row chat-first-gate-row--blank">
              <strong>−</strong>
              <span>
                <strong>Demographic / EEO questions</strong>
                <small>left blank for you · never auto-answered</small>
              </span>
            </div>
          </div>
          <div className="chat-first-gate__column">
            <div className="chat-first-eyebrow">PACKET</div>
            {packet.map((item) => (
              <div className="chat-first-gate-row chat-first-gate-row--packet" key={item.id}>
                <span aria-hidden="true">{item.icon || "📄"}</span>
                <strong>{item.name}</strong>
                <button type="button" onClick={() => onViewPacket?.(item.id)}>
                  View
                </button>
              </div>
            ))}
            <p className="chat-first-gate__packet-note">
              Exports as PDF, matching what the form expects.
            </p>
          </div>
        </div>
        <footer className="chat-first-gate__footer">
          <p>The form is filled and waiting. Nothing sends until you press submit.</p>
          <button
            className="chat-first-pill chat-first-pill--outline"
            type="button"
            onClick={onRequestChanges}
          >
            Ask {agentName} to change something
          </button>
          <button
            className="chat-first-pill chat-first-pill--lime"
            type="button"
            onClick={onSubmit}
          >
            Open {channel} &amp; submit ↗
          </button>
        </footer>
      </section>
    </div>
  );
}

export function EngineDownCover({
  open,
  agentName = "Paul",
  onRetry,
  onOpenSettings,
  onShowTechnical,
  technicalDetails,
}) {
  if (!open) return null;
  return (
    <div className="chat-first-cover chat-first-cover--engine">
      <section
        className="chat-first-engine-down"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="chat-first-engine-title"
      >
        <span className="chat-first-engine-down__avatar" aria-hidden="true">
          🐀
        </span>
        <h2 id="chat-first-engine-title">{agentName} can't think right now</h2>
        <p>
          The AI on this computer isn't responding. Your data is fine, everything lives in local
          files,
          {` ${agentName}`} just can't act on it until it's back.
        </p>
        <div className="chat-first-engine-down__actions">
          <button className="chat-first-pill chat-first-pill--lime" type="button" onClick={onRetry}>
            Retry
          </button>
          <button
            className="chat-first-pill chat-first-pill--outline"
            type="button"
            onClick={onOpenSettings}
          >
            Open settings
          </button>
        </div>
        <button
          className="chat-first-engine-down__technical"
          type="button"
          onClick={onShowTechnical}
        >
          what happened, technically
        </button>
        {technicalDetails ? (
          <p className="chat-first-engine-down__technical-details" role="status">
            {technicalDetails}
          </p>
        ) : null}
      </section>
    </div>
  );
}
