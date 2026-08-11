// tests/search-route.test.mjs
// node:test suite for the M3 /search surface's HTTP layer
// (src/cli/search-route.mjs) — POST /api/search/scan, GET /api/search/results,
// GET /api/search/sources. Mirrors tests/onboard-route.test.mjs's
// bootServer(): a bare addRoute Map wrapped in http.createServer, no full
// tracker-dev.mjs dev server needed. The scan tests inject a stub fetchImpl
// (mountSearchRoutes({fetchImpl}) — see that file's header) so nothing here
// touches a real ATS API.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mountSearchRoutes } from "../src/cli/search-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  companyAtsUpsert,
  sourceConfigGet,
  sourceConfigPut,
  sourcedUpsertBatch,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { stringifyYaml } from "../src/core/profile/yaml.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-search-route-"));
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

function putDbSearchSources(repoRoot, searches = []) {
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: {},
      location_filter: null,
      searches,
      tracked_companies: [],
      source_catalog: {},
    },
  });
}

function seedDbSourcedRow(repoRoot, patch = {}) {
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "sourced-acme-director",
        company: "Acme",
        role: "Director of IT",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: "https://jobs.lever.co/acme/db-row",
        loc: "Remote",
        base: "verify",
        fitScore: 88,
        fitBucket: "high",
        fitBasis: "triage",
        gate: "likely-keep",
        sourcedAt: "2026-07-05T00:00:00Z",
        updatedAt: "2026-07-05T00:00:00Z",
        artifacts: { jd: "workspace/jobs/acme-director-of-it-db-row.md" },
        ...patch,
      },
    ],
  });
}

