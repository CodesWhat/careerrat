// Phase 08 Wave 0 RED contracts for the local Deep ingest API surface.
// These tests intentionally fail until src/cli/deep-ingest-route.mjs exists.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateConfigGet,
  candidateSetupInitialize,
  deepIngestConfirmProposal,
  deepIngestLaneSetState,
  deepIngestProposalPut,
  deepIngestSourceCreate,
  deepIngestStateGet,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const cleanupRoots = [];
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const VISIBLE_OUTCOME_STATUSES = new Set([
  "proposal_ready",
  "manual_fallback",
  "gap",
  "deferred",
  "not_available",
  "failed",
]);

const FORBIDDEN_RUNTIME_TOKENS = [
  "/api/skill/run",
  "/api/chat",
  "POST /api/skill/run",
  "runSkillStream",
  "skillRuntime",
  "chatId",
  "chatRuntime",
  "handoff",
  "ingest-profile",
  "evaluate-job",
  "apply-job",
  "search-jobs",
  "discover-companies",
  "research-boards",
];

const REQUIRED_LANES = [
  "source_coverage",
  "evidence_claims",
  "story_bank",
  "honesty_boundaries",
  "writing_voice",
  "role_signals",
  "open_gaps",
];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-deep-ingest-route-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

async function bootServer(repoRoot, opts = {}) {
  const { mountDeepIngestRoutes } = await import("../src/cli/deep-ingest-route.mjs");
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDeepIngestRoutes({
    addRoute,
    repoRoot,
    env: opts.env ?? {},
    fetchImpl: opts.fetchImpl,
    scanSource: opts.scanSource,
    proposalBuilders: opts.proposalBuilders,
    appOperations: opts.appOperations,
  });

  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${path}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    dispatchHttpRoute(route, req, res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function mountDirectRoutes(repoRoot, opts = {}) {
  const { mountDeepIngestRoutes } = await import("../src/cli/deep-ingest-route.mjs");
  const routes = new Map();
  mountDeepIngestRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env: opts.env ?? {},
    fetchImpl: opts.fetchImpl,
    scanSource: opts.scanSource,
    proposalBuilders: opts.proposalBuilders,
    appOperations: opts.appOperations,
  });
  return routes;
}

async function postJsonDirect(routes, path, payload) {
  const handler = routes.get(`POST ${path}`);
  assert.ok(handler, `expected mounted route for POST ${path}`);
  const req = Readable.from([Buffer.from(JSON.stringify(payload ?? {}))]);
  req.method = "POST";
  req.url = path;
  req.headers = { "content-type": "application/json" };
  let status = 200;
  let responseBody = "";
  const res = {
    writeHead(nextStatus) {
      status = nextStatus;
      return this;
    },
    end(chunk = "") {
      responseBody += String(chunk);
    },
  };
  await handler(req, res);
  return { status, body: responseBody ? JSON.parse(responseBody) : {} };
}

async function bootDeepAndOnboardServer(repoRoot, opts = {}) {
  const [{ mountDeepIngestRoutes }, { mountOnboardRoutes }] = await Promise.all([
    import("../src/cli/deep-ingest-route.mjs"),
    import("../src/cli/onboard-route.mjs"),
  ]);
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDeepIngestRoutes({
    addRoute,
    repoRoot,
    env: opts.env ?? {},
    fetchImpl: opts.fetchImpl,
    scanSource: opts.scanSource,
    proposalBuilders: opts.proposalBuilders,
    appOperations: opts.appOperations,
  });
  mountOnboardRoutes({
    addRoute,
    repoRoot,
    env: opts.env ?? {},
    fetchImpl: opts.fetchImpl,
  });

  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${path}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    dispatchHttpRoute(route, req, res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postRaw(server, path, body, headers = {}) {
  const res = await fetch(`${baseUrl(server)}${path}`, { method: "POST", headers, body });
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

function assertNoRuntimeTokens(value) {
  const serialized = JSON.stringify(value);
  for (const token of FORBIDDEN_RUNTIME_TOKENS) {
    assert.equal(serialized.includes(token), false, `deep ingest route leaked ${token}`);
  }
}

function assertVisibleOutcome(body) {
  const status = body?.data?.outcome?.status || body?.data?.source?.status || body?.outcome?.status;
  assert.ok(VISIBLE_OUTCOME_STATUSES.has(status), `unexpected visible outcome ${status}`);
  const flags = [
    body?.data?.proposal,
    body?.data?.manualFallback,
    body?.data?.gap,
    body?.data?.deferred,
    body?.data?.notAvailable,
    body?.data?.error,
  ].filter(Boolean);
  assert.equal(flags.length, 1, "each submitted source must expose exactly one visible outcome");
}

function invalidProposalScan(input, sourceId) {
  const text = Buffer.from(input.bytes || []).toString("utf8");
  const chunk = {
    id: `${sourceId}_chunk_001`,
    sourceId,
    index: 0,
    chunkKind: "text",
    text,
    charStart: 0,
    charEnd: text.length,
    byteStart: 0,
    byteEnd: Buffer.byteLength(text),
  };
  return {
    status: "proposal_ready",
    source: {
      id: sourceId,
      targetShape: input.targetShape,
      sourceKind: "file",
      status: "proposal_ready",
      label: input.fileName,
      artifactPath: input.artifactPath,
      metadata: { fileName: input.fileName, artifactPath: input.artifactPath },
      textLength: text.length,
    },
    outcome: {
      id: `outcome_${sourceId}`,
      sourceId,
      status: "proposal_ready",
      targetShape: input.targetShape,
      visible: true,
      reason: null,
    },
    chunks: [chunk],
    proposal: {
      id: `proposal_${sourceId}`,
      sourceId,
      targetShape: "invalid-target",
      lane: "evidence_claims",
      status: "review_needed",
      validation: { status: "source_scanned" },
    },
  };
}

function tempHomeEnv() {
  return { CAREERRAT_HOME: tempRepo() };
}

function setAllRequiredLanes(repoRoot, overrides = {}, env) {
  for (const lane of REQUIRED_LANES) {
    const next = overrides[lane] || { status: "completed" };
    deepIngestLaneSetState({
      repoRoot,
      env,
      lane,
      status: next.status,
      reason: next.reason,
    });
  }
}

function seedConfirmedRouteItem(repoRoot) {
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "story",
      sourceKind: "paste",
      text: "Led a route-backed rollout that cut review time by 30%.",
      chunks: [
        {
          id: "chunk-route-confirmed-edit-1",
          text: "Led a route-backed rollout that cut review time by 30%.",
        },
      ],
    },
  }).source;
  const item = {
    id: "story-route-edit-1",
    title: "Route-backed rollout",
    situation: "Manual review queue",
    result: "Cut review time by 30%",
    sourceId: source.id,
    chunkId: "chunk-route-confirmed-edit-1",
    supportingQuote: "Led a route-backed rollout that cut review time by 30%",
  };
  const proposal = deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "story",
    lane: "story_bank",
    proposal: {
      items: [{ ...item, validation: { status: "passed", blockedReasons: [] } }],
    },
  });
  deepIngestConfirmProposal({
    repoRoot,
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    edits: { items: [item] },
  });
  return item;
}

