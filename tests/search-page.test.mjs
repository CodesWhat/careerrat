// tests/search-page.test.mjs
// node:test suite for the M3 /search surface's UI
// (src/core/onboarding/search-page.mjs, mounted at GET /search by
// tracker-dev.mjs). Mirrors tests/onboard-page.test.mjs's structural
// approach: hook presence, byte-static serving, and a `new Function()`
// syntax check on the inline <script> (never executed — the same guard
// client-script.test.mjs uses for DASHBOARD_SCRIPT). Does not re-test
// search-route.mjs's request/response contracts — that's
// tests/search-route.test.mjs's job; this file only confirms the page mounts
// correctly and doesn't disturb the other routes.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { SEARCH_PAGE_HTML } from "../src/core/onboarding/search-page.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-search-page-"));
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
// GET /search
// ---------------------------------------------------------------------------

// GET /search was intentionally removed from tracker-dev.mjs by a85a9e96
// ("retire the static-HTML dashboard and /evaluate, /answer, /packet,
// /search, /onboard, /tracker compat pages ... Electron only loads /app") —
// the route is gone, apps/web's SPA at /app is the canonical surface now.
// SEARCH_PAGE_HTML itself still exists as an orphaned export (still checked
// below for content/hook correctness), it's just no longer mounted, so the
// two HTTP-serving tests that used to live here are dead and deleted.

test("the results-list container starts with an empty-state message, not an offer-row", () => {
  assert.ok(SEARCH_PAGE_HTML.includes("No results yet"));
  assert.ok(!/data-hook="offer-row"/.test(SEARCH_PAGE_HTML));
});

// ---------------------------------------------------------------------------
// Inline <script> — syntax-only guard, never executed (see client-script.test.mjs)
// ---------------------------------------------------------------------------

test("search-page.mjs inline <script> parses as valid JavaScript (no syntax error)", () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(SEARCH_PAGE_HTML);
  assert.ok(match, "expected an inline <script> block in the page");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(match[1]);
  }, "search-page.mjs's inline script has a JS syntax error — it would break the live page");
});

test("search-page.mjs's inline <script> never uses a template literal or backtick", () => {
  // This page is itself an outer template literal (see the module source) —
  // a stray backtick or ${...} in the inner <script> would either break the
  // outer literal or silently get interpolated at module-load time instead of
  // shipping as literal client-side JS. Mirrors onboard-page.test.mjs's own
  // guard on this exact invariant.
  const match = /<script>([\s\S]*?)<\/script>/.exec(SEARCH_PAGE_HTML);
  assert.ok(match);
  assert.ok(!match[1].includes("`"), "inline script must not contain a backtick");
});

test("the offer-evaluate link is built against /evaluate?url=", () => {
  // Rows (and their "Evaluate" link) are built client-side per result, so the
  // data-hook is set via setAttribute() in the script rather than appearing
  // literally as data-hook="offer-evaluate" in the static markup.
  assert.match(SEARCH_PAGE_HTML, /\/evaluate\?url=/);
  assert.match(SEARCH_PAGE_HTML, /setAttribute\("data-hook", "offer-evaluate"\)/);
});

test("scanner review panel exposes public-intel hooks, copy, and local decision wiring", () => {
  for (const hook of [
    'data-hook="scanner-review-section"',
    'data-hook="scanner-review-list"',
    'data-hook="scanner-review-empty"',
    'data-hook="scanner-review-error"',
  ]) {
    assert.ok(SEARCH_PAGE_HTML.includes(hook), `expected ${hook}`);
  }

  assert.match(SEARCH_PAGE_HTML, /No scanner reviews/);
  assert.match(SEARCH_PAGE_HTML, /Clean misses are recorded locally and do not interrupt you/);
  for (const label of [
    "Use supported ATS",
    "Keep public metadata",
    "Refresh scan",
    "Suppress review",
    "Escalate to agent",
  ]) {
    assert.ok(SEARCH_PAGE_HTML.includes(label), `expected ${label}`);
  }

  assert.match(SEARCH_PAGE_HTML, /\/api\/discovery\/public-intel\/review/);
  assert.match(SEARCH_PAGE_HTML, /\/api\/discovery\/public-intel\/review-decisions/);
});

// ---------------------------------------------------------------------------
// Mounting /search didn't disturb the existing routes
// ---------------------------------------------------------------------------

// "existing routes still work alongside the new /search route" deleted —
// it asserted GET /evaluate and GET /onboard both 200, both retired by
// a85a9e96 alongside /search itself. /api/health and /api/search/sources
// (409-no-db) coverage already lives in api-server.test.mjs and
// search-route.test.mjs respectively.

test("the 404 fallback body mentions /search and its API routes", async () => {
  const repoRoot = tempRepo();
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/this-route-does-not-exist`);
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.match(text, /\/search/);
    assert.match(text, /\/api\/search\/scan/);
    assert.match(text, /\/api\/search\/results/);
    assert.match(text, /\/api\/search\/sources/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("the onboard finish panel and chat done panel link to /search without a 'coming soon' label", async () => {
  const { ONBOARD_PAGE_HTML } = await import("../src/core/onboarding/onboard-page.mjs");
  const { CHAT_PAGE_HTML } = await import("../src/core/onboarding/chat-page.mjs");
  assert.match(
    ONBOARD_PAGE_HTML,
    /<a id="link-search" data-hook="link-search" href="\/search">Search<\/a>/
  );
  assert.match(
    CHAT_PAGE_HTML,
    /<a id="link-search" data-hook="link-search" href="\/search">Search<\/a>/
  );
  assert.ok(!/coming soon/i.test(ONBOARD_PAGE_HTML));
  assert.ok(!/coming soon/i.test(CHAT_PAGE_HTML));
});
