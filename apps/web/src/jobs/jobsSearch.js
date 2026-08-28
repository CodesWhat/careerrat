import { getSearchExecution, startSearchRun } from "../lib/api.js";
import { errorState } from "../lib/errorCopy.js";

const SEARCH_LANES = Object.freeze({
  deterministic: { label: "Configured sources" },
  aiWeb: { label: "AI web search" },
});

const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "failed", "cancelled"]);

function unwrapRun(value) {
  if (!value || typeof value !== "object") return null;
  if (Object.hasOwn(value, "run")) {
    return value.run && typeof value.run === "object" ? value.run : null;
  }
  return value;
}

function unwrapExecution(value) {
  if (!value || typeof value !== "object") return null;
  const execution = Object.hasOwn(value, "execution") ? value.execution : value;
  return execution && typeof execution === "object" ? execution : null;
}

function laneError(value, fallback) {
  if (typeof value?.error === "string" && value.error.trim()) return value.error.trim();
  if (typeof value?.error?.message === "string" && value.error.message.trim()) {
    return value.error.message.trim();
  }
  return fallback;
}

function failedPromptIds(result) {
  const ids = [
    result?.failedPromptIds,
    result?.summary?.failedPromptIds,
    result?.error?.failedPromptIds,
  ].find((candidate) => Array.isArray(candidate) && candidate.length > 0);
  return Array.isArray(ids)
    ? [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];
}

function deterministicErrorCount(value) {
  const errors = Array.isArray(value?.summary?.errors) ? value.summary.errors : [];
  const declared = Number(value?.summary?.errorCount || 0);
  return Math.max(errors.length, Number.isFinite(declared) ? declared : 0);
}

export function classifyDurableSearchRun(id, value) {
  const run = unwrapRun(value);
  if (!run || run.status === "not_started") {
    return { status: "idle", partial: false, error: null, failedPromptIds: [], run };
  }
  if (run.status === "running") {
    return { status: "running", partial: false, error: null, failedPromptIds: [], run };
  }
  if (id === "aiWeb" && run.status === "failed" && run?.error?.code === "AI_WEB_SEARCH_ABORTED") {
    return {
      status: "skipped",
      reason: "cancelled",
      partial: false,
      error: null,
      failedPromptIds: [],
      run,
    };
  }
  if (run.status === "failed") {
    return {
      status: "failed",
      partial: false,
      error: laneError(run, `${SEARCH_LANES[id].label} failed.`),
      failedPromptIds: failedPromptIds(run),
      run,
    };
  }
  const errorCount = id === "deterministic" ? deterministicErrorCount(run) : 0;
  const promptIds = id === "aiWeb" ? failedPromptIds(run) : [];
  if (errorCount > 0 || promptIds.length > 0) {
    const fallback =
      id === "deterministic"
        ? `${errorCount} configured source${errorCount === 1 ? "" : "s"} couldn't be searched.`
        : `${promptIds.length} AI search prompt${promptIds.length === 1 ? "" : "s"} failed.`;
    return {
      status: "failed",
      partial: true,
      error: laneError(run, fallback),
      failedPromptIds: promptIds,
      run,
    };
  }
  return { status: "succeeded", partial: false, error: null, failedPromptIds: [], run };
}

function executionLaneError(id, lane) {
  return laneError(lane, `${SEARCH_LANES[id].label} failed.`);
}

function executionLaneState(id, lane = {}) {
  const status = String(lane.status || "queued");
  const base = {
    label: SEARCH_LANES[id].label,
    ...(lane.runId ? { runId: lane.runId } : {}),
    ...(lane.summary ? { summary: lane.summary } : {}),
  };
  if (status === "completed") return { ...base, status: "succeeded" };
  if (status === "failed") {
    return { ...base, status: "failed", error: executionLaneError(id, lane) };
  }
  if (status === "cancelled") return { ...base, status: "skipped", reason: "cancelled" };
  if (status === "skipped") {
    return { ...base, status: "skipped", reason: lane.reason || "unavailable" };
  }
  return { ...base, status: status === "running" ? "running" : "queued" };
}