test("GET /api/deep-ingest/state fails closed with 409 when SQLite is absent", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/deep-ingest/state");
    assert.equal(status, 409);
    assert.match(body.error, /no database yet/);
    assertNoRuntimeTokens(body);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/deep-ingest/state returns lane progress without requiring candidate compatibility files", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/deep-ingest/state");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.requiredLaneCount, 7);
    assert.equal(body.data.terminalLaneCount, 0);
    assert.deepEqual(
      body.data.lanes.map((lane) => lane.key),
      [
        "source_coverage",
        "evidence_claims",
        "story_bank",
        "honesty_boundaries",
        "writing_voice",
        "role_signals",
        "open_gaps",
      ]
    );
    assertNoRuntimeTokens(body);
  } finally {
    await closeServer(server);
  }
});

test("Deep ingest readiness treats completed, deferred, and not-available lanes as terminal with visible todos and gaps", async () => {
  const repoRoot = PROJECT_ROOT;
  const env = tempHomeEnv();
  openDb({ repoRoot, env });
  candidateSetupInitialize({ repoRoot, env });
  setAllRequiredLanes(
    repoRoot,
    {
      role_signals: {
        status: "deferred",
        reason: "Role-specific signals can wait until the first target role is reviewed.",
      },
      open_gaps: {
        status: "not_available",
        reason: "No extra unanswered gaps are available yet.",
      },
    },
    env
  );
  const server = await bootDeepAndOnboardServer(repoRoot, { env });
  try {
    const deep = await getJson(server, "/api/deep-ingest/state");
    const onboard = await getJson(server, "/api/onboard/state");

    assert.equal(deep.status, 200);
    assert.equal(onboard.status, 200);
    assert.equal(deep.body.data.readiness.ready, true);
    assert.equal(deep.body.data.readiness.terminalCount, 7);
    assert.equal(deep.body.data.readiness.requiredCount, 7);
    assert.equal(deep.body.data.readiness.progressText, "7 of 7 lanes terminal");
    assert.deepEqual(deep.body.data.readiness.missing, []);
    assert.deepEqual(
      deep.body.data.todos.map((todo) => [todo.lane, todo.reason]),
      [["role_signals", "Role-specific signals can wait until the first target role is reviewed."]]
    );
    assert.deepEqual(
      deep.body.data.gaps.map((gap) => [gap.lane, gap.reason]),
      [["open_gaps", "No extra unanswered gaps are available yet."]]
    );
    assert.equal(onboard.body.data.setup.readiness.deep_ingest_complete, true);
    assert.deepEqual(onboard.body.data.setup.missing.deep_ingest_complete, []);
    assert.equal(onboard.body.data.deepIngest.readiness.ready, deep.body.data.readiness.ready);
    assert.equal(
      onboard.body.data.deepIngest.readiness.progressText,
      deep.body.data.readiness.progressText
    );
    assert.deepEqual(onboard.body.data.deepIngest.todos, deep.body.data.todos);
    assert.deepEqual(onboard.body.data.deepIngest.gaps, deep.body.data.gaps);
    assertNoRuntimeTokens(deep.body);
    assertNoRuntimeTokens(onboard.body);
  } finally {
    await closeServer(server);
  }
});

