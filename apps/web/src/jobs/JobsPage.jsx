import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { FunnelSankey } from "./FunnelSankey.jsx";
import { JobDrawer } from "./JobDrawer.jsx";
import { JobFunnel } from "./JobFunnel.jsx";
import { JobRow } from "./JobRow.jsx";

// /jobs — the funnel bar + row list + drawer. Filter tabs are All / Applied /
// Sourced: sourced triage folds in HERE rather than getting its own route,
// because dashboard-data.js already merges sourced and application rows into
// one rows[] and routes both through the identical buildJobAction precedence
// chain (M10 design doc §1) — a second page would either duplicate that or
// force an awkward cross-page drawer reuse.
const TABS = [
  { key: "all", label: "All" },
  { key: "application", label: "Applied" },
  { key: "sourced", label: "Sourced" },
];

export function JobsPage() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const [tab, setTab] = useState("all");
  const [searchParams, setSearchParams] = useSearchParams();

  const rows = data?.jobs?.rows || [];
  const filtered = useMemo(
    () => (tab === "all" ? rows : rows.filter((r) => r.source === tab)),
    [rows, tab]
  );

  const openId = searchParams.get("open");
  const openRow = openId ? rows.find((r) => r.id === openId) : null;

  function openDrawer(id) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("open", id);
      return next;
    });
  }

  function closeDrawer() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("open");
      return next;
    });
  }

  if (noDatabase) {
    return (
      <PageScaffold title="Jobs">
        <InlineAlert message="No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload." />
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      title="Jobs"
      subtitle="Every application and sourced role, one list — gate sourced roles from here before they enter the active pipeline."
      wide
    >
      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p>Loading…</p> : null}

      {data ? (
        <>
          <JobFunnel funnel={data.jobs.funnel} />

          <div className="inbox-filters">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`inbox-filter${tab === t.key ? " inbox-filter--active" : ""}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <p className="field__hint">Nothing here for this filter.</p>
          ) : (
            <div className="job-list">
              {filtered.map((row) => (
                <JobRow key={row.id} row={row} onOpen={openDrawer} />
              ))}
            </div>
          )}

          <FunnelSankey sankey={data.jobs.sankey} />
        </>
      ) : null}

      {openRow ? <JobDrawer row={openRow} onClose={closeDrawer} /> : null}
    </PageScaffold>
  );
}
