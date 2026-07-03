// tests/search-route.test.mjs
// node:test suite for the M3 /search surface's HTTP layer
// (src/cli/search-route.mjs) — POST /api/search/scan, GET /api/search/results,
// GET /api/search/sources. Mirrors tests/onboard-route.test.mjs's
// bootServer(): a bare addRoute Map wrapped in http.createServer, no full
// tracker-dev.mjs dev server needed. The scan tests inject a stub fetchImpl
// (mountSearchRoutes({fetchImpl}) — see that file's header) so nothing here
// touches a real ATS API.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mountSearchRoutes } from "../src/cli/search-route.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { stringifyYaml } from "../src/core/profile/yaml.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-search-route-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  return repoRoot;
}

function writeSourcedScanConfig(repoRoot, trackedCompanies = []) {
  writeFileSync(
    join(repoRoot, "config/sourced-scan.json"),
    JSON.stringify(
      { title_filter: {}, location_filter: null, tracked_companies: trackedCompanies },
      null,
      2
    )
  );
}

function writeSearchSourcesConfig(repoRoot, searches = []) {
  writeFileSync(
    join(repoRoot, "config/search-sources.yml"),
    `${stringifyYaml({ title_filter: {}, location_filter: null, searches })}\n`
  );
}

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountSearchRoutes({ addRoute, repoRoot, env: {}, ...opts });

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

function leverFetchStub() {
  return async (url) => {
    if (String(url).includes("api.lever.co")) {
      return new Response(
        JSON.stringify([
          {
            text: "Director of IT",
            hostedUrl: "https://jobs.lever.co/acme/abc",
            categories: { location: "Remote" },
            descriptionBodyPlain: "Own corporate IT, identity, endpoint, and automation.",
          },
        ]),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

after(() => {
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/search/scan
// ---------------------------------------------------------------------------

test("POST /api/search/scan: happy path returns the summary and persists a scan-results file", async () => {
  const repoRoot = tempRepo();
  writeSourcedScanConfig(repoRoot, [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }]);
  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/search/scan", {});
    assert.equal(status, 200);
    assert.equal(body.scanned, 1);
    assert.equal(body.new, 1);
    assert.equal(body.offers[0].company, "Acme");

    const date = new Date().toISOString().slice(0, 10);
    const outPath = userPath({ repoRoot }, `workspace/scan-results/sourced-${date}.json`);
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(written, body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: 400 when neither search-sources.yml nor sourced-scan.json exists", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/search/scan", {});
    assert.equal(status, 400);
    assert.match(body.error, /onboard write-config/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: succeeds when only search-sources.yml exists (no sourced-scan.json)", async () => {
  const repoRoot = tempRepo();
  writeSearchSourcesConfig(repoRoot, []);
  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/search/scan", {});
    assert.equal(status, 200);
    assert.equal(body.scanned, 0);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: 409 while a scan is already in flight", async () => {
  const repoRoot = tempRepo();
  writeSourcedScanConfig(repoRoot, [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }]);

  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const gatedFetchStub = async (url) => {
    await gate;
    return leverFetchStub()(url);
  };

  const server = await bootServer(repoRoot, { fetchImpl: gatedFetchStub });
  try {
    const firstPromise = postJson(server, "/api/search/scan", {});
    // Give the first request's handler time to set the in-flight flag before
    // the second request is dispatched.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await postJson(server, "/api/search/scan", {});
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already running/);

    releaseFirst();
    const first = await firstPromise;
    assert.equal(first.status, 200);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// GET /api/search/results
// ---------------------------------------------------------------------------

test("GET /api/search/results: 404 when no scan-results files exist yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/search/results`);
    assert.equal(res.status, 404);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/search/results: returns the newest persisted summary, wrapped with a date", async () => {
  const repoRoot = tempRepo();
  const dir = userPath({ repoRoot }, "workspace/scan-results");
  mkdirSync(dir, { recursive: true });
  const fixtureSummary = {
    scanned: 3,
    new: 2,
    filteredTitle: 1,
    filteredLocation: 0,
    duplicates: 0,
    invalid: 0,
    expired: 0,
    errors: [],
    offers: [{ company: "Acme", title: "Director of IT", url: "https://jobs.lever.co/acme/abc" }],
  };
  writeFileSync(join(dir, "sourced-2026-01-01.json"), JSON.stringify(fixtureSummary));

  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/search/results`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.date, "2026-01-01");
    assert.equal(body.scanned, 3);
    assert.deepEqual(body.offers, fixtureSummary.offers);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/search/results?date=YYYY-MM-DD: returns that day's file, 404 if missing", async () => {
  const repoRoot = tempRepo();
  const dir = userPath({ repoRoot }, "workspace/scan-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sourced-2026-01-01.json"), JSON.stringify({ scanned: 1, offers: [] }));
  writeFileSync(join(dir, "sourced-2026-01-02.json"), JSON.stringify({ scanned: 2, offers: [] }));

  const server = await bootServer(repoRoot);
  try {
    const hit = await fetch(`${baseUrl(server)}/api/search/results?date=2026-01-01`);
    assert.equal(hit.status, 200);
    const hitBody = await hit.json();
    assert.equal(hitBody.date, "2026-01-01");
    assert.equal(hitBody.scanned, 1);

    const miss = await fetch(`${baseUrl(server)}/api/search/results?date=2026-03-03`);
    assert.equal(miss.status, 404);

    const malformed = await fetch(`${baseUrl(server)}/api/search/results?date=not-a-date`);
    assert.equal(malformed.status, 400);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// GET /api/search/sources
// ---------------------------------------------------------------------------

test("GET /api/search/sources: zeroes out when neither config file exists", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/search/sources`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { searches: { enabled: 0, total: 0 }, trackedCompanies: 0 });
  } finally {
    await closeServer(server);
  }
});

test("GET /api/search/sources: reports enabled/total searches and tracked-company count", async () => {
  const repoRoot = tempRepo();
  writeSearchSourcesConfig(repoRoot, [
    { provider: "HiringCafe", label: "A", enabled: true },
    { provider: "HiringCafe", label: "B", enabled: true },
    { provider: "HiringCafe", label: "C", enabled: false },
  ]);
  writeSourcedScanConfig(repoRoot, [
    { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    { name: "Beta", careers_url: "https://job-boards.greenhouse.io/beta" },
  ]);

  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/search/sources`);
    const body = await res.json();
    assert.deepEqual(body, { searches: { enabled: 2, total: 3 }, trackedCompanies: 2 });
  } finally {
    await closeServer(server);
  }
});
