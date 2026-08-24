import assert from "node:assert/strict";
import { test } from "node:test";
import { mimeFor, resolvePort, safeAssetPath } from "../src/core/tracker/dev-server.mjs";

// ── mimeFor ──────────────────────────────────────────────────────────────────

test("mimeFor maps known extensions and defaults to octet-stream", () => {
  assert.equal(mimeFor("/a/logo.png"), "image/png");
  assert.equal(mimeFor("x.JPG"), "image/jpeg");
  assert.equal(mimeFor("black-mesa.svg"), "image/svg+xml");
  assert.equal(mimeFor("photo.webp"), "image/webp");
  assert.equal(mimeFor("favicon.ico"), "image/x-icon");
  assert.equal(mimeFor("dashboard-data.js"), "text/javascript; charset=utf-8");
  assert.equal(mimeFor("tracker.json"), "application/json; charset=utf-8");
  assert.equal(mimeFor("GeistVF.woff2"), "font/woff2");
  assert.equal(mimeFor("data.bin"), "application/octet-stream");
  assert.equal(mimeFor("noext"), "application/octet-stream");
});

// ── safeAssetPath: the path-traversal guard ──────────────────────────────────

const ASSETS = "/repo/assets";

test("safeAssetPath resolves a normal asset under the assets dir", () => {
  const r = safeAssetPath(ASSETS, "/assets/logo.png");
  assert.equal(r.ok, true);
  assert.equal(r.full, "/repo/assets/logo.png");
});

test("safeAssetPath resolves a nested asset", () => {
  const r = safeAssetPath(ASSETS, "/assets/logos/black-mesa.svg");
  assert.equal(r.ok, true);
  assert.equal(r.full, "/repo/assets/logos/black-mesa.svg");
});

test("safeAssetPath rejects ../ traversal with 403", () => {
  const r = safeAssetPath(ASSETS, "/assets/../package.json");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("safeAssetPath rejects percent-encoded traversal with 403", () => {
  const r = safeAssetPath(ASSETS, "/assets/%2e%2e%2fpackage.json");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("safeAssetPath rejects nested traversal that escapes the dir", () => {
  const r = safeAssetPath(ASSETS, "/assets/logos/../../secret");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("safeAssetPath rejects an absolute path with 403", () => {
  const r = safeAssetPath(ASSETS, "/assets//etc/passwd");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("safeAssetPath rejects a null byte with 403", () => {
  const r = safeAssetPath(ASSETS, "/assets/foo%00.png");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("safeAssetPath returns 400 on malformed percent-encoding", () => {
  const r = safeAssetPath(ASSETS, "/assets/%E0%A4%A");
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test("safeAssetPath returns 404 for a non-/assets path", () => {
  const r = safeAssetPath(ASSETS, "/secret");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test("safeAssetPath does not treat a sibling dir prefix as inside", () => {
  // /repo/assets-evil must not pass as under /repo/assets.
  const r = safeAssetPath(ASSETS, "/assets/../assets-evil/x");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("safeAssetPath supports a custom static prefix", () => {
  const r = safeAssetPath("/repo/app", "/app/assets/index.js", "/app/");
  assert.equal(r.ok, true);
  assert.equal(r.full, "/repo/app/assets/index.js");
});

test("safeAssetPath custom prefix keeps traversal blocked", () => {
  const r = safeAssetPath("/repo/app", "/app/../package.json", "/app/");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

// ── resolvePort ──────────────────────────────────────────────────────────────

test("resolvePort: --port flag wins", () => {
  assert.equal(resolvePort(["--port", "8080"], { CAREERRAT_DEV_PORT: "9000" }), 8080);
});

test("resolvePort: env used when no flag", () => {
  assert.equal(resolvePort([], { CAREERRAT_DEV_PORT: "9000" }), 9000);
});

test("resolvePort: default 7777 when nothing set", () => {
  assert.equal(resolvePort([], {}), 7777);
});

test("resolvePort: invalid flag falls through to env then default", () => {
  assert.equal(resolvePort(["--port", "abc"], { CAREERRAT_DEV_PORT: "9000" }), 9000);
  assert.equal(resolvePort(["--port", "99999"], {}), 7777);
  assert.equal(resolvePort(["--port", "0"], {}), 7777);
});
