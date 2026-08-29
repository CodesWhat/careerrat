import { AnnualCashWorksheet } from "./AnnualCashWorksheet.jsx";
import { cleanAgentCopy } from "./agent-copy.js";
import { SendUpIcon } from "./chat-first-icons.jsx";
import {
  isFirstRunExtractedFact,
  runtimeIsSupported,
  runtimePresentation,
} from "./first-run-controller.js";
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
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLAUDE_REFERRAL_URL = "https://claude.ai/referral/rOLHwxlsfA";
const CLAUDE_CODE_SETUP_URL = "https://code.claude.com/docs/en/quickstart";

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
  return {
    completed,
    total,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

function engineStatus(engine) {
  return runtimePresentation(engine).label;
}

function engineSelectable(engine) {
  const state = runtimePresentation(engine).state;
  return engine?.ready === true && engine?.selectable === true && state === "ready";
}

function engineDescription(engine) {
  const presentation = runtimePresentation(engine);
  if (presentation.state === "auth_required")
    return "Detected on this computer. Sign in before CareerRat can use it.";
  if (presentation.state === "ready")
    return `Ready to run the complete CareerRat workflow with ${engine.name || "this AI CLI"}.`;
  if (engine?.probeMessage) return engine.probeMessage;
  return "This provider is not available on this computer.";
}

function RetryControl({ onRetrySearch, onRetryCompany, submitting }) {
  if (!onRetrySearch && !onRetryCompany) return null;
  return (
    <div className="cf-first-run__answer-options">
      {onRetrySearch ? (
        <button type="button" disabled={submitting} onClick={onRetrySearch}>
          Retry search
        </button>
      ) : null}
      {onRetryCompany ? (
        <button type="button" disabled={submitting} onClick={onRetryCompany}>
          Retry company search
        </button>
      ) : null}
    </div>
  );
}

function DetectedEngine({
  engine,
  submitting,
  onChooseEngine,
  onRetryEngine,
  onStartEngineSignIn,
}) {
  const selectable = engineSelectable(engine);
  const presentation = runtimePresentation(engine);
  const canCompleteSetup =
    presentation.state === "auth_required" && engine.action === "start_sign_in";
  const canRetry = engine.detected === true && engine.ready !== true;
  const hasActions = canCompleteSetup || canRetry;
  const className = `cf-first-run__engine-choice${engine.selected ? " is-selected" : ""}`;
  const content = (
    <>
      <span className="cf-first-run__engine-radio" aria-hidden="true">
        <span>✓</span>
      </span>
      <span className="cf-first-run__engine-identity">
        <span className="cf-first-run__engine-name">
          <RuntimeIcon runtimeId={engine.id} name={engine.name} size={28} />
          <strong>{engine.name || "AI engine"}</strong>
        </span>
        <span className="cf-first-run__engine-description">{engineDescription(engine)}</span>
        {engine.capabilityReason && engine.capabilityReason !== engine.probeMessage ? (
          <span className="cf-first-run__engine-capability">{engine.capabilityReason}</span>
        ) : null}
      </span>
      <span className="cf-first-run__engine-status">{engineStatus(engine).toUpperCase()}</span>
    </>
  );

  if (selectable) {
    return (
      <button
        type="button"
        className={className}
        aria-pressed={Boolean(engine.selected)}
        disabled={submitting}
        onClick={() => onChooseEngine?.(engine.id)}
      >
        {content}
      </button>
    );
  }

  return (
    <article className={className} aria-disabled={hasActions ? undefined : "true"}>
      {content}
      {hasActions ? (
        <span className="cf-first-run__engine-actions">
          {canCompleteSetup ? (
            <button
              className="cf-first-run__engine-action"
              type="button"
              disabled={submitting}
              onClick={() => onStartEngineSignIn?.(engine.id)}
            >
              Sign in
            </button>
          ) : null}
          {canRetry ? (
            <button
              className="cf-first-run__engine-action"
              type="button"
              disabled={submitting}
              onClick={() => onRetryEngine?.(engine.id)}
            >
              {engine.actionLabel || "Check again"}
            </button>
          ) : null}
        </span>
      ) : null}
    </article>
  );
}

function ClaudeSetupGuide({ guidedSetup, submitting, onStartGuidedSetup, onRefreshEngines }) {
  const setupStatus = guidedSetup?.status || "idle";
  const installing = setupStatus === "installing";
  const installed = ["installed", "ready"].includes(setupStatus);
  const unavailable = setupStatus === "unavailable";
  const retryable = ["failed", "cancelled"].includes(setupStatus);
  const setupMessage =
    {
      installing: "CareerRat is installing Claude Code. You can stay in this window.",
      installed: "Claude Code is installed. CareerRat is checking that it can connect.",
      ready: "Claude Code is ready for CareerRat.",
      sign_in_started: "Finish signing in in the browser window, then come back here.",
      cancelled: "Installation stopped. Nothing in your setup was lost.",
      unavailable:
        "In-app installation isn't available here. Use the Claude setup guide, then choose Check setup.",
      failed: "CareerRat couldn't finish installing Claude Code. Nothing in your setup was lost.",
    }[setupStatus] || "CareerRat can install Claude Code here and keep you on this screen.";
  const actionLabel = installing
    ? "Installing inside CareerRat…"
    : installed
      ? "Claude Code installed ✓"
      : unavailable
        ? "Check setup"
        : retryable
          ? "Try installation again"
          : "Install inside CareerRat";
  return (
    <article className="cf-first-run__beginner-setup">
      <div className="cf-first-run__beginner-heading">
        <span className="cf-first-run__beginner-kicker">NO IDEA WHERE TO START?</span>
        <h2>New to AI tools? We’ll walk you through it.</h2>
        <p>
          Choose Claude Code or OpenAI Codex. Claude Code has an in-app installer, and Codex has a
          setup guide.
        </p>
      </div>
      <ol className="cf-first-run__setup-steps">
        <li>
          <span className="cf-first-run__setup-number">1</span>
          <div>
            <strong>Get Claude</strong>
            <p>Claude Code needs a paid Claude plan. Pro is enough; Max gives you more usage.</p>
            <a href={CLAUDE_REFERRAL_URL} target="_blank" rel="noreferrer">
              Get Claude through Scott’s referral
            </a>
          </div>
        </li>
        <li>
          <span className="cf-first-run__setup-number">2</span>
          <div>
            <strong>
              {unavailable
                ? "Install Claude Code from its setup guide"
                : "Let CareerRat install Claude Code"}
            </strong>
            <p>
              {unavailable
                ? "Open Claude's setup guide, finish installation, then choose Check setup."
                : installing
                  ? "CareerRat is installing Claude Code. You can stay in this window."
                  : installed
                    ? "The install finished. CareerRat is checking it now."
                    : "CareerRat can install Claude Code here and keep you on this screen."}
            </p>
            <button
              type="button"
              className="cf-first-run__guided-action"
              disabled={submitting || installing || installed}
              onClick={() => (unavailable ? onRefreshEngines?.() : onStartGuidedSetup?.("claude"))}
            >
              {actionLabel}
            </button>
            {unavailable ? (
              <a href={CLAUDE_CODE_SETUP_URL} target="_blank" rel="noreferrer">
                Open Claude setup guide
              </a>
            ) : null}
            {guidedSetup ? (
              <section className="cf-first-run__setup-console" aria-label="CareerRat setup">
                <header>
                  <span>CareerRat setup</span>
                  <span>
                    {installing
                      ? "RUNNING"
                      : installed
                        ? "DONE"
                        : unavailable
                          ? "SETUP"
                          : retryable
                            ? "RETRY"
                            : "READY"}
                  </span>
                </header>
                <div className="cf-first-run__setup-console-output" role="log" aria-live="polite">
                  <p>{setupMessage}</p>
                </div>
              </section>
            ) : null}
          </div>
        </li>
        <li>
          <span className="cf-first-run__setup-number">3</span>
          <div>
            <strong>Sign in and come back</strong>
            <p>
              {installed
                ? "CareerRat will show a Sign in button. Claude opens your browser, then CareerRat notices when you are ready."
                : "After installation, click Sign in. Claude opens your browser, then CareerRat checks the result for you."}
            </p>
            <button
              type="button"
              className="cf-first-run__engine-action"
              disabled={submitting}
              onClick={onRefreshEngines}
            >
              Check setup
            </button>
          </div>
        </li>
      </ol>
    </article>
  );
}

function HostedInterestCard({
  hostedInterest = {},
  onHostedInterestStart,
  onHostedInterestChange,
  onHostedInterestSubmit,
}) {
  const status = hostedInterest.status || "idle";
  const email = String(hostedInterest.email || "");
  const editing = ["editing", "error", "submitting"].includes(status);
  const validEmail = EMAIL_SHAPE_RE.test(email.trim());

  return (
    <article className="cf-first-run__engine-special cf-first-run__engine-special--managed">
      <span className="cf-first-run__engine-spacer" aria-hidden="true" />
      <span className="cf-first-run__engine-identity">
        <span className="cf-first-run__engine-name">
          <span className="cf-runtime-icon cf-runtime-icon--careerrat" aria-hidden="true">
            🐀
          </span>
          <strong>CareerRat AI</strong>
        </span>
        <small>Hosted CareerRat AI is planned, but it is not available today.</small>
      </span>
      <span className="cf-first-run__engine-coming-soon">COMING SOON</span>
      <span className="cf-first-run__hosted-control">
        {status === "requested" ? (
          <>
            <button type="button" className="cf-first-run__hosted-trigger" disabled>
              REQUESTED ✓
            </button>
            <small className="cf-first-run__hosted-confirm">
              Thanks, we’ll email you when it’s ready.
            </small>
          </>
        ) : editing ? (
          <form
            className="cf-first-run__hosted-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (validEmail && status !== "submitting") onHostedInterestSubmit?.();
            }}
          >
            <label>
              <span className="cf-first-run__hosted-label-text">Email for CareerRat AI access</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@email.com"
                value={email}
                disabled={status === "submitting"}
                onChange={(event) => onHostedInterestChange?.(event.target.value)}
              />
            </label>
            <button type="submit" disabled={!validEmail || status === "submitting"}>
              {status === "submitting" ? "Sending…" : "Send request"}
            </button>
            {hostedInterest.error ? (
              <small className="cf-first-run__hosted-error" role="alert">
                {hostedInterest.error}
              </small>
            ) : null}
          </form>
        ) : (
          <button
            type="button"
            className="cf-first-run__hosted-trigger"
            onClick={onHostedInterestStart}
          >
            Request access
          </button>
        )}
      </span>
    </article>
  );
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
  engines = [],
  error,
  submitting = false,
  onChooseEngine,
  onStartInterview,
  onRetryEngine,
  onRefreshEngines,
  onStartGuidedSetup,
  onStartEngineSignIn,
  onOpenSettings,
  guidedSetup,
  hostedInterest,
  onHostedInterestStart,
  onHostedInterestChange,
  onHostedInterestSubmit,
  onRetrySearch,
  onRetryCompany,
}) {
  const choices = safeArray(engines).filter(
    (engine) =>
      engine &&
      typeof engine === "object" &&
      String(engine.id || "").trim() &&
      runtimeIsSupported(engine)
  );
  const detectedChoices = choices.filter(
    (engine) => engine.id !== "custom" && engine.detected === true
  );
  const missingChoices = choices.filter(
    (engine) => engine.id !== "custom" && engine.detected !== true
  );
  const alternateMissingChoices =
    detectedChoices.length === 0
      ? missingChoices.filter((engine) => engine.id !== "claude")
      : missingChoices;
  const needsFirstTool = detectedChoices.length === 0;
  const selectedEngine = detectedChoices.find(
    (engine) => engine.selected && engineSelectable(engine)
  );
  return (
    <section className="cf-first-run__engine" aria-labelledby="cf-engine-title">
      <div className="cf-first-run__engine-content">
        <div className="cf-first-run__engine-intro">
          <h1 id="cf-engine-title">
            {needsFirstTool ? "Let’s get CareerRat ready." : "Pick your engine."}
          </h1>
          {needsFirstTool ? (
            <p>CareerRat works with Claude Code or Codex. If you’re new to both, start below.</p>
          ) : (
            <p>
              We found {detectedChoices.length} AI {detectedChoices.length === 1 ? "tool" : "tools"}{" "}
              on this computer. Every choice shown here runs the complete CareerRat workflow.
            </p>
          )}
        </div>
        {error ? (
          <div className="cf-first-run__engine-error" role="alert">
            <span>{error}</span>
            {RetryControl({ onRetrySearch, onRetryCompany, submitting })}
          </div>
        ) : null}
        <fieldset className="cf-first-run__engine-choices">
          <legend className="cf-first-run__engine-legend">
            {needsFirstTool ? "Set up an AI tool" : "Detected AI tools"}
          </legend>
          {detectedChoices.length > 0 ? (
            detectedChoices.map((engine) => (
              <DetectedEngine
                key={engine.id}
                engine={engine}
                submitting={submitting}
                onChooseEngine={onChooseEngine}
                onRetryEngine={onRetryEngine}
                onStartEngineSignIn={onStartEngineSignIn}
              />
            ))
          ) : (
            <ClaudeSetupGuide
              guidedSetup={guidedSetup}
              submitting={submitting}
              onStartGuidedSetup={onStartGuidedSetup}
              onRefreshEngines={onRefreshEngines}
            />
          )}
        </fieldset>
        {alternateMissingChoices.length > 0 ? (
          <details className="cf-first-run__engine-missing">
            <summary>
              {needsFirstTool ? "Set up OpenAI Codex instead" : "Set up another supported AI tool"}
            </summary>
            <div className="cf-first-run__engine-missing-list">
              {alternateMissingChoices.map((engine) => (
                <div className="cf-first-run__engine-missing-row" key={engine.id}>
                  <span className="cf-first-run__engine-name">
                    <RuntimeIcon runtimeId={engine.id} name={engine.name} size={24} />
                    <strong>{engine.name}</strong>
                  </span>
                  {engine.installUrl ? (
                    <a href={engine.installUrl} target="_blank" rel="noreferrer">
                      Install guide
                    </a>
                  ) : (
                    <button
                      className="cf-first-run__engine-action"
                      type="button"
                      disabled={submitting}
                      onClick={onOpenSettings}
                    >
                      Install guide
                    </button>
                  )}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {needsFirstTool ? null : (
          <>
            <HostedInterestCard
              hostedInterest={hostedInterest}
              onHostedInterestStart={onHostedInterestStart}
              onHostedInterestChange={onHostedInterestChange}
              onHostedInterestSubmit={onHostedInterestSubmit}
            />
            <footer className="cf-first-run__engine-footer">
              <button
                type="button"
                className="cf-first-run__engine-start"
                disabled={!selectedEngine || submitting}
                onClick={() => onStartInterview?.(selectedEngine.id)}
              >
                {submitting ? "Starting…" : "Start the interview"}
                <span aria-hidden="true">→</span>
              </button>
            </footer>
          </>
        )}
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

function AssistantMessage({
  message,
  agentName,
  onChooseOption,
  onAnswer,
  binaryAnswerActive = false,
  submitting = false,
  itemKey,
}) {
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
        {binaryAnswerActive ? (
          <fieldset className="cf-first-run__binary-actions">
            <legend className="sr-only">Suggested answers</legend>
            {["Yes", "No"].map((answer) => (
              <button
                key={answer}
                type="button"
                disabled={submitting}
                onClick={() => onAnswer?.(answer)}
              >
                {answer}
              </button>
            ))}
            <span className="cf-first-run__answer-hint">or just type it</span>
          </fieldset>
        ) : null}
      </div>
    </article>
  );
}

function TranscriptMessage({
  message,
  agentName,
  onChooseOption,
  onAnswer,
  binaryAnswerActive,
  submitting,
  itemKey,
}) {
  if (message?.role === "user")
    return (
      <article key={itemKey} className="cf-first-run__user-bubble">
        {message.text || ""}
      </article>
    );
  return AssistantMessage({
    message: message || {},
    agentName,
    onChooseOption,
    onAnswer,
    binaryAnswerActive,
    submitting,
    itemKey,
  });
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
  if (field.type === "annual-cash-worksheet") {
    return (
      <AnnualCashWorksheet
        currency={field.currency}
        idPrefix={inputId}
        name={field.id}
        value={field.value}
      />
    );
  }
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
  if (field.type === "select") {
    return (
      <label className="cf-first-run__editor-field" htmlFor={inputId}>
        <span>{field.label}</span>
        <select id={inputId} name={field.id} defaultValue={field.value || ""}>
          {safeArray(field.options).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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

function VoluntaryDefaultsPrompt({ agentName, submitting, error, onChoose }) {
  const titleId = "cf-first-run-voluntary-defaults-title";
  return (
    <div className="cf-first-run__editor-cover">
      <section
        className="cf-first-run__editor cf-first-run__voluntary-defaults"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <span>APPLICATION DEFAULTS</span>
            <strong id={titleId}>Optional application questions</strong>
          </div>
        </header>
        <p>
          Some job applications ask optional demographic questions about race, gender, disability,
          or veteran status. CareerRat can leave them blank, or choose the form’s decline option
          when one is available.
        </p>
        <p>This choice stays on this computer and isn’t shared with {agentName}.</p>
        {error ? (
          <div className="cf-first-run__engine-error" role="alert">
            <span>{error}</span>
          </div>
        ) : null}
        <div className="cf-first-run__editor-actions">
          <button type="button" disabled={submitting} onClick={() => onChoose?.("leave_blank")}>
            Leave them blank
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onChoose?.("decline_when_available")}
          >
            Choose decline when available
          </button>
        </div>
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
  onRetrySearch,
  onRetryCompany,
  companyReviewReady = false,
  onOpenCompanyReview,
  onSubmitAnswer,
}) {
  const rows = safeArray(messages);
  const latestDialogue = [...rows]
    .reverse()
    .find((message) => message?.role === "assistant" || message?.role === "user");
  const binaryQuestionId =
    latestDialogue?.role === "assistant" && latestDialogue?.answerMode === "yes-no"
      ? latestDialogue.id
      : null;
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
              TranscriptMessage({
                message,
                agentName,
                onChooseOption,
                onAnswer: onSubmitAnswer,
                binaryAnswerActive: message.id === binaryQuestionId,
                submitting,
                itemKey: message.id,
              })
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
            <span>{error}</span>
            {RetryControl({ onRetrySearch, onRetryCompany, submitting })}
          </div>
        ) : null}
        {companyReviewReady ? (
          <div className="cf-first-run__composer-notice" role="status">
            <span>Company suggestions are ready. Your current answer is still here.</span>
            <div className="cf-first-run__answer-options">
              <button type="button" disabled={submitting} onClick={onOpenCompanyReview}>
                Review companies
              </button>
            </div>
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
  let content;
  if (props?.stage === "voluntary-defaults" || props?.voluntaryDefaultsRequired === true) {
    content = (
      <VoluntaryDefaultsPrompt
        agentName={props.agentName || "Paul"}
        submitting={props.submitting}
        error={props.error}
        onChoose={props.onChooseVoluntaryDefaults}
      />
    );
  } else if (props?.stage === "chat") {
    content = FirstRunChat(props);
  } else {
    content = EngineSelection(props);
  }
  return props?.companyReview ? (
    <>
      {content}
      {props.companyReview}
    </>
  ) : (
    content
  );
}
