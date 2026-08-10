import { Toggle } from "../components/form.jsx";

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
          <span className="onboarding-runtime__eyebrow">One setup choice</span>
          <h2 id="automation-mode-title">How hands-on should CareerRat be?</h2>
        </div>
        <span className="badge">
          {status?.liveCount || 0} live {status?.liveCount === 1 ? "permission" : "permissions"}
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
            <strong>Basic</strong>
            <small>Recommended</small>
          </span>
          <p>Keep work read-only and manual. Every external capability is hard-off.</p>
        </button>
        <button
          type="button"
          className={`automation-mode__choice${mode === "advanced" ? " automation-mode__choice--selected" : ""}`}
          aria-pressed={mode === "advanced"}
          disabled={busy}
          onClick={() => onSetMode?.("advanced")}
        >
          <span>
            <strong>Advanced</strong>
            <small>Individual opt-ins</small>
          </span>
          <p>
            Show browser, mail, messaging, application, relationship, and calendar controls. Nothing
            turns on automatically.
          </p>
        </button>
      </div>
    </section>
  );
}

function platformLabel(platform) {
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
          <h2 id="automation-matrix-title">Advanced permissions</h2>
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
