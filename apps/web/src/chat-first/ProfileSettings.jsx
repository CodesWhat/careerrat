import "./profile-settings.css";
import { RuntimeIcon } from "./RuntimeIcon.jsx";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function valueOrFallback(value, fallback = "Not set yet") {
  return value === null || value === undefined || value === "" ? fallback : value;
}

function SectionHeading({ label, actionLabel, onAction }) {
  return (
    <div className="cf-profile__section-heading">
      <span>{label}</span>
      {onAction ? (
        <button
          type="button"
          className="cf-profile__text-action"
          aria-label={actionLabel || `Edit ${label.toLowerCase()}`}
          onClick={onAction}
        >
          {actionLabel || "✎"}
        </button>
      ) : null}
    </div>
  );
}

function Lines({ values, fallback = "Tell Paul what belongs here." }) {
  const lines = safeArray(values);
  return lines.length > 0 ? (
    lines.map((line) => <span key={String(line)}>{line}</span>)
  ) : (
    <span className="cf-profile__empty-copy">{fallback}</span>
  );
}

function ProfileGrid({ agentName, profile = {}, onEditSection, onOpenFiles }) {
  const evidence = profile?.evidence || {};
  const writing = profile?.writingStyle || {};
  const compensation = profile?.compensation || {};
  const location = profile?.locationPolicy || {};
  return (
    <section className="cf-profile__grid" aria-label={`What ${agentName} knows`}>
      <article className="cf-profile__card">
        <SectionHeading label="TARGETS" onAction={() => onEditSection?.("targets")} />
        <div className="cf-profile__lines cf-profile__lines--strong">
          <Lines values={profile?.targets} />
        </div>
      </article>
      <article className="cf-profile__card">
        <SectionHeading label="COMPENSATION" onAction={() => onEditSection?.("compensation")} />
        <div className="cf-profile__comp">
          <div>
            <strong>{valueOrFallback(compensation?.floor, "Not set")}</strong>
            <span>floor · roles under this never reach you</span>
          </div>
          <div>
            <strong>{valueOrFallback(compensation?.target, "Not set")}</strong>
            <span>target · what {agentName} negotiates toward</span>
          </div>
        </div>
      </article>
      <article className="cf-profile__card">
        <SectionHeading label="DEALBREAKERS" onAction={() => onEditSection?.("dealbreakers")} />
        <div className="cf-profile__lines cf-profile__lines--strong">
          <Lines values={profile?.dealbreakers} fallback="No dealbreakers recorded." />
        </div>
      </article>
      <article className="cf-profile__card cf-profile__card--location">
        <SectionHeading
          label="LOCATION POLICY"
          actionLabel="Edit location policy"
          onAction={() => onEditSection?.("location-policy")}
        />
        <strong className="cf-profile__location-summary">
          {valueOrFallback(location?.summary, "Location policy needs confirmation")}
        </strong>
        <div className="cf-profile__location-scopes">
          <span>Home market · {valueOrFallback(location?.home)}</span>
          <span>Remote · {location?.remoteRegion || "Off"}</span>
          <span>Hybrid · {location?.hybrid ? location?.home || "On" : "Off"}</span>
          <span>
            On-site · {location?.onsite ? `${location?.home || "saved locations"} only` : "Off"}
          </span>
        </div>
        <span className="cf-profile__location-boundary">
          {valueOrFallback(location?.boundary, "No location boundary saved")}
        </span>
        <span
          className={`cf-profile__confirmation${location?.confirmed ? " cf-profile__confirmation--confirmed" : ""}`}
        >
          {location?.confirmed ? "Confirmed search boundary" : "Needs your confirmation"}
        </span>
      </article>
      <article className="cf-profile__card">
        <SectionHeading
          label="EVIDENCE BANK"
          actionLabel="open Files"
          onAction={() => onOpenFiles?.()}
        />
        <div className="cf-profile__lines cf-profile__lines--strong">
          <span>
            {Number(evidence?.roles) || 0} roles · {Number(evidence?.promotions) || 0} promotions
          </span>
          <span>{Number(evidence?.stories) || 0} stories captured</span>
          <span className="cf-profile__explanation">
            every resume claim traces back here. {agentName} never invents
          </span>
        </div>
      </article>
      <article className="cf-profile__card">
        <SectionHeading label="WRITING STYLE" onAction={() => onEditSection?.("writing-style")} />
        <div className="cf-profile__lines cf-profile__lines--strong">
          <span>Calibrated from {Number(writing?.sampleCount) || 0} samples</span>
          <span className="cf-profile__explanation">
            {valueOrFallback(writing?.description, "Add writing samples so drafts sound like you.")}
          </span>
        </div>
      </article>
      <article className="cf-profile__card">
        <SectionHeading label="SEARCH RULES" onAction={() => onEditSection?.("search-rules")} />
        <div className="cf-profile__lines cf-profile__lines--strong">
          <Lines values={profile?.searchRules} fallback="Search rules will appear after setup." />
        </div>
      </article>
    </section>
  );
}

