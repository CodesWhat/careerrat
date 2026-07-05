// tests/boards-route.test.mjs
// node:test suite for the additive M8 board-URL route (src/cli/boards-route.mjs)
// Builder B (wizard UI) had to add — see that file's own header comment for
// why it didn't already exist. Mirrors tests/onboard-route.test.mjs's bare
// addRoute-Map-over-http.createServer harness; no full tracker-dev.mjs needed.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mountBoardsRoutes } from "../src/cli/boards-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { sourceConfigGet, sourceConfigPut } from "../src/core/db/verbs/source-config.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-boards-route-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileSync(
    join(repoRoot, "config/search-sources.schema.json"),
    readFileSync(join(REAL_ROOT, "config/search-sources.schema.json"))
  );
  return repoRoot;
}

function bootServer(repoRoot) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountBoardsRoutes({ addRoute, repoRoot, env: {} });

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

async function postJson(server, path, body) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
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
// POST /api/boards/preview
// ---------------------------------------------------------------------------

test("POST /api/boards/preview: keywords only -> both builders succeed", async () => {
  const server = await bootServer(tempRepo());
  try {
    const { status, body } = await postJson(server, "/api/boards/preview", {
      keywords: "Forward Deployed Engineer",
    });
    assert.equal(status, 200);
    assert.match(body.hiringCafe.url, /^https:\/\/hiring\.cafe\/\?searchState=/);
    assert.equal(
      body.linkedin.url,
      "https://www.linkedin.com/jobs/search/?keywords=%22Forward%20Deployed%20Engineer%22&sortBy=DD"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/boards/preview: derives f_SB2 from minimumBase and f_TPR from windowHours", async () => {
  const server = await bootServer(tempRepo());
  try {
    const { status, body } = await postJson(server, "/api/boards/preview", {
      keywords: "Forward Deployed Engineer",
      location: "United States",
      minimumBase: 200000,
      windowHours: 24,
    });
    assert.equal(status, 200);
    assert.equal(
      body.linkedin.url,
      "https://www.linkedin.com/jobs/search/?keywords=%22Forward%20Deployed%20Engineer%22" +
        "&location=United%20States&f_TPR=r86400&f_SB2=9&sortBy=DD"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/boards/preview: missing keywords -> 400", async () => {
  const server = await bootServer(tempRepo());
  try {
    const { status, body } = await postJson(server, "/api/boards/preview", {});
    assert.equal(status, 400);
    assert.match(body.error, /keywords/);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/boards/add
// ---------------------------------------------------------------------------

test("POST /api/boards/add: missing url -> 400", async () => {
  const server = await bootServer(tempRepo());
  try {
    const { status, body } = await postJson(server, "/api/boards/add", {});
    assert.equal(status, 400);
    assert.match(body.error, /url/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/boards/add: an unparseable URL -> 400, nothing written", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status } = await postJson(server, "/api/boards/add", { url: "not a url" });
    assert.equal(status, 400);
    assert.equal(existsSync(userPath({ repoRoot }, "config/search-sources.yml")), false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/boards/add: valid URL without an initialized DB -> 409", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/boards/add", {
      url: "https://www.linkedin.com/jobs/search/?keywords=%22Forward%20Deployed%20Engineer%22",
    });
    assert.equal(status, 409);
    assert.match(body.error, /database/i);
    assert.equal(existsSync(userPath({ repoRoot }, "config/search-sources.yml")), false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/boards/add: a LinkedIn URL persists an auth:true, enabled:false DB browser source", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const linkedinUrl =
      "https://www.linkedin.com/jobs/search/?keywords=%22Forward%20Deployed%20Engineer%22" +
      "&location=United%20States&f_TPR=r86400&f_SB2=9&sortBy=DD";
    const { status, body } = await postJson(server, "/api/boards/add", {
      url: linkedinUrl,
      label: "LinkedIn — FDE",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.searches.length, 1);
    assert.equal(body.searches[0].auth, true);
    assert.equal(body.searches[0].platform, "linkedin");
    assert.equal(body.searches[0].enabled, false);

    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.equal(stored.searches.length, 1);
    assert.equal(stored.searches[0].url, linkedinUrl);
    assert.equal(stored.searches[0].label, "LinkedIn — FDE");
    assert.equal(stored.searches[0].enabled, false);
    assert.equal(existsSync(userPath({ repoRoot }, "config/search-sources.yml")), false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/boards/add: appends onto an existing config rather than overwriting it", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: { positive: [], negative: [] },
      location_filter: { always_allow: [], allow: [], block: [] },
      searches: [
        {
          provider: "HiringCafe",
          source_type: "url-query",
          label: "existing",
          query: "existing",
          enabled: true,
        },
      ],
      tracked_companies: [],
      source_catalog: {},
    },
  });
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/boards/add", {
      url: "https://www.linkedin.com/jobs/search/?keywords=%22X%22&sortBy=DD",
    });
    assert.equal(status, 200);
    assert.equal(body.searches.length, 2);
    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.equal(stored.searches.length, 2);
    assert.equal(stored.searches[0].label, "existing");
    assert.equal(stored.searches[1].platform, "linkedin");
    assert.equal(existsSync(userPath({ repoRoot }, "config/search-sources.yml")), false);
  } finally {
    await closeServer(server);
  }
});
