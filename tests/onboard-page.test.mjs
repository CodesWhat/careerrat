// tests/onboard-page.test.mjs
// node:test suite for the non-AI onboarding wizard's UI (M1 —
// src/core/onboarding/onboard-page.mjs, mounted at GET /onboard by
// tracker-dev.mjs). Mirrors tests/answer-page.test.mjs's structural
// approach exactly: hook presence, byte-static serving, and a
// `new Function()` syntax check on the inline <script> (never executed —
// the same guard client-script.test.mjs uses for DASHBOARD_SCRIPT). Does not
// re-test onboard-route.mjs's request/response contracts — that's
// tests/onboard-route.test.mjs's job; this file only confirms the page mounts
// correctly and doesn't disturb the other routes.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { ONBOARD_PAGE_HTML } from "../src/core/onboarding/onboard-page.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";

// A fresh repoRoot with its workspace dir pre-created — same convention
// tests/answer-page.test.mjs's tempRepoWithSkills() uses (no skills needed
// here since /onboard never calls POST /api/skill/run).
function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-onboard-page-"));
  mkdirSync(resolveUserPaths({ repoRoot }).workspaceDir, { recursive: true });
  return repoRoot;
}

function bootServer(repoRoot, opts = {}) {
  const dev = createDevServer({ repoRoot, ...opts });
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

// ---------------------------------------------------------------------------
// GET /onboard
// ---------------------------------------------------------------------------

// GET /onboard was intentionally removed from tracker-dev.mjs by a85a9e96
// ("retire the static-HTML dashboard and /evaluate, /answer, /packet,
// /search, /onboard, /tracker compat pages ... Electron only loads /app") —
// apps/web's SPA at /app is the canonical onboarding surface now.
// ONBOARD_PAGE_HTML itself still exists as an orphaned export (content still
// checked below), it's just no longer mounted, so the two HTTP-serving tests
// that used to live here are dead and deleted.

test("GET /onboard's steps 2-8 start hidden; step 1 does not", async () => {
  const html = ONBOARD_PAGE_HTML;
  const step1 = /<section id="step-1"[^>]*>/.exec(html);
  assert.ok(step1, "expected a step-1 section");
  assert.ok(!step1[0].includes("hidden"), "step 1 should be visible by default");
  for (let i = 2; i <= 8; i++) {
    const re = new RegExp(`<section id="step-${i}"[^>]*>`);
    const match = re.exec(html);
    assert.ok(match, `expected a step-${i} section`);
    assert.ok(match[0].includes("hidden"), `step ${i} should start hidden`);
  }
});

test("the finish-links panel starts hidden (only revealed after write-config succeeds)", async () => {
  const match = /<div id="finish-links"[^>]*>/.exec(ONBOARD_PAGE_HTML);
  assert.ok(match);
  assert.ok(match[0].includes("hidden"));
});

// ---------------------------------------------------------------------------
// Inline <script> — syntax-only guard, never executed (see client-script.test.mjs)
// ---------------------------------------------------------------------------

test("onboard-page.mjs inline <script> parses as valid JavaScript (no syntax error)", () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(ONBOARD_PAGE_HTML);
  assert.ok(match, "expected an inline <script> block in the page");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(match[1]);
  }, "onboard-page.mjs's inline script has a JS syntax error — it would break the live page");
});

test("onboard-page.mjs's inline <script> never uses a template literal or backtick", () => {
  // This page is itself an outer template literal (see the module source) —
  // a stray backtick or ${...} in the inner <script> would either break the
  // outer literal or silently get interpolated at module-load time instead of
  // shipping as literal client-side JS. The whole file is written to avoid
  // backticks entirely; this test guards that invariant going forward.
  const match = /<script>([\s\S]*?)<\/script>/.exec(ONBOARD_PAGE_HTML);
  assert.ok(match);
  assert.ok(!match[1].includes("`"), "inline script must not contain a backtick");
});

// ---------------------------------------------------------------------------
// Mounting /onboard didn't disturb the existing routes
// ---------------------------------------------------------------------------

// "existing routes still work alongside the new /onboard route" deleted —
// it asserted GET /evaluate and GET /answer both 200, both retired by
// a85a9e96 alongside /onboard itself. /api/health and /api/onboard/state
// coverage already lives in api-server.test.mjs and onboard-route.test.mjs
// respectively.

test("the 404 fallback body mentions /onboard and the onboarding API routes", async () => {
  const repoRoot = tempRepo();
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/this-route-does-not-exist`);
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.match(text, /\/onboard/);
    assert.match(text, /\/api\/onboard\/state/);
  } finally {
    teardown(dev, repoRoot);
  }
});
