import { cleanAgentCopy } from "./agent-copy.js";
import { SendUpIcon } from "./chat-first-icons.jsx";
import { isFirstRunExtractedFact } from "./first-run-controller.js";
import { RuntimeIcon } from "./RuntimeIcon.jsx";
import { TopBar } from "./workspace-shell.jsx";
import "./first-run.css";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactAssistantText(value) {
  return cleanAgentCopy(value);
}

const RESUME_ACCEPT = ".pdf,.docx,.txt,.md,image/*";

function firstFile(files) {
  return files?.[0] || null;
}

function actionableOptions(message, blocks) {
  return safeArray(message.options).filter((option) => {
    const match = /^(?:confirm|decline):(\d+)$/.exec(String(option?.id || ""));
    if (!match) return true;
    return !isFirstRunExtractedFact(blocks[Number(match[1])]);
  });
}

function progressValues(progress = {}) {
  const total = Math.max(0, Number(progress?.total) || 0);
  const completed = Math.max(0, Math.min(total, Number(progress?.completed) || 0));
  return { completed, total, percent: total > 0 ? Math.round((completed / total) * 100) : 0 };
}

function engineStatus(engine) {
  if (engine.selectable === false) return "Secure tool runs unavailable";
  if (engine.ready) return engine.selected ? "Selected" : "Ready";
  if (engine.status === "authentication_required") return "Sign-in needed";
  if (!engine.detected) return "Not found";
  return "Needs attention";
}

export function FirstRunShell({ agentName = "Paul", onOpenSettings, children }) {
  return (
    <div className="chat-first-workspace cf-first-run-shell">
      <TopBar agentName={agentName} showActivity={false} onOpenProfile={onOpenSettings} />
      <main className="cf-first-run-shell__body">{children}</main>
    </div>
  );
}