function aggregateExecutionMetrics(execution) {
  const deterministic = execution?.lanes?.deterministic?.summary || {};
  const aiWeb = execution?.lanes?.aiWeb?.summary || {};
  const numeric = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    new: numeric(deterministic.new) + numeric(aiWeb.new),
    qualified: numeric(deterministic.qualified) + numeric(aiWeb.qualified),
    scanned: numeric(deterministic.scanned) + numeric(aiWeb.scanned),
    sources: numeric(
      deterministic.attemptedSources || deterministic?.deterministicSources?.attempted
    ),
  };
}

function completedExecutionSummary(lanes, metrics) {
  const succeeded = Object.entries(lanes)
    .filter(([, lane]) => lane.status === "succeeded")
    .map(([id]) => id);
  const failed = Object.entries(lanes)
    .filter(([, lane]) => lane.status === "failed")
    .map(([id]) => id);
  if (succeeded.includes("deterministic") && failed.includes("aiWeb")) {
    return "Your saved job sites finished. The AI search needs another try.";
  }
  if (succeeded.includes("aiWeb") && failed.includes("deterministic")) {
    return "The AI search finished. Your saved job sites need another try.";
  }
  if (failed.length && succeeded.length) {
    return "Part of the search finished. The rest needs another try.";
  }
  if (failed.length) return "The search needs another try.";
  return [
    `${metrics.new} new`,
    `${metrics.qualified} qualified`,
    `${metrics.scanned} scanned`,
    `${metrics.sources} ${metrics.sources === 1 ? "source" : "sources"}`,
  ].join(" · ");
}

export function searchExecutionPresentation(value) {
  const execution = unwrapExecution(value);
  if (!execution) return { status: "hydrating", detail: "Loading your saved search" };
  const lanes = {
    deterministic: executionLaneState("deterministic", execution?.lanes?.deterministic),
    aiWeb: executionLaneState("aiWeb", execution?.lanes?.aiWeb),
  };
  const running = Object.entries(lanes)
    .filter(([, lane]) => lane.status === "running")
    .map(([id]) => id);
  const searchExecutionId = String(execution.id || "").trim();
  if (!TERMINAL_EXECUTION_STATUSES.has(execution.status)) {
    const detail =
      running.includes("deterministic") && running.includes("aiWeb")
        ? "Searching your saved job sites and the web"
        : running.includes("deterministic")
          ? "Searching your saved job sites"
          : running.includes("aiWeb")
            ? "Searching the web"
            : "Preparing your job search";
    return {
      status: "running",
      detail,
      ...(searchExecutionId ? { searchExecutionId } : {}),
      lanes,
    };
  }
  if (execution.status === "cancelled") {
    return {
      status: "idle",
      reason: "cancelled",
      summary: "Search cancelled.",
      ...(searchExecutionId ? { searchExecutionId } : {}),
      lanes,
    };
  }
  const metrics = aggregateExecutionMetrics(execution);
  const anySucceeded = Object.values(lanes).some((lane) => lane.status === "succeeded");
  return {
    status:
      execution.status === "completed" || (execution.partial === true && anySucceeded)
        ? "complete"
        : "error",
    partial: execution.partial === true,
    metrics,
    summary: completedExecutionSummary(lanes, metrics),
    ...(searchExecutionId ? { searchExecutionId } : {}),
    ...(execution.completedAt ? { completedAt: execution.completedAt } : {}),
    lanes,
  };
}