function SettingsView({
  agentName,
  engine = {},
  permissions = [],
  sources = {},
  onPermissionChange,
  onChangeEngine,
  onShowTechnicalDetails,
  onAddSource,
  onExportData,
}) {
  const blockedCount = Number(sources?.blockedCount) || 0;
  return (
    <section className="cf-settings" aria-label="App settings">
      <article className="cf-settings__card">
        <div className="cf-settings__engine-heading">
          <span className="cf-settings__eyebrow">AI ENGINE</span>
          {engine?.connected ? (
            <span className="cf-settings__connected">Connected</span>
          ) : (
            <span className="cf-settings__disconnected">Needs attention</span>
          )}
        </div>
        <strong>
          {agentName} runs on{" "}
          {engine?.name ? `${engine.name}, already installed` : "the AI installed"} on this
          computer.
        </strong>
        <span className="cf-settings__muted">
          Your files stay on your machine. No account, no CareerRat server.
        </span>
        <div className="cf-settings__links">
          <button type="button" onClick={() => onChangeEngine?.()}>
            Change engine
          </button>
          <button type="button" onClick={() => onShowTechnicalDetails?.()}>
            technical details
          </button>
        </div>
      </article>
      <article className="cf-settings__card">
        <div className="cf-settings__eyebrow">WHAT {agentName.toUpperCase()} MAY DO ON HIS OWN</div>
        {safeArray(permissions).map((permission) => (
          <div key={permission.id} className="cf-settings__permission">
            <div>
              <strong>{permission.name}</strong>
              <span>{permission.description || ""}</span>
            </div>
            {permission.mutable === false ? (
              <span className="cf-settings__fixed-capability">
                {permission.statusLabel || "Always on"}
              </span>
            ) : (
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(permission.enabled)}
                aria-label={`${permission.name}: ${permission.enabled ? "on" : "off"}`}
                className="cf-settings__switch"
                onClick={() => onPermissionChange?.(permission.id, !permission.enabled)}
              >
                <span />
              </button>
            )}
          </div>
        ))}
        <p className="cf-settings__note">
          Submitting an application always gates back to you. That one isn't a setting.
        </p>
      </article>
      <article className="cf-settings__card">
        <SectionHeading
          label="JOB SOURCES"
          actionLabel="Add a niche board"
          onAction={() => onAddSource?.()}
        />
        <div className="cf-settings__source-copy">
          <strong>
            Every board {agentName} can read stays on. You never curate, so you never miss a job.
          </strong>
          <span>
            {Number(sources?.scannedCount) || 0} scanned automatically ·{" "}
            {Number(sources?.pinnedCount) || 0} pinned for your targets
            {sources?.lastSweep ? ` · last sweep ${sources.lastSweep}` : ""}
          </span>
          {blockedCount > 0 ? (
            <span>
              ⚠ {blockedCount} {blockedCount === 1 ? "board" : "boards"} blocked by a bot wall.
              Retrying, {agentName} will tell you if it stays dead.
            </span>
          ) : (
            <span>All readable boards are healthy.</span>
          )}
        </div>
      </article>
      <article className="cf-settings__card cf-settings__data-card">
        <div>
          <strong>Your data</strong>
          <span>everything lives in local files you own</span>
        </div>
        <button
          type="button"
          className="cf-settings__outline-button"
          onClick={() => onExportData?.()}
        >
          Export everything
        </button>
      </article>
    </section>
  );
}

