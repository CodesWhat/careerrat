// tests/assist-route.test.mjs
// node:test suite for M8's POST /api/assist/suggest (src/cli/assist-route.mjs)
// — the bare no-tool, no-skill, native-preferred bounded AI one-shot the
// onboarding wizard's Targeting step uses for titles/keywords chip
// suggestions. Mocks the route's own `call` DI seam (the same
// call(options) => {content, model} convention bounded-ai.test.mjs and
// packet-engine.test.mjs use) rather than the Agent SDK — no real
// @anthropic-ai/claude-agent-sdk devDependency or network call anywhere in
// this suite.

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { suggestAssist } from "../apps/web/src/lib/api.js";
import { buildAssistPrompt, mountAssistRoutes, runBareOneshot } from "../src/cli/assist-route.mjs";

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
const FORBIDDEN_CONTENT = [
  "PROMPT_SECRET_02_07",
  "RAW_MODEL_REPLY_02_07",
  "RESUME_SECRET_02_07",
  "JD_SECRET_02_07",
  "CANDIDATE_FACT_SECRET_02_07",
  "PAGE_BODY_SECRET_02_07",
];
const FORBIDDEN_TEXT = FORBIDDEN_CONTENT.join(" ");

// A `call` DI double matching runBoundedAI's native-preferred nativeCall
// shape: call(options) => { content: [{type:"text", text}], model }. Same
// convention tests/bounded-ai.test.mjs and tests/packet-engine.test.mjs use.
function textReply(text, model = "claude-native-test") {
  return { content: [{ type: "text", text }], model };
}

