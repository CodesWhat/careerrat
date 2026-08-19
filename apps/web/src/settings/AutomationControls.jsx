import { Field, Select, Toggle } from "../components/form.jsx";

export function buildAutomationSessionPatch(provider) {
  return { session: { provider } };
}

export function AutomationSessionChooser({ session, onChange, busy = false }) {
  const effective = String(session?.effectiveProvider || session?.provider || "extension");
  const effectiveLabel = effective.charAt(0).toUpperCase() + effective.slice(1);
  const readiness = session?.presence?.status === "ready" ? "Ready" : "Checked when used";
  const options = (session?.options || []).map(({ id, label, automatedApply }) => ({
    value: id,
    label: automatedApply === false ? `${label} (no automatic apply yet)` : label,
  }));
  return (
    <section className="automation-session" aria-labelledby="automation-session-title">
      <div className="automation-mode__heading">
        <div>
          <h2 id="automation-session-title">Browser connection</h2>
          <p className="field__hint">
            Automatic setup picks a supervised browser CareerRat can use. You don't need to know
            which CLI or extension is installed.
          </p>
        </div>
        <span className={`badge ${session?.presence?.status === "ready" ? "badge--ok" : ""}`}>
          {readiness}
        </span>
      </div>
      <Field
        label="Connection method"
        htmlFor="automation-session-provider"
        hint={`Using ${effectiveLabel}. ${session?.presence?.detail || "CareerRat verifies it when needed."}`}
      >
        <Select
          id="automation-session-provider"
          value={session?.provider || "auto"}
          options={options}
          disabled={busy}
          onChange={(provider) => onChange?.(provider)}
        />
      </Field>
    </section>
  );
}

export function buildAutomationModePatch(status, mode) {
  if (mode === "advanced") return { setup_mode: "advanced" };
  const capabilities = {};
  for (const capability of status?.capabilities || []) {
    capabilities[capability.capability] = {
      enabled: false,
      platforms: Object.fromEntries(
        (capability.platforms || []).map(({ platform }) => [platform, false])
      ),
    };
  }
  return {
    setup_mode: "basic",
    consent: Object.fromEntries(
      Object.keys(status?.consent || {}).map((platform) => [platform, false])
    ),
    capabilities,
  };
}

export function AutomationModeChooser({ status, onSetMode, busy = false }) {
  const mode = status?.mode || "basic";
  return (
    <section className="automation-mode" aria-labelledby="automation-mode-title">
      <div className="automation-mode__heading">
        <div>
          <span className="onboarding-runtime__eyebrow">Permission defaults</span>
          <h2 id="automation-mode-title">Connected services</h2>
        </div>
        <span className="badge">
          {status?.liveCount || 0} approved {status?.liveCount === 1 ? "connection" : "connections"}
        </span>
      </div>
      <div className="automation-mode__choices">
        <button
          type="button"
          className={`automation-mode__choice${mode === "basic" ? " automation-mode__choice--selected" : ""}`}
          aria-pressed={mode === "basic"}
          disabled={busy}
          onClick={() => onSetMode?.("basic")}
        >
          <span>
            <strong>Keep everything off</strong>
            <small>Recommended</small>
          </span>
          <p>
            CareerRat won't use signed-in websites, email, messages, or calendars. Turn on a
            specific connection when it becomes useful.
          </p>
        </button>
        <button
          type="button"
          className={`automation-mode__choice${mode === "advanced" ? " automation-mode__choice--selected" : ""}`}
          aria-pressed={mode === "advanced"}
          disabled={busy}
          onClick={() => onSetMode?.("advanced")}
        >
          <span>
            <strong>Choose individual connections</strong>
            <small>Review one by one</small>
          </span>
          <p>
            Review browser, mail, messaging, application, relationship, and calendar permissions.
            Nothing turns on until you approve that connection.
          </p>
        </button>
      </div>
    </section>
  );
}

function platformLabel(platform) {
  const labels = {
    apple_calendar: "Apple Calendar",
    google_calendar: "Google Calendar",
    linkedin: "LinkedIn",
    outlook_calendar: "Outlook Calendar",
  };
  if (labels[platform]) return labels[platform];
  return String(platform || "")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function AutomationConsentMatrix({
  status,
  onCapabilityChange,
  onPlatformChange,
  onConsentChange,
  busy = false,
}) {
  const liveCount = status?.liveCount || 0;
  return (
    <section className="automation-matrix" aria-labelledby="automation-matrix-title">
      <div className="automation-matrix__heading">
        <div>
          <h2 id="automation-matrix-title">Connection permissions</h2>
          <p className="field__hint">
            A row goes live only when its capability, platform, and explicit terms consent are all
            on.
          </p>
        </div>
        <span className="badge">
          {liveCount} live capability × platform {liveCount === 1 ? "pair" : "pairs"}
        </span>
      </div>
      <div className="automation-matrix__capabilities">
        {(status?.capabilities || []).map((capability) => (
          <article className="automation-capability" key={capability.capability}>
            <div className="automation-capability__heading">
              <div>
                <strong>{capability.label}</strong>
                <p>{capability.summary}</p>
              </div>
              <Toggle
                id={`automation-capability-${capability.capability}`}
                checked={capability.enabled}
                disabled={busy}
                onChange={(value) => onCapabilityChange?.(capability.capability, value)}
                label="Capability enabled"
              />
            </div>
            <div className="automation-capability__platforms">
              {(capability.platforms || []).map((platform) => (
                <div className="automation-platform" key={platform.platform}>
                  <div className="automation-platform__name">
                    <strong>{platformLabel(platform.platform)}</strong>
                    <span className={`badge ${platform.allowed ? "badge--ok" : "badge--muted"}`}>
                      {platform.allowed ? "Live" : "Off"}
                    </span>
                  </div>
                  <Toggle
                    id={`automation-platform-${capability.capability}-${platform.platform}`}
                    checked={platform.enabled}
                    disabled={busy}
                    onChange={(value) =>
                      onPlatformChange?.(capability.capability, platform.platform, value)
                    }
                    label="Platform enabled"
                  />
                  <Toggle
                    id={`automation-consent-${capability.capability}-${platform.platform}`}
                    checked={platform.consent}
                    disabled={busy}
                    onChange={(value) => onConsentChange?.(platform.platform, value)}
                    label="I accept this platform's automation terms"
                  />
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
