import {
  generateSearchPrompts,
  getSearchPrompts,
  getSourcingRun,
  runAiWebSearchStream,
  saveSearchPrompts,
  startSearchRun,
} from "../lib/api.js";
import { errorState } from "../lib/errorCopy.js";

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

// setSearchError (JobsPage.jsx's manualSearchError) is a plain string
// rendered through InlineAlert's `message` prop alone — no action/detail
// slot wired up at that call site — so this stays message-only, translated
// through resolveErrorCopy() rather than the raw server string, with the
// existing fallback wording preserved for the unmapped case.
function describeJobsPageSearchError(error) {
  return errorState(error, "Search could not start. Review Search setup, then try again.").message;
}

// Resolves after `ms`, or immediately if `signal` aborts first — the poll
// loop's sleep step, kept local rather than pulled in as a dependency.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

// The start request (POST /api/sourcing/search/start) returns immediately
// with a point-in-time "running" run row while the scan itself runs detached
// server-side (src/cli/sourcing-route.mjs -> runFirstSearchInBackground).
// Without this loop the caller stores that "running" snapshot forever and
// the button spins indefinitely even after the run completes. Polls
// GET /api/sourcing/runs/latest (via getSourcingRunFn) until the run reaches
// a terminal status, times out, or the caller aborts.
async function pollManualSearchRun({
  getSourcingRunFn,
  refetch,
  setSearchError,
  setSearchRun,
  signal,
  pollIntervalMs,
  pollTimeoutMs,
}) {
  const deadline = Date.now() + pollTimeoutMs;
  let misses = 0;

  for (;;) {
    await sleep(pollIntervalMs, signal);
    if (signal?.aborted) return { ok: false, aborted: true };

    if (Date.now() >= deadline) {
      setSearchRun?.(null);
      setSearchError?.(
        "Search is still running in the background. Reload the page later to see results."
      );
      return { ok: false, timedOut: true };
    }

    let polledRun = null;
    let pollError = null;
    try {
      polledRun = unwrapRun(await getSourcingRunFn({ purpose: "manual-search" }));
    } catch (error) {
      pollError = error;
    }

    if (!polledRun) {
      misses += 1;
      if (misses < 3) continue;
      if (signal?.aborted) return { ok: false, aborted: true };
      setSearchRun?.(null);
      setSearchError?.("Couldn't read search status. Reload the page to see results.");
      return { ok: false, error: pollError || new Error("No sourcing run returned") };
    }
    misses = 0;

    if (polledRun.status === "running") continue;

    if (signal?.aborted) return { ok: false, aborted: true };
    setSearchRun?.(polledRun);
    if (polledRun.status === "failed") {
      const message =
        polledRun.error?.message ||
        "Search failed. Add an RSS source or supported public ATS company, then retry.";
      setSearchError?.(message);
      return { ok: false, error: message, run: polledRun };
    }
    await refetch?.();
    return { ok: true, run: polledRun };
  }
}

export async function runJobsPageSearch({
  startSearchRun: startSearchRunFn = startSearchRun,
  getSourcingRun: getSourcingRunFn = getSourcingRun,
  refetch,
  setSearchError,
  setSearchRun,
  signal,
  pollIntervalMs = 2500,
  pollTimeoutMs = 10 * 60 * 1000,
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
    if (run?.status === "running") {
      return await pollManualSearchRun({
        getSourcingRunFn,
        refetch,
        setSearchError,
        setSearchRun,
        signal,
        pollIntervalMs,
        pollTimeoutMs,
      });
    }
    await refetch?.();
    return result;
  } catch (error) {
    const message = describeJobsPageSearchError(error);
    setSearchError?.(message);
    return { ok: false, error: message };
  }
}

// Same one-line, message-only treatment as describeJobsPageSearchError above
// — setError (JobsPage.jsx's aiSearchError) is a plain string too.
function describeAiWebSearchError(error) {
  return errorState(error, "AI web search could not start. Review saved prompts, then try again.")
    .message;
}

// Non-technical, single honest message for every way the invisible prep step
// below can fail (no targeting context to generate from, a model/provider
// error, or no AI route configured at all) — a non-technical job seeker has
// no use for "SEARCH_PROMPTS_NO_TARGETING" or a provider status code, only
// somewhere to go fix it.
const AI_SEARCH_PREP_ERROR =
  "Couldn't figure out what to search for. Finish your job preferences in Settings.";

// There is no per-prompt/Regenerate UI anymore (Scott, 2026-07-20: the old
// "AI prompts (N)" button + modal meant nothing to a non-technical job
// seeker), so nothing ever tells this lane "the prompts are stale" — it has
// to know on its own, the same way a cache does: no stored prompts at all is
// always stale, and stored prompts older than the candidate's targeting are
// stale too since they'd be searching for the wrong thing.
function promptsAreStale(prompts, targetingUpdatedAt) {
  const list = Array.isArray(prompts) ? prompts : [];
  if (!list.length) return true;
  if (!targetingUpdatedAt) return false;
  const targetingTime = Date.parse(targetingUpdatedAt);
  if (!Number.isFinite(targetingTime)) return false;
  const newestPromptTime = list.reduce((latest, prompt) => {
    const time = Date.parse(prompt?.updatedAt || "");
    return Number.isFinite(time) && time > latest ? time : latest;
  }, Number.NEGATIVE_INFINITY);
  return !Number.isFinite(newestPromptTime) || newestPromptTime < targetingTime;
}

