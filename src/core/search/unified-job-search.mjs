import { randomUUID } from "node:crypto";

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

function defaultExecutionId() {
  return `search-${randomUUID()}`;
}

function resolveExecutionId(searchExecutionId, createExecutionId) {
  const value = String(searchExecutionId || createExecutionId()).trim();
  if (!EXECUTION_ID_PATTERN.test(value)) {
    const error = new Error("searchExecutionId must be a short identifier");
    error.code = "BAD_REQUEST";
    throw error;
  }
  return value;
}

export function createSearchExecutionId({
  searchExecutionId,
  createExecutionId = defaultExecutionId,
} = {}) {
  return resolveExecutionId(searchExecutionId, createExecutionId);
}

function errorDetails(value, fallback) {
  if (typeof value === "string" && value.trim()) return { message: value.trim() };
  if (value && typeof value === "object") {
    const message = String(value.message || fallback).trim();
    return {
      ...(value.code ? { code: String(value.code) } : {}),
      message,
    };
  }
  return { message: fallback };
}

function cancelled(signal, value) {
  return signal?.aborted || value?.aborted === true || value?.name === "AbortError";
}

async function runLane({ id, run, searchExecutionId, signal, deterministic }) {
  if (signal?.aborted) return { status: "cancelled" };
  try {
    const result = await run({
      searchExecutionId,
      signal,
      ...(id === "aiWeb" ? { deterministic } : {}),
    });
    if (cancelled(signal, result)) return { status: "cancelled", ...(result ? { result } : {}) };
    if (result?.ok === false) {
      return {
        status: "failed",
        error: errorDetails(result.error, `${id} search failed.`),
        result,
      };
    }
    return { status: "succeeded", result };
  } catch (error) {
    if (cancelled(signal, error)) return { status: "cancelled" };
    return {
      status: "failed",
      error: errorDetails(error, `${id} search failed.`),
    };
  }
}

function unifiedResult({ searchExecutionId, lanes }) {
  const outcomes = Object.values(lanes);
  const succeeded = outcomes.filter((lane) => lane.status === "succeeded").length;
  const failed = outcomes.filter((lane) => lane.status === "failed").length;
  const wasCancelled = outcomes.some((lane) => lane.status === "cancelled");
  return {
    ok: succeeded > 0,
    partial: succeeded > 0 && (failed > 0 || wasCancelled),
    ...(wasCancelled ? { aborted: true } : {}),
    searchExecutionId,
    lanes,
  };
}

export async function runUnifiedJobSearch({
  searchExecutionId,
  createExecutionId = defaultExecutionId,
  runDeterministic,
  runAiWeb,
  aiAvailable = typeof runAiWeb === "function",
  signal,
} = {}) {
  if (typeof runDeterministic !== "function") {
    throw new TypeError("runUnifiedJobSearch requires a deterministic search runner");
  }
  const executionId = createSearchExecutionId({ searchExecutionId, createExecutionId });
  const deterministic = await runLane({
    id: "deterministic",
    run: runDeterministic,
    searchExecutionId: executionId,
    signal,
  });
  const lanes = { deterministic };

  if (deterministic.status === "cancelled" || signal?.aborted) {
    lanes.aiWeb = { status: "skipped", reason: "cancelled" };
    return unifiedResult({ searchExecutionId: executionId, lanes });
  }

  if (aiAvailable !== true || typeof runAiWeb !== "function") {
    lanes.aiWeb = { status: "skipped", reason: "unavailable" };
    return unifiedResult({ searchExecutionId: executionId, lanes });
  }

  lanes.aiWeb = await runLane({
    id: "aiWeb",
    run: runAiWeb,
    searchExecutionId: executionId,
    signal,
    deterministic,
  });
  return unifiedResult({ searchExecutionId: executionId, lanes });
}