test("Deep ingest readiness stays incomplete for each nonterminal lane status and reports progress text", async () => {
  const nonterminalStatuses = [
    ["not_started", null],
    ["needs_source", null],
    ["scanning", null],
    ["review_needed", null],
    ["gap", "Needs a supporting source."],
    ["failed", "Scanner failed."],
  ];

  for (const [statusValue, reason] of nonterminalStatuses) {
    const repoRoot = PROJECT_ROOT;
    const env = tempHomeEnv();
    openDb({ repoRoot, env });
    candidateSetupInitialize({ repoRoot, env });
    setAllRequiredLanes(
      repoRoot,
      {
        evidence_claims: { status: statusValue, reason },
      },
      env
    );
    const server = await bootDeepAndOnboardServer(repoRoot, { env });
    try {
      const deep = await getJson(server, "/api/deep-ingest/state");
      const onboard = await getJson(server, "/api/onboard/state");

      assert.equal(deep.status, 200);
      assert.equal(onboard.status, 200);
      assert.equal(deep.body.data.readiness.ready, false, `${statusValue} must not be ready`);
      assert.equal(deep.body.data.readiness.progressText, "6 of 7 lanes terminal");
      assert.equal(
        onboard.body.data.setup.readiness.deep_ingest_complete,
        false,
        `${statusValue} must keep setup readiness false`
      );
      assert.ok(
        onboard.body.data.setup.missing.deep_ingest_complete.some((item) =>
          String(item).includes("6 of 7 lanes terminal")
        ),
        "setup missing should expose terminal-lane progress"
      );
      assert.deepEqual(
        onboard.body.data.deepIngest.readiness,
        deep.body.data.readiness,
        "onboard state should expose the same Deep ingest readiness object"
      );
    } finally {
      await closeServer(server);
    }
  }
});

test("Deep ingest readiness rejects tampered terminal lanes that are missing required reasons", async () => {
  const repoRoot = PROJECT_ROOT;
  const env = tempHomeEnv();
  const db = openDb({ repoRoot, env });
  candidateSetupInitialize({ repoRoot, env });
  setAllRequiredLanes(repoRoot, {}, env);
  db.prepare("UPDATE deep_ingest_lane_states SET data = ? WHERE id = ?").run(
    JSON.stringify({
      id: "writing_voice",
      lane: "writing_voice",
      status: "deferred",
      reason: "",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    }),
    "writing_voice"
  );
  const server = await bootDeepAndOnboardServer(repoRoot, { env });
  try {
    const deep = await getJson(server, "/api/deep-ingest/state");
    const onboard = await getJson(server, "/api/onboard/state");

    assert.equal(deep.status, 200);
    assert.equal(deep.body.data.readiness.ready, false);
    assert.equal(deep.body.data.readiness.terminalCount, 6);
    assert.equal(deep.body.data.readiness.progressText, "6 of 7 lanes terminal");
    assert.ok(
      deep.body.data.readiness.missing.some(
        (lane) => lane.lane === "writing_voice" && lane.reasonRequired === true
      )
    );
    assert.equal(onboard.body.data.setup.readiness.deep_ingest_complete, false);
    assert.ok(
      onboard.body.data.setup.missing.deep_ingest_complete.some((item) =>
        /writing voice.*reason/i.test(String(item))
      )
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources validates target/source input, body caps, and no-DB behavior", async () => {
  const noDbRoot = tempRepo();
  let server = await bootServer(noDbRoot);
  try {
    const noDb = await postJson(server, "/api/deep-ingest/sources", {
      targetShape: "evidence",
      sourceKind: "paste",
      text: "hello",
    });
    assert.equal(noDb.status, 409);
    assertNoRuntimeTokens(noDb.body);
  } finally {
    await closeServer(server);
  }

  const repoRoot = tempRepo();
  openDb({ repoRoot });
  server = await bootServer(repoRoot);
  try {
    const missing = await postJson(server, "/api/deep-ingest/sources", {});
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /targetShape|sourceKind|text|url|path/i);

    const invalidTarget = await postJson(server, "/api/deep-ingest/sources", {
      targetShape: "ai_interview",
      sourceKind: "paste",
      text: "hello",
    });
    assert.equal(invalidTarget.status, 400);
    assert.match(invalidTarget.body.error, /targetShape/i);

    const huge = await postJson(server, "/api/deep-ingest/sources", {
      targetShape: "evidence",
      sourceKind: "paste",
      text: "x".repeat(1024 * 1024 + 64),
    });
    assert.equal(huge.status, 413);
  } finally {
    await closeServer(server);
  }
});

test("Deep Ingest routes delegate source scans, linked retries, and proposal builds to injected app operations", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const calls = [];
  const appOperations = {
    async start(value) {
      calls.push(["start", value]);
      return {
        reused: false,
        operation: {
          id: `operation-${calls.length}`,
          kind: value.kind,
          request: { sourceId: "deep-src-owned" },
          ownerId: "server-owner",
          fence: 1,
          status: "queued",
          progress: { phase: "queued" },
        },
      };
    },
    async retry(value) {
      calls.push(["retry", value]);
      return {
        reused: false,
        operation: {
          id: "operation-retry",
          kind: "deep-ingest-source-scan",
          request: { sourceId: "deep-src-owned" },
          ownerId: "server-owner",
          fence: 2,
          retryOf: value.id,
          status: "queued",
          progress: { phase: "queued" },
        },
      };
    },
  };
  const routes = await mountDirectRoutes(repoRoot, { appOperations });

  const source = await postJsonDirect(routes, "/api/deep-ingest/sources", {
    targetShape: "evidence",
    sourceKind: "text",
    text: "Built app-owned Deep Ingest work.",
  });
  assert.equal(source.status, 202);
  assert.equal(source.body.data.operation.kind, "deep-ingest-source-scan");
  assert.match(source.body.data.subject.sourceId, /^deep_src_/);
  assert.equal(source.body.data.subject.sourceVersion, 1);
  assert.equal(source.body.data.subject.targetShape, "evidence");
  assert.equal("request" in source.body.data.operation, false);
  assert.equal("ownerId" in source.body.data.operation, false);
  assert.equal("fence" in source.body.data.operation, false);

  const proposals = await postJsonDirect(routes, "/api/deep-ingest/proposals", {
    sourceId: "deep-src-owned",
    targetShape: "evidence",
  });
  assert.equal(proposals.status, 202);
  assert.equal(proposals.body.data.operation.kind, "deep-ingest-proposal-build");
  assert.deepEqual(proposals.body.data.subject, {
    sourceId: "deep-src-owned",
    targetShape: "evidence",
  });

  const retry = await postJsonDirect(routes, "/api/deep-ingest/sources/retry", {
    operationId: "operation-1",
  });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.data.operation.retryOf, "operation-1");
  assert.equal(retry.body.data.subject.sourceId, "deep-src-owned");
  assert.equal(calls[0][0], "start");
  assert.equal(calls[0][1].kind, "deep-ingest-source-scan");
  assert.match(calls[0][1].input.sourceId, /^deep_src_/);
  assert.match(calls[0][1].input.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(calls[0][1].input.sourceVersion, 1);
  assert.deepEqual(calls[1], [
    "start",
    {
      kind: "deep-ingest-proposal-build",
      input: { sourceId: "deep-src-owned", targetShape: "evidence" },
    },
  ]);
  assert.deepEqual(calls[2], ["retry", { id: "operation-1" }]);
});

