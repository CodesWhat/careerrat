import {
  generateSearchPrompts,
  getSearchPrompts,
  getSourcingRun,
  runAiWebSearchStream,
  saveSearchPrompts,
  startSearchRun,
} from "../lib/api.js";
import { errorState } from "../lib/errorCopy.js";

function unwrapRun(value) {
  if (!value || typeof value !== "object") return null;
  if (value.run && typeof value.run === "object") return value.run;
  return value;
}

const SEARCH_LANES = Object.freeze({
  deterministic: { label: "Configured sources" },
  aiWeb: { label: "AI web search" },
});

export function jobSearchCapabilities({ sourceStatus, ai } = {}) {
  const enabledSearches = Number(sourceStatus?.searches?.enabled || 0);
  const enabledCompanies = Number(sourceStatus?.enabledTrackedCompanies || 0);
  const deterministicAttempts = Number(sourceStatus?.deterministicSources?.attempted || 0);
  return {
    deterministic: {
      configured: enabledSearches > 0 || enabledCompanies > 0,
      executable: deterministicAttempts > 0,
      consented: true,
    },
    aiWeb: {
      configured: ai?.configured === true,
      executable: ai?.executable === true,
      consented: ai?.consented === true,
    },
  };
}

function skippedReason(capability) {
  if (!capability.configured) return "not-configured";
  if (!capability.consented) return "not-consented";
  return "unavailable";
}

function initialLaneState(id, capability = {}) {
  const configured = capability.configured === true;
  const executable = capability.executable === true;
  const consented = capability.consented !== false;
  const runnable = configured && executable && consented;
  return {
    label: SEARCH_LANES[id].label,
    configured,
    executable,
    consented,
    status: runnable ? "running" : "skipped",
    ...(!runnable ? { reason: skippedReason({ configured, executable, consented }) } : {}),
  };
}

function laneError(result, fallback) {
  if (typeof result?.error === "string" && result.error) return result.error;
  if (result?.error?.message) return result.error.message;
  return fallback;
}

function resultNewCount(result) {
  const value = result?.data?.new ?? result?.run?.summary?.new ?? result?.summary?.new;
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function resultCount(result, key) {
  const value = result?.data?.[key] ?? result?.run?.summary?.[key] ?? result?.summary?.[key];
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function normalizedIdentityPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedOfferUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return String(value || "")
      .trim()
      .toLowerCase();
  }
}

function offerIdentityKeys(offer) {
  const url = String(offer?.url || offer?.link || "").trim();
  const reqId = String(offer?.reqId || offer?.scanner?.reqId || "")
    .trim()
    .toLowerCase();
  const keys = [];
  if (url) keys.push(`url:${normalizedOfferUrl(url)}`);
  if (reqId) keys.push(`req:${reqId}`);
  if (keys.length) return keys;

  const company = normalizedIdentityPart(offer?.company);
  const role = normalizedIdentityPart(offer?.role || offer?.title);
  const location = normalizedIdentityPart(offer?.location || offer?.loc);
  return company && role && location
    ? [`company-role-location:${company}::${role}::${location}`]
    : [];
}

function resultNewOffers(result) {
  const value = result?.data?.offers ?? result?.run?.summary?.offers ?? result?.summary?.offers;
  return Array.isArray(value) ? value : null;
}

function reconciledNewCount(outcomes) {
  const seenIdentities = new Set();
  let identified = 0;
  let withoutIdentity = 0;
  for (const outcome of outcomes) {
    const count = resultNewCount(outcome.result);
    const offers = resultNewOffers(outcome.result);
    if (!offers) {
      withoutIdentity += count;
      continue;
    }
    const countedOffers = offers.slice(0, count);
    withoutIdentity += Math.max(0, count - countedOffers.length);
    for (const offer of countedOffers) {
      const identities = offerIdentityKeys(offer);
      if (!identities.length) {
        withoutIdentity += 1;
        continue;
      }
      if (identities.some((identity) => seenIdentities.has(identity))) continue;
      for (const identity of identities) seenIdentities.add(identity);
      identified += 1;
    }
  }
  return identified + withoutIdentity;
}

