// Phase 08 Wave 0 RED contracts for the local Deep ingest API surface.
// These tests intentionally fail until src/cli/deep-ingest-route.mjs exists.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];

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

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-deep-ingest-route-"));
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
  });

  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${path}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
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
