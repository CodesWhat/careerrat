import { useState } from "react";
import { Link } from "react-router-dom";

const DISMISS_KEY = "careerrat.deepIngestToast.dismissed";

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

// DeepIngestDock — docked inline as the top row of AskBar's own
// `.ask-bar__shell` card (see AskBar.jsx), not a separate floating surface.
// Living inside the same bordered/backgrounded container as the ask input
// means it can never sit on top of (or get covered by) the input itself —
// there's only one box, stacked in normal flow, not two independently
// positioned ones.
export function DeepIngestDock({ onDismiss }) {
  return (
    <div className="ask-bar__nudge" role="status" aria-label="Deep ingest">
      <div className="ask-bar__nudge-body">
        <p className="ask-bar__nudge-title">Go deeper</p>
        <p className="ask-bar__nudge-sub">
          Import your full history so tailoring and matches sharpen up.
        </p>
      </div>
      <Link className="btn btn--primary ask-bar__nudge-cta" to="/deep-ingest">
        Start deep ingest
      </Link>
      <button
        type="button"
        className="ask-bar__nudge-dismiss"
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
      <span>Go deeper: start deep ingest</span>
    </Link>
  );
}
