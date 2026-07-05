import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mountSourcingRoutes } from "../src/cli/sourcing-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunStart,
} from "../src/core/db/verbs/sourcing-runs.mjs";
import {
  candidateArtifactPut,
  candidateConfigPatch,
  candidateSetupInitialize,
  sourceConfigPut,
} from "../src/core/db/verbs.mjs";

const cleanupRoots = [];
const FORBIDDEN_ROUTE_TOKENS = [
  "chat",
  "chatId",
  "nextSkill",
  "research-boards",
  "discover-companies",
  "search-jobs",
  "/api/chat",
  "/api/skill/run",
];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-sourcing-route-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function markSearchReady(repoRoot) {
  candidateArtifactPut({
    repoRoot,
    id: "source-resume",
    kind: "source-resume",
    data: {
      format: "text",
      text: "AI engineer with identity automation and agent workflow experience.",
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "AI builder", titles: ["AI Engineer", "Forward Deployed Engineer"] }],
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: { home: "New York, NY", remote: true, hybrid: true, onsite: false },
    },
  });
}

function seedDeterministicSources(repoRoot) {
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: {
      title_filter: {},
      location_filter: null,
      tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
    },
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: {},
      location_filter: null,
      searches: [
        {
          label: "Acme RSS",
          source_type: "rss",
          rssUrl: "https://example.test/jobs.xml",
          enabled: true,
        },
      ],
      tracked_companies: [],
      source_catalog: {},
    },
  });
}

function seedNoDeterministicSources(repoRoot) {
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: { title_filter: {}, location_filter: null, tracked_companies: [] },
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: {},
      location_filter: null,
      searches: [
        {
          label: "Browser-only board",
          source_type: "browser",
          url: "https://example.test/search?q=ai",
          enabled: true,
        },
      ],
      tracked_companies: [],
      source_catalog: {},
    },
  });
}

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountSourcingRoutes({ addRoute, repoRoot, env: {}, ...opts });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function assertNoRuntimeHandoff(body) {
  const text = JSON.stringify(body);
  for (const token of FORBIDDEN_ROUTE_TOKENS) {
    assert.equal(text.includes(token), false, `response leaked runtime handoff token ${token}`);
  }
}

