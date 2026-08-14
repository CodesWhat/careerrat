// tests/chat-page.test.mjs
// node:test suite for GET /chat (src/core/onboarding/chat-page.mjs, mounted by
// tracker-dev.mjs). Mirrors tests/answer-page.test.mjs's approach exactly —
// structural hooks, byte-static serving, and a `new Function()` syntax check
// on the inline <script> (never executed, the same guard client-script.test.mjs
// uses for DASHBOARD_SCRIPT). Does not re-test POST /api/chat/* mechanics —
// that's tests/chat-route.test.mjs's job and tests/chat-runtime.test.mjs's
// job; this file only confirms the page itself is well-formed and that
// mounting /chat didn't disturb the existing routes.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { CHAT_PAGE_HTML } from "../src/core/onboarding/chat-page.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";
import { extractInlineScript } from "./html-test-helpers.mjs";

// A fresh repoRoot with its workspace dir pre-created plus fake SKILL.md
// directories for each name in `skillNames` — same convention
// tests/answer-page.test.mjs's tempRepoWithSkills() uses.
function tempRepoWithSkills(skillNames = []) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-chat-page-"));
  mkdirSync(resolveUserPaths({ repoRoot }).workspaceDir, { recursive: true });
  for (const name of skillNames) {
    const dir = join(repoRoot, ".agents/skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`, "utf8");
  }
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
  dev.chatRuntime.shutdown();
  dev.server.close();
  rmSync(repoRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// GET /chat
// ---------------------------------------------------------------------------

test("GET /chat returns HTML with the expected structural hooks", async () => {
  const repoRoot = tempRepoWithSkills(["ingest-profile"]);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/chat`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    for (const hook of [
      'data-hook="start-section"',
      'data-hook="start-btn"',
      'data-hook="chat-section"',
      'data-hook="chat-status"',
      'data-hook="end-btn"',
      'data-hook="chat-transcript"',
      'data-hook="chat-banner"',
      'data-hook="chat-input"',
      'data-hook="chat-send"',
      'data-hook="setup-progress"',
      'data-hook="chat-done"',
      'data-hook="link-onboard"',
      'data-hook="link-search"',
      'data-hook="link-evaluate"',
      'data-hook="link-tracker"',
    ]) {
      assert.ok(html.includes(hook), `expected ${hook} in the page`);
    }
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /chat's completion panel links to /onboard, /search, /evaluate, /tracker", async () => {
  const repoRoot = tempRepoWithSkills(["ingest-profile"]);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/chat`);
    const html = await res.text();
    assert.match(
      html,
      /<a id="link-onboard" data-hook="link-onboard" href="\/onboard">Onboarding wizard<\/a>/
    );
    assert.match(html, /<a id="link-search" data-hook="link-search" href="\/search">Search<\/a>/);
    assert.match(
      html,
      /<a id="link-evaluate" data-hook="link-evaluate" href="\/evaluate">Evaluate a job<\/a>/
    );
    assert.match(
      html,
      /<a id="link-tracker" data-hook="link-tracker" href="\/tracker">Tracker<\/a>/
    );
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /chat serves the same byte-static page regardless of repo state", async () => {
  const repoRoot = tempRepoWithSkills([]);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/chat`);
    const html = await res.text();
    assert.equal(html, CHAT_PAGE_HTML);
  } finally {
    teardown(dev, repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Inline <script> — syntax-only guard, never executed (see client-script.test.mjs)
// ---------------------------------------------------------------------------

test("chat-page.mjs inline <script> parses as valid JavaScript (no syntax error)", () => {
  const script = extractInlineScript(CHAT_PAGE_HTML);
  assert.ok(script, "expected an inline <script> block in the page");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(script);
  }, "chat-page.mjs's inline script has a JS syntax error — it would break the live page");
});

test("chat-page.mjs's inline <script> contains no backtick or template-literal characters", () => {
  // Header comment's stated invariant: this file's own content is a template
  // literal, so a literal backtick in the script would terminate it early.
  // Guard the invariant directly instead of only trusting the syntax check.
  const script = extractInlineScript(CHAT_PAGE_HTML);
  assert.ok(script, "expected an inline <script> block in the page");
  assert.ok(!script.includes("`"), "chat-page.mjs's inline script must not contain a backtick");
});

// ---------------------------------------------------------------------------
// Mounting /chat didn't disturb the existing routes
// ---------------------------------------------------------------------------

test("existing routes still work alongside the new /chat route", async () => {
  // Used to also assert GET /onboard and GET /evaluate 200 — both retired by
  // a85a9e96 ("retire the static-HTML dashboard and /evaluate, /answer,
  // /packet, /search, /onboard, /tracker compat pages ... Electron only
  // loads /app"), well after /chat itself was intentionally kept ("Explicit
  // user-selected chat page: /chat." in the 404 fallback). /api/health is
  // the still-live route worth guarding here.
  const repoRoot = tempRepoWithSkills(["ingest-profile"]);
  const dev = await bootServer(repoRoot);
  try {
    const health = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("404 handler and printHelp both mention /chat and the /api/chat/* routes", async () => {
  const repoRoot = tempRepoWithSkills(["ingest-profile"]);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/no-such-route`);
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.match(text, /\/chat/);
    assert.match(text, /\/api\/chat\/start/);
    assert.match(text, /\/api\/chat\/events/);
  } finally {
    teardown(dev, repoRoot);
  }
});

// ---------------------------------------------------------------------------
// createDevServer() exposes chatRuntime and defaults it correctly
// ---------------------------------------------------------------------------

test("createDevServer() builds a default chatRuntime bound to its own repoRoot/env when none is injected", async () => {
  const repoRoot = tempRepoWithSkills(["ingest-profile"]);
  const dev = await bootServer(repoRoot, { env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
  try {
    assert.ok(dev.chatRuntime, "expected createDevServer() to return a chatRuntime");
    assert.equal(typeof dev.chatRuntime.startSession, "function");
    assert.equal(typeof dev.chatRuntime.shutdown, "function");
    // startSweep() runs unconditionally inside createDevServer (see its own
    // header comment) — listSessions() being callable at all is evidence the
    // runtime constructed cleanly against this repoRoot/env.
    assert.deepEqual(dev.chatRuntime.listSessions(), []);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("createDevServer() accepts an injected chatRuntime for tests", async () => {
  const repoRoot = tempRepoWithSkills(["ingest-profile"]);
  let shutdownCalled = false;
  const fakeChatRuntime = {
    startSession: async () => ({ chatId: "fake", skill: "ingest-profile", state: "running" }),
    getSession: () => null,
    findBySkill: () => null,
    listSessions: () => [],
    postMessage: () => ({ accepted: true }),
    interrupt: async () => ({}),
    closeSession: () => ({}),
    subscribe: () => {},
    sweepOnce: () => {},
    startSweep: () => {},
    stopSweep: () => {},
    shutdown: () => {
      shutdownCalled = true;
    },
  };
  const dev = await bootServer(repoRoot, { chatRuntime: fakeChatRuntime });
  try {
    assert.equal(dev.chatRuntime, fakeChatRuntime);
    const res = await fetch(`${baseUrl(dev)}/api/chat/list`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    dev.closeClients();
    dev.stopWatching();
    dev.chatRuntime.shutdown();
    dev.server.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
  assert.equal(shutdownCalled, true);
});
