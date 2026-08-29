import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";

const verbs = await import("../src/core/db/verbs.mjs");
const roots = [];
const DIGEST = "a".repeat(64);

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-app-operation-"));
  roots.push(repoRoot);
  openDb({ repoRoot });
  return repoRoot;
}

function callVerb(name, options) {
  assert.equal(typeof verbs[name], "function", `expected ${name} to be exported`);
  return verbs[name](options);
}

function startOperation(repoRoot, overrides = {}) {
  return callVerb("appOperationStart", {
    repoRoot,
    kind: "company-proposals",
    requestDigest: DIGEST,
    request: { candidateId: "candidate-1", limit: 4 },
    executionPlan: {
      runtimeId: "codex",
      operation: "research.company",
      requested: { quality: "best", reasoning: "high" },
    },
    ownerId: "owner-1",
    leaseMs: 90_000,
    now: "2026-08-27T12:00:00.000Z",
    ...overrides,
  });
}

after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("app operations start durably with a frozen route, lease, and stable request identity", () => {
  const repoRoot = tempRepo();
  const started = startOperation(repoRoot);

  assert.equal(started.reused, false);
  assert.match(started.operation.id, /^app-operation-/);
  assert.equal(started.operation.kind, "company-proposals");
  assert.equal(started.operation.requestDigest, DIGEST);
  assert.deepEqual(started.operation.request, { candidateId: "candidate-1", limit: 4 });
  assert.equal(started.operation.status, "queued");
  assert.equal(started.operation.ownerId, "owner-1");
  assert.equal(started.operation.fence, 1);
  assert.equal(started.operation.heartbeatAt, "2026-08-27T12:00:00.000Z");
  assert.equal(started.operation.leaseExpiresAt, "2026-08-27T12:01:30.000Z");
  assert.equal(started.operation.attempt, 1);
  assert.equal(started.operation.retryOf, null);
  assert.equal(started.operation.executionPlan.runtimeId, "codex");

  const stored = callVerb("appOperationGet", { repoRoot, id: started.operation.id }).operation;
  assert.deepEqual(stored, started.operation);
});

test("starting the same request is idempotent until an explicit linked retry", () => {
  const repoRoot = tempRepo();
  const first = startOperation(repoRoot);
  const duplicate = startOperation(repoRoot, { now: "2026-08-27T12:00:01.000Z" });

  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.operation.id, first.operation.id);
  assert.equal(duplicate.operation.attempt, 1);
});

test("active app-operation writes require the exact owner and fence", () => {
  const repoRoot = tempRepo();
  const { operation } = startOperation(repoRoot);

  assert.throws(
    () =>
      callVerb("appOperationProgress", {
        repoRoot,
        id: operation.id,
        ownerId: "owner-2",
        fence: operation.fence,
        progress: { phase: "resolving" },
      }),
    (error) => error?.code === "STALE_WRITE"
  );
  assert.throws(
    () =>
      callVerb("appOperationProgress", {
        repoRoot,
        id: operation.id,
        ownerId: "owner-1",
        fence: operation.fence + 1,
        progress: { phase: "resolving" },
      }),
    (error) => error?.code === "STALE_WRITE"
  );

  const running = callVerb("appOperationProgress", {
    repoRoot,
    id: operation.id,
    ownerId: "owner-1",
    fence: operation.fence,
    progress: { phase: "resolving", completed: 1, total: 4 },
    leaseMs: 90_000,
    now: "2026-08-27T12:00:30.000Z",
  }).operation;
  assert.equal(running.status, "running");
  assert.equal(running.startedAt, "2026-08-27T12:00:30.000Z");
  assert.equal(running.leaseExpiresAt, "2026-08-27T12:02:00.000Z");
  assert.deepEqual(running.progress, { phase: "resolving", completed: 1, total: 4 });
});

test("progress, result references, and errors stay bounded", () => {
  const repoRoot = tempRepo();
  const { operation } = startOperation(repoRoot);

  assert.throws(
    () =>
      callVerb("appOperationProgress", {
        repoRoot,
        id: operation.id,
        ownerId: "owner-1",
        fence: operation.fence,
        progress: { message: "x".repeat(9_000) },
      }),
    (error) => error?.code === "APP_OPERATION_PAYLOAD_TOO_LARGE"
  );

  callVerb("appOperationProgress", {
    repoRoot,
    id: operation.id,
    ownerId: "owner-1",
    fence: operation.fence,
    progress: { phase: "saving" },
    now: "2026-08-27T12:00:30.000Z",
  });
  const completed = callVerb("appOperationComplete", {
    repoRoot,
    id: operation.id,
    ownerId: "owner-1",
    fence: operation.fence,
    resultRef: { type: "company-proposal-batch", id: "batch-1", version: 3 },
    now: "2026-08-27T12:01:00.000Z",
  }).operation;
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.resultRef, {
    type: "company-proposal-batch",
    id: "batch-1",
    version: 3,
  });
  assert.equal(completed.progress.phase, "completed");
  assert.equal(completed.completedAt, "2026-08-27T12:01:00.000Z");
});

test("failed app operations retry as a linked new attempt with a higher fence", () => {
  const repoRoot = tempRepo();
  const first = startOperation(repoRoot).operation;
  const failed = callVerb("appOperationFail", {
    repoRoot,
    id: first.id,
    ownerId: "owner-1",
    fence: first.fence,
    error: {
      code: "COMPANY_DISCOVERY_STOPPED",
      message: "CareerRat stopped while finding companies. Try again.",
      retryable: true,
    },
    now: "2026-08-27T12:01:00.000Z",
  }).operation;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.retryable, true);

  const retry = callVerb("appOperationRetryStart", {
    repoRoot,
    id: first.id,
    ownerId: "owner-2",
    executionPlan: first.executionPlan,
    leaseMs: 90_000,
    now: "2026-08-27T12:02:00.000Z",
  });
  assert.equal(retry.reused, false);
  assert.notEqual(retry.operation.id, first.id);
  assert.equal(retry.operation.retryOf, first.id);
  assert.equal(retry.operation.attempt, 2);
  assert.equal(retry.operation.fence, 2);
  assert.equal(retry.operation.ownerId, "owner-2");
  assert.deepEqual(retry.operation.request, first.request);
  assert.deepEqual(retry.operation.executionPlan, first.executionPlan);
});

test("startup reconciliation stops prior-process operations without replaying them", () => {
  const repoRoot = tempRepo();
  const first = startOperation(repoRoot).operation;
  callVerb("appOperationProgress", {
    repoRoot,
    id: first.id,
    ownerId: "owner-1",
    fence: first.fence,
    progress: { phase: "resolving", completed: 2, total: 4 },
  });

  const recovered = callVerb("appOperationRecoverOrphans", {
    repoRoot,
    ownerId: "owner-after-restart",
    now: "2026-08-27T12:05:00.000Z",
  }).recovered;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, first.id);
  assert.equal(recovered[0].status, "failed");
  assert.deepEqual(recovered[0].progress, {
    phase: "failed",
    message: "CareerRat restarted before this work finished.",
  });
  assert.deepEqual(recovered[0].error, {
    code: "APP_OPERATION_SERVER_RESTARTED",
    message: "CareerRat restarted before this work finished. Try it again.",
    retryable: true,
  });
});
