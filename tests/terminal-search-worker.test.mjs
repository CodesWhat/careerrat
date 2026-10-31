import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunGet,
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
  const receipt = await api.launchTerminalSearchWorker(ctx);
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
