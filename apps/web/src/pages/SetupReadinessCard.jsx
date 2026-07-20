import { useState } from "react";
import { Link } from "react-router-dom";

const DISMISS_KEY = "rolester.deepIngestToast.dismissed";

export function deepIngestNeeded(setup) {
  return Boolean(setup) && setup?.readiness?.deep_ingest_complete !== true;
}

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function useDeepIngestNudge(setup) {
  const needed = deepIngestNeeded(setup);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage unavailable — dismissal still holds for this session via state.
    }
  };

  return { needed, dismissed, dismiss };
}

export function DeepIngestToast({ onDismiss }) {
  return (
    <div className="setup-toast" role="status" aria-label="Deep ingest">
      <div className="setup-toast__body">
        <p className="setup-toast__title">Go deeper</p>
        <p className="setup-toast__sub">
          Import your full history so tailoring and matches sharpen up.
        </p>
        <Link className="btn btn--primary setup-toast__cta" to="/deep-ingest">
          Start deep ingest
        </Link>
      </div>
      <button
        type="button"
        className="setup-toast__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export function DeepIngestPriorityNudge() {
  return (
    <Link className="dashboard__secondary-link dashboard__deep-ingest-nudge" to="/deep-ingest">
      <span>Go deeper — start deep ingest</span>
    </Link>
  );
}