test("an injected upload start failure removes the unowned staged upload", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const routes = await mountDirectRoutes(repoRoot, {
    appOperations: {
      async start() {
        const error = new Error("CareerRat could not queue this upload.");
        error.code = "APP_OPERATION_MANAGER_STOPPED";
        throw error;
      },
    },
  });

  const handler = routes.get("POST /api/deep-ingest/sources/upload");
  const req = Readable.from([Buffer.from("Upload bytes must not be orphaned.")]);
  req.method = "POST";
  req.url = "/api/deep-ingest/sources/upload?targetShape=evidence&name=owned.md";
  req.headers = { "content-type": "application/octet-stream" };
  let status = 200;
  let text = "";
  const res = {
    writeHead(value) {
      status = value;
      return this;
    },
    end(value = "") {
      text += String(value);
    },
  };
  await handler(req, res);

  assert.equal(status, 400);
  assert.match(JSON.parse(text).error, /could not queue/i);
  const state = deepIngestStateGet({ repoRoot });
  assert.equal(state.sources.length, 0);
  assert.equal(state.laneStates.source_coverage.status, "not_started");
  assert.equal(state.laneStates.open_gaps.status, "not_started");
  const uploadDir = userPath({ repoRoot }, "workspace/deep-ingest/sources");
  assert.deepEqual(existsSync(uploadDir) ? readdirSync(uploadDir) : [], []);
});