function bootServer(repoRoot, { env = PROXY_ENV, call } = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountAssistRoutes({ addRoute, repoRoot, env, ...(call ? { call } : {}) });

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

function assertNoLegacySuggestionFields(body) {
  assert.ok(!("suggestions" in body), "shared envelope must not expose top-level suggestions");
  assert.ok(!("rationale" in body), "shared envelope must not expose top-level rationale");
}

function assertAssistLabels(body, kind, { used = true, retried = false } = {}) {
  assert.equal(body.ai.used, used);
  assert.equal(body.ai.skill, "assist");
  assert.equal(body.ai.action, `suggest-${kind}`);
  assert.equal(body.ai.operation, `assist.suggest.${kind}`);
  assert.equal(body.ai.label, `assist:suggest-${kind}:assist.suggest.${kind}`);
  assert.equal(body.ai.mode, "native");
  assert.equal(body.ai.retried, retried);
}

function assertNoSensitiveRouteEnvelope(body) {
  const serialized = JSON.stringify(body);
  for (const key of ["prompt", "body", "raw", "rawText", "resume", "jd", "candidate", "bodyText"]) {
    assert.doesNotMatch(serialized, new RegExp(`"${key}"\\s*:`));
  }
  for (const secret of FORBIDDEN_CONTENT) {
    assert.equal(serialized.includes(secret), false, `route envelope leaked ${secret}`);
  }
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

test("runBareOneshot uses the normal permission mode even with an empty tool surface", async () => {
  const repoRoot = tempRepo();
  let seenOptions = null;
  await runBareOneshot({
    prompt: "Return an empty object.",
    repoRoot,
    env: PROXY_ENV,
    labels: { skill: "assist", action: "test", operation: "assist.test" },
    loadSdk: async () => ({
      query: ({ options }) => {
        seenOptions = options;
        return (async function* emptyQuery() {})();
      },
    }),
  });
  assert.deepEqual(seenOptions.tools, []);
  assert.equal(seenOptions.permissionMode, "default");
  assert.equal(seenOptions.allowDangerouslySkipPermissions, undefined);
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

test("POST /api/assist/suggest: happy path — 200 with suggestions + rationale, call() driven on the smallFast tier with no tools/skills", async () => {
  const repoRoot = tempRepo();
  let seenOptions = null;
  const reply =
    '```json\n{"suggestions": ["Staff Engineer", "Principal Engineer"], "rationale": "same level, broader scope"}\n```';
  const server = await bootServer(repoRoot, {
    call: async (options) => {
      seenOptions = options;
      return textReply(reply);
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "titles",
      input: { titles: ["Senior Software Engineer"] },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data, {
      suggestions: ["Staff Engineer", "Principal Engineer"],
      rationale: "same level, broader scope",
    });
    assertNoLegacySuggestionFields(body);
    assertAssistLabels(body, "titles");
    assert.equal(body.manual.available, true);
    assert.equal(seenOptions.tier, "smallFast");
    assert.equal(seenOptions.skill, "assist");
    assert.equal(seenOptions.action, "suggest-titles");
    assert.equal(seenOptions.operation, "assist.suggest.titles");
    assert.equal(seenOptions.root, repoRoot);
    assert.deepEqual(seenOptions.messages, [
      {
        role: "user",
        content: buildAssistPrompt("titles", { titles: ["Senior Software Engineer"] }),
      },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/assist/suggest: omits rationale entirely when the model didn't return one", async () => {
  const repoRoot = tempRepo();
  const reply = '```json\n{"suggestions": ["Python", "Go"]}\n```';
  const server = await bootServer(repoRoot, {
    call: async () => textReply(reply),
  });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "keywords",
      input: {},
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data, { suggestions: ["Python", "Go"] });
    assert.ok(!("rationale" in body.data));
    assertNoLegacySuggestionFields(body);
    assertAssistLabels(body, "keywords");
    assert.equal(body.manual.available, true);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/assist/suggest: retry-then-ok — first reply malformed, second (corrected) reply valid", async () => {
  const repoRoot = tempRepo();
  let callCount = 0;
  const server = await bootServer(repoRoot, {
    call: async () => {
      callCount++;
      if (callCount === 1) return textReply("not json at all");
      return textReply('```json\n{"suggestions": ["fixed"]}\n```');
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "titles",
      input: {},
    });
    assert.equal(status, 200);
    assert.deepEqual(body.data.suggestions, ["fixed"]);
    assertNoLegacySuggestionFields(body);
    assertAssistLabels(body, "titles", { retried: true });
    assert.equal(
      callCount,
      2,
      "call() must be invoked exactly twice — once, then the corrective retry"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/assist/suggest: 422s when the model never produces valid output, even after the retry", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot, {
    call: async () => textReply(`still not json ${FORBIDDEN_TEXT}`),
  });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "keywords",
      input: {},
    });
    assert.equal(status, 422);
    assert.equal(body.ok, false);
    assert.equal(body.code, "AI_SCHEMA_INVALID");
    assert.equal(body.manual.available, true);
    assert.equal(body.ai.used, true);
    assert.equal(body.ai.retried, true);
    assertNoLegacySuggestionFields(body);
    assert.match(body.error.message, /route schema/);
    assertNoSensitiveRouteEnvelope(body);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/assist/suggest: provider failures return safe envelopes without raw content", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot, {
    call: async () => {
      throw new Error(`provider echoed ${FORBIDDEN_TEXT}`);
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/assist/suggest", {
      kind: "titles",
      input: { profileSummary: `profile ${FORBIDDEN_TEXT}` },
    });
    assert.equal(status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.code, "AI_PROVIDER_FAILED");
    assert.equal(body.ai.used, true);
    assertAssistLabels(body, "titles");
    assert.equal(body.manual.available, true);
    assertNoLegacySuggestionFields(body);
    assertNoSensitiveRouteEnvelope(body);
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
    assert.equal(body.code, "NO_AI_ROUTE");
    assert.equal(body.ai.used, false);
    assert.equal(body.ai.skill, "assist");
    assert.equal(body.ai.action, "suggest-titles");
    assert.equal(body.ai.operation, "assist.suggest.titles");
    assert.equal(body.manual.available, true);
    assertNoLegacySuggestionFields(body);
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

test("suggestAssist unwraps shared envelope data and preserves AI/manual metadata", async () => {
  const originalFetch = globalThis.fetch;
  const responseBody = {
    ok: true,
    data: { suggestions: ["Staff Engineer"], rationale: "same level" },
    ai: {
      used: true,
      skill: "assist",
      action: "suggest-titles",
      operation: "assist.suggest.titles",
      mode: "fallback",
      retried: false,
    },
    manual: { available: true, action: "Edit targeting manually." },
  };

  globalThis.fetch = async (path, options = {}) => {
    assert.equal(path, "/api/assist/suggest");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), {
      kind: "titles",
      input: { titles: ["Senior Software Engineer"] },
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await suggestAssist("titles", {
      titles: ["Senior Software Engineer"],
    });

    assert.deepEqual(result, {
      suggestions: ["Staff Engineer"],
      rationale: "same level",
      ai: responseBody.ai,
      manual: responseBody.manual,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
