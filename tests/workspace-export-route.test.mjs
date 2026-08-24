import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import JSZip from "jszip";

import { mountWorkspaceExportRoutes } from "../src/cli/workspace-export-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const roots = [];

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function boot(repoRoot, options = {}) {
  const routes = new Map();
  mountWorkspaceExportRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env: {},
    ...options,
  });
  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${path}`);
    if (!route) return res.writeHead(404).end();
    dispatchHttpRoute(route, req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function url(server, path) {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

test("GET export-everything downloads a consistent zip snapshot", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-export-route-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  const server = await boot(repoRoot);
  try {
    const response = await fetch(url(server, "/api/data/export-everything"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.match(
      response.headers.get("content-disposition"),
      /^attachment; filename="careerrat-export-/
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    assert.ok(zip.file("database/careerrat.db"));
    assert.ok(zip.file("manifest.json"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("GET export-everything fails closed without a database", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-export-route-no-db-"));
  roots.push(repoRoot);
  const server = await boot(repoRoot);
  try {
    const response = await fetch(url(server, "/api/data/export-everything"));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "NO_DATABASE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("GET export-everything reports a busy workspace as a retryable conflict", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-export-route-busy-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  const server = await boot(repoRoot, {
    buildExport: async () => {
      const error = new Error("workspace changed during export");
      error.code = "EXPORT_BUSY";
      throw error;
    },
  });
  try {
    const response = await fetch(url(server, "/api/data/export-everything"));
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("retry-after"), "1");
    const body = await response.json();
    assert.equal(body.code, "EXPORT_BUSY");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
