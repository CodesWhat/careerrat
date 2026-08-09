// tests/workspace-agent-preview.test.mjs
// node:test coverage for W3's ask-bar preview seam (commit 95f27540):
// previewWorkspaceIntent (src/core/agent/workspace-agent.mjs) and the
// POST /api/workspace/preview route it's mounted behind
// (src/cli/workspace-agent-route.mjs). Split into its own file rather than
// appended to tests/workspace-agent.test.mjs so it can land without touching
// that file (matches the temp-repo/mountDirect/callDirect conventions that
// file already establishes).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { mountWorkspaceAgentRoutes } from "../src/cli/workspace-agent-route.mjs";
import { previewWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { WORKSPACE_THREAD_ID, workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-workspace-agent-preview-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// previewWorkspaceIntent
// ---------------------------------------------------------------------------

test("previewWorkspaceIntent: sweep-style phrasings map to the search.run action", () => {
  const repoRoot = tempRepo();
  const phrasings = [
    "sweep my pinned boards",
    "scan for new job postings",
    "can you check my search sources today",
    "find me new roles at target companies",
  ];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.ok(result.action, `expected an action preview for "${text}"`);
    assert.equal(result.action.intent.type, "search.run");
    assert.equal(result.action.intent.entity.type, "workspace");
    assert.equal(result.action.intent.entity.id, WORKSPACE_THREAD_ID);
    assert.equal(typeof result.action.label, "string");
    assert.ok(result.action.label.length > 0);
  }
});

test("previewWorkspaceIntent: non-action phrasing returns answer-only", () => {
  const repoRoot = tempRepo();
  const phrasings = ["what's blocking my top role?", "draft a nudge to a contact"];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.equal(result.action, null);
    assert.equal(typeof result.answer.label, "string");
    assert.match(result.answer.label, /^Answer: /);
  }
});

test("previewWorkspaceIntent: empty text returns no action and the generic prompt", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({ text: "", repoRoot, env: {} });
  assert.equal(result.action, null);
  assert.equal(result.answer.label, "Ask the workspace agent.");

  const whitespaceOnly = previewWorkspaceIntent({ text: "   \n\t  ", repoRoot, env: {} });
  assert.equal(whitespaceOnly.action, null);
  assert.equal(whitespaceOnly.answer.label, "Ask the workspace agent.");
});

test("previewWorkspaceIntent: long text truncates in the answer label", () => {
  const repoRoot = tempRepo();
  // No action-trigger words in here, so this previews as answer-only —
  // isolates the truncation behavior from the action-classification path.
  const longText = "banana ".repeat(40).trim();
  const compact = longText.replace(/\s+/g, " ").trim();
  assert.ok(compact.length > 140, "fixture text must exceed the 140-char truncation threshold");

  const result = previewWorkspaceIntent({ text: longText, repoRoot, env: {} });
  assert.equal(result.action, null);
  const expected = `Answer: \u{201c}${compact.slice(0, 139)}…\u{201d}`;
  assert.equal(result.answer.label, expected);
  assert.ok(result.answer.label.endsWith("…\u{201d}"));
});

test("previewWorkspaceIntent: engineAvailable is false when resolveAIRoute finds no route", () => {
  // No repoRoot (skips the installed-runtime lookup entirely) and an env with
  // no ANTHROPIC_API_KEY / ROLESTER_AI_PROXY_URL — resolveAIRoute() falls all
  // the way through to type "none".
  const result = previewWorkspaceIntent({ text: "sweep my boards", env: {} });
  assert.equal(result.engineAvailable, false);
});

test("previewWorkspaceIntent: engineAvailable is true once a BYOK key is set", () => {
  const result = previewWorkspaceIntent({
    text: "sweep my boards",
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
  });
  assert.equal(result.engineAvailable, true);
});

test("previewWorkspaceIntent: never touches the DB or the workspace thread", () => {
  const repoRoot = tempRepo();
  previewWorkspaceIntent({ text: "sweep my boards", repoRoot, env: {} });
  previewWorkspaceIntent({ text: "what's blocking my top role?", repoRoot, env: {} });
  previewWorkspaceIntent({ text: "", repoRoot, env: {} });

  // workspaceThreadRead never creates the thread row itself (unlike
  // workspaceThreadOpen) — a null thread here proves nothing was written by
  // any of the calls above.
  const read = workspaceThreadRead({ repoRoot, env: {} });
  assert.equal(read.thread, null);
  assert.deepEqual(read.messages, []);
});

// ---------------------------------------------------------------------------
// POST /api/workspace/preview
// ---------------------------------------------------------------------------

function mountDirect(repoRoot, previewIntentImpl) {
  const routes = new Map();
  mountWorkspaceAgentRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env: {},
    previewIntentImpl,
  });
  return routes;
}

async function callDirect(routes, method, path, payload) {
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `expected mounted route for ${method} ${path}`);
  const req = Readable.from(
    payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), "utf8")]
  );
  req.method = method;
  req.url = path;
  req.headers = payload === undefined ? {} : { "content-type": "application/json" };
  let status = 200;
  let responseBody = "";
  const res = {
    writeHead(nextStatus) {
      status = nextStatus;
      return this;
    },
    end(chunk = "") {
      responseBody += String(chunk);
    },
  };
  await handler(req, res);
  return { status, body: responseBody ? JSON.parse(responseBody) : {} };
}

test("POST /api/workspace/preview returns ok:true with classify data and performs no thread writes", async () => {
  const repoRoot = tempRepo();
  // No override — exercises the route's real default (previewWorkspaceIntent
  // itself), not a stub, so this is an end-to-end check of the wiring.
  const routes = mountDirect(repoRoot);

  const response = await callDirect(routes, "POST", "/api/workspace/preview", {
    text: "sweep my pinned boards",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.action.intent.type, "search.run");
  assert.equal(typeof response.body.data.answer.label, "string");
  assert.equal(response.body.data.engineAvailable, false);

  const read = workspaceThreadRead({ repoRoot, env: {} });
  assert.equal(read.thread, null, "the preview route must never open/write the workspace thread");
  assert.deepEqual(read.messages, []);
});

test("POST /api/workspace/preview delegates text through to the injected classifier", async () => {
  const repoRoot = tempRepo();
  const seen = [];
  const routes = mountDirect(repoRoot, (input) => {
    seen.push(input);
    return { action: null, answer: { label: "stubbed" }, engineAvailable: true };
  });

  const response = await callDirect(routes, "POST", "/api/workspace/preview", {
    text: "what's blocking my top role?",
  });

  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "what's blocking my top role?");
  assert.deepEqual(response.body.data, {
    action: null,
    answer: { label: "stubbed" },
    engineAvailable: true,
  });
});