test("POST /api/deep-ingest/sources persists exactly one visible outcome and never starts skill/chat runtime", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    scanSource: async ({ input }) => ({
      status: "proposal_ready",
      source: {
        id: "deep_source_001",
        kind: input.sourceKind,
        targetShape: input.targetShape,
        status: "proposal_ready",
      },
      proposal: {
        id: "deep_prop_001",
        targetShape: input.targetShape,
        lane: "evidence_claims",
        status: "review_needed",
      },
    }),
  });
  try {
    const { status, body } = await postJson(server, "/api/deep-ingest/sources", {
      targetShape: "evidence",
      sourceKind: "paste",
      text: "Built proposal-first source ingestion.",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assertVisibleOutcome(body);
    assertNoRuntimeTokens(body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources/retry rescans the saved source instead of drafting from failed chunks", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const sourceUrl = "https://example.com/career-notes";
  const inputs = [];
  const server = await bootServer(repoRoot, {
    scanSource: async ({ input }) => {
      inputs.push(input);
      if (inputs.length === 1) {
        return {
          status: "failed",
          reason: "request timed out",
          source: {
            id: "deep_source_retry",
            kind: "url",
            sourceKind: "url",
            targetShape: "auto",
            status: "failed",
            label: sourceUrl,
            metadata: { url: sourceUrl },
          },
          outcome: { id: "outcome_retry", sourceId: "deep_source_retry", status: "failed" },
          chunks: [],
        };
      }
      return {
        status: "proposal_ready",
        source: {
          id: "different_scan_id",
          kind: "url",
          sourceKind: "url",
          targetShape: "auto",
          status: "proposal_ready",
          label: sourceUrl,
          metadata: { url: sourceUrl },
        },
        outcome: { id: "outcome_success", status: "proposal_ready" },
        chunks: [{ id: "chunk_retry", text: "Grounded career evidence." }],
        proposal: {
          id: "proposal_retry",
          targetShape: "auto",
          lane: "open_gaps",
          status: "review_needed",
          validation: { status: "source_scanned" },
        },
      };
    },
  });
  try {
    const first = await postJson(server, "/api/deep-ingest/sources", {
      targetShape: "auto",
      sourceKind: "url",
      url: sourceUrl,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.source.status, "failed");

    const retried = await postJson(server, "/api/deep-ingest/sources/retry", {
      sourceId: "deep_source_retry",
    });
    assert.equal(retried.status, 200);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1].sourceKind, "url");
    assert.equal(inputs[1].url, sourceUrl);
    assert.equal(retried.body.data.source.id, "deep_source_retry");
    assert.equal(retried.body.data.source.status, "proposal_ready");
    assert.equal(retried.body.data.chunks.length, 1);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources rejects unsafe/private URLs and exposes deferred/gap states", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    for (const url of ["file:///tmp/private.md", "http://127.0.0.1:7777/private"]) {
      const { status, body } = await postJson(server, "/api/deep-ingest/sources", {
        targetShape: "auto",
        sourceKind: "url",
        url,
      });
      assert.equal(status, 200);
      assertVisibleOutcome(body);
      assert.match(body.data.outcome.reason, /unsafe|private|unsupported/i);
      assertNoRuntimeTokens(body);
    }
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources/upload enforces file caps and creates a saved-source outcome", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const missingName = await postRaw(server, "/api/deep-ingest/sources/upload", Buffer.from("x"));
    assert.equal(missingName.status, 400);

    const empty = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=notes.md",
      Buffer.alloc(0),
      { "content-type": "text/markdown" }
    );
    assert.equal(empty.status, 400);

    const saved = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=..%2Fnotes.md",
      Buffer.from("Evidence source text."),
      { "content-type": "text/markdown" }
    );
    assert.equal(saved.status, 200);
    assertVisibleOutcome(saved.body);
    assert.match(saved.body.data.source.artifactPath, /^workspace\/deep-ingest\/sources\//);
    assertNoRuntimeTokens(saved.body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources/upload removes staged bytes after validation or scanning fails", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const uploadDir = userPath({ repoRoot, env: {} }, "workspace/deep-ingest/sources");
  const server = await bootServer(repoRoot, {
    scanSource: async () => {
      throw new Error("scanner exploded");
    },
  });
  try {
    const invalidTarget = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=not-a-lane&name=invalid.md",
      Buffer.from("invalid target")
    );
    assert.equal(invalidTarget.status, 400);
    assert.deepEqual(existsSync(uploadDir) ? readdirSync(uploadDir) : [], []);

    const scanFailure = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=scan.md",
      Buffer.from("scan failure")
    );
    assert.equal(scanFailure.status, 400);
    assert.match(scanFailure.body.error, /scanner exploded/i);
    assert.deepEqual(existsSync(uploadDir) ? readdirSync(uploadDir) : [], []);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources/upload rolls back a new source when proposal persistence fails", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const uploadDir = userPath({ repoRoot, env: {} }, "workspace/deep-ingest/sources");
  const server = await bootServer(repoRoot, {
    scanSource: async ({ input }) => invalidProposalScan(input, "deep_src_atomic_new"),
  });
  try {
    const before = await getJson(server, "/api/deep-ingest/state");
    const failed = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=atomic-new.md",
      Buffer.from("This source must roll back.")
    );
    assert.equal(failed.status, 400);
    assert.match(failed.body.error, /target shape/i);

    const after = await getJson(server, "/api/deep-ingest/state");
    assert.deepEqual(after.body.data.sources, before.body.data.sources);
    assert.deepEqual(after.body.data.sourceChunks, before.body.data.sourceChunks);
    assert.deepEqual(after.body.data.proposals, before.body.data.proposals);
    assert.deepEqual(after.body.data.laneStates, before.body.data.laneStates);
    assert.deepEqual(existsSync(uploadDir) ? readdirSync(uploadDir) : [], []);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources/upload restores the prior source and file when replacement proposal persistence fails", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const uploadDir = userPath({ repoRoot, env: {} }, "workspace/deep-ingest/sources");
  const firstServer = await bootServer(repoRoot);
  let sourceId;
  let before;
  let beforeFiles;
  try {
    const saved = await postRaw(
      firstServer,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=atomic-replace.md",
      Buffer.from("Original source text.")
    );
    assert.equal(saved.status, 200);
    sourceId = saved.body.data.source.id;
    before = (await getJson(firstServer, "/api/deep-ingest/state")).body.data;
    beforeFiles = readdirSync(uploadDir).sort();
    assert.equal(beforeFiles.length, 1);
  } finally {
    await closeServer(firstServer);
  }

  const failingServer = await bootServer(repoRoot, {
    scanSource: async ({ input }) => invalidProposalScan(input, sourceId),
  });
  try {
    const failed = await postRaw(
      failingServer,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=atomic-replace.md",
      Buffer.from("Replacement text that must roll back.")
    );
    assert.equal(failed.status, 400);
    assert.match(failed.body.error, /target shape/i);

    const after = (await getJson(failingServer, "/api/deep-ingest/state")).body.data;
    assert.deepEqual(after.sources, before.sources);
    assert.deepEqual(after.sourceChunks, before.sourceChunks);
    assert.deepEqual(after.proposals, before.proposals);
    assert.deepEqual(after.laneStates, before.laneStates);
    assert.deepEqual(readdirSync(uploadDir).sort(), beforeFiles);
    assert.equal(existsSync(userPath({ repoRoot, env: {} }, before.sources[0].artifactPath)), true);
  } finally {
    await closeServer(failingServer);
  }
});

