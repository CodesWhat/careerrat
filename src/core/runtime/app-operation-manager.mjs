import { createHash, randomUUID } from "node:crypto";
import {
  appOperationComplete,
  appOperationCompletedReplacementStart,
  appOperationFail,
  appOperationGet,
  appOperationHeartbeat,
  appOperationProgress,
  appOperationRecoverOrphans,
  appOperationRetryStart,
  appOperationStart,
} from "../db/verbs/app-operations.mjs";

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw makeError("operation input must be valid JSON", "BAD_REQUEST");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalize(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw makeError("operation input must be valid JSON", "BAD_REQUEST");
  return serialized;
}

export function appOperationRequestDigest(request) {
  return createHash("sha256").update(canonicalize(request)).digest("hex");
}

function normalizeKinds(kinds) {
  if (kinds instanceof Map) return new Map(kinds);
  if (!kinds || typeof kinds !== "object" || Array.isArray(kinds)) {
    throw makeError("app operation kinds must be a server-owned object or Map", "BAD_REQUEST");
  }
  return new Map(Object.entries(kinds));
}

function validateKind(kind, config) {
  if (!config) {
    throw makeError(`unsupported app operation kind: ${kind}`, "APP_OPERATION_KIND_UNSUPPORTED");
  }
  if (typeof config.parseRequest !== "function" || typeof config.execute !== "function") {
    throw makeError(
      `app operation kind ${kind} is not fully configured`,
      "APP_OPERATION_KIND_INVALID"
    );
  }
  return config;
}