export function EngineSelection({
  agentName = "Paul",
  engines = [],
  error,
  submitting = false,
  onSelectEngine,
  onRetryEngine,
  onOpenSettings,
}) {
  const choices = safeArray(engines);
  const primaryChoices = choices.slice(0, 4);
  return (
    <section className="cf-first-run__engine" aria-labelledby="cf-engine-title">
      <span className="cf-first-run__large-avatar" aria-hidden="true">
        🐀
      </span>
      <div className="cf-first-run__engine-intro">
        <h1 id="cf-engine-title">Choose the AI that powers {agentName}</h1>
        <p>
          CareerRat found these on your computer. Your files stay here. The one you pick talks to
          its own provider, the same as any task you'd give it.
        </p>
        {error ? (
          <div className="cf-first-run__engine-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <div className="cf-first-run__engine-choices">
        {primaryChoices.length > 0 ? (
          primaryChoices.map((engine) => {
            const className = `cf-first-run__engine-choice${engine.recommended ? " cf-first-run__engine-choice--recommended" : ""}`;
            const content = (
              <>
                <div className="cf-first-run__engine-name">
                  <RuntimeIcon runtimeId={engine.id} name={engine.name} size={24} />
                  <strong>{engine.name || "AI engine"}</strong>
                </div>
                <span>
                  {engineStatus(engine)}
                  {engine.detected ? " · detected ✓" : ""}
                </span>
                {engine.selectable === false && engine.capabilityReason ? (
                  <span>{engine.capabilityReason}</span>
                ) : null}
                {engine.recommended ? (
                  <span className="cf-first-run__recommended">RECOMMENDED</span>
                ) : null}
              </>
            );
            if (engine.ready && engine.selectable !== false) {
              return (
                <button
                  key={engine.id}
                  type="button"
                  className={className}
                  aria-pressed={Boolean(engine.selected)}
                  disabled={submitting}
                  onClick={() => onSelectEngine?.(engine.id)}
                >
                  {content}
                </button>
              );
            }
            return (
              <article key={engine.id} className={className}>
                {content}
                {engine.action === "open_terminal" ? null : (
                  <button
                    className="cf-first-run__engine-action"
                    type="button"
                    disabled={submitting}
                    onClick={() =>
                      engine.detected ? onRetryEngine?.(engine.id) : onOpenSettings?.()
                    }
                  >
                    {engine.detected ? "Retry detection" : "Set up in settings"}
                  </button>
                )}
              </article>
            );
          })
        ) : (
          <div className="cf-first-run__engine-empty">
            No compatible AI was found yet. Retry detection or open settings to connect one.
          </div>
        )}
      </div>
      <div className="cf-first-run__engine-footer">
        <span>no account, no CareerRat server · you can switch later in settings</span>
        <button type="button" disabled={submitting} onClick={onOpenSettings}>
          {choices.length > primaryChoices.length
            ? `See all ${choices.length} in settings`
            : "Open settings"}
        </button>
      </div>
    </section>
  );
}

function FirstRunRail({ agentName }) {
  return (
    <aside className="cf-first-run__rail" aria-label="Workspace preview">
      <div className="cf-first-run__paul-card">
        <strong>
          <span className="cf-first-run__rail-avatar" aria-hidden="true">
            🐀
          </span>
          {agentName}
        </strong>
        <span className="cf-first-run__rail-subtitle">main chat · you're here</span>
      </div>
      <div className="cf-first-run__locked-rail">
        <div className="cf-first-run__eyebrow">JOB CONVERSATIONS</div>
        <div className="cf-first-run__placeholder">
          threads appear when a recruiter replies or an interview lands
        </div>
        <div className="cf-first-run__eyebrow">BROWSE</div>
        <div className="cf-first-run__placeholder">
          Search, Pipeline, Files, People, Schedule. They unlock after your first sweep.
        </div>
      </div>
    </aside>
  );
}

function AssistantMessage({ message, agentName, onChooseOption, itemKey }) {
  const blocks = safeArray(message.blocks);
  const extractedFacts = blocks.filter(isFirstRunExtractedFact);
  const hasExtractedFacts = extractedFacts.length > 0;
  const factsSaved =
    hasExtractedFacts && extractedFacts.every((block) => block?.status === "resolved");
  const assistantCopy = compactAssistantText(message.text);
  const options = actionableOptions(message, blocks);
  return (
    <article
      key={itemKey}
      className={`cf-first-run__assistant-message${hasExtractedFacts ? " cf-first-run__assistant-message--knowledge-update" : ""}`}
    >
      <span className="cf-first-run__message-avatar" aria-hidden="true">
        🐀
      </span>
      <div className="cf-first-run__assistant-bubble">
        {hasExtractedFacts ? (
          <p className="cf-first-run__knowledge-acknowledgement">
            {factsSaved ? `Updated What ${agentName} knows.` : `Updating What ${agentName} knows…`}
          </p>
        ) : null}
        {assistantCopy ? (
          <p className={hasExtractedFacts ? "cf-first-run__assistant-follow-up" : undefined}>
            {assistantCopy}
          </p>
        ) : hasExtractedFacts ? null : (
          <p>{agentName} is ready for your answer.</p>
        )}
        {options.length > 0 ? (
          <div className="cf-first-run__answer-options">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onChooseOption?.(message.id, option.id)}
              >
                {option.label}
              </button>
            ))}
            {message.allowTypedAnswer !== false ? (
              <span className="cf-first-run__answer-hint">or just type it</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function TranscriptMessage({ message, agentName, onChooseOption, itemKey }) {
  if (message?.role === "user")
    return (
      <article key={itemKey} className="cf-first-run__user-bubble">
        {message.text || ""}
      </article>
    );
  return AssistantMessage({ message: message || {}, agentName, onChooseOption, itemKey });
}

function KnowledgePanel({ agentName, knowledge = [], progress = {}, onEditSection, onResumeFile }) {
  const current = progressValues(progress);
  return (
    <aside className="cf-first-run__knowledge" aria-label={`What ${agentName} knows`}>
      <div className="cf-first-run__knowledge-title">
        <span className="cf-first-run__knowledge-label">WHAT {agentName.toUpperCase()} KNOWS</span>
        <strong>
          {current.completed} of {current.total}
        </strong>
      </div>
      <div
        className="cf-first-run__progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax={current.total}
        aria-valuenow={current.completed}
      >
        <span
          className="cf-first-run__progress-value"
          style={{ "--cf-progress-width": `${current.percent}%` }}
        />
      </div>
      <div className="cf-first-run__knowledge-cards">
        {safeArray(knowledge).length > 0 ? (
          knowledge.map((item) => {
            const lines = safeArray(item.lines);
            return (
              <article
                key={item.id}
                className={`cf-first-run__knowledge-card cf-first-run__knowledge-card--${item.status || "pending"}`}
              >
                <div className="cf-first-run__knowledge-card-heading">
                  <span>{item.label || "PROFILE DETAIL"}</span>
                  <div className="cf-first-run__knowledge-card-actions">
                    {item.id === "resume" ? (
                      <label className="cf-first-run__file-action">
                        Drop resume
                        <input
                          type="file"
                          accept={RESUME_ACCEPT}
                          onChange={(event) => {
                            const file = firstFile(event.target.files);
                            if (file) onResumeFile?.(file);
                            event.target.value = "";
                          }}
                        />
                      </label>
                    ) : null}
                    {item.editor ? (
                      <button type="button" onClick={() => onEditSection?.(item)}>
                        Edit
                      </button>
                    ) : null}
                  </div>
                </div>
                {lines.length > 0 ? (
                  <div className="cf-first-run__knowledge-lines">
                    {lines.map((line) => (
                      <span key={String(line)}>
                        {item.status === "complete" ? "✓ " : ""}
                        {line}
                      </span>
                    ))}
                  </div>
                ) : item.status === "active" ? (
                  <span className="cf-first-run__knowledge-state">answering now…</span>
                ) : (
                  <span className="cf-first-run__knowledge-state">
                    {item.placeholder || "comes next"}
                  </span>
                )}
              </article>
            );
          })
        ) : (
          <div className="cf-first-run__knowledge-empty">
            Your answers land here as setup progresses.
          </div>
        )}
      </div>
      <div className="cf-first-run__knowledge-note">
        This becomes your profile page. Edit it there any time, or just tell {agentName} what
        changed.
      </div>
    </aside>
  );
}

function editorValues(item, form) {
  return Object.fromEntries(
    safeArray(item?.editor?.fields).map((field) => {
      const control = form?.elements?.namedItem?.(field.id);
      return [
        field.id,
        field.type === "checkbox" ? Boolean(control?.checked) : control?.value || "",
      ];
    })
  );
}

function EditorField({ itemId, field }) {
  const inputId = `cf-first-run-edit-${itemId}-${field.id}`;
  if (field.type === "textarea") {
    return (
      <label className="cf-first-run__editor-field" htmlFor={inputId}>
        <span>{field.label}</span>
        <textarea
          id={inputId}
          name={field.id}
          defaultValue={field.value || ""}
          placeholder={field.placeholder}
          rows={field.rows || 5}
        />
      </label>
    );
  }
  if (field.type === "checkbox") {
    return (
      <label className="cf-first-run__editor-checkbox" htmlFor={inputId}>
        <input
          id={inputId}
          name={field.id}
          type="checkbox"
          defaultChecked={field.checked === true}
        />
        <span>{field.label}</span>
      </label>
    );
  }
  return (
    <label className="cf-first-run__editor-field" htmlFor={inputId}>
      <span>{field.label}</span>
      <input
        id={inputId}
        name={field.id}
        type={field.type || "text"}
        defaultValue={field.value || ""}
        placeholder={field.placeholder}
        min={field.min}
        step={field.step}
      />
    </label>
  );
}

export function KnowledgeSectionEditor({
  agentName = "Paul",
  item,
  submitting = false,
  onCancel,
  onSave,
  onResumeFile,
}) {
  if (!item?.editor) return null;
  const titleId = `cf-first-run-editor-title-${item.id}`;
  return (
    <div className="cf-first-run__editor-cover">
      <section
        className="cf-first-run__editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <span>WHAT {String(agentName).toUpperCase()} KNOWS</span>
            <strong id={titleId}>Edit {item.label || item.id}</strong>
          </div>
          <button
            type="button"
            aria-label={`Close Edit ${item.label || item.id}`}
            onClick={onCancel}
          >
            ×
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void Promise.resolve(onSave?.(item, editorValues(item, event.currentTarget))).catch(
              () => undefined
            );
          }}
        >
          {item.id === "resume" ? (
            <label className="cf-first-run__editor-file-action">
              Choose a resume file
              <input
                type="file"
                accept={RESUME_ACCEPT}
                onChange={(event) => {
                  const file = firstFile(event.target.files);
                  if (file) onResumeFile?.(file);
                  event.target.value = "";
                }}
              />
            </label>
          ) : null}
          {safeArray(item.editor.fields).map((field) => (
            <EditorField key={field.id} itemId={item.id} field={field} />
          ))}
          <div className="cf-first-run__editor-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save section"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function FirstRunChat({
  agentName = "Paul",
  messages = [],
  knowledge = [],
  progress = {},
  draft = "",
  submitting = false,
  error,
  resumeUploading = false,
  resumeUploadingName = "",
  editingKnowledgeSection = null,
  knowledgeSaving = false,
  onChooseOption,
  onEditKnowledgeSection,
  onCancelKnowledgeEdit,
  onSaveKnowledgeSection,
  onResumeFile,
  onDraftChange,
  onSubmitAnswer,
}) {
  const rows = safeArray(messages);
  function submit(event) {
    event.preventDefault();
    if (!String(draft).trim() || submitting) return;
    onSubmitAnswer?.(draft);
  }
  return (
    <section className="cf-first-run__chat">
      <FirstRunRail agentName={agentName} />
      <main
        className="cf-first-run__conversation"
        aria-label="Setup conversation and resume drop zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = firstFile(event.dataTransfer?.files);
          if (file) onResumeFile?.(file);
        }}
      >
        <div className="cf-first-run__transcript" aria-live="polite">
          <div className="cf-first-run__hello">
            <span className="cf-first-run__large-avatar" aria-hidden="true">
              🐀
            </span>
            <h1>Hey, I'm {agentName}, your recruiter.</h1>
          </div>
          {rows.length > 0 ? (
            rows.map((message) =>
              TranscriptMessage({ message, agentName, onChooseOption, itemKey: message.id })
            )
          ) : (
            <div className="cf-first-run__empty-chat">
              Your setup conversation will continue here.
            </div>
          )}
        </div>
        {error ? (
          <div
            className="cf-first-run__composer-notice cf-first-run__composer-notice--error"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        {resumeUploading ? (
          <div className="cf-first-run__composer-notice" role="status">
            Reading {resumeUploadingName || "your resume"}…
          </div>
        ) : null}
        <div className="cf-first-run__composer-shell">
          <form className="cf-first-run__composer" onSubmit={submit}>
            <input
              aria-label="Type your answer"
              value={draft}
              placeholder="type your answer…"
              onChange={(event) => onDraftChange?.(event.target.value)}
            />
            <button
              type="submit"
              aria-label="Send answer"
              disabled={submitting || !String(draft).trim()}
            >
              <SendUpIcon />
            </button>
          </form>
        </div>
      </main>
      <KnowledgePanel
        agentName={agentName}
        knowledge={knowledge}
        progress={progress}
        onEditSection={onEditKnowledgeSection}
        onResumeFile={onResumeFile}
      />
      {editingKnowledgeSection ? (
        <KnowledgeSectionEditor
          agentName={agentName}
          item={editingKnowledgeSection}
          submitting={knowledgeSaving}
          onCancel={onCancelKnowledgeEdit}
          onSave={onSaveKnowledgeSection}
          onResumeFile={onResumeFile}
        />
      ) : null}
    </section>
  );
}

export function FirstRunExperience(props) {
  if (props?.stage === "chat") return FirstRunChat(props);
  return EngineSelection(props);
}
