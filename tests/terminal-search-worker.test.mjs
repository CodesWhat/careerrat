import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunGet,
  sourcingRunProgress,
  sourcingRunStart,
} from "../src/core/db/verbs/sourcing-runs.mjs";

const api = await import("../src/core/search/terminal-search-worker.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-search-worker-"));
  const ctx = { repoRoot: home, env: { CAREERRAT_HOME: home } };
  openDb(ctx);
  t.after(() => {
    closeAll();
    rmSync(home, { recursive: true, force: true });
  });
  const { run } = sourcingRunStart({ ...ctx, purpose: "manual-search" });
  return { ...ctx, runId: run.id };
}
test("search worker saves a private handoff from its canonical completed run", async (t) => {
  assert.equal(typeof api.runTerminalSearchWorker, "function");
  const ctx = fixture(t);
  let ready = false;
  const result = await api.runTerminalSearchWorker({
    ...ctx,
    onReady: () => {
      ready = true;
    },
    execute: async ({ runId }) => {
      assert.equal(ready, true);
      return sourcingRunComplete({ ...ctx, id: runId, summary: { new: 2, errorCount: 1 } }).run;
    },
  });
  const saved = JSON.parse(readFileSync(result.handoffPath, "utf8"));
  assert.equal(saved.runId, ctx.runId);
  assert.equal(saved.status, "completed");
  assert.equal(saved.summary.new, 2);
  assert.match(saved.nextAction, /evaluate-job/);
  if (process.platform !== "win32") assert.equal(statSync(result.handoffPath).mode & 0o777, 0o600);
});
test("cancellation aborts active work and cannot be replaced with completed results", async (t) => {
  assert.equal(typeof api.runTerminalSearchWorker, "function");
  const ctx = fixture(t);
  let aborted = false;
  const result = await api.runTerminalSearchWorker({
    ...ctx,
    checkMs: 5,
    execute: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true }
        );
        sourcingRunFail({
          ...ctx,
          id: ctx.runId,
          error: { code: "SEARCH_CANCELLED", message: "Cancelled by user." },
        });
      }),
  });
  assert.equal(aborted, true);
  assert.equal(result.run.error.code, "SEARCH_CANCELLED");
  assert.equal(JSON.parse(readFileSync(result.handoffPath, "utf8")).status, "failed");
});
test("a deadline settles the run even when the executor ignores cancellation", async (t) => {
  assert.equal(typeof api.runTerminalSearchWorker, "function");
  const ctx = fixture(t);
  const result = await api.runTerminalSearchWorker({
    ...ctx,
    maxMs: 25,
    execute: () => new Promise(() => {}),
  });
  assert.equal(result.run.error.code, "SEARCH_DEADLINE");
  assert.equal(sourcingRunGet({ ...ctx, id: ctx.runId }).run.status, "failed");
});
test("worker failures remain failures with a recoverable handoff", async (t) => {
  assert.equal(typeof api.runTerminalSearchWorker, "function");
  const ctx = fixture(t);
  const result = await api.runTerminalSearchWorker({
    ...ctx,
    execute: async () => {
      throw new Error("Source unavailable");
    },
  });
  assert.equal(result.run.status, "failed");
  assert.match(result.run.error.message, /Source unavailable/);
  assert.equal(existsSync(result.handoffPath), true);
});
test("a detached worker acknowledges its run and exits after a real empty-source scan", {
  timeout: 12000,
}, async (t) => {
  assert.equal(typeof api.launchTerminalSearchWorker, "function");
  const ctx = fixture(t);
  ctx.env.CAREERRAT_TUI_SESSION = "session-proof";
  const receipt = await api.launchTerminalSearchWorker(ctx);
  assert.equal(
    sourcingRunGet({ ...ctx, id: ctx.runId }).run.progress.ownerSession,
    "session-proof"
  );
  assert.equal(receipt.run.id, ctx.runId);
  assert.equal(receipt.detached, true);
  let result;
  for (let n = 0; n < 100; n++) {
    result = api.terminalSearchStatus({ ...ctx, id: ctx.runId });
    if (result.run.status !== "running" && result.handoffPath) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(result.run.status, "completed");
  assert.ok(result.handoffPath);
  for (let n = 0; n < 100; n++) {
    try {
      process.kill(receipt.workerPid, 0);
    } catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("detached search worker did not exit");
});
test("handoff preserves every returned job reference and an honest partial failure", async (t) => {
  const ctx = fixture(t);
  const offers = Array.from({ length: 75 }, (_, index) => ({
    id: `saved-${index}`,
    co: "Synthetic",
    title: "Engineer",
    artifacts: { jd: `workspace/jobs/saved-${index}.md` },
  }));
  const result = await api.runTerminalSearchWorker({
    ...ctx,
    execute: async () => ({
      settlement: {
        status: "failed",
        error: { code: "SOURCED_ARTIFACT_WRITE_FAILED", message: "One JD could not be saved" },
      },
      value: { offers, failed: 1 },
    }),
  });
  const saved = JSON.parse(readFileSync(result.handoffPath, "utf8"));
  assert.ok(saved.resultPath);
  assert.equal(JSON.parse(readFileSync(saved.resultPath, "utf8")).offers.length, 75);
  assert.equal(saved.jobs.length, 75);
  assert.equal(saved.jobs[74].id, "saved-74");
  assert.equal(saved.jobs[74].artifacts.jd, "workspace/jobs/saved-74.md");
  assert.equal(saved.error.code, "SOURCED_ARTIFACT_WRITE_FAILED");
});

test("failed worker startup settles its run and leaves a failure receipt", async (t) => {
  const ctx = fixture(t);
  ctx.env.NODE_OPTIONS = "--not-a-real-node-option";
  await assert.rejects(api.launchTerminalSearchWorker(ctx), /before acknowledging startup/);
  const result = api.terminalSearchStatus({ ...ctx, id: ctx.runId });
  assert.equal(result.run.error.code, "SEARCH_WORKER_START_FAILED");
  assert.ok(result.handoffPath);
});

test("closing a terminal session cancels only its owned searches", async (t) => {
  assert.equal(typeof api.stopTerminalSessionSearches, "function");
  const ctx = fixture(t);
  sourcingRunProgress({ ...ctx, id: ctx.runId, progress: { ownerSession: "session-a" } });
  const other = sourcingRunStart({ ...ctx, purpose: "first-search" }).run;
  sourcingRunProgress({ ...ctx, id: other.id, progress: { ownerSession: "session-b" } });
  const standalone = sourcingRunStart({ ...ctx, purpose: "ai-web-search" }).run;
  const result = await api.stopTerminalSessionSearches({ ...ctx, sessionId: "session-a" });
  assert.deepEqual(result.stopped, [ctx.runId]);
  assert.equal(sourcingRunGet({ ...ctx, id: ctx.runId }).run.error.code, "SEARCH_CANCELLED");
  assert.equal(sourcingRunGet({ ...ctx, id: other.id }).run.status, "running");
  assert.equal(sourcingRunGet({ ...ctx, id: standalone.id }).run.status, "running");
});
test("terminal shutdown does not create a database in a legacy workspace", async (t) => {
  assert.equal(typeof api.stopTerminalSessionSearches, "function");
  const home = mkdtempSync(join(tmpdir(), "careerrat-session-stop-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(
    await api.stopTerminalSessionSearches({
      repoRoot: home,
      env: { CAREERRAT_HOME: home },
      sessionId: "session-a",
    }),
    { stopped: [] }
  );
  assert.equal(existsSync(join(home, "db")), false);
});

function spawnStubbornWorker(t, { ignoreTerm }) {
  const child = spawn(
    process.execPath,
    ["-e", (ignoreTerm ? "process.on('SIGTERM',()=>{});" : "") + "setInterval(()=>{},1000)"],
    { detached: true, stdio: "ignore" }
  );
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  });
  return child;
}
function ownedBy(ctx, pid) {
  sourcingRunProgress({
    ...ctx,
    id: ctx.runId,
    progress: { ownerSession: "session-a", workerPid: pid },
  });
}
function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

test("shutdown escalates to SIGTERM for a worker that outlives the deadline", {
  skip: process.platform === "win32",
}, async (t) => {
  const ctx = fixture(t);
  const child = spawnStubbornWorker(t, { ignoreTerm: false });
  await new Promise((resolve) => setTimeout(resolve, 150));
  ownedBy(ctx, child.pid);
  await api.stopTerminalSessionSearches({
    ...ctx,
    sessionId: "session-a",
    shutdownMs: 50,
    graceMs: 2000,
  });
  assert.equal(isGone(child.pid), true);
});

test("shutdown escalates to SIGKILL when a worker ignores SIGTERM", {
  skip: process.platform === "win32",
}, async (t) => {
  const ctx = fixture(t);
  const child = spawnStubbornWorker(t, { ignoreTerm: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  ownedBy(ctx, child.pid);
  await api.stopTerminalSessionSearches({
    ...ctx,
    sessionId: "session-a",
    shutdownMs: 50,
    graceMs: 200,
  });
  assert.equal(isGone(child.pid), true);
});

test("EPERM on the liveness check does not abort shutdown of other workers", {
  skip: process.platform === "win32",
}, async (t) => {
  const ctx = fixture(t);
  const child = spawnStubbornWorker(t, { ignoreTerm: false });
  await new Promise((resolve) => setTimeout(resolve, 150));
  ownedBy(ctx, child.pid);
  const other = sourcingRunStart({ ...ctx, purpose: "first-search" }).run;
  const foreign = 4194001;
  sourcingRunProgress({
    ...ctx,
    id: other.id,
    progress: { ownerSession: "session-a", workerPid: foreign },
  });
  const real = process.kill.bind(process);
  t.mock.method(process, "kill", (pid, signal) => {
    if (Math.abs(pid) === foreign) {
      const error = new Error("operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return real(pid, signal);
  });
  await assert.rejects(
    api.stopTerminalSessionSearches({
      ...ctx,
      sessionId: "session-a",
      shutdownMs: 50,
      graceMs: 100,
    }),
    (error) => error.message.includes(String(foreign)) && /no permission/.test(error.message)
  );
  assert.equal(isGone(child.pid), true);
});
