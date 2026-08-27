import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunProgress,
  sourcingRunRecoverRunning,
} from "../db/verbs/sourcing-runs.mjs";

const SERVER_STOPPED_CODE = "SOURCING_RUN_SERVER_STOPPED";

function workerFailure(error) {
  return {
    code: error?.code || "SOURCING_SCAN_FAILED",
    message: error?.message || "The search stopped before it finished.",
  };
}

function isTerminalRun(value, runId) {
  return value?.id === runId && (value.status === "completed" || value.status === "failed");
}

function settleSuccessfulExecution({ repoRoot, env, run, result }) {
  if (isTerminalRun(result, run.id)) return { run: result, value: result };
  const settlement = result?.settlement;
  const value = Object.hasOwn(result || {}, "value") ? result.value : result;
  if (settlement?.status === "failed") {
    return {
      run: sourcingRunFail({ repoRoot, env, id: run.id, error: settlement.error }).run,
      value,
    };
  }
  return {
    run: sourcingRunComplete({
      repoRoot,
      env,
      id: run.id,
      summary: settlement?.summary ?? value ?? {},
    }).run,
    value,
  };
}

export function createSourcingWorkerManager({
  repoRoot,
  env = process.env,
  onTerminal,
  heartbeatMs = 30_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const definitions = new Map();
  const workers = new Map();

  function register({ purpose, execute }) {
    const normalizedPurpose = String(purpose || "").trim();
    if (!normalizedPurpose || typeof execute !== "function") {
      throw new TypeError("sourcing worker registration requires a purpose and execute function");
    }
    if (workers.values().some((worker) => worker.run.purpose === normalizedPurpose)) {
      throw new Error(`cannot replace the active ${normalizedPurpose} sourcing worker`);
    }
    definitions.set(normalizedPurpose, { execute });
  }

  function reportProgress(runId, progress) {
    try {
      sourcingRunProgress({ repoRoot, env, id: runId, progress });
    } catch {
      // Progress and lease refreshes are best effort. The durable terminal
      // transition remains authoritative if another owner wins the race.
    }
  }

  function start({ run, context } = {}) {
    if (!run?.id || run.status !== "running") return null;
    const existing = workers.get(run.id);
    if (existing) return existing;
    const definition = definitions.get(run.purpose);
    if (!definition) {
      throw new Error(`no sourcing worker is registered for ${run.purpose}`);
    }

    const controller = new AbortController();
    const worker = {
      run,
      controller,
      promise: null,
    };
    const heartbeat = setIntervalImpl(
      () => reportProgress(run.id, { workerStatus: "running" }),
      Math.max(1, Number(heartbeatMs) || 30_000)
    );
    heartbeat?.unref?.();

    worker.promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        reportProgress(run.id, { workerStatus: "running" });
        return definition.execute({
          run,
          context,
          signal: controller.signal,
          reportProgress: (progress) => reportProgress(run.id, progress),
        });
      })
      .then((result) => {
        controller.signal.throwIfAborted();
        return settleSuccessfulExecution({ repoRoot, env, run, result });
      })
      .catch((error) => {
        const failure =
          controller.signal.aborted && controller.signal.reason ? controller.signal.reason : error;
        if (failure?.code === SERVER_STOPPED_CODE) {
          return { run: null, value: null, resumable: true };
        }
        try {
          return {
            run: sourcingRunFail({
              repoRoot,
              env,
              id: run.id,
              error: workerFailure(failure),
            }).run,
            value: null,
          };
        } catch {
          throw error;
        }
      })
      .then(async (outcome) => {
        if (outcome.run && typeof onTerminal === "function") {
          try {
            await onTerminal({ run: outcome.run });
          } catch {
            // The sourcing ledger is canonical. Workspace history mirroring
            // must not rewrite or mask a settled search.
          }
        }
        return outcome;
      })
      .finally(() => {
        clearIntervalImpl(heartbeat);
        workers.delete(run.id);
      });
    workers.set(run.id, worker);
    return worker;
  }

  function recover() {
    const recovered = [];
    for (const purpose of definitions.keys()) {
      try {
        const result = sourcingRunRecoverRunning({ repoRoot, env, purpose });
        if (result.run?.status !== "running") continue;
        const worker = start({ run: result.run });
        if (worker) recovered.push(result.run);
      } catch {
        // A workspace without a database has no durable sourcing work.
      }
    }
    return recovered;
  }

  async function shutdown(purpose) {
    const stopped = new Error("CareerRat paused this search because the app closed.");
    stopped.code = SERVER_STOPPED_CODE;
    const selected = [...workers.values()].filter(
      (worker) => !purpose || worker.run.purpose === purpose
    );
    for (const worker of selected) worker.controller.abort(stopped);
    await Promise.allSettled(selected.map((worker) => worker.promise));
  }

  return {
    register,
    start,
    recover,
    shutdown,
    owns(runId) {
      return workers.has(runId);
    },
  };
}