function publicFetchStub() {
  return async (url) => {
    const text = String(url);
    assert.doesNotMatch(text, /linkedin|wellfound|hiringcafe|browser|session/i);
    if (text.includes("api.lever.co")) {
      return new Response(
        JSON.stringify([
          {
            text: "AI Engineer",
            hostedUrl: "https://jobs.lever.co/acme/ai-engineer",
            categories: { location: "Remote" },
            descriptionBodyPlain: "Build agent workflows with customer teams.",
          },
        ]),
        { status: 200 }
      );
    }
    if (text.includes("example.test/jobs.xml")) {
      return new Response(
        `<?xml version="1.0"?><rss><channel><item><title>Forward Deployed Engineer</title><link>https://example.test/jobs/1</link><description>Customer AI workflows</description></item></channel></rss>`,
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

async function waitForLatestStatus(server, expectedStatus) {
  let latest;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    latest = await getJson(server, "/api/sourcing/runs/latest?purpose=first-search");
    if (latest.body?.run?.status === expectedStatus || latest.body?.status === expectedStatus) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return latest;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/sourcing/runs/latest returns not_started for first-search before a run exists", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(
      server,
      "/api/sourcing/runs/latest?purpose=first-search"
    );
    assert.equal(status, 200);
    assert.equal(body.purpose, "first-search");
    assert.equal(body.status, "not_started");
    assert.equal(body.run, null);
    assertNoRuntimeHandoff(body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/sourcing/first-run/start returns 409 when SQLite DB is missing", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-sourcing-route-no-db-"));
  cleanupRoots.push(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/sourcing/first-run/start", {});
    assert.equal(status, 409);
    assert.equal(body.ok, false);
    assert.match(body.error, /database/i);
    assertNoRuntimeHandoff(body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/sourcing/first-run/start returns 202 for a new deterministic background run", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  seedDeterministicSources(repoRoot);
  const server = await bootServer(repoRoot, { fetchImpl: publicFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/sourcing/first-run/start", {});
    assert.equal(status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.reused, false);
    assert.equal(body.run.purpose, "first-search");
    assert.equal(body.run.status, "running");
    assertNoRuntimeHandoff(body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/sourcing/first-run/start reuses running and completed first-search runs", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  seedDeterministicSources(repoRoot);
  const running = sourcingRunStart({ repoRoot, purpose: "first-search" });
  const server = await bootServer(repoRoot, { fetchImpl: publicFetchStub() });
  try {
    const runningReuse = await postJson(server, "/api/sourcing/first-run/start", {});
    assert.equal(runningReuse.status, 200);
    assert.equal(runningReuse.body.reused, true);
    assert.equal(runningReuse.body.run.id, running.run.id);
    assert.equal(runningReuse.body.run.status, "running");
    assertNoRuntimeHandoff(runningReuse.body);

    sourcingRunComplete({
      repoRoot,
      id: running.run.id,
      summary: { scanned: 1, new: 0, errors: [], offers: [] },
    });

    const completedReuse = await postJson(server, "/api/sourcing/first-run/start", {});
    assert.equal(completedReuse.status, 200);
    assert.equal(completedReuse.body.reused, true);
    assert.equal(completedReuse.body.run.id, running.run.id);
    assert.equal(completedReuse.body.run.status, "completed");
    assertNoRuntimeHandoff(completedReuse.body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/sourcing/first-run/start returns 409 when candidate setup is not search_ready", async () => {
  const repoRoot = tempRepo();
  seedDeterministicSources(repoRoot);
  const server = await bootServer(repoRoot, { fetchImpl: publicFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/sourcing/first-run/start", {});
    assert.equal(status, 409);
    assert.equal(body.ok, false);
    assert.match(body.error, /search-ready/i);
    assert.deepEqual(body.readiness?.search_ready, false);
    assertNoRuntimeHandoff(body);
  } finally {
    await closeServer(server);
  }
});

test("first run with zero deterministic sources records failed run with actionable setup error", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  seedNoDeterministicSources(repoRoot);
  const server = await bootServer(repoRoot, { fetchImpl: publicFetchStub() });
  try {
    const start = await postJson(server, "/api/sourcing/first-run/start", {});
    assert.equal(start.status, 202);
    assertNoRuntimeHandoff(start.body);

    const latest = await waitForLatestStatus(server, "failed");
    assert.equal(latest.status, 200);
    assert.equal(latest.body.run.status, "failed");
    assert.equal(latest.body.run.error.code, "NO_DETERMINISTIC_SOURCES");
    assert.match(latest.body.run.error.message, /RSS source|supported public ATS/i);
    assertNoRuntimeHandoff(latest.body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/sourcing/first-run/start retries failed first-search runs with 202 after source setup is fixed", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  seedDeterministicSources(repoRoot);
  const failed = sourcingRunStart({ repoRoot, purpose: "first-search" });
  sourcingRunFail({
    repoRoot,
    id: failed.run.id,
    error: {
      code: "NO_DETERMINISTIC_SOURCES",
      message: "No deterministic first-search sources are ready.",
    },
  });

  const server = await bootServer(repoRoot, { fetchImpl: publicFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/sourcing/first-run/start", {});
    assert.equal(status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.reused, false);
    assert.equal(body.run.status, "running");
    assert.notEqual(body.run.id, failed.run.id);
    assert.equal(body.run.metadata.retryOf, failed.run.id);
    assertNoRuntimeHandoff(body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/sourcing/search/start creates a manual-search run without using chat or skill runtime", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  seedDeterministicSources(repoRoot);
  const server = await bootServer(repoRoot, { fetchImpl: publicFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/sourcing/search/start", {});
    assert.equal(status, 202);
    assert.equal(body.run.purpose, "manual-search");
    assert.equal(body.run.status, "running");
    assertNoRuntimeHandoff(body);
  } finally {
    await closeServer(server);
  }
});
