import "./profile-settings.css";
import { ArrowLeftIcon } from "./chat-first-icons.jsx";
import { runtimePresentation } from "./first-run-controller.js";
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
          className={`cf-profile__text-action${actionLabel ? " cf-profile__text-action--text" : ""}`}
          aria-label={actionLabel || `Edit ${label.toLowerCase()}`}
          onClick={onAction}
        >
          {actionLabel || "✎"}
        </button>
      ) : null}
    </div>
  );
}

function Lines({ values, fallback = "Nothing recorded yet." }) {
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
          <Lines values={profile?.targets} fallback={`Tell ${agentName} what belongs here.`} />
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
  desktopUpdate = null,
  engine = {},
  permissions = [],
  sources = {},
  publicSyncPreference = { enabled: true, source: "default", updatedAt: null },
  publicSyncBusy = false,
  onPermissionChange,
  onPublicSyncChange,
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
            <span className="cf-settings__connected">{engine.statusLabel || "Connected"}</span>
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
          Your private candidate files stay on this machine. Public company and board metadata
          follows the sharing setting below.
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
      <article className="cf-settings__card cf-settings__public-sync">
        <div className="cf-settings__permission">
          <div>
            <strong>Share public company and board metadata</strong>
            <span>
              Share public company and board metadata to improve CareerRat for future searches.
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={publicSyncPreference.enabled !== false}
            aria-label={`Share public company and board metadata: ${publicSyncPreference.enabled !== false ? "on" : "off"}`}
            className="cf-settings__switch"
            disabled={publicSyncBusy}
            onClick={() => onPublicSyncChange?.(publicSyncPreference.enabled === false)}
          >
            <span />
          </button>
        </div>
        <p className="cf-settings__note">
          This can include company domains, career pages, ATS board links, providers, and scan
          confidence. It never sends résumé text, profile data, applications, private notes,
          compensation, fit scores, or local files.
        </p>
        <span className="cf-settings__public-sync-status">
          {publicSyncPreference.enabled === false
            ? "Off · no public metadata shared"
            : publicSyncPreference.source === "default"
              ? "On by default · public metadata only"
              : "On · public metadata only"}
        </span>
      </article>
      {desktopUpdate?.available ? (
        <article className="cf-settings__card cf-settings__desktop-update">
          <div className="cf-settings__eyebrow">DESKTOP APP</div>
          <div className="cf-settings__permission">
            <div>
              <strong>Automatically check for updates</strong>
              <span>Checks GitHub once a day. Nothing downloads or installs on its own.</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={desktopUpdate.enabled !== false}
              aria-label={`Automatically check for updates: ${desktopUpdate.enabled !== false ? "on" : "off"}`}
              className="cf-settings__switch"
              disabled={desktopUpdate.saving}
              onClick={() => desktopUpdate.onEnabledChange?.(desktopUpdate.enabled === false)}
            >
              <span />
            </button>
          </div>
          <div className="cf-settings__desktop-update-actions">
            <span>
              Manual checks work even when automatic checks are off and never change that setting.
            </span>
            <button
              type="button"
              className="cf-settings__outline-button"
              disabled={desktopUpdate.checking}
              onClick={() => desktopUpdate.onCheckNow?.()}
            >
              {desktopUpdate.checking ? "Checking…" : "Check now"}
            </button>
          </div>
          {desktopUpdate.status ? (
            <span className="cf-settings__desktop-update-status" role="status">
              {desktopUpdate.status}
            </span>
          ) : null}
        </article>
      ) : null}
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

function runtimeStatus(choice) {
  return runtimePresentation(choice).label;
}

function EnginePicker({
  engine,
  busy,
  signInRuntimeId,
  onClose,
  onSelect,
  onConnect,
  onRetry,
  onRefresh,
}) {
  const choices = safeArray(engine?.choices);
  return (
    <SettingsDialog title="Choose an AI engine" onClose={onClose}>
      <p className="cf-settings-dialog__intro">
        Use an AI tool already on this computer. Tools that need setup stay visible here.
      </p>
      <div className="cf-settings-dialog__runtime-list">
        {choices.map((choice) => {
          const selected =
            choice.id === engine?.selectedId && choice.ready && choice.selectable !== false;
          const signingIn = choice.id === signInRuntimeId && choice.ready !== true;
          return (
            <article
              className="cf-settings-dialog__runtime"
              data-selected={selected ? "true" : undefined}
              key={choice.id}
            >
              <div className="cf-settings-dialog__runtime-copy">
                <RuntimeIcon runtimeId={choice.id} name={choice.name} size={22} />
                <div>
                  <strong>{choice.name || "AI engine"}</strong>
                  <span>{runtimeStatus(choice)}</span>
                  {choice.capabilityReason ? <span>{choice.capabilityReason}</span> : null}
                  {signingIn ? (
                    <span role="status">Finish sign-in in your browser, then check again.</span>
                  ) : null}
                </div>
              </div>
              {selected ? (
                <span className="cf-settings-dialog__current">Current</span>
              ) : choice.ready && choice.selectable !== false ? (
                <button type="button" disabled={busy} onClick={() => onSelect?.(choice.id)}>
                  Use this tool
                </button>
              ) : signingIn ? (
                <button type="button" disabled={busy} onClick={() => onRetry?.(choice.id)}>
                  Check sign-in
                </button>
              ) : choice.action === "start_sign_in" ? (
                <button type="button" disabled={busy} onClick={() => onConnect?.(choice.id)}>
                  Sign in
                </button>
              ) : choice.selectable === false ? null : (
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

function TechnicalDetails({
  agentName,
  engine,
  browser = {},
  providerBusy,
  onProviderChange,
  onClose,
}) {
  const playwright = browser?.playwright || {};
  const presenceStatus = browser?.presenceStatus || "unknown";
  const providerOptions = safeArray(browser?.options);
  const selectedProvider =
    providerOptions.find((option) => option.id === browser?.providerId) || providerOptions[0];
  return (
    <SettingsDialog title="Technical details" onClose={onClose}>
      <div className="cf-settings-dialog__technical">
        <p>
          {agentName} is {engine?.connected ? "connected" : "not connected"} through{" "}
          {engine?.name || "the selected AI engine"}.
        </p>
        <p>Your candidate files stay on this computer. The selected tool uses its own login.</p>
        <div className="cf-settings-dialog__technical-row">
          <label htmlFor="cf-browser-automation-provider">
            <strong>Browser automation provider</strong>
          </label>
          <select
            id="cf-browser-automation-provider"
            value={browser?.providerId || ""}
            disabled={providerBusy || providerOptions.length === 0}
            onChange={(event) => onProviderChange?.(event.target.value)}
          >
            {providerOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <small>
            {selectedProvider?.needs || "Choose which supervised browser CareerRat uses."}
          </small>
        </div>
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

function ProfileSectionEditor({
  agentName,
  editor,
  values = {},
  busy,
  onChange,
  onSave,
  onAskAgent,
  onClose,
}) {
  return (
    <SettingsDialog title={editor?.title || "Edit profile section"} onClose={onClose}>
      <form
        className="cf-settings-dialog__form cf-profile-editor"
        onSubmit={(event) => {
          event.preventDefault();
          onSave?.();
        }}
      >
        {safeArray(editor?.fields).map((field) => {
          const inputId = `cf-profile-editor-${field.id}`;
          if (field.type === "checkbox") {
            return (
              <label className="cf-profile-editor__check" htmlFor={inputId} key={field.id}>
                <input
                  id={inputId}
                  type="checkbox"
                  checked={values[field.id] === true}
                  onChange={(event) => onChange?.(field.id, event.target.checked)}
                />
                <span>{field.label}</span>
              </label>
            );
          }
          return (
            <label className="cf-profile-editor__field" htmlFor={inputId} key={field.id}>
              <span>{field.label}</span>
              {field.type === "textarea" ? (
                <textarea
                  id={inputId}
                  value={values[field.id] ?? ""}
                  rows={field.rows || 4}
                  placeholder={field.placeholder}
                  onChange={(event) => onChange?.(field.id, event.target.value)}
                />
              ) : field.type === "select" ? (
                <select
                  id={inputId}
                  value={values[field.id] ?? ""}
                  onChange={(event) => onChange?.(field.id, event.target.value)}
                >
                  {safeArray(field.options).map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={inputId}
                  type={field.type || "text"}
                  value={values[field.id] ?? ""}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  placeholder={field.placeholder}
                  onChange={(event) => onChange?.(field.id, event.target.value)}
                />
              )}
            </label>
          );
        })}
        <div className="cf-settings-dialog__actions cf-profile-editor__actions">
          <button type="button" disabled={busy} onClick={() => onAskAgent?.(editor?.id)}>
            Ask {agentName} instead
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save section"}
          </button>
        </div>
      </form>
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
  publicSyncPreference = { enabled: true, source: "default", updatedAt: null },
  publicSyncBusy = false,
  desktopUpdate = null,
  onBack,
  onTabChange,
  onEditSection,
  onOpenFiles,
  onPermissionChange,
  onPublicSyncChange,
  onChangeEngine,
  onShowTechnicalDetails,
  onAddSource,
  onExportData,
  enginePickerOpen = false,
  enginePickerBusy = false,
  engineSignInId = null,
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
  browserProviderBusy = false,
  onBrowserProviderChange,
  onCloseTechnicalDetails,
  profileEditor = null,
  editorValues = {},
  editorBusy = false,
  onEditorChange,
  onSaveEditor,
  onAskAgent,
  onCloseEditor,
}) {
  const settingsActive = activeTab === "settings" || activeTab === "app";
  return (
    <div className="cf-profile">
      <header className="cf-profile__header">
        <button type="button" className="cf-profile__back" onClick={() => onBack?.()}>
          <ArrowLeftIcon /> Back
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
            desktopUpdate,
            engine,
            permissions,
            sources,
            publicSyncPreference,
            publicSyncBusy,
            onPermissionChange,
            onPublicSyncChange,
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
          signInRuntimeId={engineSignInId}
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
          providerBusy={browserProviderBusy}
          onProviderChange={onBrowserProviderChange}
          onClose={onCloseTechnicalDetails}
        />
      ) : null}
      {profileEditor ? (
        <ProfileSectionEditor
          agentName={agentName}
          editor={profileEditor}
          values={editorValues}
          busy={editorBusy}
          onChange={onEditorChange}
          onSave={onSaveEditor}
          onAskAgent={onAskAgent}
          onClose={onCloseEditor}
        />
      ) : null}
    </div>
  );
}
