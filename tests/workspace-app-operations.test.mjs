import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { confirmPacketGapAnswer } from "../apps/web/src/chat-first/chat-first-app-controller.js";
import {
  createWorkspaceOperationKinds,
  mountWorkspaceAgentRoutes,
} from "../src/cli/workspace-agent-route.mjs";
import { runWorkspaceAgentTurn } from "../src/core/agent/workspace-agent.mjs";
import { workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appOperationGet, appUpsert, jobThreadMessageAppend } from "../src/core/db/verbs.mjs";
import { createAppOperationManager } from "../src/core/runtime/app-operation-manager.mjs";

const roots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-workspace-operation-"));
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

async function turn() {
  await new Promise((resolve) => setImmediate(resolve));
}

function responseText(text, engine = "codex") {
  return {
    content: [{ type: "text", text }],
    engine,
    model: "test-model",
    usage: null,
    elapsedMs: 1,
  };
}

function executionPlan(runtimeId = "codex", operation = "paul.conversation") {
  return {
    policyVersion: 1,
    operation,
    runtimeId,
    adapterVersion: 1,
    requested: { quality: "best", reasoning: "medium" },
    resolved: {
      quality: "best",
      reasoning: "medium",
      model: "test-model",
      modelSource: "operator-override",
      effort: "medium",
      speedTier: null,
    },
    fallback: null,
  };
}

function requestDirect(routes, method, path, payload) {
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `expected ${method} ${path}`);
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = method;
  req.url = path;
  req.headers = { "content-type": "application/json" };
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
  return Promise.resolve(handler(req, res)).then(() => ({
    status,
    body: text ? JSON.parse(text) : {},
  }));
}

function createWorkspaceHarness({
  repoRoot,
  ownerId,
  callAIImpl,
  executeIntentImpl,
  resolveExecutionPlanImpl,
  startCompanyDiscoveryOperationImpl,
} = {}) {
  const routes = new Map();
  const runTurnImpl = (input) => runWorkspaceAgentTurn({ ...input, callAIImpl });
  const kinds = createWorkspaceOperationKinds({
    repoRoot,
    runTurnImpl,
    executeIntentImpl,
    resolveExecutionPlanImpl,
    startCompanyDiscoveryOperationImpl,
  });
  const manager = createAppOperationManager({
    repoRoot,
    ownerId,
    kinds,
    heartbeatMs: 60_000,
  });
  mountWorkspaceAgentRoutes({
    repoRoot,
    appOperations: manager,
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
  });
  return { routes, manager };
}

test("workspace intents receive the server-owned company discovery starter", async () => {
  const repoRoot = tempRepo();
  const startCompanyDiscoveryOperationImpl = async () => ({
    batchId: "company-batch-1",
    operation: { id: "app-operation-company-1" },
  });
  let receivedStarter;
  const { routes, manager } = createWorkspaceHarness({
    repoRoot,
    ownerId: "company-intent-owner",
    resolveExecutionPlanImpl: () => executionPlan("codex", "research.web"),
    startCompanyDiscoveryOperationImpl,
    async executeIntentImpl(input) {
      receivedStarter = input.startCompanyDiscoveryOperationImpl;
      return { messages: [] };
    },
  });

  const started = await requestDirect(routes, "POST", "/api/workspace/intent", {
    requestId: "workspace-company-discovery",
    intent: {
      type: "company.discover",
      entity: { type: "workspace", id: "workspace-main" },
      input: {},
    },
  });
  const completed = await manager.wait(started.body.operation.id);

  assert.equal(completed.status, "completed", JSON.stringify(completed.error));
  assert.equal(receivedStarter, startCompanyDiscoveryOperationImpl);
  await manager.shutdown();
});