function writeScanResult(repoRoot, fileName, summary) {
  const dir = userPath({ repoRoot }, "workspace/scan-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), JSON.stringify(summary, null, 2));
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
  closeAll();
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

test("POST /api/search/scan: legacy source files without DB -> 409", async () => {
  const repoRoot = tempRepo();
  writeSourcedScanConfig(repoRoot, [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }]);
  writeSearchSourcesConfig(repoRoot, [{ provider: "HiringCafe", label: "legacy", enabled: true }]);
  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/search/scan", {});
    assert.equal(status, 409);
    assert.match(body.error, /database/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: in DB mode persists kept offers as sourced rows and exports tracker.json", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  companyAtsUpsert({
    repoRoot,
    entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
  });

  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/search/scan", {});
    assert.equal(status, 200);
    assert.equal(body.new, 1);

    const db = openDb({ repoRoot });
    const rows = db
      .prepare("SELECT data FROM sourced ORDER BY rowid ASC")
      .all()
      .map((row) => JSON.parse(row.data));
    assert.equal(rows.length, 1);
    assert.match(rows[0].id, /^sourced-acme-/);
    assert.equal(rows[0].company, "Acme");
    assert.equal(rows[0].role, "Director of IT");
    assert.equal(rows[0].fitBasis, "triage");
    assert.equal(rows[0].channel, "board");
    assert.equal(rows[0].link, "https://jobs.lever.co/acme/abc");
    assert.equal(typeof rows[0].fitScore, "number");
    assert.match(rows[0].artifacts.jd, /^workspace\/jobs\/acme-director-of-it-/);
    assert.equal(existsSync(userPath({ repoRoot }, rows[0].artifacts.jd)), true);

    const tracker = JSON.parse(
      readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
    );
    assert.equal(tracker.sourced.length, 1);
    assert.equal(tracker.sourced[0].id, rows[0].id);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: DB source config is enough when legacy config files are absent", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  companyAtsUpsert({
    repoRoot,
    entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
  });

  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/search/scan", {});
    assert.equal(status, 200);
    assert.equal(body.scanned, 1);
    assert.equal(body.offers[0].company, "Acme");

    const sources = await fetch(`${baseUrl(server)}/api/search/sources`);
    assert.equal(sources.status, 200);
    assert.equal((await sources.json()).trackedCompanies, 1);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: DB mode ignores legacy source files when DB source config is empty", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  writeSourcedScanConfig(repoRoot, [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }]);

  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/search/scan", {});
    assert.equal(status, 400);
    assert.match(body.error, /No search config/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: missing DB -> 409 instead of legacy no-config handling", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/search/scan", {});
    assert.equal(status, 409);
    assert.match(body.error, /database/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: invalid DB source config shape returns JSON 500", async () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  db.prepare(
    `INSERT INTO candidate_source_configs (name, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  ).run("sourced-scan", "null", "2026-07-05T00:00:00Z");

  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    let res;
    try {
      res = await fetch(`${baseUrl(server)}/api/search/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.ok, false);
    assert.match(body.error, /Cannot read|tracked_companies|null/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: legacy search-sources.yml alone is not sufficient product state", async () => {
  const repoRoot = tempRepo();
  writeSearchSourcesConfig(repoRoot, []);
  const server = await bootServer(repoRoot, { fetchImpl: leverFetchStub() });
  try {
    const { status, body } = await postJson(server, "/api/search/scan", {});
    assert.equal(status, 409);
    assert.match(body.error, /database/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/search/scan: 409 while a scan is already in flight", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  companyAtsUpsert({
    repoRoot,
    entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
  });

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

test("GET /api/search/results: scan-result files without DB -> 409", async () => {
  const repoRoot = tempRepo();
  writeScanResult(repoRoot, "sourced-2026-01-01.json", {
    scanned: 1,
    offers: [{ company: "File Corp", title: "File Role", url: "https://example.test/file" }],
  });
  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/search/results`);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /database/i);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/search/results: returns DB sourced rows and ignores contradictory scan-result JSON", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedDbSourcedRow(repoRoot);
  writeScanResult(repoRoot, "sourced-2026-01-01.json", {
    scanned: 99,
    new: 99,
    filteredTitle: 1,
    filteredLocation: 0,
    duplicates: 0,
    invalid: 0,
    expired: 0,
    errors: [],
    offers: [
      {
        company: "File Corp",
        title: "File-only duplicate",
        url: "https://jobs.lever.co/file/legacy",
      },
    ],
  });

  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/search/results`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, "db");
    assert.equal(body.scanned, 1);
    assert.equal(body.new, 1);
    assert.equal(body.offers.length, 1);
    assert.equal(body.offers[0].id, "sourced-acme-director");
    assert.equal(body.offers[0].company, "Acme");
    assert.equal(body.offers[0].title, "Director of IT");
    assert.equal(body.offers[0].url, "https://jobs.lever.co/acme/db-row");
    assert.equal(body.offers[0].score, 88);
    assert.equal(body.offers[0].fit, "high");
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// GET /api/search/sources
// ---------------------------------------------------------------------------

test("GET /api/search/sources: legacy config files without DB -> 409", async () => {
  const repoRoot = tempRepo();
  writeSearchSourcesConfig(repoRoot, [
    { provider: "HiringCafe", label: "legacy", enabled: true },
    { provider: "HiringCafe", label: "legacy disabled", enabled: false },
  ]);
  writeSourcedScanConfig(repoRoot, [
    { name: "Legacy", careers_url: "https://jobs.lever.co/legacy" },
  ]);
  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/search/sources`);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /database/i);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/search/sources: reports only DB enabled/total searches and tracked-company count", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  putDbSearchSources(repoRoot, [
    { provider: "HiringCafe", label: "A", enabled: true },
    { provider: "HiringCafe", label: "B", enabled: true },
    { provider: "HiringCafe", label: "C", enabled: false },
  ]);
  companyAtsUpsert({
    repoRoot,
    entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
  });
  companyAtsUpsert({
    repoRoot,
    entry: {
      name: "Disabled Co",
      careers_url: "https://jobs.lever.co/disabled-co",
    },
  });
  const companyConfig = sourceConfigGet({ repoRoot, name: "sourced-scan" }).data;
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: {
      ...companyConfig,
      tracked_companies: companyConfig.tracked_companies.map((company) =>
        company.name === "Disabled Co" ? { ...company, enabled: false } : company
      ),
    },
  });

  writeSearchSourcesConfig(repoRoot, [
    { provider: "HiringCafe", label: "legacy 1", enabled: true },
    { provider: "HiringCafe", label: "legacy 2", enabled: true },
    { provider: "HiringCafe", label: "legacy 3", enabled: true },
    { provider: "HiringCafe", label: "legacy 4", enabled: true },
  ]);
  writeSourcedScanConfig(repoRoot, [
    { name: "Legacy", careers_url: "https://jobs.lever.co/legacy" },
    { name: "Beta", careers_url: "https://job-boards.greenhouse.io/beta" },
  ]);

  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/search/sources`);
    const body = await res.json();
    assert.deepEqual(body.searches, { enabled: 2, total: 3 });
    assert.equal(body.trackedCompanies, 2);
    assert.equal(body.enabledTrackedCompanies, 1);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/search/sources: reports deterministic attempted source counts separately from browser/auth/url-query sources", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  putDbSearchSources(repoRoot, [
    {
      provider: "Custom RSS",
      label: "RSS fetchable",
      source_type: "rss",
      rssUrl: "https://example.test/jobs.xml",
      enabled: true,
    },
    {
      provider: "HiringCafe",
      label: "Browser board",
      source_type: "browser",
      url: "https://hiring.cafe/search?q=ai",
      enabled: true,
    },
    {
      provider: "LinkedIn",
      label: "Authenticated saved search",
      source_type: "auth",
      url: "https://www.linkedin.com/jobs/search/?keywords=ai",
      enabled: true,
    },
    {
      provider: "Generic",
      label: "URL query only",
      url: "https://example.test/jobs?query=ai",
      enabled: true,
    },
    {
      provider: "Custom RSS",
      label: "Disabled RSS",
      source_type: "rss",
      rssUrl: "https://example.test/disabled.xml",
      enabled: false,
    },
  ]);
  companyAtsUpsert({
    repoRoot,
    entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
  });
  companyAtsUpsert({
    repoRoot,
    entry: { name: "Beta", careers_url: "https://job-boards.greenhouse.io/beta" },
  });

  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/search/sources`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.deterministicSources, {
      attempted: 3,
      rss: 1,
      boards: 0,
      supportedAtsCompanies: 2,
      skipped: 3,
    });
  } finally {
    await closeServer(server);
  }
});
