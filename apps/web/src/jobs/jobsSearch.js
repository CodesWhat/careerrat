import { runAiWebSearchStream, startSearchRun } from "../lib/api.js";

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

function describeAiWebSearchError(error) {
  return (
    error?.body?.error?.message ||
    error?.body?.message ||
    error?.message ||
    "AI web search could not start. Review saved prompts, then try again."
  );
}

// Runs the AI web-search lane (POST /api/search/ai-web-search/run's SSE
// stream) — same status/error-describing shape as runJobsPageSearch above,
// but stateful across the run's lifetime instead of a single request/
// response: `status` moves idle -> running -> results | error, `setActivity`
// gets the latest {type:"activity"} message as it streams, and `setCounts`
// gets the {type:"done"} payload's {searched, found, new, duplicates,
// errors} once the run finishes. Aborting via `signal` (see AbortController)
// is treated as a user cancel, not a failure — status returns to "idle"
// rather than "error". Same refetch handoff on completion as the free-board
// lane: the dashboard/results view re-reads the latest DB state rather than
// this function trying to merge the run's counts into it locally.
export async function runAiWebSearchLane({
  runAiWebSearchStream: runFn = runAiWebSearchStream,
  refetch,
  signal,
  setStatus,
  setActivity,
  setCounts,
  setError,
} = {}) {
  setError?.(null);
  setCounts?.(null);
  setActivity?.(null);
  setStatus?.("running");

  let doneData = null;
  let sawDone = false;
  let streamErrorMessage = null;

  try {
    await runFn({
      signal,
      onEvent: (payload) => {
        if (!payload || typeof payload !== "object") return;
        switch (payload.type) {
          case "activity":
            if (payload.message) setActivity?.(payload.message);
            break;
          case "done":
            sawDone = true;
            doneData = payload.data || null;
            break;
          case "error":
            streamErrorMessage = payload.message || "AI web search failed.";
            break;
          default:
            break;
        }
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus?.("idle");
      return { ok: false, aborted: true };
    }
    const message = describeAiWebSearchError(error);
    setStatus?.("error");
    setError?.(message);
    return { ok: false, error: message };
  }

  if (streamErrorMessage) {
    setStatus?.("error");
    setError?.(streamErrorMessage);
    return { ok: false, error: streamErrorMessage };
  }

  // The stream closed without ever emitting a "done" or "error" frame — a
  // dropped connection or a server-side bug, not a legitimate zero-result
  // run. Report it as a failure and skip refetch rather than quietly
  // clearing results/counts as if the search actually completed.
  if (!sawDone) {
    const message = "Search ended unexpectedly — try again.";
    setStatus?.("error");
    setError?.(message);
    return { ok: false, error: message };
  }

  setCounts?.(doneData);
  setStatus?.("results");
  await refetch?.();
  return { ok: true, data: doneData };
}