after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("workspace message HTTP returns a durable operation before model work and dedupes a double click", async () => {
  const repoRoot = tempRepo();
  const model = deferred();
  let modelCalls = 0;
  let modelSignal;
  let modelPlan;
  const plan = executionPlan();
  const { routes, manager } = createWorkspaceHarness({
    repoRoot,
    ownerId: "workspace-owner",
    resolveExecutionPlanImpl: () => plan,
    async callAIImpl(input) {
      modelCalls += 1;
      modelSignal = input.signal;
      modelPlan = input.executionPlan;
      return model.promise;
    },
  });

  const payload = {
    text: "What should I focus on today?",
    context: { pathname: "/jobs", jobId: "app-1" },
    requestId: "workspace-request-1",
  };
  const started = await requestDirect(routes, "POST", "/api/workspace/message", payload);
  assert.equal(started.status, 202);
  assert.match(started.body.operation.id, /^app-operation-/);
  assert.equal(started.body.operation.kind, "workspace.message");
  assert.equal(started.body.operation.executionPlan.runtimeId, "codex");

  await turn();
  const during = workspaceThreadRead({ repoRoot });
  assert.equal(during.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(during.messages.filter((message) => message.role === "assistant").length, 0);
  assert.equal(modelCalls, 1);
  assert.ok(modelSignal instanceof AbortSignal);
  assert.deepEqual(modelPlan, plan);

  const duplicate = await requestDirect(routes, "POST", "/api/workspace/message", payload);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.operation.id, started.body.operation.id);
  assert.equal(duplicate.body.reused, true);
  assert.equal(modelCalls, 1);

  model.resolve(responseText("Focus on the two roles already waiting for review."));
  const completed = await manager.wait(started.body.operation.id);
  assert.equal(completed.status, "completed", JSON.stringify(completed.error));
  assert.equal(completed.resultRef.type, "workspace-message");
  const after = workspaceThreadRead({ repoRoot });
  assert.equal(after.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(after.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(after.messages.at(-1).text, "Focus on the two roles already waiting for review.");
  await manager.shutdown();
});

test("repeating one packet answer request persists one user transcript row and one workspace operation", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    row: {
      id: "app-packet-answer",
      company: "Hightouch",
      role: "Solutions Engineer",
      status: "reviewed-hold",
    },
  });
  const action = deferred();
  let actionCalls = 0;
  const { routes, manager } = createWorkspaceHarness({
    repoRoot,
    ownerId: "packet-answer-owner",
    resolveExecutionPlanImpl: () => null,
    async executeIntentImpl() {
      actionCalls += 1;
      await action.promise;
      return { messages: [] };
    },
  });
  const api = {
    appendJobThreadMessage(payload) {
      return Promise.resolve(jobThreadMessageAppend({ repoRoot, ...payload }));
    },
    async runWorkspaceIntent(type, entity, input, { requestId }) {
      const response = await requestDirect(routes, "POST", "/api/workspace/intent", {
        requestId,
        intent: { type, entity, input },
      });
      assert.equal(response.status, 202);
      return response.body;
    },
  };
  const input = {
    api,
    applicationId: "app-packet-answer",
    gap: { questionId: "availability", label: "When can you start?" },
    answer: "Two weeks after accepting an offer",
    requestId: "workspace-packet-answer-repeat",
  };

  try {
    const first = await confirmPacketGapAnswer(input);
    const second = await confirmPacketGapAnswer(input);
    await turn();

    assert.equal(second.operation.id, first.operation.id);
    assert.equal(actionCalls, 1);
    const db = openDb({ repoRoot });
    assert.equal(
      db
        .prepare("SELECT count(*) AS count FROM app_operations WHERE kind = 'workspace.intent'")
        .get().count,
      1
    );
    const transcriptRows = db
      .prepare("SELECT id, data FROM job_thread_messages ORDER BY sequence")
      .all()
      .map((row) => ({ id: row.id, ...JSON.parse(row.data) }))
      .filter(
        (message) =>
          message.role === "user" &&
          message.text === "When can you start?: Two weeks after accepting an offer"
      );
    assert.equal(transcriptRows.length, 1);
    assert.equal(transcriptRows[0].id, "packet-answer-user:workspace-packet-answer-repeat");
  } finally {
    action.resolve();
    await manager.shutdown();
  }
});

test("workspace message shortcuts still settle one fenced durable assistant result", async () => {
  const repoRoot = tempRepo();
  let modelCalls = 0;
  const { routes, manager } = createWorkspaceHarness({
    repoRoot,
    ownerId: "workspace-shortcut-owner",
    resolveExecutionPlanImpl: () => executionPlan(),
    async callAIImpl() {
      modelCalls += 1;
      return responseText("This should not run.");
    },
  });

  const started = await requestDirect(routes, "POST", "/api/workspace/message", {
    text: "How's this search going?",
    requestId: "workspace-search-status",
  });
  const completed = await manager.wait(started.body.operation.id);
  const messages = workspaceThreadRead({ repoRoot }).messages;

  assert.equal(completed.status, "completed", JSON.stringify(completed.error));
  assert.equal(modelCalls, 0);
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(completed.resultRef.id, messages.at(-1).id);
  await manager.shutdown();
});

test("hard restart fences the stale message completion and a linked retry reuses its frozen plan once", async () => {
  const repoRoot = tempRepo();
  const oldModel = deferred();
  const old = createWorkspaceHarness({
    repoRoot,
    ownerId: "workspace-old-owner",
    resolveExecutionPlanImpl: () => executionPlan("codex"),
    callAIImpl: () => oldModel.promise,
  });
  const payload = { text: "Help me pick a next step.", requestId: "workspace-request-restart" };
  const started = await requestDirect(old.routes, "POST", "/api/workspace/message", payload);
  await turn();
  assert.equal(workspaceThreadRead({ repoRoot }).messages.length, 1);

  const retryCalls = [];
  const fresh = createWorkspaceHarness({
    repoRoot,
    ownerId: "workspace-new-owner",
    resolveExecutionPlanImpl: () => executionPlan("claude"),
    async callAIImpl(input) {
      retryCalls.push(input);
      return responseText("Review the strongest saved role first.", "codex");
    },
  });
  const recovered = fresh.manager.recoverOrphans();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, started.body.operation.id);
  assert.equal(recovered[0].error.code, "APP_OPERATION_SERVER_RESTARTED");
  assert.equal(recovered[0].error.retryable, true);

  oldModel.resolve(responseText("This stale reply must never be written."));
  await old.manager.wait(started.body.operation.id);
  assert.equal(workspaceThreadRead({ repoRoot }).messages.length, 1);

  const retried = await fresh.manager.retry({ id: started.body.operation.id });
  assert.equal(retried.operation.retryOf, started.body.operation.id);
  const completed = await fresh.manager.wait(retried.operation.id);
  assert.equal(completed.status, "completed", JSON.stringify(completed.error));
  assert.equal(retryCalls.length, 1);
  assert.equal(retryCalls[0].executionPlan.runtimeId, "codex");
  assert.equal(retryCalls[0].useExecutionPlanRoute, true);
  const messages = workspaceThreadRead({ repoRoot }).messages;
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(messages.at(-1).text, "Review the strongest saved role first.");
  await Promise.all([old.manager.shutdown(), fresh.manager.shutdown()]);
});

