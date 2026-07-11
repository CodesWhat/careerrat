import { startSearchRun } from "../lib/api.js";

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
