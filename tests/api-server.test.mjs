// tests/api-server.test.mjs
// node:test suite for the tracker-dev API server surface (Productization Phase 0,
// P0-2 — tracker-dev.mjs promoted from a dashboard preview to the embedded app
// server). Exercises createDevServer() directly against an isolated temp repoRoot
// so it never touches the real workspace, boots on an ephemeral port (0), and
// covers: GET /api/tracker (StorageAdapter-backed, 404/500 error shapes),
// GET /api/activity, GET /api/health, and the named tracker-update/activity-update
// SSE events on /__livereload.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { openDb } from "../src/core/db/connection.mjs";
import { candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";
import {
  appOperationGet,
  appOperationStart,
  intakeCapture,
  intakeOne,
  intakeUpdate,
  sourceConfigGet,
  sourcingRunLatest,
  sourcingRunStart,
} from "../src/core/db/verbs.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";
import { defaultAdapter } from "../src/core/storage/storage-adapter.mjs";
import { resolveTrackerBindHost } from "../src/core/tracker/request-security.mjs";

const REAL_ROOT = new URL("..", import.meta.url);

// A minimal valid tracker.json — shape trimmed from templates/tracker.json, just
// enough for adapter.readTracker()/JSON.parse to round-trip.
const MINIMAL_TRACKER = {
  applications: [{ id: "demo-app-1", company: "Aperture Science", role: "Test Engineer" }],
  sourced: [],
  sources: [],
  communications: [],
};

test("tracker-dev refuses non-loopback bind hosts instead of exposing local APIs to a LAN", () => {
  assert.equal(resolveTrackerBindHost({}), "127.0.0.1");
  assert.equal(resolveTrackerBindHost({ CAREERRAT_TRACKER_HOST: "localhost" }), "localhost");
  assert.equal(resolveTrackerBindHost({ CAREERRAT_TRACKER_HOST: "::1" }), "::1");
  assert.throws(
    () => resolveTrackerBindHost({ CAREERRAT_TRACKER_HOST: "0.0.0.0" }),
    /loopback-only/
  );
  assert.throws(
    () => resolveTrackerBindHost({ CAREERRAT_TRACKER_HOST: "192.168.1.20" }),
    /loopback-only/
  );
});

test("tracker-dev exposes the durable AI-search shutdown lifecycle", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = createDevServer({ repoRoot });
  try {
    assert.equal(typeof dev.shutdownAiWebSearch, "function");
    assert.equal(typeof dev.shutdownResumeExtractions, "function");
    assert.equal(typeof dev.shutdownAppOperations, "function");
    await dev.shutdownAiWebSearch();
    await dev.shutdownResumeExtractions();
    await dev.shutdownAppOperations();
  } finally {
    dev.chatRuntime.shutdown();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("shared operation recovery stays a no-op before a workspace database exists", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = createDevServer({
    repoRoot,
    workspaceAgentRuntime: {
      recoverOrphanedSourcingRuns() {},
      async recoverAdjacentRoleCoaching() {},
      async runTurn() {
        throw new Error("not used");
      },
      async executeIntent() {
        throw new Error("not used");
      },
      async captureIntake() {
        throw new Error("not used");
      },
      async shutdownSourcingWorkers() {},
    },
  });
  try {
    await dev.listen({ port: 0, host: "127.0.0.1" });
    assert.equal(dev.server.listening, true);
  } finally {
    await dev.shutdownAppOperations();
    dev.chatRuntime.shutdown();
    if (dev.server.listening) await new Promise((resolve) => dev.server.close(resolve));
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the default app server reaches first-run setup before a database exists", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = createDevServer({ repoRoot });
  try {
    await dev.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(response.status, 200);
  } finally {
    await dev.shutdownAppOperations();
    await dev.shutdownSourcingWorkers?.();
    dev.chatRuntime.shutdown();
    if (dev.server.listening) await new Promise((resolve) => dev.server.close(resolve));
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the listening workspace owner reconciles interrupted shared app operations without replay", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  openDb({ repoRoot });
  const orphan = appOperationStart({
    repoRoot,
    kind: "company-proposals",
    requestDigest: "c".repeat(64),
    request: { candidateId: "candidate-1" },
    executionPlan: { runtimeId: "codex", operation: "research.company" },
    ownerId: "dead-process",
  }).operation;
  let executeCalls = 0;
  const dev = createDevServer({
    repoRoot,
    appOperationKinds: {
      "company-proposals": {
        parseRequest: (input) => input,
        async execute() {
          executeCalls += 1;
          return { resultRef: null };
        },
      },
    },
  });

  try {
    await dev.listen({ port: 0, host: "127.0.0.1" });
    const recovered = appOperationGet({ repoRoot, id: orphan.id }).operation;
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error.code, "APP_OPERATION_SERVER_RESTARTED");
    assert.equal(recovered.error.retryable, true);
    assert.equal(executeCalls, 0);
  } finally {
    await dev.shutdownAppOperations();
    dev.chatRuntime.shutdown();
    if (dev.server.listening) await new Promise((resolve) => dev.server.close(resolve));
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the listening workspace owner recovers durable career-coach handoffs", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  openDb({ repoRoot });
  const calls = [];
  const workspaceAgentRuntime = {
    recoverOrphanedSourcingRuns() {
      calls.push("searches");
    },
    async recoverAdjacentRoleCoaching() {
      calls.push("career-coach");
    },
    async runTurn() {
      throw new Error("not used");
    },
    async executeIntent() {
      throw new Error("not used");
    },
    async captureIntake() {
      throw new Error("not used");
    },
  };
  const dev = createDevServer({ repoRoot, workspaceAgentRuntime });
  try {
    await dev.listen({ port: 0, host: "127.0.0.1" });
    assert.deepEqual(calls, ["searches", "career-coach"]);
  } finally {
    dev.chatRuntime.shutdown();
    if (dev.server.listening) await new Promise((resolve) => dev.server.close(resolve));
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("tracker-dev preserves LinkedIn optimization's frozen plan across provider change and retry", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  openDb({ repoRoot });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "automation",
    patch: {
      setup_mode: "advanced",
      capabilities: {
        profile_optimize: { enabled: true, platforms: { linkedin: true } },
      },
      consent: { linkedin: true },
    },
  });
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  const plans = [];
  const dev = createDevServer({
    repoRoot,
    env,
    optimizeLinkedinInAppImpl: async ({ executionPlan }) => {
      plans.push(executionPlan);
      if (plans.length === 1) {
        delete env.ANTHROPIC_API_KEY;
        env.CAREERRAT_AI_PROXY_URL = "http://127.0.0.1:7788";
        const error = new Error("temporary provider failure");
        error.code = "AI_PROVIDER_FAILED";
        throw error;
      }
      return {
        kind: "browser_workflow_result",
        skill: "optimize-linkedin",
        state: "completed",
        summary: "LinkedIn suggestions ready.",
      };
    },
  });

  try {
    await dev.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${baseUrl(dev)}/api/workspace/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "linkedin-plan-retry",
        intent: {
          type: "linkedin.optimize-request",
          entity: { type: "workspace", id: "workspace-main" },
          input: {},
        },
      }),
    });
    const started = await response.json();
    assert.equal(response.status, 202, JSON.stringify(started));
    let failed = started.operation;
    for (let attempt = 0; attempt < 100 && failed.status !== "failed"; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      failed = appOperationGet({ repoRoot, id: failed.id }).operation;
    }
    assert.equal(failed.status, "failed", JSON.stringify(failed.error));

    const retried = await dev.appOperations.retry({ id: failed.id });
    const completed = await dev.appOperations.wait(retried.operation.id);
    assert.equal(completed.status, "completed", JSON.stringify(completed.error));
    assert.equal(plans.length, 2);
    assert.equal(plans[0].runtimeId, "anthropic-api");
    assert.deepEqual(plans[1], plans[0]);
  } finally {
    await dev.shutdownAppOperations();
    await dev.shutdownSourcingWorkers?.();
    dev.chatRuntime.shutdown();
    if (dev.server.listening) await new Promise((resolve) => dev.server.close(resolve));
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("only the listening workspace owner starts durable background recovery", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const recoveries = [];
  const isolatedRuntime = (owner) => ({
    recoverOrphanedSourcingRuns() {
      recoveries.push({
        owner,
        runId: sourcingRunLatest({ repoRoot, purpose: "manual-search" }).run?.id || null,
      });
    },
    async recoverAdjacentRoleCoaching() {},
    async runTurn() {
      throw new Error("not used");
    },
    async executeIntent() {
      throw new Error("not used");
    },
    async captureIntake() {
      throw new Error("not used");
    },
    async shutdownSourcingWorkers() {},
  });
  const first = createDevServer({ repoRoot, workspaceAgentRuntime: isolatedRuntime("first") });
  const second = createDevServer({ repoRoot, workspaceAgentRuntime: isolatedRuntime("second") });

  assert.equal(typeof first.listen, "function");
  await first.listen({ port: 0, host: "127.0.0.1" });
  assert.deepEqual(recoveries, [{ owner: "first", runId: null }]);

  const liveSearch = sourcingRunStart({
    repoRoot,
    purpose: "manual-search",
    id: "manual-search-owned-by-first",
  }).run;
  const { id: liveIntakeId } = intakeCapture({
    repoRoot,
    rawInput: "A live intake operation",
    inputKind: "text",
  });
  intakeUpdate({
    repoRoot,
    id: liveIntakeId,
    patch: {
      status: "running",
      operation: {
        id: `${liveIntakeId}:owned-by-first`,
        status: "running",
        skill: "evaluate-job",
        startedAt: "2026-08-27T12:00:00.000Z",
        heartbeatAt: "2026-08-27T12:00:30.000Z",
      },
    },
  });

  try {
    await assert.rejects(
      second.listen({ port: 0, host: "127.0.0.1" }),
      (error) => error?.code === "WORKSPACE_RUNTIME_IN_USE"
    );
    assert.equal(sourcingRunLatest({ repoRoot, purpose: "manual-search" }).run.status, "running");
    assert.equal(intakeOne({ repoRoot, id: liveIntakeId }).status, "running");
    assert.deepEqual(recoveries, [{ owner: "first", runId: null }]);

    await new Promise((resolve) => first.server.close(resolve));
    await second.listen({ port: 0, host: "127.0.0.1" });

    const recoveredSearch = sourcingRunLatest({ repoRoot, purpose: "manual-search" }).run;
    assert.equal(recoveredSearch.id, liveSearch.id);
    assert.equal(recoveredSearch.status, "running");
    assert.deepEqual(recoveries, [
      { owner: "first", runId: null },
      { owner: "second", runId: liveSearch.id },
    ]);
    const recoveredIntake = intakeOne({ repoRoot, id: liveIntakeId });
    assert.equal(recoveredIntake.status, "error");
    assert.equal(recoveredIntake.operation.error.code, "INTAKE_SERVER_RESTARTED");
  } finally {
    await first.shutdownSourcingWorkers?.();
    await second.shutdownSourcingWorkers?.();
    first.chatRuntime.shutdown();
    second.chatRuntime.shutdown();
    if (first.server.listening) await new Promise((resolve) => first.server.close(resolve));
    if (second.server.listening) await new Promise((resolve) => second.server.close(resolve));
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// A fresh repoRoot with its resolved (non-legacy, .careerrat-backed) workspace dir
// pre-created — same convention as storage-adapter.test.mjs's tempRepo().
function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-apiserver-"));
  mkdirSync(resolveUserPaths({ repoRoot }).workspaceDir, { recursive: true });
  return repoRoot;
}

function writeTracker(repoRoot, data = MINIMAL_TRACKER) {
  const trackerPath = join(resolveUserPaths({ repoRoot }).workspaceDir, "tracker.json");
  writeFileSync(trackerPath, JSON.stringify(data), "utf8");
}

// Boot a dev server on an ephemeral port and resolve once listening.
function bootServer(repoRoot) {
  const dev = createDevServer({ repoRoot });
  dev.startWatching();
  return new Promise((resolve) => {
    dev.server.listen(0, () => resolve(dev));
  });
}

function baseUrl(dev) {
  return `http://localhost:${dev.server.address().port}`;
}

async function runWorkspaceIntentOverHttp(dev, repoRoot, intent, requestId) {
  const response = await fetch(`${baseUrl(dev)}/api/workspace/intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, intent }),
  });
  const started = await response.json();
  assert.ok([200, 202].includes(response.status), JSON.stringify(started));
  let operation = started.operation;
  for (
    let attempt = 0;
    attempt < 100 && ["queued", "running"].includes(operation.status);
    attempt += 1
  ) {
    await new Promise((resolve) => setImmediate(resolve));
    operation = appOperationGet({ repoRoot, id: operation.id }).operation;
  }
  assert.equal(operation.status, "completed", JSON.stringify(operation.error));
  const threadResponse = await fetch(`${baseUrl(dev)}/api/workspace/thread`);
  assert.equal(threadResponse.status, 200);
  return (await threadResponse.json()).data;
}

function lastMatchingArtifact(messages, predicate) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const artifacts = Array.isArray(messages[messageIndex].artifacts)
      ? messages[messageIndex].artifacts
      : [];
    for (let artifactIndex = artifacts.length - 1; artifactIndex >= 0; artifactIndex -= 1) {
      if (predicate(artifacts[artifactIndex])) return artifacts[artifactIndex];
    }
  }
  return null;
}

function rawRequest(dev, { path, method = "GET", headers = {}, body = "" }) {
  const { port } = dev.server.address();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function teardown(dev, repoRoot) {
  dev.closeClients();
  dev.stopWatching();
  dev.server.close();
  rmSync(repoRoot, { recursive: true, force: true });
}

// GET /api/tracker and GET /api/activity (the raw StorageAdapter tracker/
// activity feeds) were intentionally removed from tracker-dev.mjs by a85a9e96
// ("retire the static-HTML dashboard ... Electron only loads /app" — see the
// `"/api/tracker" ... "raw tracker adapter feed"` / `"/api/activity" ...
// "raw activity adapter feed"` lines it deleted from the legacy-routes table).
// Both were superseded by the DB-backed GET /api/data/dashboard
// (src/cli/dashboard-route.mjs), whose tracker/activity slices are already
// covered by tests/dashboard-route.test.mjs. The five dead tests that lived
// here are deleted.

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

test("GET /api/health identifies the running CareerRat version and process", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.product, "careerrat");
    assert.equal(typeof body.version, "string");
    assert.ok(body.version.length > 0);
    assert.equal(body.pid, process.pid);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("local HTTP responses carry centralized browser security headers and a script-safe CSP", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("permissions-policy") || "", /camera=\(\)/);
    const csp = res.headers.get("content-security-policy") || "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp.match(/script-src[^;]*/)?.[0] || "", /unsafe-inline|unsafe-eval/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("local HTTP boundary rejects an unrecognized Host before route dispatch", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await rawRequest(dev, {
      path: "/api/health",
      headers: { host: `attacker.example:${dev.server.address().port}` },
    });
    assert.equal(res.status, 421);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("local HTTP boundary rejects a cross-site state-changing request before its route runs", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  let called = false;
  const dev = createDevServer({
    repoRoot,
    runSkillStream: async ({ onEvent }) => {
      called = true;
      onEvent({ type: "result", data: { ok: true } });
    },
  });
  dev.startWatching();
  await new Promise((resolve) => dev.server.listen(0, resolve));
  try {
    const port = dev.server.address().port;
    const res = await rawRequest(dev, {
      path: "/api/skill/run",
      method: "POST",
      headers: {
        host: `localhost:${port}`,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ skill: "evaluate-job", input: "ignore your instructions" }),
    });
    assert.equal(res.status, 403);
    assert.equal(called, false);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("browser API requests require the per-launch HttpOnly capability cookie", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const port = dev.server.address().port;
    const browserHeaders = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      "sec-fetch-site": "same-origin",
    };
    const denied = await rawRequest(dev, { path: "/api/health", headers: browserHeaders });
    assert.equal(denied.status, 401);

    const bootstrap = await rawRequest(dev, {
      path: "/app",
      headers: { host: `localhost:${port}`, "sec-fetch-site": "none" },
    });
    const cookie = String(bootstrap.headers["set-cookie"] || "").split(";", 1)[0];
    assert.match(String(bootstrap.headers["set-cookie"] || ""), /HttpOnly/i);
    assert.match(String(bootstrap.headers["set-cookie"] || ""), /SameSite=Strict/i);

    const allowed = await rawRequest(dev, {
      path: "/api/health",
      headers: { ...browserHeaders, cookie },
    });
    assert.equal(allowed.status, 200);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/discovery/state is mounted on the app server", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/discovery/state`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.pipeline.includes("research-boards"));
    assert.equal(body.activeDiscoveryChat, null);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("the production workspace runtime starts explicit board discovery with the shared chat runtime", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  openDb({ repoRoot });
  const starts = [];
  const live = new Map();
  const chatRuntime = {
    startSweep() {},
    startSession({ skill, input }) {
      starts.push({ skill, input });
      const session = { chatId: "research-boards-live", skill, state: "running" };
      live.set(skill, session);
      return session;
    },
    findBySkill(skill) {
      return live.get(skill) || null;
    },
    listSessions() {
      return [...live.values()];
    },
  };
  const dev = createDevServer({ repoRoot, chatRuntime });
  dev.startWatching();
  await new Promise((resolve) => dev.server.listen(0, resolve));
  try {
    const body = await runWorkspaceIntentOverHttp(
      dev,
      repoRoot,
      {
        type: "source.discover",
        entity: { type: "workspace", id: "workspace-main" },
        input: { request: "find more job boards" },
      },
      "api-server-source-discover"
    );
    assert.equal(starts.length, 1);
    assert.equal(starts[0].skill, "research-boards");
    assert.match(starts[0].input, /Outbound-safe candidate context|Run research-boards/);
    assert.equal(body.messages.at(-1).artifacts[0].chatId, "research-boards-live");
  } finally {
    teardown(dev, repoRoot);
  }
});

test("the production workspace runtime imports an explicitly confirmed board URL", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  openDb({ repoRoot });
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileSync(
    join(repoRoot, "config/search-sources.schema.json"),
    readFileSync(new URL("config/search-sources.schema.json", REAL_ROOT))
  );
  const dev = createDevServer({ repoRoot });
  dev.startWatching();
  await new Promise((resolve) => dev.server.listen(0, resolve));
  // Keep this source-operation test isolated from the automatic expanded
  // search owned by public sources. Login-backed sources stay pending until
  // the separate point-of-use decision.
  const sourceUrl = "https://www.linkedin.com/jobs/search/?keywords=platform";
  let importedLabel;
  try {
    let body = await runWorkspaceIntentOverHttp(
      dev,
      repoRoot,
      {
        type: "source.add",
        entity: { type: "workspace", id: "workspace-main" },
        input: { url: sourceUrl },
      },
      "api-server-source-add"
    );
    const added = lastMatchingArtifact(
      body.messages,
      (artifact) => artifact.kind === "search_source" && artifact.target === sourceUrl
    );
    assert.ok(added);
    assert.equal(added.added, true);
    importedLabel = added.label;
    body = await runWorkspaceIntentOverHttp(
      dev,
      repoRoot,
      {
        type: "source.add",
        entity: { type: "workspace", id: "workspace-main" },
        input: { url: sourceUrl },
      },
      "api-server-source-add-duplicate"
    );
    const duplicate = lastMatchingArtifact(
      body.messages,
      (artifact) =>
        artifact.kind === "search_source" && artifact.target === sourceUrl && !artifact.added
    );
    assert.ok(duplicate);
    assert.equal(duplicate.added, false);
    body = await runWorkspaceIntentOverHttp(
      dev,
      repoRoot,
      {
        type: "source.set-enabled",
        entity: { type: "workspace", id: "workspace-main" },
        input: { selector: importedLabel, enabled: false },
      },
      "api-server-source-toggle"
    );
    const disabled = lastMatchingArtifact(
      body.messages,
      (artifact) =>
        artifact.kind === "search_source" && artifact.label === importedLabel && !artifact.enabled
    );
    assert.ok(disabled);
    assert.equal(disabled.enabled, false);
    await runWorkspaceIntentOverHttp(
      dev,
      repoRoot,
      {
        type: "source.query-add",
        entity: { type: "workspace", id: "workspace-main" },
        input: { query: "staff AI engineer" },
      },
      "api-server-source-query-add"
    );
    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data.searches;
    const imported = stored.filter((source) => source.url === sourceUrl);
    const queried = stored.filter((source) => source.query === "staff AI engineer");
    assert.equal(imported.length, 1);
    assert.equal(imported[0].enabled, false);
    assert.equal(queried.length, 1);
  } finally {
    await dev.shutdownSourcingWorkers?.();
    teardown(dev, repoRoot);
  }
});

test("the production intake mount preserves a requested apply action", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const seen = [];
  const workspaceAgentRuntime = {
    async captureIntake(input) {
      seen.push(input);
      return {
        intake: {
          id: "intake-apply-1",
          status: "proposed",
          kind: "jd-text",
          requestedAction: input.requestedAction,
        },
      };
    },
    async executeIntent() {
      throw new Error("not used");
    },
    async runTurn() {
      throw new Error("not used");
    },
  };
  const dev = createDevServer({ repoRoot, workspaceAgentRuntime });
  dev.startWatching();
  await new Promise((resolve) => dev.server.listen(0, resolve));
  try {
    const res = await fetch(`${baseUrl(dev)}/api/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Acme\nSRE\nKeep production reliable.",
        requestedAction: "prepare",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).item.requestedAction, "prepare");
    assert.deepEqual(seen, [
      {
        text: "Acme\nSRE\nKeep production reliable.",
        inputKind: undefined,
        requestedAction: "prepare",
      },
    ]);
  } finally {
    teardown(dev, repoRoot);
  }
});

// ---------------------------------------------------------------------------
// SSE: named tracker-update / activity-update events on /__livereload
// ---------------------------------------------------------------------------

// Connect to the SSE stream and resolve the first time `eventName` shows up in
// the raw text, or reject on timeout. Keeps the whole test comfortably under 5s.
//
// `onConnected` is called repeatedly, not once, and that is the whole point.
// The server watches WORKSPACE_DIR with fs.watch, which is FSEvents-backed on
// macOS: a write can land in a window where the watch handle exists but the
// stream isn't delivering yet, and that write is then dropped silently rather
// than delivered late. A single nudge in that window produces a test that waits
// the full timeout for an event that is never coming.
//
// Measured before this change: 0 failures in 40 runs of this file alone, but 2
// in 40 runs of the full suite, both at the 4s ceiling. The suite runs files
// across every core, so the loaded machine is what widens the window. Nudging
// on an interval closes it without hiding a real break — if the watcher never
// delivers at all, every nudge misses and the test still fails.
async function waitForSseEvent(
  url,
  eventName,
  { onConnected, timeoutMs = 4000, nudgeMs = 250 } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let nudge = null;
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let nudges = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`SSE stream closed before "${eventName}" arrived`);
      buffer += decoder.decode(value, { stream: true });
      if (!nudge && buffer.includes("event: hello")) {
        onConnected?.(nudges++);
        nudge = setInterval(() => onConnected?.(nudges++), nudgeMs);
      }
      if (buffer.includes(`event: ${eventName}`)) return;
    }
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`timed out waiting for SSE event "${eventName}"`);
    }
    throw err;
  } finally {
    clearInterval(nudge);
    clearTimeout(timeout);
    controller.abort();
  }
}

test("changing tracker.json emits a tracker-update SSE event", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const trackerPath = join(resolveUserPaths({ repoRoot }).workspaceDir, "tracker.json");
    await waitForSseEvent(`${baseUrl(dev)}/__livereload`, "tracker-update", {
      // Version bumps per nudge so a repeat write is a real content change,
      // not a same-bytes rewrite the filesystem could coalesce away.
      onConnected: (n) =>
        writeFileSync(
          trackerPath,
          JSON.stringify({ ...MINIMAL_TRACKER, meta: { version: 1 + n } }),
          "utf8"
        ),
    });
  } finally {
    teardown(dev, repoRoot);
  }
});

test("touching activity.jsonl emits an activity-update SSE event", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    await waitForSseEvent(`${baseUrl(dev)}/__livereload`, "activity-update", {
      // Title varies per nudge because appendActivity dedupes on a content
      // hash: a repeat of the identical event is a no-op that writes nothing,
      // so it would produce no fs change for the watcher to see.
      onConnected: (n) =>
        defaultAdapter(repoRoot).appendActivity({ type: "system", title: `sse test ${n}` }),
    });
  } finally {
    teardown(dev, repoRoot);
  }
});
