// tests/packet-page.test.mjs
// node:test suite for the M4 /packet view's UI (src/core/onboarding/packet-page.mjs,
// mounted at GET /packet by tracker-dev.mjs). Mirrors tests/search-page.test.mjs's
// structural approach: hook presence, byte-static serving, and a `new Function()`
// syntax check on the inline <script> (never executed — the same guard
// client-script.test.mjs uses for DASHBOARD_SCRIPT). Does not re-test
// packet-route.mjs's request/response contracts — that's
// tests/packet-route.test.mjs's job; this file only confirms the page mounts
// correctly and doesn't disturb the other routes.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { PACKET_PAGE_HTML } from "../src/core/onboarding/packet-page.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-packet-page-"));
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
// GET /packet
// ---------------------------------------------------------------------------

test("GET /packet returns HTML with the expected structural hooks", async () => {
  const repoRoot = tempRepo();
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/packet`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    for (const hook of [
      'data-hook="packet-picker"',
      'data-hook="detail-section"',
      'data-hook="detail-title"',
      'data-hook="generate-btn"',
      'data-hook="run-status"',
      'data-hook="feed-section"',
      'data-hook="generate-feed"',
      'data-hook="error-box"',
      'data-hook="packet-tabs"',
      'data-hook="tab-btn-resume"',
      'data-hook="tab-btn-coverLetter"',
      'data-hook="tab-btn-answers"',
      'data-hook="pane-resume"',
      'data-hook="pane-coverLetter"',
      'data-hook="pane-answers"',
      'data-hook="link-answer"',
      'data-hook="link-tracker"',
    ]) {
      assert.ok(html.includes(hook), `expected ${hook} in the page`);
    }
    // Generate is hidden until a packet is selected + evaluated for
    // completeness, and the detail section itself starts hidden.
    assert.match(html, /id="generate-btn"[^>]*hidden/);
    assert.match(html, /id="detail-section"[^>]*hidden/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /packet serves the same byte-static page regardless of repo state", async () => {
  const repoRoot = tempRepo();
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/packet`);
    const html = await res.text();
    assert.equal(html, PACKET_PAGE_HTML);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("the packet-picker container starts with a loading message, not a packet-row", () => {
  assert.ok(PACKET_PAGE_HTML.includes("Loading"));
  assert.ok(!/data-hook="packet-row"/.test(PACKET_PAGE_HTML));
});

test("the needs-you-link and NEEDS YOU highlighting are built client-side per artifact, not baked into the static markup", () => {
  assert.ok(!/data-hook="needs-you-link"/.test(PACKET_PAGE_HTML));
  assert.match(PACKET_PAGE_HTML, /setAttribute\("data-hook", "needs-you-link"\)/);
  assert.match(PACKET_PAGE_HTML, /highlightNeedsYou/);
});

test("binary packet artifacts render as open links instead of markdown panes", () => {
  assert.match(PACKET_PAGE_HTML, /artifact\.binary/);
  assert.match(PACKET_PAGE_HTML, /setAttribute\("data-hook", "artifact-open-link"\)/);
  assert.match(PACKET_PAGE_HTML, /artifact\.url/);
});

// ---------------------------------------------------------------------------
// Inline <script> — syntax-only guard, never executed (see client-script.test.mjs)
// ---------------------------------------------------------------------------

test("packet-page.mjs inline <script> parses as valid JavaScript (no syntax error)", () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(PACKET_PAGE_HTML);
  assert.ok(match, "expected an inline <script> block in the page");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(match[1]);
  }, "packet-page.mjs's inline script has a JS syntax error — it would break the live page");
});

test("packet-page.mjs's inline <script> never uses a template literal or backtick", () => {
  // This page is itself an outer template literal (see the module source) —
  // a stray backtick or ${...} in the inner <script> would either break the
  // outer literal or silently get interpolated at module-load time instead of
  // shipping as literal client-side JS. Mirrors search-page.test.mjs's own
  // guard on this exact invariant.
  const match = /<script>([\s\S]*?)<\/script>/.exec(PACKET_PAGE_HTML);
  assert.ok(match);
  assert.ok(!match[1].includes("`"), "inline script must not contain a backtick");
});

test("the Generate packet run POSTs the local packet generate API by default", () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(PACKET_PAGE_HTML);
  assert.ok(match);
  const script = match[1];
  assert.match(script, /fetch\("\/api\/packet\/generate"/);
  assert.doesNotMatch(script, /\/api\/skill\/run/);
  assert.doesNotMatch(script, /tailor-application/);
  assert.doesNotMatch(script, /tailorAllowed|ROLESTER_RUNTIME_SKILLS/);
});

// ---------------------------------------------------------------------------
// Mounting /packet didn't disturb the existing routes
// ---------------------------------------------------------------------------

test("existing routes still work alongside the new /packet route", async () => {
  const repoRoot = tempRepo();
  const dev = await bootServer(repoRoot);
  try {
    const health = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(health.status, 200);

    const evaluate = await fetch(`${baseUrl(dev)}/evaluate`);
    assert.equal(evaluate.status, 200);

    const search = await fetch(`${baseUrl(dev)}/search`);
    assert.equal(search.status, 200);

    const list = await fetch(`${baseUrl(dev)}/api/packet/list`);
    // No DB is seeded in this fixture. The DB-first route should still be
    // mounted and answering with a setup conflict, not falling through.
    assert.equal(list.status, 409);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("the 404 fallback body mentions /packet and its API routes", async () => {
  const repoRoot = tempRepo();
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/this-route-does-not-exist`);
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.match(text, /\/packet/);
    assert.match(text, /\/api\/packet\/list/);
    assert.match(text, /\/api\/packet/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("the onboard finish panel and chat done panel link to /packet without a 'coming soon' label", async () => {
  const { ONBOARD_PAGE_HTML } = await import("../src/core/onboarding/onboard-page.mjs");
  const { CHAT_PAGE_HTML } = await import("../src/core/onboarding/chat-page.mjs");
  assert.match(
    ONBOARD_PAGE_HTML,
    /<a id="link-packet" data-hook="link-packet" href="\/packet">Packet<\/a>/
  );
  assert.match(
    CHAT_PAGE_HTML,
    /<a id="link-packet" data-hook="link-packet" href="\/packet">Packet<\/a>/
  );
  assert.ok(!/coming soon/i.test(ONBOARD_PAGE_HTML));
  assert.ok(!/coming soon/i.test(CHAT_PAGE_HTML));
});
