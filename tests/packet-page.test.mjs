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
import { extractInlineScript } from "./html-test-helpers.mjs";

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-packet-page-"));
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

// GET /packet was intentionally removed from tracker-dev.mjs by a85a9e96
// ("retire the static-HTML dashboard and /evaluate, /answer, /packet,
// /search, /onboard, /tracker compat pages ... Electron only loads /app") —
// apps/web's SPA at /app is the canonical packet surface now.
// PACKET_PAGE_HTML itself still exists as an orphaned export (content still
// checked below), it's just no longer mounted, so the two HTTP-serving tests
// that used to live here are dead and deleted.

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
  const script = extractInlineScript(PACKET_PAGE_HTML);
  assert.ok(script, "expected an inline <script> block in the page");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(script);
  }, "packet-page.mjs's inline script has a JS syntax error — it would break the live page");
});

test("packet-page.mjs's inline <script> never uses a template literal or backtick", () => {
  // This page is itself an outer template literal (see the module source) —
  // a stray backtick or ${...} in the inner <script> would either break the
  // outer literal or silently get interpolated at module-load time instead of
  // shipping as literal client-side JS. Mirrors search-page.test.mjs's own
  // guard on this exact invariant.
  const script = extractInlineScript(PACKET_PAGE_HTML);
  assert.ok(script);
  assert.ok(!script.includes("`"), "inline script must not contain a backtick");
});

test("the Generate packet run POSTs the local packet generate API by default", () => {
  const script = extractInlineScript(PACKET_PAGE_HTML);
  assert.ok(script);
  assert.match(script, /fetch\("\/api\/packet\/generate"/);
  assert.match(script, /fetch\("\/api\/packet\/questions"/);
  assert.match(script, /questionCaptureState/);
  assert.match(script, /questionCapture: questionCaptureState/);
  assert.match(script, /packetQuestionExcludedCount/);
  assert.match(script, /excludedQuestionIds/);
  assert.doesNotMatch(script, /\/api\/skill\/run/);
  assert.doesNotMatch(script, /tailor-application/);
  assert.doesNotMatch(script, /tailorAllowed|CAREERRAT_RUNTIME_SKILLS/);
});

test("packet page captures application questions before local generation", () => {
  const script = extractInlineScript(PACKET_PAGE_HTML);
  assert.ok(script);
  assert.match(script, /function captureQuestions\(\)/);
  assert.match(script, /manualText: manualText/);
  assert.match(script, /url: url/);
  assert.match(script, /renderQuestionCaptureSummary/);
  assert.match(script, /answerable/);
  assert.match(script, /skipped/);
});

// ---------------------------------------------------------------------------
// Mounting /packet didn't disturb the existing routes
// ---------------------------------------------------------------------------

// "existing routes still work alongside the new /packet route" deleted —
// it asserted GET /evaluate and GET /search both 200, both retired by
// a85a9e96 alongside /packet itself. /api/health and /api/packet/list
// (409-no-db) coverage already lives in api-server.test.mjs and
// packet-route.test.mjs respectively.

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
