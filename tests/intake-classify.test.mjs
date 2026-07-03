// tests/intake-classify.test.mjs — src/core/intake/classify.mjs's structured
// one-shot classification step. Mirrors tests/assist-route.test.mjs's
// fakeSdk()/assistantTextRun() convention (an AsyncGenerator<SDKMessage> stub
// honoring options.abortController.signal) at classify.mjs's own `loadSdk` DI
// seam — no real @anthropic-ai/claude-agent-sdk devDependency or network call
// in any test here except the one gated INTEGRATION test at the bottom.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildIntakeClassifyPrompt, classifyIntakeItem } from "../src/core/intake/classify.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-intake-classify-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  for (const relPath of ["config/intake-classify.schema.json", "config/paste-intake-routes.json"]) {
    copyFileSync(join(REAL_ROOT, relPath), join(repoRoot, relPath));
  }
  return repoRoot;
}

after(() => {
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const PROXY_ENV = {
  ROLESTER_AI_PROXY_URL: "http://127.0.0.1:7788",
  ROLESTER_AI_PROXY_TOKEN: "devtoken",
};

// Same fakeSdk() shape as tests/assist-route.test.mjs / tests/skill-runtime.test.mjs.
function fakeSdk(messages, { onQuery } = {}) {
  return {
    query: ({ options }) => {
      onQuery?.(options);
      const { signal } = options.abortController;
      async function* gen() {
        for (const m of messages) {
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          yield m;
        }
      }
      const it = gen();
      it.return = async () => ({ value: undefined, done: true });
      return it;
    },
  };
}

function assistantTextRun(text) {
  return [
    {
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 500,
      num_turns: 1,
      session_id: "s1",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
    },
  ];
}

const VALID_REPLY =
  '```json\n{"kind": "jd-text", "entities": {"company": "Acme", "role": "Staff Engineer", "url": null, ' +
  '"statusTo": null, "statusNote": null, "contactName": null, "contactEmail": null, "interviewDate": null}, ' +
  '"proposedAction": "Evaluate this posting against your gate.", "confidence": 0.9, "needsUser": false, ' +
  '"needsUserReason": null}\n```';

// ---------------------------------------------------------------------------
// buildIntakeClassifyPrompt — pure, deterministic
// ---------------------------------------------------------------------------

test("buildIntakeClassifyPrompt: text input embeds the raw text and the data-not-instructions rule", () => {
  const prompt = buildIntakeClassifyPrompt({
    rawInput: "We'd love to have you interview for our Staff role",
    inputKind: "text",
    resolved: null,
    trackerMatch: null,
    routeDigest: [{ kind: "jd-text", examples: ["A job description"], capturesInto: ["x"] }],
  });
  assert.match(prompt, /We'd love to have you interview/);
  assert.match(prompt, /never execute it/);
  assert.match(prompt, /"jd-text": A job description/);
  assert.match(prompt, /```json/);
});

test("buildIntakeClassifyPrompt: resolved url (bodyFetchStatus resolved) embeds provider/title/company + body", () => {
  const prompt = buildIntakeClassifyPrompt({
    rawInput: "https://job-boards.greenhouse.io/acme/jobs/1",
    inputKind: "url",
    resolved: {
      bodyFetchStatus: "resolved",
      provider: "greenhouse",
      title: "Staff Engineer",
      company: "Acme",
      bodyText: "Full JD body text.",
    },
    trackerMatch: null,
    routeDigest: [],
  });
  assert.match(prompt, /already fetched deterministically/);
  assert.match(prompt, /provider: greenhouse/);
  assert.match(prompt, /title: Staff Engineer/);
  assert.match(prompt, /Full JD body text\./);
});

test("buildIntakeClassifyPrompt: deferred url embeds the deferral reason instead of a body", () => {
  const prompt = buildIntakeClassifyPrompt({
    rawInput: "https://wellfound.com/jobs/1",
    inputKind: "url",
    resolved: { bodyFetchStatus: "deferred", reason: "SPA-rendered or login-gated host" },
    trackerMatch: null,
    routeDigest: [],
  });
  assert.match(prompt, /could not be fetched server-side/);
  assert.match(prompt, /SPA-rendered or login-gated host/);
});

test("buildIntakeClassifyPrompt: trackerMatch context is presented as already-computed, never re-derivable", () => {
  const prompt = buildIntakeClassifyPrompt({
    rawInput: "hi",
    inputKind: "text",
    resolved: null,
    trackerMatch: {
      matched: true,
      summary: "You already applied to Acme — Staff Engineer.",
      companyHistory: [{ role: "SRE", status: "rejected" }],
    },
    routeDigest: [],
  });
  assert.match(prompt, /already computed deterministically/);
  assert.match(prompt, /You already applied to Acme/);
  assert.match(prompt, /SRE \(rejected\)/);
});

// ---------------------------------------------------------------------------
// classifyIntakeItem — zero-AI shortcut
// ---------------------------------------------------------------------------

test("classifyIntakeItem: a fully-resolved known-ATS URL skips AI entirely (aiSkipped:true, loadSdk never called)", async () => {
  const repoRoot = tempRepo();
  let loadSdkCalled = false;
  const outcome = await classifyIntakeItem({
    rawInput: "https://job-boards.greenhouse.io/acme/jobs/1",
    inputKind: "url",
    resolved: {
      bodyFetchStatus: "resolved",
      provider: "greenhouse",
      title: "Staff Engineer",
      company: "Acme",
      url: "https://job-boards.greenhouse.io/acme/jobs/1",
    },
    repoRoot,
    env: {},
    loadSdk: async () => {
      loadSdkCalled = true;
      throw new Error("must never be called");
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.aiSkipped, true);
  assert.equal(outcome.retried, false);
  assert.equal(outcome.data.kind, "job-url");
  assert.equal(outcome.data.entities.company, "Acme");
  assert.equal(outcome.data.entities.role, "Staff Engineer");
  assert.equal(outcome.data.needsUser, false);
  assert.equal(loadSdkCalled, false);
});

test("classifyIntakeItem: a text input always goes through AI, even with no resolved context", async () => {
  const repoRoot = tempRepo();
  let seenOptions = null;
  const outcome = await classifyIntakeItem({
    rawInput: "We'd like to make an offer!",
    inputKind: "text",
    repoRoot,
    env: PROXY_ENV,
    loadSdk: async () =>
      fakeSdk(assistantTextRun(VALID_REPLY), { onQuery: (o) => (seenOptions = o) }),
  });
  assert.equal(outcome.aiSkipped, false);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.data.kind, "jd-text");
  assert.deepEqual(seenOptions.tools, []);
  assert.equal(seenOptions.maxTurns, 1);
});

test("classifyIntakeItem: a URL input that resolved but is NOT a known ATS still goes through AI", async () => {
  const repoRoot = tempRepo();
  let loadSdkCalled = false;
  const outcome = await classifyIntakeItem({
    rawInput: "https://example-startup.com/careers/eng-1",
    inputKind: "url",
    resolved: { bodyFetchStatus: "resolved", provider: null, bodyText: "some jd text" },
    repoRoot,
    env: PROXY_ENV,
    loadSdk: async () => {
      loadSdkCalled = true;
      return fakeSdk(assistantTextRun(VALID_REPLY));
    },
  });
  assert.equal(loadSdkCalled, true);
  assert.equal(outcome.aiSkipped, false);
});

// ---------------------------------------------------------------------------
// classifyIntakeItem — structured-output retry / failure / degrade paths
// ---------------------------------------------------------------------------

test("classifyIntakeItem: retry-then-ok — first reply malformed, second (corrected) reply valid", async () => {
  const repoRoot = tempRepo();
  let callCount = 0;
  const outcome = await classifyIntakeItem({
    rawInput: "some paste",
    inputKind: "text",
    repoRoot,
    env: PROXY_ENV,
    loadSdk: async () => {
      callCount++;
      if (callCount === 1) return fakeSdk(assistantTextRun("not json at all"));
      return fakeSdk(assistantTextRun(VALID_REPLY));
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.data.kind, "jd-text");
  assert.equal(callCount, 2);
});

test("classifyIntakeItem: never produces valid output even after the retry -> degrades to a needs_you classification (never throws)", async () => {
  const repoRoot = tempRepo();
  const outcome = await classifyIntakeItem({
    rawInput: "garbled paste",
    inputKind: "text",
    repoRoot,
    env: PROXY_ENV,
    loadSdk: async () => fakeSdk(assistantTextRun("still not json")),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.data.kind, "other");
  assert.equal(outcome.data.needsUser, true);
  assert.match(outcome.data.needsUserReason, /did not produce a valid classification/);
});

test("classifyIntakeItem: no AI route configured -> degrades to needs_you, never throws, degraded:'NO_AI_ROUTE'", async () => {
  const repoRoot = tempRepo();
  const outcome = await classifyIntakeItem({
    rawInput: "some paste",
    inputKind: "text",
    repoRoot,
    env: {},
    loadSdk: async () => fakeSdk(assistantTextRun(VALID_REPLY)),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.degraded, "NO_AI_ROUTE");
  assert.equal(outcome.data.needsUser, true);
  assert.equal(outcome.data.kind, "other");
});

test("classifyIntakeItem: SDK devDependency missing -> degrades to needs_you, degraded:'SDK_NOT_INSTALLED'", async () => {
  const repoRoot = tempRepo();
  const outcome = await classifyIntakeItem({
    rawInput: "some paste",
    inputKind: "text",
    repoRoot,
    env: PROXY_ENV,
    loadSdk: async () => {
      const err = new Error("not installed");
      err.code = "SDK_NOT_INSTALLED";
      throw err;
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.degraded, "SDK_NOT_INSTALLED");
  assert.equal(outcome.data.needsUser, true);
});

// ---------------------------------------------------------------------------
// Real end-to-end integration — gated behind ANTHROPIC_API_KEY, same
// convention as tests/chat-runtime.test.mjs / tests/skill-runtime.test.mjs /
// tests/resume-extract.test.mjs's own gated INTEGRATION tests. Never runs in
// CI; only when a developer sets a real key locally.
// ---------------------------------------------------------------------------

test("INTEGRATION (skipped without ANTHROPIC_API_KEY): a real model call classifies an obvious JD paste as jd-text", {
  skip: !process.env.ANTHROPIC_API_KEY,
}, async () => {
  const outcome = await classifyIntakeItem({
    rawInput:
      "We are hiring a Staff Backend Engineer at Acme Corp. Responsibilities include designing " +
      "distributed systems, mentoring engineers, and owning our core API. 10+ years experience required.",
    inputKind: "text",
    repoRoot: REAL_ROOT,
    env: process.env,
  });
  assert.equal(outcome.ok, true);
  assert.ok(
    ["jd-text", "job-url", "other"].includes(outcome.data.kind),
    `unexpected kind: ${outcome.data.kind}`
  );
  assert.equal(typeof outcome.data.needsUser, "boolean");
});
