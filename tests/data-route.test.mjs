// tests/data-route.test.mjs — the HTTP surface for M6's sqlite data layer
// (src/cli/data-route.mjs), mounted on a bare addRoute Map wrapped in
// http.createServer, mirroring tests/packet-route.test.mjs's bootServer() and
// tests/skill-run-route.test.mjs's POST-body pattern. Covers: happy-path reads
// + writes, fail-closed 409 when no db exists yet, and 400/404 validation.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mountDataRoutes } from "../src/cli/data-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-data-route-"));
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

function bootServer(repoRoot) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDataRoutes({ addRoute, repoRoot, env: {} });

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

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function seedDb(repoRoot) {
  const sourceDir = join(repoRoot, "fixture-source");
  const applications = [
    { id: "app-1", company: "Acme", role: "Staff Engineer", status: "reviewed-hold" },
    { id: "app-2", company: "Globex", role: "PM", status: "interview" },
  ];
  const communications = [
    { id: "comm-1", applicationId: "app-1", company: "Acme", channel: "email", status: "waiting" },
  ];
  const sourced = [{ id: "sourced-1", company: "Initech", fitScore: 60 }];
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify({ meta: {}, applications, sourced, sources: [], communications }, null, 2)
  );
  importFromTracker({ repoRoot, sourceDir });
}

// ---------------------------------------------------------------------------
// Fail-closed: no db file yet -> 409 on every route, per decision 7.
// ---------------------------------------------------------------------------

test("GET /api/data/snapshot: 409 with the exact fail-closed message when no db exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/data/snapshot");
    assert.equal(status, 409);
    assert.match(body.error, /no database yet/);
    assert.match(body.error, /rolester data import/);
    assert.match(body.error, /rolester data init/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/app/status: 409 when no db exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/data/app/status", {
      id: "app-1",
      to: "offer",
    });
    assert.equal(status, 409);
    assert.match(body.error, /no database yet/);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Reads — happy path
// ---------------------------------------------------------------------------

test("GET /api/data/snapshot: counts + meta once a db exists", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/data/snapshot");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.counts, {
      applications: 2,
      sourced: 1,
      sources: 0,
      communications: 1,
      activity: 0,
    });
  } finally {
    await closeServer(server);
  }
});

test("GET /api/data/applications: optional status/company filters", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const all = await getJson(server, "/api/data/applications");
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 2);

    const filtered = await getJson(server, "/api/data/applications?status=interview");
    assert.equal(filtered.body.data.length, 1);
    assert.equal(filtered.body.data[0].id, "app-2");

    const byCompany = await getJson(server, "/api/data/applications?company=Acme");
    assert.equal(byCompany.body.data.length, 1);
    assert.equal(byCompany.body.data[0].id, "app-1");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/data/applications/one?id=: 400 without ?id=, 404 for an unknown id, 200 for a known one", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingParam = await getJson(server, "/api/data/applications/one");
    assert.equal(missingParam.status, 400);

    const notFound = await getJson(server, "/api/data/applications/one?id=does-not-exist");
    assert.equal(notFound.status, 404);

    const found = await getJson(server, "/api/data/applications/one?id=app-1");
    assert.equal(found.status, 200);
    assert.equal(found.body.data.company, "Acme");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/data/sourced and /api/data/communications: 200 with the seeded rows", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const sourced = await getJson(server, "/api/data/sourced");
    assert.equal(sourced.status, 200);
    assert.equal(sourced.body.data.length, 1);

    const comms = await getJson(server, "/api/data/communications");
    assert.equal(comms.status, 200);
    assert.equal(comms.body.data.length, 1);
    assert.equal(comms.body.data[0].id, "comm-1");
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Writes — happy path, thin shims over the same verbs the CLI calls
// ---------------------------------------------------------------------------

test("POST /api/data/app/status: 400 when body.to is missing, 200 + persisted change otherwise", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingTo = await postJson(server, "/api/data/app/status", { id: "app-1" });
    assert.equal(missingTo.status, 400);

    const ok = await postJson(server, "/api/data/app/status", { id: "app-1", to: "offer" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.data.to, "offer");
    assert.equal(typeof ok.body.meta.version, "number");

    const db = openDb({ repoRoot });
    const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-1");
    assert.equal(JSON.parse(row.data).status, "offer");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/app/fields: 400 without body.patch, 200 + merged fields otherwise", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingPatch = await postJson(server, "/api/data/app/fields", { id: "app-1" });
    assert.equal(missingPatch.status, 400);

    const ok = await postJson(server, "/api/data/app/fields", {
      id: "app-1",
      patch: { statusNote: "hi" },
    });
    assert.equal(ok.status, 200);

    const db = openDb({ repoRoot });
    const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-1");
    assert.equal(JSON.parse(row.data).statusNote, "hi");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/sourced/promote: 404 for an unknown sourced id, 200 for a known one", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const notFound = await postJson(server, "/api/data/sourced/promote", { id: "does-not-exist" });
    assert.equal(notFound.status, 404);

    const ok = await postJson(server, "/api/data/sourced/promote", { id: "sourced-1" });
    assert.equal(ok.status, 200);

    const db = openDb({ repoRoot });
    const stillSourced = db.prepare("SELECT 1 FROM sourced WHERE id = ?").get("sourced-1");
    assert.equal(stillSourced, undefined);
    const promoted = db.prepare("SELECT data FROM applications WHERE id = ?").get("sourced-1");
    assert.ok(promoted);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/comm/send: sent-clears-draft, 404 for an unknown comm id", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const notFound = await postJson(server, "/api/data/comm/send", { id: "does-not-exist" });
    assert.equal(notFound.status, 404);

    const ok = await postJson(server, "/api/data/comm/send", { id: "comm-1" });
    assert.equal(ok.status, 200);

    const db = openDb({ repoRoot });
    const row = db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-1");
    const comm = JSON.parse(row.data);
    assert.equal(comm.status, "waiting");
    assert.equal(comm.draft, null);
  } finally {
    await closeServer(server);
  }
});

test("malformed JSON body: 400, not a 500", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/data/app/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  } finally {
    await closeServer(server);
  }
});
