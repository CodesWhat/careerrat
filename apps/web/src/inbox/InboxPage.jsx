import { useCallback, useEffect, useState } from "react";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { listIntake } from "../lib/api.js";
import { emitIntakeChanged, subscribeIntakeChanged } from "../lib/intake-events.js";
import { IntakeCard } from "./IntakeCard.jsx";

// InboxPage — the M9 "/inbox" route: the queue behind the docked capture bar
// (../app-shell/CaptureBar.jsx). One card per intake_items row (the repo's
// standing "no giant tables" rule — see project memory
// dashboard-no-giant-tables), glanceable with a drill-in per card rather than
// a dense list. Not paginated beyond LIST_LIMIT — matches the scale every
// other Inbox-shaped list in this repo (Activity Pulse) is built for.
const FILTERS = [
  { key: "all", label: "All", status: undefined },
  { key: "needs_you", label: "Needs you", status: "needs_you" },
  { key: "proposed", label: "To confirm", status: "proposed" },
  { key: "running", label: "Running", status: "running" },
  { key: "done", label: "Done", status: "done" },
  { key: "dismissed", label: "Dismissed", status: "dismissed" },
];
const LIST_LIMIT = 50;
// Confirmed Lane B/C dispatches finish in the background AFTER
// POST /api/intake/confirm's response returns (see intake-route.mjs's
// executeLaneB — it fires runSkillStream without awaiting it), so the only
// way this page observes a running -> done/error transition it didn't cause
// itself is polling.
const POLL_MS = 8000;

export function InboxPage() {
  const [filterKey, setFilterKey] = useState("all");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const filterStatus = FILTERS.find((f) => f.key === filterKey)?.status;

  const load = useCallback(async () => {
    try {
      const { items: fetched } = await listIntake({ status: filterStatus, limit: LIST_LIMIT });
      setItems(fetched);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load the inbox");
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => {
    setLoading(true);
    load();
    const unsubscribe = subscribeIntakeChanged(load);
    const interval = setInterval(load, POLL_MS);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [load]);

  function handleChanged(updatedItem) {
    setItems((prev) => prev.map((it) => (it.id === updatedItem.id ? updatedItem : it)));
    emitIntakeChanged();
  }

  return (
    <PageScaffold
      title="Inbox"
      subtitle="Everything pasted or dropped into the capture bar — classified, matched against your tracker, and waiting on a confirm."
    >
      {loadError ? <InlineAlert message={loadError} /> : null}
      <div className="inbox-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`inbox-filter${f.key === filterKey ? " inbox-filter--active" : ""}`}
            onClick={() => setFilterKey(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {loading ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p className="field__hint">
          Nothing here for this filter — paste a job posting, recruiter email, interview note, or
          status update into the capture bar to get started.
        </p>
      ) : (
        <div className="inbox-list">
          {items.map((item) => (
            <IntakeCard key={item.id} item={item} onChanged={handleChanged} />
          ))}
        </div>
      )}
    </PageScaffold>
  );
}