// No route exposes the candidate_targeting singleton row's own `updated_at`
// column yet (readTargeting()/candidateConfigGet() in
// src/core/db/verbs/candidate.mjs return the doc's fields, not its DB
// timestamp) — this stays a seam rather than a hardcoded "always fresh"
// assumption, so promptsAreStale() picks up a real value the moment a route
// exposes one, with no call site here needing to change. Until then the "no
// stored prompts at all" branch above is the only staleness trigger that
// fires.
async function getTargetingUpdatedAt() {
  return null;
}

// Invisible AI-search prep: makes sure there ARE saved search prompts, and
// that they still reflect the candidate's current targeting, before the AI
// web-search run itself starts. Generation is a FULL replace, never a
// partial-preserve merge — there's no UI left to reconcile a partial edit
// against, so the freshly generated set simply becomes the stored set.
async function ensureFreshSearchPrompts({
  getSearchPrompts: getSearchPromptsFn,
  generateSearchPrompts: generateSearchPromptsFn,
  saveSearchPrompts: saveSearchPromptsFn,
  getTargetingUpdatedAt: getTargetingUpdatedAtFn,
  setActivity,
}) {
  let stored;
  try {
    stored = await getSearchPromptsFn();
  } catch (_error) {
    return { ok: false, error: AI_SEARCH_PREP_ERROR };
  }

  const prompts = stored?.data?.prompts;
  const targetingUpdatedAt = await getTargetingUpdatedAtFn().catch(() => null);

  if (!promptsAreStale(prompts, targetingUpdatedAt)) {
    return { ok: true, prompts };
  }

  setActivity?.("Preparing your search…");

  let generated;
  try {
    generated = await generateSearchPromptsFn();
  } catch (_error) {
    return { ok: false, error: AI_SEARCH_PREP_ERROR };
  }
  if (!generated?.data?.prompts?.length) {
    return { ok: false, error: AI_SEARCH_PREP_ERROR };
  }

  try {
    const saved = await saveSearchPromptsFn(
      generated.data.prompts.map((prompt) => ({ text: prompt.text }))
    );
    return { ok: true, prompts: saved?.data?.prompts || generated.data.prompts };
  } catch (_error) {
    return { ok: false, error: AI_SEARCH_PREP_ERROR };
  }
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
//
// Before any of that, ensureFreshSearchPrompts() (above) runs invisibly —
// there's no more user-facing "AI prompts"/Regenerate control, so this lane
// has to keep its own prompts current. A brief "Preparing your search…"
// activity message covers that step through the same SearchStatusStrip the
// rest of this lane's activity text renders through; a prep failure (no
// targeting context, a model error, or no AI route) reports AI_SEARCH_PREP_ERROR
// and returns without ever starting the stream.
export async function runAiWebSearchLane({
  runAiWebSearchStream: runFn = runAiWebSearchStream,
  getSearchPrompts: getSearchPromptsFn = getSearchPrompts,
  generateSearchPrompts: generateSearchPromptsFn = generateSearchPrompts,
  saveSearchPrompts: saveSearchPromptsFn = saveSearchPrompts,
  getTargetingUpdatedAt: getTargetingUpdatedAtFn = getTargetingUpdatedAt,
  promptIds,
  refetch,
  signal,
  setStatus,
  setActivity,
  setCounts,
  setError,
  // Optional — reports the stream's wall-clock duration once a run finishes,
  // for the sweep-line engine receipt (design handoff 3b: "AI · ENGINE ·
  // 41S"). Measured client-side since neither the runtime-config route nor
  // the "done" SSE frame carries a server-side duration.
  setElapsedMs,
} = {}) {
  setError?.(null);
  setCounts?.(null);
  setActivity?.(null);
  setStatus?.("running");

  const prep = await ensureFreshSearchPrompts({
    getSearchPrompts: getSearchPromptsFn,
    generateSearchPrompts: generateSearchPromptsFn,
    saveSearchPrompts: saveSearchPromptsFn,
    getTargetingUpdatedAt: getTargetingUpdatedAtFn,
    setActivity,
  });

  if (!prep.ok) {
    setStatus?.("error");
    setError?.(prep.error);
    return { ok: false, error: prep.error };
  }

  setActivity?.(null);

  const startedAt = Date.now();
  let doneData = null;
  let sawDone = false;
  let streamErrorMessage = null;

  try {
    await runFn({
      promptIds,
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
    const message = "Search ended unexpectedly. Try again.";
    setStatus?.("error");
    setError?.(message);
    return { ok: false, error: message };
  }

  const failedPromptIds = Array.isArray(doneData?.failedPromptIds) ? doneData.failedPromptIds : [];
  const allQueriesFailed =
    Number(doneData?.searched || 0) > 0 &&
    failedPromptIds.length >= Number(doneData.searched) &&
    Number(doneData?.new || 0) === 0;

  if (allQueriesFailed) {
    const message =
      doneData?.errors?.[0] ||
      doneData?.queryResults?.find((item) => item?.error)?.error ||
      "Every selected AI web-search query failed.";
    setCounts?.(doneData);
    setStatus?.("error");
    setError?.(message);
    return { ok: false, error: message, data: doneData };
  }

  setCounts?.(doneData);
  setElapsedMs?.(Date.now() - startedAt);
  setStatus?.("results");
  await refetch?.();
  return { ok: true, data: doneData };
}
