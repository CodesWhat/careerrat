import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appOperationGet, appOperationStart } from "../src/core/db/verbs.mjs";

let runtime = {};
let routeModule = {};
try {
  runtime = await import("../src/core/runtime/app-operation-manager.mjs");
} catch {
  // The first TDD run proves the manager does not exist yet.
}
try {
  routeModule = await import("../src/cli/app-operation-route.mjs");
} catch {
  // The first TDD run proves the route does not exist yet.
}

const roots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-app-operation-route-"));
  roots.push(repoRoot);
  openDb({ repoRoot });
  return repoRoot;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseEntityRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw codedError("input must be an object", "BAD_REQUEST");
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "entityId") {
    throw codedError("only entityId is accepted", "BAD_REQUEST");
  }
  const entityId = String(input.entityId || "").trim();
  if (!entityId) throw codedError("entityId is required", "BAD_REQUEST");
  return { entityId };
}

function createManager(options) {
  assert.equal(
    typeof runtime.createAppOperationManager,
    "function",
    "expected createAppOperationManager to be exported"
  );
  return runtime.createAppOperationManager(options);
}

function mountRoutes(options) {
  assert.equal(
    typeof routeModule.mountAppOperationRoutes,
    "function",
    "expected mountAppOperationRoutes to be exported"
  );
  const routes = new Map();
  const manager = routeModule.mountAppOperationRoutes({
    ...options,
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
  });
  return { routes, manager };
}

async function requestDirect(routes, method, path, payload) {
  const requestPath = path.split("?")[0];
  const handler = routes.get(`${method} ${requestPath}`);
  assert.ok(handler, `expected ${method} ${requestPath}`);
  const content = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  const req = Readable.from(content);
  req.method = method;
  req.url = path;
  req.headers = payload === undefined ? {} : { "content-type": "application/json" };
  let status = 200;
  let text = "";
  const res = {
    writeHead(nextStatus) {
      status = nextStatus;
      return this;
    },
    end(chunk = "") {
      text += String(chunk);
    },
  };
  await handler(req, res);
  return { status, body: text ? JSON.parse(text) : {} };
}

after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("the app manager writes the row before server-owned work and freezes its execution plan", async () => {
  const repoRoot = tempRepo();
  const release = deferred();
  let workerOperation;
  let workerRequest;
  let workerPlan;
  const manager = createManager({
    repoRoot,
    ownerId: "manager-owner",
    kinds: {
      "company-proposals": {
        parseRequest: parseEntityRequest,
        resolveExecutionPlan: () => ({
          runtimeId: "codex",
          operation: "research.company",
          requested: { quality: "best", reasoning: "high" },
        }),
        async execute({ operation, request, executionPlan, reportProgress }) {
          workerOperation = appOperationGet({ repoRoot, id: operation.id }).operation;
          workerRequest = request;
          workerPlan = executionPlan;
          await reportProgress({ phase: "resolving", completed: 0, total: 1 });
          await release.promise;
          return { resultRef: { type: "company-proposal-batch", id: "batch-1" } };
        },
      },
    },
  });

  const started = await manager.start({
    kind: "company-proposals",
    input: { entityId: "candidate-1" },
  });
  assert.equal(started.reused, false);
  assert.ok(["queued", "running"].includes(started.operation.status));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workerOperation.id, started.operation.id);
  assert.ok(["queued", "running"].includes(workerOperation.status));
  assert.deepEqual(workerRequest, { entityId: "candidate-1" });
  assert.equal(Object.isFrozen(workerPlan), true);
  assert.equal(Object.isFrozen(workerPlan.requested), true);

  release.resolve();
  const completed = await manager.wait(started.operation.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.resultRef, { type: "company-proposal-batch", id: "batch-1" });
});