function SettingsDialog({ title, children, onClose }) {
  return (
    <div className="cf-settings-dialog__cover">
      <section className="cf-settings-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <strong>{title}</strong>
          <button type="button" aria-label={`Close ${title}`} onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function runtimeStatus(choice, selectedId) {
  if (choice.id === selectedId && choice.ready) return "Selected";
  if (choice.ready) return "Ready";
  if (choice.status === "authentication_required") return "Sign-in needed";
  if (!choice.available) return "Not found";
  return "Needs attention";
}

function EnginePicker({ engine, busy, onClose, onSelect, onConnect, onRetry, onRefresh }) {
  const choices = safeArray(engine?.choices);
  return (
    <SettingsDialog title="Choose an AI engine" onClose={onClose}>
      <p className="cf-settings-dialog__intro">
        Use an AI tool already on this computer. Tools that need setup stay visible here.
      </p>
      <div className="cf-settings-dialog__runtime-list">
        {choices.map((choice) => {
          const selected = choice.id === engine?.selectedId && choice.ready;
          return (
            <article className="cf-settings-dialog__runtime" key={choice.id}>
              <div className="cf-settings-dialog__runtime-copy">
                <RuntimeIcon runtimeId={choice.id} name={choice.name} size={22} />
                <div>
                  <strong>{choice.name || "AI engine"}</strong>
                  <span>{runtimeStatus(choice, engine?.selectedId)}</span>
                </div>
              </div>
              {selected ? (
                <span className="cf-settings-dialog__selected">Current</span>
              ) : choice.ready ? (
                <button type="button" disabled={busy} onClick={() => onSelect?.(choice.id)}>
                  Use this tool
                </button>
              ) : choice.action === "open_terminal" ? (
                <button type="button" disabled={busy} onClick={() => onConnect?.(choice.id)}>
                  Open Terminal to sign in
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => onRetry?.(choice.id)}>
                  Retry detection
                </button>
              )}
            </article>
          );
        })}
        {choices.length === 0 ? (
          <div className="cf-settings-dialog__empty">
            <span>No supported AI tools were found.</span>
            <button type="button" disabled={busy} onClick={onRefresh}>
              Check again
            </button>
          </div>
        ) : null}
      </div>
    </SettingsDialog>
  );
}

function SourceDialog({ value, busy, onChange, onSubmit, onClose }) {
  return (
    <SettingsDialog title="Add a niche board" onClose={onClose}>
      <form
        className="cf-settings-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.();
        }}
      >
        <label htmlFor="cf-niche-board-url">Board URL</label>
        <input
          id="cf-niche-board-url"
          type="url"
          required
          value={value}
          placeholder="https://jobs.example.com"
          onChange={(event) => onChange?.(event.target.value)}
        />
        <div className="cf-settings-dialog__actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !String(value || "").trim()}>
            Add board
          </button>
        </div>
      </form>
    </SettingsDialog>
  );
}

function browserPresenceLabel(status) {
  return (
    {
      ready: "Ready",
      unverified: "Needs confirmation",
      missing: "Not ready",
      unknown: "Could not verify",
    }[status] || "Could not verify"
  );
}