test("POST /api/deep-ingest/sources/upload replaces an owned artifact without orphaning the prior file", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const first = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=repeat.md",
      Buffer.from("Same evidence source.")
    );
    assert.equal(first.status, 200);
    const firstPath = userPath({ repoRoot, env: {} }, first.body.data.source.artifactPath);
    assert.equal(existsSync(firstPath), true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const replacement = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=repeat.md",
      Buffer.from("Same evidence source.")
    );
    assert.equal(replacement.status, 200);
    const replacementPath = userPath(
      { repoRoot, env: {} },
      replacement.body.data.source.artifactPath
    );
    assert.notEqual(replacementPath, firstPath);
    assert.equal(existsSync(firstPath), false);
    assert.equal(existsSync(replacementPath), true);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources/upload gives concurrent same-name uploads distinct owned paths", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  const originalNow = Date.now;
  Date.now = () => 1_787_602_901_963;
  try {
    const first = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=collision.md",
      Buffer.from("First source.")
    );
    const second = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=collision.md",
      Buffer.from("Second source.")
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first.body.data.source.artifactPath, second.body.data.source.artifactPath);
    assert.equal(
      existsSync(userPath({ repoRoot, env: {} }, first.body.data.source.artifactPath)),
      true
    );
    assert.equal(
      existsSync(userPath({ repoRoot, env: {} }, second.body.data.source.artifactPath)),
      true
    );
  } finally {
    Date.now = originalNow;
    await closeServer(server);
  }
});

test("ISSUE-015: POST /api/deep-ingest/sources/remove deletes only undrafted source state", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      id: "deep_src_route_remove",
      targetShape: "auto",
      sourceKind: "url",
      text: "Example source text.",
    },
  }).source;
  deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "auto",
    lane: "open_gaps",
    proposal: {
      status: "review_needed",
      validation: { status: "source_scanned" },
    },
  });
  const server = await bootServer(repoRoot);
  try {
    const removed = await postJson(server, "/api/deep-ingest/sources/remove", {
      sourceId: source.id,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.ok, true);
    assert.equal(removed.body.data.removedProposals, 1);

    const state = await getJson(server, "/api/deep-ingest/state");
    assert.equal(state.body.data.sources.length, 0);
    assert.equal(state.body.data.proposals.length, 0);

    const missing = await postJson(server, "/api/deep-ingest/sources/remove", {});
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /sourceId/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources/remove deletes owned uploads and tolerates an already-missing file", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const saved = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=remove.md",
      Buffer.from("Owned source artifact.")
    );
    assert.equal(saved.status, 200);
    const sourceId = saved.body.data.source.id;
    const artifactPath = userPath({ repoRoot, env: {} }, saved.body.data.source.artifactPath);
    assert.equal(existsSync(artifactPath), true);

    unlinkSync(artifactPath);
    const removed = await postJson(server, "/api/deep-ingest/sources/remove", { sourceId });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.ok, true);
    assert.equal(existsSync(artifactPath), false);

    const savedAgain = await postRaw(
      server,
      "/api/deep-ingest/sources/upload?targetShape=evidence&name=remove-again.md",
      Buffer.from("Another owned source artifact.")
    );
    assert.equal(savedAgain.status, 200);
    const nextArtifactPath = userPath(
      { repoRoot, env: {} },
      savedAgain.body.data.source.artifactPath
    );
    const removedAgain = await postJson(server, "/api/deep-ingest/sources/remove", {
      sourceId: savedAgain.body.data.source.id,
    });
    assert.equal(removedAgain.status, 200);
    assert.equal(existsSync(nextArtifactPath), false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/sources/remove never deletes unowned or unconfined artifacts", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const uploadDir = userPath({ repoRoot, env: {} }, "workspace/deep-ingest/sources");
  mkdirSync(uploadDir, { recursive: true });
  const unownedPath = join(uploadDir, "unowned.md");
  writeFileSync(unownedPath, "not owned by this source");
  const outsidePath = join(repoRoot, "must-survive.md");
  writeFileSync(outsidePath, "keep me");
  const traversalPath = userPath(
    { repoRoot, env: {} },
    "workspace/deep-ingest/sources/../../../must-also-survive.md"
  );
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  writeFileSync(traversalPath, "keep me too");

  const unsafeSources = [
    {
      id: "deep_src_unowned_artifact",
      artifactPath: "workspace/deep-ingest/sources/unowned.md",
    },
    {
      id: "deep_src_absolute_artifact",
      artifactPath: outsidePath,
      metadata: { ownedUpload: true },
    },
    {
      id: "deep_src_traversal_artifact",
      artifactPath: "workspace/deep-ingest/sources/../../../must-also-survive.md",
      metadata: { ownedUpload: true },
    },
  ];
  for (const source of unsafeSources) {
    deepIngestSourceCreate({
      repoRoot,
      input: {
        id: source.id,
        targetShape: "auto",
        sourceKind: "file",
        text: "Unsafe artifact metadata.",
        artifactPath: source.artifactPath,
        metadata: source.metadata,
      },
    });
  }

  const server = await bootServer(repoRoot);
  try {
    for (const source of unsafeSources) {
      const removed = await postJson(server, "/api/deep-ingest/sources/remove", {
        sourceId: source.id,
      });
      assert.equal(removed.status, 200);
    }
    assert.equal(existsSync(unownedPath), true);
    assert.equal(existsSync(outsidePath), true);
    assert.equal(existsSync(traversalPath), true);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/proposal-decisions rejects stale expectedVersion and requires explicit terminal reasons", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const stale = await postJson(server, "/api/deep-ingest/proposal-decisions", {
      proposalId: "deep_prop_001",
      expectedVersion: 1,
      decision: "confirm",
      edits: {},
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /version|not found/i);

    const noReason = await postJson(server, "/api/deep-ingest/lane-states", {
      lane: "writing_voice",
      status: "not_available",
    });
    assert.equal(noReason.status, 400);
    assert.match(noReason.body.error, /reason/i);
    assertNoRuntimeTokens(noReason.body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/proposals persists builder output as review state only", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      text: "Built route-backed proposal review.",
      chunks: [{ id: "chunk-route-1", text: "Built route-backed proposal review." }],
    },
  }).source;
  const beforeClaims = candidateConfigGet({ repoRoot }).evidence.claims.length;
  const server = await bootServer(repoRoot, {
    proposalBuilders: {
      evidence: async ({ source: builderSource }) => ({
        status: "proposal_ready",
        proposals: [
          {
            id: "proposal-route-evidence-1",
            lane: "evidence",
            sourceId: builderSource.id,
            chunkId: "chunk-route-1",
            status: "review_needed",
            confidence: 0.92,
            supportingQuote: "Built route-backed proposal review",
            payload: { claim: "Built route-backed proposal review." },
            validation: { status: "passed", blockedReasons: [] },
          },
        ],
        gaps: [],
        manual: null,
      }),
    },
  });

  try {
    const { status, body } = await postJson(server, "/api/deep-ingest/proposals", {
      sourceId: source.id,
      targetShape: "evidence",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.proposals.length, 1);
    assert.equal(body.data.proposals[0].status, "review_needed");
    assert.equal(body.data.state.reviewQueue.length, 1);
    assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, beforeClaims);
    assert.equal(existsSync(userPath({ repoRoot }, "candidate/evidence.yml")), false);
    assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);
    assertNoRuntimeTokens(body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/proposals stores auto-classified rows in their real lanes", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "auto",
      sourceKind: "paste",
      text: "Built incident automation and led the migration.",
      chunks: [
        {
          id: "chunk-route-auto-1",
          text: "Built incident automation and led the migration.",
        },
      ],
    },
  }).source;
  const routes = await mountDirectRoutes(repoRoot, {
    proposalBuilders: {
      auto: async ({ source: builderSource }) => ({
        status: "proposal_ready",
        proposals: [
          {
            id: "proposal-route-auto-evidence",
            lane: "evidence",
            sourceId: builderSource.id,
            chunkId: "chunk-route-auto-1",
            status: "review_needed",
            confidence: 0.91,
            supportingQuote: "Built incident automation",
            payload: { claim: "Built incident automation." },
            validation: { status: "passed", blockedReasons: [] },
          },
          {
            id: "proposal-route-auto-story",
            lane: "story",
            sourceId: builderSource.id,
            chunkId: "chunk-route-auto-1",
            status: "review_needed",
            confidence: 0.82,
            supportingQuote: "led the migration",
            payload: { title: "Migration leadership" },
            validation: { status: "passed", blockedReasons: [] },
          },
        ],
        gaps: [],
        manual: null,
      }),
    },
  });

  const { status, body } = await postJsonDirect(routes, "/api/deep-ingest/proposals", {
    sourceId: source.id,
    targetShape: "auto",
  });

  assert.equal(status, 200);
  assert.deepEqual(
    body.data.proposals.map((proposal) => proposal.lane),
    ["evidence_claims", "story_bank"]
  );
  assert.equal(
    body.data.proposals.some((proposal) => proposal.lane === "open_gaps"),
    false
  );
});