test("interrupted workspace intents become outcome-uncertain and never replay", async () => {
  const repoRoot = tempRepo();
  const action = deferred();
  let actionCalls = 0;
  const old = createWorkspaceHarness({
    repoRoot,
    ownerId: "intent-old-owner",
    resolveExecutionPlanImpl: () => executionPlan("codex", "communication.drafting"),
    async executeIntentImpl() {
      actionCalls += 1;
      await action.promise;
      return { messages: [] };
    },
  });
  const started = await requestDirect(old.routes, "POST", "/api/workspace/intent", {
    requestId: "workspace-intent-restart",
    intent: {
      type: "communication.draft",
      entity: { type: "communication", id: "comm-1" },
      input: { instruction: "Keep it short" },
    },
  });
  assert.equal(started.status, 202);
  await turn();
  assert.equal(actionCalls, 1);

  const fresh = createWorkspaceHarness({
    repoRoot,
    ownerId: "intent-new-owner",
    resolveExecutionPlanImpl: () => executionPlan("claude", "communication.drafting"),
    async executeIntentImpl() {
      actionCalls += 1;
      return { messages: [] };
    },
  });
  const recovered = fresh.manager.recoverOrphans();
  assert.equal(recovered[0].error.code, "APP_OPERATION_OUTCOME_UNCERTAIN");
  assert.equal(recovered[0].error.retryable, false);
  await assert.rejects(
    fresh.manager.retry({ id: started.body.operation.id }),
    (error) => error?.code === "APP_OPERATION_NOT_RETRYABLE"
  );
  action.resolve();
  await old.manager.wait(started.body.operation.id);
  assert.equal(actionCalls, 1);
  assert.equal(
    appOperationGet({ repoRoot, id: started.body.operation.id }).operation.status,
    "failed"
  );
  await Promise.all([old.manager.shutdown(), fresh.manager.shutdown()]);
});

test("workspace message and intent operations never persist raw internal failure text", async () => {
  const repoRoot = tempRepo();
  const message = createWorkspaceHarness({
    repoRoot,
    ownerId: "safe-message-owner",
    resolveExecutionPlanImpl: () => executionPlan(),
    async callAIImpl() {
      const error = new Error("provider stderr: secret local path /Users/private/file");
      error.code = "SDK_PROCESS_FAILED";
      throw error;
    },
  });
  const messageStarted = await requestDirect(message.routes, "POST", "/api/workspace/message", {
    requestId: "workspace-safe-message",
    text: "What now?",
  });
  const messageFailed = await message.manager.wait(messageStarted.body.operation.id);
  assert.equal(messageFailed.status, "failed");
  assert.equal(messageFailed.error.code, "SDK_PROCESS_FAILED");
  assert.match(messageFailed.error.message, /couldn't finish that reply/i);
  assert.doesNotMatch(messageFailed.error.message, /private|stderr|Users/);

  const intent = createWorkspaceHarness({
    repoRoot,
    ownerId: "safe-intent-owner",
    resolveExecutionPlanImpl: () => executionPlan("codex", "application.judgment"),
    async executeIntentImpl() {
      const error = new Error("internal ambiguity detail with private match records");
      error.code = "JOB_REFERENCE_AMBIGUOUS";
      error.details = { matches: [{ company: "Private Co", role: "Hidden role" }] };
      throw error;
    },
  });
  const intentStarted = await requestDirect(intent.routes, "POST", "/api/workspace/intent", {
    requestId: "workspace-safe-intent",
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: "workspace-main" },
      input: { jobReference: "the role" },
    },
  });
  const intentFailed = await intent.manager.wait(intentStarted.body.operation.id);
  assert.equal(intentFailed.status, "failed");
  assert.equal(intentFailed.error.code, "JOB_REFERENCE_AMBIGUOUS");
  assert.match(intentFailed.error.message, /more than one matching job/i);
  assert.doesNotMatch(intentFailed.error.message, /internal|private|Hidden/);
  assert.equal("details" in intentFailed.error, false);

  await Promise.all([message.manager.shutdown(), intent.manager.shutdown()]);
});