test("manager start dedupes canonical requests and linked retries reuse the frozen plan", async () => {
  const repoRoot = tempRepo();
  let calls = 0;
  const plans = [];
  const manager = createManager({
    repoRoot,
    ownerId: "manager-owner",
    kinds: {
      "deep-ingest-analysis": {
        parseRequest(input) {
          return { entityId: String(input.entityId), lane: String(input.lane) };
        },
        resolveExecutionPlan: () => ({ runtimeId: "claude", operation: "structured.extraction" }),
        async execute({ executionPlan }) {
          calls += 1;
          plans.push(executionPlan);
          if (calls === 1) {
            throw codedError(
              "CareerRat couldn't finish this analysis. Try again.",
              "ANALYSIS_FAILED"
            );
          }
          return { resultRef: { type: "deep-ingest-source", id: "source-1" } };
        },
      },
    },
  });

  const first = await manager.start({
    kind: "deep-ingest-analysis",
    input: { lane: "identity", entityId: "source-1" },
  });
  const duplicate = await manager.start({
    kind: "deep-ingest-analysis",
    input: { entityId: "source-1", lane: "identity" },
  });
  assert.equal(duplicate.operation.id, first.operation.id);
  const failed = await manager.wait(first.operation.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "ANALYSIS_FAILED");

  const retry = await manager.retry({ id: first.operation.id });
  const duplicateRetry = await manager.retry({ id: first.operation.id });
  assert.equal(duplicateRetry.operation.id, retry.operation.id);
  const completed = await manager.wait(retry.operation.id);
  assert.equal(completed.status, "completed");
  assert.equal(retry.operation.retryOf, first.operation.id);
  assert.equal(retry.operation.attempt, 2);
  assert.deepEqual(plans[1], plans[0]);
});

test("manager normalizes an allowlisted kind before durable dedupe", async () => {
  const repoRoot = tempRepo();
  let executeCalls = 0;
  const manager = createManager({
    repoRoot,
    ownerId: "normalized-kind-owner",
    kinds: {
      "company-proposals": {
        parseRequest: parseEntityRequest,
        async execute() {
          executeCalls += 1;
          return { resultRef: { type: "company-proposal-batch", id: "batch-normalized" } };
        },
      },
    },
  });

  const first = await manager.start({
    kind: " company-proposals ",
    input: { entityId: "candidate-normalized" },
  });
  const duplicate = await manager.start({
    kind: "company-proposals",
    input: { entityId: "candidate-normalized" },
  });
  await manager.wait(first.operation.id);

  assert.equal(first.operation.kind, "company-proposals");
  assert.equal(duplicate.operation.id, first.operation.id);
  assert.equal(executeCalls, 1);
  await manager.shutdown();
});

test("manager recovery never replays old work and shutdown aborts, awaits, and settles active workers", async () => {
  const repoRoot = tempRepo();
  const seeded = appOperationStart({
    repoRoot,
    kind: "company-proposals",
    requestDigest: "b".repeat(64),
    request: { entityId: "orphan" },
    executionPlan: null,
    ownerId: "old-owner",
  }).operation;
  let executeCalls = 0;
  let aborted = false;
  const manager = createManager({
    repoRoot,
    ownerId: "new-owner",
    kinds: {
      "company-proposals": {
        parseRequest: parseEntityRequest,
        async execute({ signal }) {
          executeCalls += 1;
          await new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true }
            );
          });
          return { resultRef: null };
        },
      },
    },
  });

  const recovered = manager.recoverOrphans();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, seeded.id);
  assert.equal(executeCalls, 0);

  const active = await manager.start({
    kind: "company-proposals",
    input: { entityId: "active" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await manager.shutdown();
  assert.equal(aborted, true);
  const stopped = appOperationGet({ repoRoot, id: active.operation.id }).operation;
  assert.equal(stopped.status, "failed");
  assert.deepEqual(stopped.error, {
    code: "APP_OPERATION_SERVER_STOPPED",
    message: "CareerRat stopped because the app closed. Try this work again.",
    retryable: true,
  });
  await assert.rejects(
    manager.start({ kind: "company-proposals", input: { entityId: "later" } }),
    (error) => error?.code === "APP_OPERATION_MANAGER_STOPPED"
  );
});

test("manager shutdown while a start is resolving cannot dispatch new server work afterward", async () => {
  const repoRoot = tempRepo();
  let executeCalls = 0;
  const routeStarted = deferred();
  const releaseRoute = deferred();
  const manager = createManager({
    repoRoot,
    ownerId: "immediate-stop-owner",
    kinds: {
      "company-proposals": {
        parseRequest: parseEntityRequest,
        async resolveExecutionPlan() {
          routeStarted.resolve();
          return releaseRoute.promise;
        },
        async execute() {
          executeCalls += 1;
          return { resultRef: null };
        },
      },
    },
  });

  const starting = manager.start({
    kind: "company-proposals",
    input: { entityId: "stop-before-dispatch" },
  });
  await routeStarted.promise;
  await manager.shutdown();
  releaseRoute.resolve(null);

  await assert.rejects(starting, (error) => error?.code === "APP_OPERATION_MANAGER_STOPPED");
  assert.equal(executeCalls, 0);
});

test("manager bounds an oversized worker failure and never strands the durable operation", async () => {
  const repoRoot = tempRepo();
  const manager = createManager({
    repoRoot,
    ownerId: "bounded-error-owner",
    kinds: {
      "company-proposals": {
        parseRequest: parseEntityRequest,
        async execute() {
          throw codedError(`Company discovery failed: ${"x".repeat(10_000)}`, "DISCOVERY_FAILED");
        },
      },
    },
  });

  const active = await manager.start({
    kind: "company-proposals",
    input: { entityId: "bounded-failure" },
  });
  const failed = await manager.wait(active.operation.id);

  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "DISCOVERY_FAILED");
  assert.equal(failed.error.retryable, true);
  assert.ok(Buffer.byteLength(JSON.stringify(failed.error), "utf8") <= 4_096);
  await manager.shutdown();
});