function waitForPoll(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

function executionResult(execution) {
  if (execution?.status === "cancelled") {
    return { ok: false, aborted: true, searchExecutionId: execution.id, execution };
  }
  const ok = execution?.status === "completed";
  return {
    ok,
    partial: execution?.partial === true,
    searchExecutionId: execution?.id,
    execution,
    ...(!ok ? { error: "Search couldn't finish. Try again." } : {}),
  };
}

export async function followSearchExecution({
  getSearchExecution: getSearchExecutionFn = getSearchExecution,
  searchExecutionId,
  initialExecution,
  refetch,
  setSearchState,
  signal,
  pollIntervalMs = 2500,
  pollTimeoutMs = 10 * 60 * 1000,
} = {}) {
  const id = String(searchExecutionId || initialExecution?.id || "").trim();
  if (!id) return { ok: false, error: "Search status is missing its execution id." };
  let execution = unwrapExecution(initialExecution);
  if (execution?.id !== id) execution = null;
  let deterministicStatus = execution?.lanes?.deterministic?.status || null;
  if (execution) setSearchState?.(searchExecutionPresentation(execution));
  if (execution && TERMINAL_EXECUTION_STATUSES.has(execution.status)) {
    await refetch?.();
    return executionResult(execution);
  }

  const deadline = Date.now() + pollTimeoutMs;
  let misses = 0;
  for (;;) {
    await waitForPoll(pollIntervalMs, signal);
    if (signal?.aborted) return { ok: false, aborted: true, searchExecutionId: id };
    if (Date.now() >= deadline) {
      return { ok: true, running: true, timedOut: true, searchExecutionId: id, execution };
    }
    let next = null;
    try {
      next = unwrapExecution(
        await getSearchExecutionFn({
          searchExecutionId: id,
          ...(signal ? { signal } : {}),
        })
      );
    } catch (error) {
      misses += 1;
      if (misses < 3) continue;
      const message = errorState(
        error,
        "Couldn't read this search's status. Reload to see its latest results."
      ).message;
      return { ok: false, error: message, searchExecutionId: id };
    }
    if (!next || next.id !== id) {
      misses += 1;
      if (misses < 3) continue;
      return { ok: false, error: "Couldn't read this search's status.", searchExecutionId: id };
    }
    misses = 0;
    const nextDeterministicStatus = next?.lanes?.deterministic?.status || null;
    const deterministicJustCompleted =
      deterministicStatus !== "completed" && nextDeterministicStatus === "completed";
    if (deterministicJustCompleted) {
      await refetch?.();
    }
    deterministicStatus = nextDeterministicStatus;
    execution = next;
    setSearchState?.(searchExecutionPresentation(execution));
    if (!TERMINAL_EXECUTION_STATUSES.has(execution.status)) continue;
    if (!deterministicJustCompleted) await refetch?.();
    return executionResult(execution);
  }
}

export async function runUnifiedJobSearch({
  startSearchRun: startSearchRunFn = startSearchRun,
  getSearchExecution: getSearchExecutionFn = getSearchExecution,
  searchExecutionId,
  refetch,
  setSearchState,
  signal,
  pollIntervalMs,
  pollTimeoutMs,
} = {}) {
  try {
    const started = await startSearchRunFn({
      purpose: "manual-search",
      ...(searchExecutionId ? { searchExecutionId } : {}),
    });
    const initialExecution = unwrapExecution(started);
    const adoptedId = String(
      started?.searchExecutionId || initialExecution?.id || searchExecutionId || ""
    ).trim();
    return followSearchExecution({
      getSearchExecution: getSearchExecutionFn,
      searchExecutionId: adoptedId,
      initialExecution,
      refetch,
      setSearchState,
      signal,
      ...(pollIntervalMs == null ? {} : { pollIntervalMs }),
      ...(pollTimeoutMs == null ? {} : { pollTimeoutMs }),
    });
  } catch (error) {
    const message = errorState(
      error,
      "Search could not start. Review Search setup, then try again."
    ).message;
    setSearchState?.({ status: "error", summary: message });
    return { ok: false, error: message };
  }
}