export async function runCoordinatedJobSearch({
  capabilities = {},
  runDeterministic,
  runAiWeb,
  refetch,
  setSearchState,
  signal,
} = {}) {
  let lanes = {
    deterministic: initialLaneState("deterministic", capabilities.deterministic),
    aiWeb: initialLaneState("aiWeb", capabilities.aiWeb),
  };
  const runners = { deterministic: runDeterministic, aiWeb: runAiWeb };
  const runnable = Object.keys(lanes).filter(
    (id) => lanes[id].status === "running" && typeof runners[id] === "function"
  );

  function publish(state) {
    setSearchState?.({ ...state, lanes: { ...lanes } });
  }

  function updateLane(id, patch = {}) {
    lanes = { ...lanes, [id]: { ...lanes[id], ...patch } };
    publish({
      status: "running",
      detail: `${runnable.map((laneId) => SEARCH_LANES[laneId].label).join(" and ")} running`,
    });
  }

  if (!runnable.length) {
    const state = {
      status: "error",
      summary: "No configured search lane is available. Review source and AI settings.",
    };
    publish(state);
    return { ok: false, skipped: true, lanes };
  }

  publish({
    status: "running",
    detail: `${runnable.map((id) => SEARCH_LANES[id].label).join(" and ")} running`,
  });

  const outcomes = await Promise.all(
    runnable.map(async (id) => {
      try {
        const result = await runners[id]({
          signal,
          onLaneState: (patch) => updateLane(id, patch),
        });
        if (signal?.aborted || result?.aborted) return { id, result, aborted: true };
        if (result?.ok === false) {
          return {
            id,
            result,
            error: laneError(result, `${SEARCH_LANES[id].label} failed.`),
          };
        }
        return { id, result, ok: true };
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") return { id, aborted: true };
        return { id, error: error?.message || `${SEARCH_LANES[id].label} failed.` };
      }
    })
  );

  if (signal?.aborted || outcomes.every((outcome) => outcome.aborted)) {
    for (const id of runnable) {
      lanes = {
        ...lanes,
        [id]: { ...lanes[id], status: "skipped", reason: "cancelled" },
      };
    }
    publish({ status: "idle", summary: "Search cancelled." });
    return { ok: false, aborted: true };
  }

  for (const outcome of outcomes) {
    lanes = {
      ...lanes,
      [outcome.id]: outcome.ok
        ? { ...lanes[outcome.id], status: "succeeded", result: outcome.result }
        : {
            ...lanes[outcome.id],
            status: outcome.aborted ? "skipped" : "failed",
            ...(outcome.aborted
              ? { reason: "cancelled" }
              : { error: outcome.error || `${SEARCH_LANES[outcome.id].label} failed.` }),
          },
    };
  }

  await refetch?.();
  const succeeded = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => outcome.error);
  const newCount = reconciledNewCount(succeeded);
  const unreadableCount = succeeded.reduce(
    (sum, outcome) => sum + resultCount(outcome.result, "unreadable"),
    0
  );
  const partialDescriptionCount = succeeded.reduce(
    (sum, outcome) => sum + resultCount(outcome.result, "partial"),
    0
  );
  const finishedCopy = `${succeeded.length} search lane${succeeded.length === 1 ? "" : "s"} finished`;
  const failedCopy = failed.length ? ` · ${failed.length} failed` : "";
  const newCopy = newCount ? ` · ${newCount} new` : "";
  const unreadableCopy = unreadableCount ? ` · ${unreadableCount} couldn't be added` : "";
  const partialDescriptionCopy = partialDescriptionCount
    ? ` · ${partialDescriptionCount} ${partialDescriptionCount === 1 ? "has" : "have"} a partial description`
    : "";
  const ok = succeeded.length > 0;
  const state = {
    status: ok ? "complete" : "error",
    summary: `${finishedCopy}${failedCopy}${newCopy}${unreadableCopy}${partialDescriptionCopy}`,
  };
  publish(state);
  return {
    ok,
    partial: ok && failed.length > 0,
    lanes,
    results: Object.fromEntries(outcomes.map((outcome) => [outcome.id, outcome.result])),
  };
}

// The chat-first sweep status accepts one user-facing string, so errors stay
// message-only after translation through resolveErrorCopy().
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

// Keep AI sweep failures in the same message-only shape.
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
// seeker), so nothing ever tells this lane "the prompts are stale". The
// server fingerprints only the candidate inputs that prompt generation reads
// and stores that fingerprint with the generated set. This avoids timestamp
// races because the prompts themselves live inside targeting.
function promptsAreStale(prompts, inputFingerprint, savedInputFingerprint) {
  const list = Array.isArray(prompts) ? prompts : [];
  if (!list.length) return true;
  if (!inputFingerprint || !savedInputFingerprint) return true;
  return inputFingerprint !== savedInputFingerprint;
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
  setActivity,
}) {
  let stored;
  try {
    stored = await getSearchPromptsFn();
  } catch (_error) {
    return { ok: false, error: AI_SEARCH_PREP_ERROR };
  }

  const prompts = stored?.data?.prompts;

  if (
    !promptsAreStale(prompts, stored?.data?.inputFingerprint, stored?.data?.savedInputFingerprint)
  ) {
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
