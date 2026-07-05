import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Button } from "../components/Button.jsx";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { getSearchSources, startSearchRun } from "../lib/api.js";
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

export function hasDbSourceSetup(sourceSetup) {
  if (!sourceSetup || typeof sourceSetup !== "object") return false;
  if (sourceSetup.deterministicSources && typeof sourceSetup.deterministicSources === "object") {
    return Number(sourceSetup.deterministicSources.attempted || 0) > 0;
  }
  if (sourceSetup.ready === true) return true;

  const enabledSearches =
    Number(sourceSetup.searches?.enabled || 0) ||
    Number(sourceSetup.enabledSearches || 0) ||
    Number(sourceSetup.enabled || 0);
  const trackedCompanies =
    Number(sourceSetup.trackedCompanies || 0) ||
    Number(sourceSetup.tracked_companies || 0) ||
    Number(sourceSetup.companies || 0);

  return enabledSearches > 0 || trackedCompanies > 0;
}

function unwrapRun(value) {
  if (!value || typeof value !== "object") return null;
  if (value.run && typeof value.run === "object") return value.run;
  return value;
}

function describeJobsPageSearchError(error) {
  return (
    error?.body?.error ||
    error?.body?.message ||
    error?.message ||
    "Search could not start. Review Search setup, then try again."
  );
}

export async function runJobsPageSearch({
  startSearchRun: startSearchRunFn = startSearchRun,
  refetch,
  setSearchError,
  setSearchRun,
} = {}) {
  try {
    setSearchError?.(null);
    const result = await startSearchRunFn({ purpose: "manual-search" });
    const run = unwrapRun(result);
    setSearchRun?.(run);
    if (run?.status === "failed") {
      const message =
        run.error?.message ||
        "Search failed. Add an RSS source or supported public ATS company, then retry.";
      setSearchError?.(message);
      return { ok: false, error: message, run };
    }
    await refetch?.();
    return result;
  } catch (error) {
    const message = describeJobsPageSearchError(error);
    setSearchError?.(message);
    return { ok: false, error: message };
  }
}

export function JobsPage() {
  const { data, loading, error, noDatabase, refetch } = useDashboardSnapshot();
  const [tab, setTab] = useState("all");
  const [loadedSearchSources, setLoadedSearchSources] = useState(null);
  const [sourceSetupError, setSourceSetupError] = useState(null);
  const [manualSearchError, setManualSearchError] = useState(null);
  const [manualSearchRun, setManualSearchRun] = useState(null);
  const [manualSearchPending, setManualSearchPending] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const rows = data?.jobs?.rows || [];
  const filtered = useMemo(
    () => (tab === "all" ? rows : rows.filter((r) => r.source === tab)),
    [rows, tab]
  );

  const openId = searchParams.get("open");
  const openRow = openId ? rows.find((r) => r.id === openId) : null;
  const dashboardSourceSetup = data?.searchSources || data?.sourceSetup || null;
  const sourceSetup = dashboardSourceSetup || loadedSearchSources;
  const sourceSetupReady = hasDbSourceSetup(sourceSetup);
  const latestManualRun =
    manualSearchRun ||
    unwrapRun(data?.sourcing?.manualSearchRun) ||
    unwrapRun(data?.manualSearchRun) ||
    unwrapRun(data?.searchRun);
  const manualSearchRunning = manualSearchPending || latestManualRun?.status === "running";
  const visibleManualSearchError = manualSearchError || data?.sourcing?.manualSearchError || null;

  useEffect(() => {
    if (!data || dashboardSourceSetup) return undefined;

    let cancelled = false;
    getSearchSources()
      .then((body) => {
        if (cancelled) return;
        setLoadedSearchSources(body);
        setSourceSetupError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setSourceSetupError(describeJobsPageSearchError(err));
      });

    return () => {
      cancelled = true;
    };
  }, [data, dashboardSourceSetup]);

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

  async function handleManualSearch() {
    setManualSearchPending(true);
    try {
      await runJobsPageSearch({
        refetch,
        setSearchError: setManualSearchError,
        setSearchRun: setManualSearchRun,
      });
    } finally {
      setManualSearchPending(false);
    }
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
      actions={
        sourceSetupReady ? (
          <Button onClick={handleManualSearch} disabled={manualSearchRunning}>
            {manualSearchRunning ? "Searching..." : "Search jobs"}
          </Button>
        ) : null
      }
      wide
    >
      {error ? <InlineAlert message={error} /> : null}
      {sourceSetupError ? <InlineAlert message={sourceSetupError} /> : null}
      {visibleManualSearchError ? <InlineAlert message={visibleManualSearchError} /> : null}
      {loading ? <p>Loading…</p> : null}
      {data && !sourceSetupReady ? (
        <p className="field__hint">Finish Search setup before running a job search.</p>
      ) : null}

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