export function createAppOperationManager({
  repoRoot,
  env = process.env,
  kinds = {},
  ownerId = `app-process-${randomUUID()}`,
  heartbeatMs = 30_000,
  leaseMs = 90_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const pathCtx = { repoRoot, env };
  const kindRegistry = normalizeKinds(kinds);
  const workers = new Map();
  let accepting = true;

  function getKind(kind) {
    const normalized = String(kind || "").trim();
    if (!normalized) throw makeError("kind is required", "BAD_REQUEST");
    return { kind: normalized, config: validateKind(normalized, kindRegistry.get(normalized)) };
  }

  async function prepareRequest(kind, input) {
    const { config } = getKind(kind);
    const request = clone(await config.parseRequest(clone(input)));
    if (request == null || typeof request !== "object" || Array.isArray(request)) {
      throw makeError(`${kind} did not produce a valid request object`, "BAD_REQUEST");
    }
    return { config, request, requestDigest: appOperationRequestDigest(request) };
  }

  function activeWriteOptions(operation) {
    return {
      ...pathCtx,
      id: operation.id,
      ownerId,
      fence: operation.fence,
    };
  }

  function startWorker(operation, config) {
    const existing = workers.get(operation.id);
    if (existing) return existing;

    const controller = new AbortController();
    const execution = {
      controller,
      shutdownRequested: false,
      promise: null,
    };
    workers.set(operation.id, execution);

    execution.promise = Promise.resolve().then(async () => {
      let heartbeat = null;
      try {
        appOperationHeartbeat({
          ...activeWriteOptions(operation),
          leaseMs,
        });
        heartbeat = setIntervalImpl(
          () => {
            try {
              appOperationHeartbeat({
                ...activeWriteOptions(operation),
                leaseMs,
              });
            } catch {
              // A terminal write or newer fence remains authoritative.
            }
          },
          Math.max(1, Number(heartbeatMs) || 30_000)
        );
        heartbeat?.unref?.();

        const request = deepFreeze(clone(operation.request));
        const executionPlan = deepFreeze(clone(operation.executionPlan));
        const result = await config.execute({
          operation: deepFreeze(clone(operation)),
          request,
          executionPlan,
          signal: controller.signal,
          reportProgress(progress) {
            return Promise.resolve(
              appOperationProgress({
                ...activeWriteOptions(operation),
                progress: clone(progress),
                leaseMs,
              }).operation
            );
          },
        });

        if (controller.signal.aborted) {
          throw controller.signal.reason || makeError("app operation stopped", "ABORTED");
        }
        const resultRef = result?.resultRef ?? null;
        return appOperationComplete({
          ...activeWriteOptions(operation),
          resultRef,
        }).operation;
      } catch (error) {
        const stopped = execution.shutdownRequested || controller.signal.aborted;
        let normalizedError = null;
        if (!stopped && typeof config.normalizeError === "function") {
          try {
            normalizedError = clone(config.normalizeError(error));
          } catch {
            normalizedError = null;
          }
        }
        const safeError = stopped
          ? {
              code: "APP_OPERATION_SERVER_STOPPED",
              message: "CareerRat stopped because the app closed. Try this work again.",
              retryable: true,
            }
          : {
              code: String(normalizedError?.code || error?.code || "APP_OPERATION_FAILED"),
              message: String(
                normalizedError?.message || "CareerRat couldn't finish this work. Try again."
              ),
              retryable:
                normalizedError?.retryable == null
                  ? error?.retryable !== false
                  : normalizedError.retryable !== false,
            };
        try {
          return appOperationFail({
            ...activeWriteOptions(operation),
            error: safeError,
          }).operation;
        } catch {
          return appOperationGet({ ...pathCtx, id: operation.id }).operation;
        }
      } finally {
        if (heartbeat) clearIntervalImpl(heartbeat);
        if (workers.get(operation.id) === execution) workers.delete(operation.id);
      }
    });

    return execution;
  }

  async function start({ kind, input } = {}) {
    if (!accepting) {
      throw makeError(
        "CareerRat is stopping and cannot start new work.",
        "APP_OPERATION_MANAGER_STOPPED"
      );
    }
    const prepared = await prepareRequest(kind, input);
    const executionPlan = prepared.config.resolveExecutionPlan
      ? clone(await prepared.config.resolveExecutionPlan({ request: clone(prepared.request) }))
      : null;
    if (!accepting) {
      throw makeError(
        "CareerRat is stopping and cannot start new work.",
        "APP_OPERATION_MANAGER_STOPPED"
      );
    }
    const started = appOperationStart({
      ...pathCtx,
      kind,
      requestDigest: prepared.requestDigest,
      request: prepared.request,
      executionPlan,
      ownerId,
      leaseMs,
    });
    let dispatched = started;
    if (
      started.reused &&
      started.operation.status === "completed" &&
      typeof prepared.config.isCompletedResultReusable === "function"
    ) {
      const reusable = await prepared.config.isCompletedResultReusable({
        operation: deepFreeze(clone(started.operation)),
        request: deepFreeze(clone(prepared.request)),
      });
      if (!accepting) {
        throw makeError(
          "CareerRat is stopping and cannot start new work.",
          "APP_OPERATION_MANAGER_STOPPED"
        );
      }
      if (reusable !== true) {
        dispatched = appOperationCompletedReplacementStart({
          ...pathCtx,
          id: started.operation.id,
          ownerId,
          leaseMs,
        });
      }
    }
    if (!dispatched.reused && ["queued", "running"].includes(dispatched.operation.status)) {
      startWorker(dispatched.operation, prepared.config);
    }
    return dispatched;
  }

  async function retry({ id } = {}) {
    if (!accepting) {
      throw makeError(
        "CareerRat is stopping and cannot retry work.",
        "APP_OPERATION_MANAGER_STOPPED"
      );
    }
    const previous = appOperationGet({ ...pathCtx, id }).operation;
    const { config } = getKind(previous.kind);
    const started = appOperationRetryStart({
      ...pathCtx,
      id: previous.id,
      ownerId,
      executionPlan: previous.executionPlan,
      leaseMs,
    });
    if (!started.reused && ["queued", "running"].includes(started.operation.status)) {
      startWorker(started.operation, config);
    }
    return started;
  }

  function get({ id } = {}) {
    return appOperationGet({ ...pathCtx, id }).operation;
  }

  async function wait(id) {
    const active = workers.get(id);
    if (active) await active.promise;
    return get({ id });
  }

  function recoverOrphans() {
    try {
      return appOperationRecoverOrphans({
        ...pathCtx,
        ownerId,
        recoveryError(operation) {
          const configured = kindRegistry.get(operation.kind)?.recoveryError;
          return typeof configured === "function" ? configured(operation) : configured;
        },
      }).recovered;
    } catch (error) {
      if (error?.code === "NO_DATABASE") return [];
      throw error;
    }
  }

  async function shutdown() {
    accepting = false;
    const stopped = makeError(
      "CareerRat stopped because the app closed. Try this work again.",
      "APP_OPERATION_SERVER_STOPPED"
    );
    const active = [...workers.values()];
    for (const execution of active) {
      execution.shutdownRequested = true;
      execution.controller.abort(stopped);
    }
    await Promise.allSettled(active.map((execution) => execution.promise));
  }

  return {
    ownerId,
    start,
    retry,
    get,
    wait,
    recoverOrphans,
    shutdown,
    owns(id) {
      return workers.has(id);
    },
    supportedKinds() {
      return [...kindRegistry.keys()];
    },
  };
}