test("app-operation routes expose exact follow and retry without accepting executable client work", async () => {
  const repoRoot = tempRepo();
  let attempt = 0;
  const { routes, manager } = mountRoutes({
    repoRoot,
    ownerId: "route-owner",
    kinds: {
      "company-proposals": {
        parseRequest: parseEntityRequest,
        resolveExecutionPlan: () => ({ runtimeId: "codex", operation: "research.company" }),
        async execute() {
          attempt += 1;
          if (attempt === 1)
            throw codedError("Company discovery stopped. Try again.", "DISCOVERY_FAILED");
          return { resultRef: { type: "company-proposal-batch", id: "batch-2" } };
        },
      },
    },
  });

  const executable = await requestDirect(routes, "POST", "/api/app-operations/start", {
    kind: "company-proposals",
    input: { entityId: "candidate-1" },
    executionPlan: { runtimeId: "client-chosen" },
  });
  assert.equal(executable.status, 400);
  assert.match(executable.body.error.message, /only kind and input/i);

  const unsupported = await requestDirect(routes, "POST", "/api/app-operations/start", {
    kind: "run-shell",
    input: { entityId: "candidate-1" },
  });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.code, "APP_OPERATION_KIND_UNSUPPORTED");

  const started = await requestDirect(routes, "POST", "/api/app-operations/start", {
    kind: "company-proposals",
    input: { entityId: "candidate-1" },
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.ok, true);
  assert.equal("request" in started.body.operation, false);
  assert.equal("ownerId" in started.body.operation, false);
  assert.equal("fence" in started.body.operation, false);
  await manager.wait(started.body.operation.id);

  const followed = await requestDirect(
    routes,
    "GET",
    `/api/app-operations/operation?id=${encodeURIComponent(started.body.operation.id)}`
  );
  assert.equal(followed.status, 200);
  assert.equal(followed.body.operation.status, "failed");
  assert.equal(followed.body.operation.error.retryable, true);

  const retried = await requestDirect(routes, "POST", "/api/app-operations/retry", {
    id: started.body.operation.id,
  });
  assert.equal(retried.status, 202);
  assert.equal(retried.body.operation.retryOf, started.body.operation.id);
  const completed = await manager.wait(retried.body.operation.id);
  assert.equal(completed.status, "completed");

  const invalidInput = await requestDirect(routes, "POST", "/api/app-operations/start", {
    kind: "company-proposals",
    input: { entityId: "candidate-2", command: "rm -rf something" },
  });
  assert.equal(invalidInput.status, 400);
  assert.match(invalidInput.body.error.message, /only entityId/i);
  await manager.shutdown();
});

test("app-operation routes cap request bodies before parsing them", async () => {
  const repoRoot = tempRepo();
  const { routes, manager } = mountRoutes({ repoRoot, kinds: {} });
  const oversized = await requestDirect(routes, "POST", "/api/app-operations/start", {
    kind: "company-proposals",
    input: { content: "x".repeat(70_000) },
  });
  assert.equal(oversized.status, 413);
  await manager.shutdown();
});