test("POST /api/deep-ingest/proposals persists a genuine provider failure reason", async () => {
  const { proposeEvidenceFromSource } = await import(
    "../src/core/deep-ingest/proposals/evidence.mjs"
  );
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      text: "Built a grounded provider-failure regression.",
      chunks: [
        {
          id: "chunk-route-provider-failure-1",
          text: "Built a grounded provider-failure regression.",
        },
      ],
    },
  }).source;
  const providerReason =
    "Structured-output schema object at properties.payload must set additionalProperties to false.";
  const routes = await mountDirectRoutes(repoRoot, {
    proposalBuilders: {
      evidence: (options) =>
        proposeEvidenceFromSource({
          ...options,
          call: async () => {
            throw new Error(
              `AI request failed: 400 Bad Request — ${JSON.stringify({
                type: "error",
                error: { type: "invalid_request_error", message: providerReason },
                request_id: "req_route_test",
              })}`
            );
          },
        }),
    },
  });

  const { status, body } = await postJsonDirect(routes, "/api/deep-ingest/proposals", {
    sourceId: source.id,
    targetShape: "evidence",
  });

  assert.equal(status, 200);
  assert.equal(body.data.proposals.length, 1);
  assert.equal(body.data.proposals[0].proposal.status, "manual_fallback");
  assert.equal(body.data.proposals[0].proposal.payload.reason, providerReason);
});

