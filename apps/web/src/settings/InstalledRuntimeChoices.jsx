// apps/web/src/settings/InstalledRuntimeChoices.jsx — moved out of the dead
// onboarding wizard step (formerly onboarding/steps/KeyStep.jsx). settings/
// SettingsPage.jsx is the sole consumer. Moved verbatim, behavior unchanged.
import { Button } from "../components/Button.jsx";

function runtimeStatusLabel(runtime) {
  if (runtime.selected) return "Selected";
  if (runtime.ready) return "Ready";
  if (runtime.status === "authentication_required") return "Sign-in needed";
  if (!runtime.available) return "Not installed";
  return "Needs attention";
}

export function InstalledRuntimeChoices({
  state,
  onSelect,
  onRetry,
  onOpenTerminal,
  busyId = null,
  showAdvancedHint = true,
}) {
  const runtimes = Array.isArray(state?.runtimes) ? state.runtimes : [];
  const installed = runtimes.filter((runtime) => runtime.available);

  return (
    <section className="onboarding-runtime" aria-labelledby="onboarding-runtime-title">
      <div className="onboarding-runtime__heading">
        <div>
          <span className="onboarding-runtime__eyebrow">Recommended</span>
          <h2 id="onboarding-runtime-title">Use an AI tool already on this computer</h2>
        </div>
        <span className="badge">No extra API key</span>
      </div>
      <p className="field__hint">
        Rolester uses the tool's existing login and subscription. Credentials stay with that CLI.
      </p>
      {!state ? <p className="field__hint">Checking this computer…</p> : null}
      {state && installed.length === 0 ? (
        <p className="field__hint">
          No supported signed-in AI CLI was found. Manual setup still works.
        </p>
      ) : null}
      {installed.length ? (
        <div className="onboarding-runtime__list">
          {installed.map((runtime) => (
            <article
              className={`onboarding-runtime__choice${runtime.selected ? " onboarding-runtime__choice--selected" : ""}`}
              key={runtime.id}
            >
              <div className="onboarding-runtime__choice-copy">
                <strong>{runtime.name}</strong>
                <code>{runtime.commandShape}</code>
                {runtime.warning ? <span className="field__hint">{runtime.warning}</span> : null}
              </div>
              <div className="onboarding-runtime__choice-action">
                <span className="badge">{runtimeStatusLabel(runtime)}</span>
                {runtime.ready && !runtime.selected ? (
                  <Button
                    variant="secondary"
                    disabled={busyId === runtime.id}
                    onClick={() => onSelect?.(runtime.id)}
                  >
                    {busyId === runtime.id ? "Selecting…" : "Use this tool"}
                  </Button>
                ) : null}
                {!runtime.ready && runtime.action === "open_terminal" ? (
                  <>
                    <Button
                      variant="secondary"
                      disabled={busyId === runtime.id}
                      onClick={() => onOpenTerminal?.(runtime.id)}
                    >
                      Open Terminal to sign in
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busyId === runtime.id}
                      onClick={() => onRetry?.(runtime.id)}
                    >
                      Retry detection
                    </Button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {showAdvancedHint ? (
        <details className="onboarding-runtime__advanced">
          <summary>Advanced · Use a provider API key instead</summary>
          <p className="field__hint">
            Provider keys and managed AI are optional fallbacks. Configure them later in Settings.
          </p>
        </details>
      ) : null}
    </section>
  );
}
