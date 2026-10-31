import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dbExists, requireDb } from "../db/connection.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunGet,
  sourcingRunProgress,
} from "../db/verbs/sourcing-runs.mjs";
import { runFirstSearchInBackground } from "../onboarding/first-search-run.mjs";
import { userPath } from "../paths/workspace.mjs";

export function searchHandoffPath(ctx, runId) {
  return userPath(ctx, `workspace/research/search-runs/${encodeURIComponent(runId)}.json`);
}

export function terminalSearchStatus({ repoRoot, env = process.env, id } = {}) {
  const ctx = { repoRoot, env };
  const { run } = sourcingRunGet({ ...ctx, id });
  const path = searchHandoffPath(ctx, run.id);
  return { ok: true, run, handoffPath: existsSync(path) ? path : null };
}

function writePrivateJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function saveHandoff(ctx, run, result) {
  const path = searchHandoffPath(ctx, run.id);
  const resultPath = result ? `${path.slice(0, -5)}.results.json` : null;
  if (resultPath) writePrivateJson(resultPath, result);
  const handoff = {
    schemaVersion: 1,
    runId: run.id,
    purpose: run.purpose,
    status: run.status,
    completedAt: run.completedAt,
    summary: run.summary,
    resultPath,
    jobs: (result?.offers || []).map((offer) => ({
      id: offer.id,
      company: offer.company || offer.co,
      role: offer.role || offer.title,
      fitScore: offer.fitScore,
      fitBucket: offer.fitBucket,
      artifacts: offer.artifacts || {},
    })),
    error: run.error,
    nextAction:
      run.status === "completed"
        ? "Read the canonical sourced jobs and use evaluate-job on the strongest matches before apply-job."
        : "Inspect the error and any saved partial results before retrying this search.",
  };
  writePrivateJson(path, handoff);
  return path;
}

export function cancelTerminalSearch({ repoRoot, env = process.env, id } = {}) {
  const ctx = { repoRoot, env };
  const { run } = sourcingRunGet({ ...ctx, id });
  if (run.status !== "running") return terminalSearchStatus({ ...ctx, id });
  const failed = sourcingRunFail({
    ...ctx,
    id,
    error: {
      code: "SEARCH_CANCELLED",
      message: "Search cancelled by the user. Saved partial results remain available.",
    },
  }).run;
  return { ok: true, run: failed, handoffPath: saveHandoff(ctx, failed) };
}

export async function runTerminalSearchWorker({
  repoRoot,
  env = process.env,
  runId,
  onReady = () => {},
  execute = runFirstSearchInBackground,
  maxMs = 20 * 60 * 1000,
  checkMs = 1000,
  signal,
} = {}) {
  const ctx = { repoRoot, env };
  const initial = sourcingRunGet({ ...ctx, id: runId }).run;
  if (initial.status !== "running") {
    onReady(initial);
    return { ok: true, run: initial, handoffPath: saveHandoff(ctx, initial) };
  }
  let outcome;
  const controller = new AbortController();
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  function abort(error) {
    if (controller.signal.aborted) return;
    controller.abort(error);
    stop();
  }
  function interrupted() {
    const error = new Error(
      "Search worker stopped before completion. Saved partial results remain available."
    );
    error.code = "SEARCH_INTERRUPTED";
    abort(error);
  }
  const timer = setTimeout(() => {
    const error = new Error(
      "Search reached its 20-minute worker limit. Saved partial results remain available."
    );
    error.code = "SEARCH_DEADLINE";
    abort(error);
  }, maxMs);
  const monitor = setInterval(() => {
    try {
      const current = sourcingRunGet({ ...ctx, id: runId }).run;
      if (current.status !== "running") {
        const error = new Error("Search is no longer active.");
        error.code = current.error?.code || "SOURCING_RUN_INACTIVE";
        abort(error);
      }
    } catch (error) {
      abort(error);
    }
  }, checkMs);
  signal?.addEventListener("abort", interrupted, { once: true });
  try {
    sourcingRunProgress({
      ...ctx,
      id: runId,
      progress: { workerPid: process.pid, workerSurface: "terminal" },
    });
    onReady(initial);
    if (signal?.aborted) interrupted();
    if (!controller.signal.aborted) {
      outcome = await Promise.race([
        Promise.resolve().then(() =>
          execute({ ...ctx, runId, signal: controller.signal, settle: false })
        ),
        stopped,
      ]);
    }
  } catch (error) {
    abort(error);
  } finally {
    clearTimeout(timer);
    clearInterval(monitor);
    signal?.removeEventListener("abort", interrupted);
  }
  let run = sourcingRunGet({ ...ctx, id: runId }).run;
  if (run.status === "running" && outcome?.settlement && !controller.signal.aborted) {
    run =
      outcome.settlement.status === "failed"
        ? sourcingRunFail({
            ...ctx,
            id: runId,
            error: outcome.settlement.error,
            summary: outcome.value,
          }).run
        : sourcingRunComplete({ ...ctx, id: runId, summary: outcome.settlement.summary }).run;
  }
  if (run.status === "running") {
    const reason = controller.signal.reason;
    run = sourcingRunFail({
      ...ctx,
      id: runId,
      error: {
        code: reason?.code || "SEARCH_WORKER_INCOMPLETE",
        message: reason?.message || "Search worker returned without settling its run.",
      },
    }).run;
  }
  return { ok: true, run, handoffPath: saveHandoff(ctx, run, outcome?.value) };
}

