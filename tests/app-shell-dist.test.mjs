// tests/app-shell-dist.test.mjs
// node:test suite for tracker-dev.mjs's M7 "/app/*" static + SPA-fallback
// handler (serveApp(), src/cli/tracker-dev.mjs). Exercises createDevServer()
// against an isolated temp repoRoot with a hand-written fake apps/web/dist
// fixture — mirrors tests/api-server.test.mjs's tempRepo() convention.
//
// This suite never invokes the real `vite build` (that's the non-gating CI
// web-build job's job, plus the root `prepack` script before npm
// pack/publish); it proves the SERVING CONTRACT instead: a built index.html
// is returned for both "/app" and any extension-less client route, a real
// hashed asset comes back with the right content-type and a long-lived cache
// header, the "SPA never built" placeholder page is served (503, never a
// raw 404) when apps/web/dist doesn't exist at all, and every legacy route
// keeps working unaffected. The path-traversal guard itself (safeAssetPath)
// already has its own direct unit tests in tests/tracker-dev-server.test.mjs
// — serveApp() reuses that exact function rather than re-implementing it, so
// this suite doesn't re-test the guard.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-app-dist-"));
  mkdirSync(resolveUserPaths({ repoRoot }).workspaceDir, { recursive: true });
  return repoRoot;
}

function writeFakeDist(repoRoot) {
  const distDir = join(repoRoot, "apps/web/dist");
  const assetsDir = join(distDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(
    join(distDir, "index.html"),
    '<!doctype html><html><body><div id="root"></div>' +
      '<script type="module" src="/app/assets/main-abc123.js"></script></body></html>'
  );
  writeFileSync(join(assetsDir, "main-abc123.js"), "console.log('rolester app shell fixture');");
}

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

function teardown(dev, repoRoot) {
  dev.closeClients();
  dev.stopWatching();
  dev.server.close();
  rmSync(repoRoot, { recursive: true, force: true });
}

test("GET /app serves the built index.html with no-store", async () => {
  const repoRoot = tempRepo();
  writeFakeDist(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/app`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.text();
    assert.match(body, /id="root"/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /app/ (trailing slash) serves the same index.html", async () => {
  const repoRoot = tempRepo();
  writeFakeDist(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/app/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="root"/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /app/settings (an extension-less client route) falls back to the same index.html", async () => {
  const repoRoot = tempRepo();
  writeFakeDist(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/app/settings`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="root"/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /app/onboarding (M8 wizard route) falls back to the same index.html", async () => {
  const repoRoot = tempRepo();
  writeFakeDist(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/app/onboarding`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="root"/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /app/inbox (M9 Inbox route) falls back to the same index.html", async () => {
  const repoRoot = tempRepo();
  writeFakeDist(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/app/inbox`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="root"/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /app/assets/main-abc123.js serves the real hashed asset with a JS content-type and a long-lived cache", async () => {
  const repoRoot = tempRepo();
  writeFakeDist(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/app/assets/main-abc123.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /javascript/);
    assert.match(res.headers.get("cache-control") || "", /immutable/);
    const body = await res.text();
    assert.match(body, /rolester app shell fixture/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /app serves a 503 placeholder (never a raw 404) when apps/web/dist doesn't exist yet", async () => {
  const repoRoot = tempRepo();
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/app`);
    assert.equal(res.status, 503);
    const body = await res.text();
    assert.match(body, /app:build/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("legacy routes are unaffected: GET /api/health and GET /onboard still 200 alongside /app", async () => {
  const repoRoot = tempRepo();
  writeFakeDist(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const health = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const onboard = await fetch(`${baseUrl(dev)}/onboard`);
    assert.equal(onboard.status, 200);
    assert.match(await onboard.text(), /<html/i);
  } finally {
    teardown(dev, repoRoot);
  }
});
