// tests/assist-route.test.mjs
// node:test suite for M8's POST /api/assist/suggest (src/cli/assist-route.mjs)
// — the bare no-tool, no-skill, maxTurns:1 one-shot the onboarding wizard's
// Targeting step uses for titles/keywords chip suggestions. Mirrors
// tests/skill-runtime.test.mjs's fakeSdk()/SAMPLE_RUN convention (an
// AsyncGenerator<SDKMessage> stub honoring options.abortController.signal) at
// this route's own `loadSdk` DI seam — no real @anthropic-ai/claude-agent-sdk
// devDependency or network call anywhere in this suite.

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAssistPrompt, mountAssistRoutes } from "../src/cli/assist-route.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-assist-route-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  copyFileSync(
    join(REAL_ROOT, "config/assist-suggest.schema.json"),
    join(repoRoot, "config/assist-suggest.schema.json")
  );
  return repoRoot;
}

// A stub AI route that's cheap and side-effect-free: ROLESTER_AI_PROXY_URL
// (not ANTHROPIC_API_KEY) so resolveAIRoute() resolves to "proxy" and
// runBareOneshot() never attempts writeByokUsage()'s usage-log write — this
// suite only cares about the request/response contract, not usage metering
// (already covered by skill-runtime.test.mjs).
const PROXY_ENV = {
  ROLESTER_AI_PROXY_URL: "http://127.0.0.1:7788",
  ROLESTER_AI_PROXY_TOKEN: "devtoken",
};

// Same fakeSdk() shape as tests/skill-runtime.test.mjs: an AsyncGenerator
// that checks the abortController's signal every step. `onQuery` lets a test
// inspect exactly what `options` runBareOneshot() actually passed.
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

function bootServer(repoRoot, { env = PROXY_ENV, loadSdk } = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountAssistRoutes({ addRoute, repoRoot, env, ...(loadSdk ? { loadSdk } : {}) });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

// ---------------------------------------------------------------------------
// buildAssistPrompt — pure, deterministic
// ---------------------------------------------------------------------------

test("buildAssistPrompt: kind:'titles' embeds the summary and existing titles, asks for 5-8 suggestions", () => {
  const prompt = buildAssistPrompt("titles", {
    profileSummary: "Senior backend engineer, 8 years, distributed systems.",
    titles: ["Senior Software Engineer", "Staff Engineer"],
  });
  assert.match(prompt, /Senior backend engineer, 8 years/);
  assert.match(prompt, /Senior Software Engineer, Staff Engineer/);
  assert.match(prompt, /5-8/);
  assert.match(prompt, /```json/);
});

test("buildAssistPrompt: kind:'keywords' embeds current keywords, asks for 5-10 suggestions", () => {
  const prompt = buildAssistPrompt("keywords", {
    profileSummary: "",
    currentKeywords: ["Python", "Kubernetes"],
  });
  assert.match(prompt, /Python, Kubernetes/);
  assert.match(prompt, /5-10/);
});

test("buildAssistPrompt: omits the summary/existing lines entirely when absent", () => {
  const prompt = buildAssistPrompt("titles", {});
  assert.ok(!prompt.includes("Candidate summary:"));
  assert.ok(!prompt.includes("Current target titles:"));
});

// ---------------------------------------------------------------------------
// POST /api/assist/suggest
// ---------------------------------------------------------------------------

test("POST /api/assist/suggest: happy path — 200 with suggestions + rationale, query() called with tools:[]/maxTurns:1/no skills option", async () => {
  const repoRoot = tempRepo();
  let seenOptions = null;
  const reply =
    '```json\n{"suggestions": ["Staff Engineer", "Principal Engineer"], "rationale": "same level, broader scope"}\n```';
  const server = await bootServer(repoRoot, {
    loadSdk: async () => fakeSdk(assistantTextRun(reply), { onQuery: (o) => (seenOptions = o) }),
  });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "titles",
      input: { titles: ["Senior Software Engineer"] },
    });
    assert.equal(status, 200);
    assert.deepEqual(body, {
      ok: true,
      suggestions: ["Staff Engineer", "Principal Engineer"],
      rationale: "same level, broader scope",
    });
    assert.deepEqual(seenOptions.tools, []);
    assert.equal(seenOptions.maxTurns, 1);
    assert.ok(
      !("skills" in seenOptions),
      "must not pass a skills option — this is not a skill run"
    );
    assert.ok(!("settingSources" in seenOptions));
  } finally {
    await closeServer(server);
  }
});

test("POST /api/assist/suggest: omits rationale entirely when the model didn't return one", async () => {
  const repoRoot = tempRepo();
  const reply = '```json\n{"suggestions": ["Python", "Go"]}\n```';
  const server = await bootServer(repoRoot, {
    loadSdk: async () => fakeSdk(assistantTextRun(reply)),
  });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "keywords",
      input: {},
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, suggestions: ["Python", "Go"] });
    assert.ok(!("rationale" in body));
  } finally {
    await closeServer(server);
  }
});

test("POST /api/assist/suggest: retry-then-ok — first reply malformed, second (corrected) reply valid", async () => {
  const repoRoot = tempRepo();
  let callCount = 0;
  const server = await bootServer(repoRoot, {
    loadSdk: async () => {
      callCount++;
      if (callCount === 1) return fakeSdk(assistantTextRun("not json at all"));
      return fakeSdk(assistantTextRun('```json\n{"suggestions": ["fixed"]}\n```'));
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "titles",
      input: {},
    });
    assert.equal(status, 200);
    assert.deepEqual(body.suggestions, ["fixed"]);
    assert.equal(callCount, 2, "loadSdk (and therefore invoke) must be called exactly twice");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/assist/suggest: 422s when the model never produces valid output, even after the retry", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot, {
    loadSdk: async () => fakeSdk(assistantTextRun("still not json")),
  });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "keywords",
      input: {},
    });
    assert.equal(status, 422);
    assert.equal(body.ok, false);
    assert.match(body.error, /could not produce a valid suggestion/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/assist/suggest: 501s when no AI route is configured (route:'none')", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot, { env: {} });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "titles",
      input: {},
    });
    assert.equal(status, 501);
    assert.equal(body.ok, false);
    assert.match(body.error, /no AI route configured/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/assist/suggest: 400s on a bad/missing kind", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "not-a-real-kind",
      input: {},
    });
    assert.equal(status, 400);
    assert.match(body.error, /titles.*keywords/);

    const missing = await postJson(server, "/api/assist/suggest", { input: {} });
    assert.equal(missing.status, 400);
  } finally {
    await closeServer(server);
  }
});