export async function launchTerminalSearchWorker({ repoRoot, env = process.env, runId } = {}) {
  const ctx = { repoRoot, env };
  const { run } = sourcingRunGet({ ...ctx, id: runId });
  if (!["manual-search", "first-search"].includes(run.purpose))
    throw new Error("Terminal scanner workers require a deterministic sourcing run");
  let child;
  try {
    if (env.CAREERRAT_TUI_SESSION)
      sourcingRunProgress({
        ...ctx,
        id: runId,
        progress: { ownerSession: env.CAREERRAT_TUI_SESSION },
      });
    child = fork(new URL("../../cli/search.mjs", import.meta.url), ["_worker", "--id", runId], {
      cwd: repoRoot,
      env,
      detached: true,
      windowsHide: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    sourcingRunProgress({ ...ctx, id: runId, progress: { workerPid: child.pid } });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Search worker did not acknowledge startup")),
        10_000
      );
      function onExit() {
        finish(new Error("Search worker exited before acknowledging startup"));
      }
      function onError(error) {
        finish(error);
      }
      function onMessage(message) {
        if (message?.error) return finish(new Error(message.error));
        if (message?.ready !== true || message.run?.id !== runId) return;
        finish(null, {
          ok: true,
          detached: true,
          run: message.run,
          workerPid: child.pid,
          handoffPath: searchHandoffPath(ctx, runId),
        });
      }
      function finish(error, result) {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
        child.removeListener("message", onMessage);
        if (child.connected) child.disconnect();
        if (error) {
          child.kill("SIGKILL");
          reject(error);
        } else {
          child.unref();
          resolve(result);
        }
      }
      child.once("exit", onExit);
      child.once("error", onError);
      child.on("message", onMessage);
    });
  } catch (error) {
    if (child) {
      if (child.connected) child.disconnect();
      child.kill("SIGKILL");
    }
    const current = sourcingRunGet({ ...ctx, id: runId }).run;
    if (current.status === "running") {
      const failed = sourcingRunFail({
        ...ctx,
        id: runId,
        error: { code: "SEARCH_WORKER_START_FAILED", message: error.message },
      }).run;
      saveHandoff(ctx, failed);
    }
    throw error;
  }
}

export async function stopTerminalSessionSearches({ repoRoot, env = process.env, sessionId } = {}) {
  const ctx = { repoRoot, env };
  if (!sessionId || !dbExists(ctx)) return { stopped: [] };
  const runs = requireDb(ctx)
    .prepare("SELECT data FROM sourcing_runs WHERE status = 'running'")
    .all()
    .map((row) => JSON.parse(row.data))
    .filter((run) => run.progress?.ownerSession === sessionId);
  for (const run of runs) cancelTerminalSearch({ ...ctx, id: run.id });
  const pending = new Set(
    runs.map((run) => run.progress?.workerPid).filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  );
  const deadline = Date.now() + 3000;
  while (pending.size) {
    for (const pid of pending) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") pending.delete(pid);
        else throw error;
      }
    }
    if (!pending.size) break;
    if (Date.now() >= deadline)
      throw new Error(
        "Search cancellation was saved, but a terminal worker did not exit within its shutdown deadline"
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { stopped: runs.map((run) => run.id) };
}