function TechnicalDetails({ agentName, engine, browser = {}, onClose }) {
  const playwright = browser?.playwright || {};
  const presenceStatus = browser?.presenceStatus || "unknown";
  return (
    <SettingsDialog title="Technical details" onClose={onClose}>
      <div className="cf-settings-dialog__technical">
        <p>
          {agentName} is {engine?.connected ? "connected" : "not connected"} through{" "}
          {engine?.name || "the selected AI engine"}.
        </p>
        <p>Your candidate files stay on this computer. The selected tool uses its own login.</p>
        <div className="cf-settings-dialog__technical-row">
          <div className="cf-settings-dialog__technical-heading">
            <strong>Browser connection</strong>
            <span
              className={`cf-settings-dialog__status cf-settings-dialog__status--${presenceStatus}`}
            >
              {browserPresenceLabel(presenceStatus)}
            </span>
          </div>
          <span>
            {browser?.provider || "Not configured"}
            {browser?.effectiveProvider && browser.effectiveProvider !== browser.provider
              ? ` · using ${browser.effectiveProvider}`
              : ""}
          </span>
          <small>{browser?.presenceDetail || "Browser readiness has not been checked yet."}</small>
        </div>
        <div className="cf-settings-dialog__technical-row">
          <strong>Playwright</strong>
          <span>{playwright?.ready ? "Ready" : "Not ready"}</span>
          <small>{playwright?.detail || "Playwright readiness has not been checked yet."}</small>
        </div>
        <div className="cf-settings-dialog__technical-row">
          <strong>Automatic application fill</strong>
          <span>
            {browser?.automaticFillSupported
              ? "Available with this browser connection"
              : "Unavailable with this browser connection"}
          </span>
          <small>CareerRat still stops at the final submit button every time.</small>
        </div>
      </div>
    </SettingsDialog>
  );
}

export function ProfileSettings({
  agentName = "Paul",
  activeTab = "profile",
  profile = {},
  engine = {},
  browser = {},
  permissions = [],
  sources = {},
  onBack,
  onTabChange,
  onEditSection,
  onOpenFiles,
  onPermissionChange,
  onChangeEngine,
  onShowTechnicalDetails,
  onAddSource,
  onExportData,
  enginePickerOpen = false,
  enginePickerBusy = false,
  onCloseEnginePicker,
  onSelectEngine,
  onConnectEngine,
  onRetryEngine,
  onRefreshEngines,
  sourceDialogOpen = false,
  sourceDialogBusy = false,
  sourceDraft = "",
  onCloseSourceDialog,
  onSourceDraftChange,
  onSubmitSource,
  technicalDetailsOpen = false,
  onCloseTechnicalDetails,
}) {
  const settingsActive = activeTab === "settings" || activeTab === "app";
  return (
    <div className="cf-profile">
      <header className="cf-profile__header">
        <button type="button" className="cf-profile__back" onClick={() => onBack?.()}>
          ← Back
        </button>
        <strong className="cf-profile__brand">CareerRat</strong>
        <nav className="cf-profile__tabs" aria-label="Profile and settings">
          <button
            type="button"
            aria-current={!settingsActive ? "page" : undefined}
            onClick={() => onTabChange?.("profile")}
          >
            What {agentName} knows
          </button>
          <button
            type="button"
            aria-current={settingsActive ? "page" : undefined}
            onClick={() => onTabChange?.("settings")}
          >
            App settings
          </button>
        </nav>
        <span className="cf-profile__hint">
          edit anything here. Or just tell {agentName} what changed
        </span>
      </header>
      {settingsActive
        ? SettingsView({
            agentName,
            engine,
            permissions,
            sources,
            onPermissionChange,
            onChangeEngine,
            onShowTechnicalDetails,
            onAddSource,
            onExportData,
          })
        : ProfileGrid({ agentName, profile, onEditSection, onOpenFiles })}
      {enginePickerOpen ? (
        <EnginePicker
          engine={engine}
          busy={enginePickerBusy}
          onClose={onCloseEnginePicker}
          onSelect={onSelectEngine}
          onConnect={onConnectEngine}
          onRetry={onRetryEngine}
          onRefresh={onRefreshEngines}
        />
      ) : null}
      {sourceDialogOpen ? (
        <SourceDialog
          value={sourceDraft}
          busy={sourceDialogBusy}
          onChange={onSourceDraftChange}
          onSubmit={onSubmitSource}
          onClose={onCloseSourceDialog}
        />
      ) : null}
      {technicalDetailsOpen ? (
        <TechnicalDetails
          agentName={agentName}
          engine={engine}
          browser={browser}
          onClose={onCloseTechnicalDetails}
        />
      ) : null}
    </div>
  );
}
