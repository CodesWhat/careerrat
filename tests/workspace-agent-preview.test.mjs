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
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-workspace-agent-preview-"));
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

test("previewWorkspaceIntent: company expansion phrasings map to company.discover", () => {
  const repoRoot = tempRepo();
  const phrasings = [
    "find more companies for me",
    "discover companies that fit my preferences",
    "refresh my company discovery",
  ];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(result.action, {
      label: "Discover more matching companies",
      intent: {
        type: "company.discover",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { requestedCount: 12, request: text },
      },
    });
  }
});

test("previewWorkspaceIntent: new board discovery stays distinct from a job sweep", () => {
  const repoRoot = tempRepo();
  const phrasings = [
    "find more job boards for me",
    "discover new sources for my search",
    "research niche job boards",
  ];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(result.action, {
      label: "Find and review new job boards",
      intent: {
        type: "source.discover",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { request: text },
      },
    });
  }

  assert.equal(
    previewWorkspaceIntent({ text: "sweep my pinned boards", repoRoot, env: {} }).action.intent
      .type,
    "search.run"
  );
});

test("previewWorkspaceIntent: an explicit board URL import maps to a source write", () => {
  const repoRoot = tempRepo();
  const sourceUrl = "https://remoteok.com/remote-dev-jobs?order_by=date";
  for (const text of [
    `add this job board ${sourceUrl}`,
    `use this source for my searches ${sourceUrl}`,
  ]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(result.action, {
      label: "Add this job board",
      intent: {
        type: "source.add",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { url: sourceUrl },
      },
    });
  }
});

test("previewWorkspaceIntent: an explicit query request maps to source setup, not a sweep", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "add a job search for staff AI engineer",
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: "Add a job search",
    intent: {
      type: "source.query-add",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { query: "staff AI engineer" },
    },
  });
});

test("previewWorkspaceIntent: explicit source toggles become reviewable source writes", () => {
  const repoRoot = tempRepo();
  assert.deepEqual(
    previewWorkspaceIntent({
      text: "disable the LinkedIn source",
      repoRoot,
      env: {},
    }).action,
    {
      label: "Disable this search source",
      intent: {
        type: "source.set-enabled",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { selector: "LinkedIn", enabled: false },
      },
    }
  );
  assert.deepEqual(
    previewWorkspaceIntent({
      text: "enable the RemoteOK job board",
      repoRoot,
      env: {},
    }).action,
    {
      label: "Enable this search source",
      intent: {
        type: "source.set-enabled",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { selector: "RemoteOK", enabled: true },
      },
    }
  );
});

test("previewWorkspaceIntent: rate or evaluate plus a job URL maps to job.evaluate-request", () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/12345";
  for (const text of [`rate this job ${jobUrl}`, `Can you evaluate ${jobUrl}?`]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(result.action, {
      label: "Capture and evaluate this job",
      intent: {
        type: "job.evaluate-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { jobUrl },
      },
    });
  }
});

test("previewWorkspaceIntent: a bare likely job URL maps to job.evaluate-request", () => {
  const repoRoot = tempRepo();
  const urls = [
    "https://jobs.lever.co/acme/abc-123",
    "https://www.linkedin.com/jobs/view/1234567890",
    "https://example.com/careers/jobs/staff-engineer",
  ];
  for (const jobUrl of urls) {
    const result = previewWorkspaceIntent({ text: jobUrl, repoRoot, env: {} });
    assert.equal(result.action?.intent.type, "job.evaluate-request");
    assert.equal(result.action?.intent.input.jobUrl, jobUrl);
  }
});

test("previewWorkspaceIntent: apply plus a job URL maps to job.prepare-request", () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://jobs.ashbyhq.com/acme/abc-123";
  const result = previewWorkspaceIntent({
    text: `Can you apply to this job? ${jobUrl}`,
    repoRoot,
    env: {},
  });

  assert.deepEqual(result.action, {
    label: "Evaluate and prepare this application",
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
  });
});

test("previewWorkspaceIntent: standalone tailoring resolves URL, open-job, and named-job requests", () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://jobs.ashbyhq.com/acme/abc-123";

  assert.deepEqual(
    previewWorkspaceIntent({
      text: `tailor my resume for ${jobUrl}`,
      repoRoot,
      env: {},
    }).action,
    {
      label: "Evaluate and tailor this job",
      intent: {
        type: "job.tailor-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { jobUrl },
      },
    }
  );

  assert.deepEqual(
    previewWorkspaceIntent({
      text: "write a cover letter for this job",
      context: { pathname: "/jobs", jobId: "app-acme" },
      repoRoot,
      env: {},
    }).action,
    {
      label: "Evaluate and tailor this saved job",
      intent: {
        type: "job.tailor-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { jobId: "app-acme" },
      },
    }
  );

  assert.deepEqual(
    previewWorkspaceIntent({
      text: "customize my application materials for the Acme Staff AI Engineer role",
      repoRoot,
      env: {},
    }).action,
    {
      label: "Evaluate and tailor this saved job",
      intent: {
        type: "job.tailor-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: {
          jobReference: "customize my application materials for the Acme Staff AI Engineer role",
        },
      },
    }
  );
});

test("previewWorkspaceIntent: this job resolves to the explicitly open saved job", () => {
  const repoRoot = tempRepo();
  const context = { pathname: "/jobs", jobId: "app-acme" };

  const rate = previewWorkspaceIntent({
    text: "Can you rate this job?",
    context,
    repoRoot,
    env: {},
  });
  assert.deepEqual(rate.action, {
    label: "Evaluate this saved job",
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobId: "app-acme" },
    },
  });

  const apply = previewWorkspaceIntent({
    text: "Apply to this job",
    context,
    repoRoot,
    env: {},
  });
  assert.deepEqual(apply.action, {
    label: "Evaluate and prepare this saved job",
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobId: "app-acme" },
    },
  });
});

test("previewWorkspaceIntent: never guesses what 'this job' means without an open job", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "Can you rate this job?",
    context: { pathname: "/jobs", jobId: null },
    repoRoot,
    env: {},
  });
  assert.equal(result.action, null);
});

test("previewWorkspaceIntent: named saved job references are resolved by the executor", () => {
  const repoRoot = tempRepo();

  const rate = previewWorkspaceIntent({
    text: "Can you rate the Acme role?",
    repoRoot,
    env: {},
  });
  assert.deepEqual(rate.action, {
    label: "Evaluate this saved job",
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: "Can you rate the Acme role?" },
    },
  });

  const apply = previewWorkspaceIntent({
    text: "Apply to the Northstar Staff AI role",
    repoRoot,
    env: {},
  });
  assert.deepEqual(apply.action, {
    label: "Evaluate and prepare this saved job",
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: "Apply to the Northstar Staff AI role" },
    },
  });
});

test("previewWorkspaceIntent: a non-job URL stays answer-only", () => {
  const repoRoot = tempRepo();
  for (const text of [
    "https://example.com/about-us",
    "review https://example.com/about-us",
    "apply https://example.com/about-us",
  ]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.equal(result.action, null);
    assert.match(result.answer.label, /^Answer: /);
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
  // no ANTHROPIC_API_KEY / CAREERRAT_AI_PROXY_URL — resolveAIRoute() falls all
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
    context: { pathname: "/jobs", jobId: "app-acme" },
  });

  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "what's blocking my top role?");
  assert.deepEqual(seen[0].context, { pathname: "/jobs", jobId: "app-acme" });
  assert.deepEqual(response.body.data, {
    action: null,
    answer: { label: "stubbed" },
    engineAvailable: true,
  });
});
