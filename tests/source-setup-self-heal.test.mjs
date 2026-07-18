import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { mountSearchRoutes } from "../src/cli/search-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateConfigPatch,
  candidateSetupInitialize,
  sourceConfigGet,
  sourceConfigPut,
} from "../src/core/db/verbs.mjs";
import { healSearchSourceConfig } from "../src/core/onboarding/first-search-run.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-source-self-heal-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function seedCandidate(repoRoot, titles) {
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Primary", priority: "primary", titles }],
      tracked_companies: [],
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { candidate: { domain: "" }, location: {} },
  });
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: { title_filter: {}, location_filter: null, tracked_companies: [] },
  });
}

function preFixSearchSources() {
  return {
    title_filter: { positive: [], negative: [] },
    location_filter: { always_allow: [], allow: [], block: [] },
    searches: [
      {
        provider: "remoteok",
        label: "Remote OK",
        source_type: "board",
        url: "https://remoteok.com/api",
        enabled: false,
      },
      {
        provider: "remotive",
        label: "Remotive",
        source_type: "board",
        url: "https://remotive.com/api/remote-jobs",
        enabled: false,
      },
      {
        provider: "workingnomads",
        label: "Working Nomads",
        source_type: "board",
        url: "https://www.workingnomads.com/jobsapi/job/_search",
        enabled: false,
      },
    ],
    tracked_companies: [],
    source_catalog: {},
  };
}

function putPreFixSearchSources(repoRoot) {
  sourceConfigPut({ repoRoot, name: "search-sources", data: preFixSearchSources() });
}

function sourceConfigUpdatedAt(repoRoot) {
  return openDb({ repoRoot })
    .prepare("SELECT updated_at FROM candidate_source_configs WHERE name = ?")
    .get("search-sources").updated_at;
}

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  const fetchCalls = [];
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountSearchRoutes({
    addRoute,
    repoRoot,
    env: {},
    fetchImpl: async (...args) => {
      fetchCalls.push(args);
      throw new Error("self-heal must not call fetch");
    },
    ...opts,
  });
  return { routes, fetchCalls };
}

async function getJson(server, path) {
  const route = server.routes.get(`GET ${path}`);
  assert.ok(route, `missing route: GET ${path}`);
  const req = Readable.from([]);
  req.method = "GET";
  req.url = path;
  const res = {
    status: null,
    rawBody: "",
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(chunk = "") {
      this.rawBody += chunk;
      return this;
    },
  };
  await route(req, res);
  return { status: res.status, body: JSON.parse(res.rawBody) };
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tech-majority pre-fix source config heals once and persists deterministic sources", () => {
  const repoRoot = tempRepo();
  seedCandidate(repoRoot, [
    "Applied AI Engineer",
    "Forward Deployed Engineer",
    "Solutions Engineer",
  ]);
  putPreFixSearchSources(repoRoot);

  const first = healSearchSourceConfig({ repoRoot, env: {} });
  assert.equal(first.healed, true);
  assert.ok(first.deterministicSources.attempted > 0);
  assert.ok(first.deterministicSources.rss > 0);
  assert.equal(
    first.searchSources.searches.some(
      (source) => source.provider === "RemoteVibeCodingJobs" && source.enabled !== false
    ),
    true
  );

  const storedAfterFirst = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
  const updatedAfterFirst = sourceConfigUpdatedAt(repoRoot);
  const second = healSearchSourceConfig({ repoRoot, env: {} });

  assert.equal(second.healed, false);
  assert.deepEqual(second.searchSources, storedAfterFirst);
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "search-sources" }).data, storedAfterFirst);
  assert.equal(sourceConfigUpdatedAt(repoRoot), updatedAfterFirst);
});

test("non-tech config never enables deterministic sources and converges without a write loop", () => {
  const repoRoot = tempRepo();
  seedCandidate(repoRoot, ["Registered Nurse", "Nurse Practitioner", "Clinical Manager"]);
  putPreFixSearchSources(repoRoot);

  const first = healSearchSourceConfig({ repoRoot, env: {} });
  assert.equal(first.deterministicSources.attempted, 0);
  assert.equal(first.deterministicSources.rss, 0);
  assert.equal(first.deterministicSources.boards, 0);
  assert.equal(
    first.searchSources.searches.some(
      (source) =>
        (source.source_type === "rss" || source.source_type === "board") && source.enabled !== false
    ),
    false,
    "the heal must not fabricate an enabled deterministic source"
  );

  const storedAfterFirst = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
  const updatedAfterFirst = sourceConfigUpdatedAt(repoRoot);
  const second = healSearchSourceConfig({ repoRoot, env: {} });
  assert.equal(second.healed, false);
  assert.equal(second.deterministicSources.attempted, 0);
  assert.deepEqual(second.searchSources, storedAfterFirst);
  assert.equal(sourceConfigUpdatedAt(repoRoot), updatedAfterFirst);
});

test("GET /api/search/sources returns healed readiness in one in-process request with zero AI or network calls", async () => {
  const repoRoot = tempRepo();
  seedCandidate(repoRoot, ["Applied AI Engineer", "Forward Deployed Engineer"]);
  putPreFixSearchSources(repoRoot);
  const server = bootServer(repoRoot);

  const response = await getJson(server, "/api/search/sources");

  assert.equal(response.status, 200);
  assert.ok(response.body.deterministicSources.attempted > 0);
  assert.ok(response.body.searches.enabled > 0);
  assert.equal(server.fetchCalls.length, 0);
  assert.equal(
    sourceConfigGet({ repoRoot, name: "search-sources" }).data.searches.some(
      (source) => source.provider === "RemoteVibeCodingJobs"
    ),
    true
  );
});