test("POST /api/deep-ingest/proposal-decisions returns updated state after confirm and not_available", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      text: "Confirmed route decisions keep provenance.",
      chunks: [
        { id: "chunk-route-decision-1", text: "Confirmed route decisions keep provenance." },
      ],
    },
  }).source;
  const proposal = deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "evidence",
    lane: "evidence_claims",
    proposal: {
      items: [
        {
          claim: "Confirmed route decisions keep provenance.",
          sourceId: source.id,
          chunkId: "chunk-route-decision-1",
          supportingQuote: "Confirmed route decisions keep provenance",
          validation: { status: "passed", blockedReasons: [] },
        },
      ],
    },
  });
  const gapProposal = deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "gap",
    lane: "open_gaps",
    proposal: {
      items: [{ prompt: "Missing voice sample.", sourceId: source.id }],
    },
  });
  const server = await bootServer(repoRoot);

  try {
    const confirmed = await postJson(server, "/api/deep-ingest/proposal-decisions", {
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      decision: "confirm",
      edits: {
        items: [
          {
            id: "deep-evidence-route-confirmed",
            claim: "Confirmed route decisions keep provenance.",
            evidence: "Deep ingest route decision",
            sourceId: source.id,
            chunkId: "chunk-route-decision-1",
            supportingQuote: "Confirmed route decisions keep provenance",
          },
        ],
      },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.data.proposal.status, "confirmed");
    assert.equal(confirmed.body.data.state.confirmed.evidence.length, 1);
    assert.equal(confirmed.body.data.state.confirmed.evidence[0].sourceProposalId, proposal.id);
    assert.equal(confirmed.body.data.state.laneStates.evidence_claims.status, "completed");
    assertNoRuntimeTokens(confirmed.body);

    const notAvailable = await postJson(server, "/api/deep-ingest/proposal-decisions", {
      proposalId: gapProposal.id,
      expectedVersion: gapProposal.version,
      decision: "mark_not_available",
      reason: "No writing sample is available.",
    });
    assert.equal(notAvailable.status, 200);
    assert.equal(notAvailable.body.data.proposal.status, "not_available");
    assert.equal(
      notAvailable.body.data.state.openGaps[0].reason,
      "No writing sample is available."
    );
    assertNoRuntimeTokens(notAvailable.body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/deep-ingest/confirmed/update and /remove mutate one confirmed item", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const item = seedConfirmedRouteItem(repoRoot);
  const routes = await mountDirectRoutes(repoRoot);

  const updated = await postJsonDirect(routes, "/api/deep-ingest/confirmed/update", {
    lane: "story_bank",
    id: item.id,
    title: "Edited route-backed rollout",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.ok, true);
  assert.equal(updated.body.data.item.title, "Edited route-backed rollout");
  assert.equal(updated.body.data.item.situation, "Manual review queue");
  assert.equal(updated.body.data.event.title, "Interview story updated");

  const removed = await postJsonDirect(routes, "/api/deep-ingest/confirmed/remove", {
    lane: "story_bank",
    id: item.id,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ok, true);
  assert.equal(removed.body.data.ok, true);
  assert.equal(removed.body.data.lane, "story_bank");
  assert.equal(removed.body.data.removed, item.id);
  assert.equal(removed.body.data.event.title, "Interview story removed");
});

test("POST /api/deep-ingest/confirmed/upsert saves a manual writing style", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const routes = await mountDirectRoutes(repoRoot);

  const response = await postJsonDirect(routes, "/api/deep-ingest/confirmed/upsert", {
    lane: "writing_voice",
    id: null,
    fields: {
      summary: "Plain, direct, concrete.",
      doPhrases: ["Lead with the result"],
      avoidPhrases: ["Excited to apply"],
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.item.summary, "Plain, direct, concrete.");
  assert.equal(response.body.data.created, true);
});

test("POST /api/deep-ingest/confirmed/upsert rejects a stale Settings base revision", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const routes = await mountDirectRoutes(repoRoot);

  const response = await postJsonDirect(routes, "/api/deep-ingest/confirmed/upsert", {
    lane: "writing_voice",
    id: null,
    expectedBaseRevision: "stale-settings-revision",
    fields: { summary: "This stale draft must not overwrite current state." },
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, "SETTINGS_BASE_CHANGED");
});

test("POST confirmed-item routes reject missing id/lane payloads", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const routes = await mountDirectRoutes(repoRoot);

  for (const [path, payload, message] of [
    [
      "/api/deep-ingest/confirmed/update",
      { lane: "story_bank", title: "Missing id" },
      /requires id/,
    ],
    [
      "/api/deep-ingest/confirmed/update",
      { id: "story-route-edit-1", title: "Missing lane" },
      /unsupported Deep ingest lane "\(missing\)"/,
    ],
    ["/api/deep-ingest/confirmed/remove", { lane: "story_bank" }, /requires id/],
    [
      "/api/deep-ingest/confirmed/remove",
      { id: "story-route-edit-1" },
      /unsupported Deep ingest lane "\(missing\)"/,
    ],
  ]) {
    const response = await postJsonDirect(routes, path, payload);
    assert.equal(response.status, 400);
    assert.equal(response.body.ok, false);
    assert.match(response.body.error, message);
  }
});

test("POST /api/deep-ingest/confirmed/update returns privacy reasons", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const item = seedConfirmedRouteItem(repoRoot);
  const routes = await mountDirectRoutes(repoRoot);

  const response = await postJsonDirect(routes, "/api/deep-ingest/confirmed/update", {
    lane: "story_bank",
    id: item.id,
    result: "My current salary is $210,000; contact me at private@example.com.",
  });

  assert.deepEqual(response, {
    status: 400,
    body: {
      ok: false,
      error: "Deep ingest confirmed item update is blocked by the privacy guard",
      reasons: ["contact_detail", "current_base"],
    },
  });
});
