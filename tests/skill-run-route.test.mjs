// tests/skill-run-route.test.mjs
// node:test suite for POST /api/skill/run's HTTP surface (Productization
// Phase 0, P0-4 — src/cli/skill-run-route.mjs). `runSkillStream` is fully
// stubbed here — these tests only exercise SSE framing, the 1MB body cap,
// status-code mapping (400/501/500), and client-disconnect abort. The actual
// Agent SDK driving loop has its own hermetic coverage in
// tests/skill-runtime.test.mjs.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mountSkillRunRoute } from "../src/cli/skill-run-route.mjs";
import {
  APP_SAFE_RUNTIME_TOOLS,
  DEFAULT_RUNTIME_TOOL_PROFILE,
} from "../src/core/ai/runtime-tools.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const realRoot = fileURLToPath(new URL("..", import.meta.url));

// A minimal addRoute-based harness mirroring tracker-dev.mjs's own routing
// table (method+path -> handler), without pulling in the whole dev server.
function bootRouteServer(runSkillStream, { repoRoot = realRoot, env = {} } = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountSkillRunRoute({ addRoute, repoRoot, runSkillStream, env });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    dispatchHttpRoute(route, req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function tempRepoWithSkills(skillNames = []) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-skill-run-route-"));
  for (const name of skillNames) {
    const dir = join(repoRoot, ".agents/skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`, "utf8");
  }
  return repoRoot;
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Reads a fetch Response's SSE body to completion (or until `stopWhen`
// matches accumulated text) and returns the raw text.
async function readSseBody(res, { stopWhen } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (stopWhen?.(text)) break;
  }
  try {
    reader.cancel();
  } catch {
    /* ignore */
  }
  return text;
}

// ---------------------------------------------------------------------------
// GET /api/runtime/config — read-only capability metadata
// ---------------------------------------------------------------------------

test("GET /api/runtime/config: returns one-shot, chat, AI-route, and discovery capabilities without starting a skill run", async () => {
  const repoRoot = tempRepoWithSkills([
    "intake-extract",
    "resume-extract",
    "evaluate-job",
    "answer-question",
    "tailor-application",
    "ingest-profile",
    "research-boards",
    "discover-companies",
    "search-jobs",
    "research-company",
    "research-comp",
    "company-health",
    "email-comms",
  ]);
  let called = false;
  const server = await bootRouteServer(
    async () => {
      called = true;
    },
    {
      repoRoot,
      env: {
        CAREERRAT_RUNTIME_SKILLS:
          "evaluate-job,answer-question,search-jobs,intake-extract,resume-extract",
        CAREERRAT_CHAT_SKILLS:
          "ingest-profile,research-boards,discover-companies,research-company,research-comp,company-health,search-jobs,email-comms",
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    }
  );
  try {
    const res = await fetch(`${baseUrl(server)}/api/runtime/config`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    const body = await res.json();
    assert.deepEqual(body, {
      skills: ["intake-extract", "resume-extract"],
      chatSkills: [
        "ingest-profile",
        "research-boards",
        "research-company",
        "research-comp",
        "company-health",
      ],
      ai: { available: true, route: "byok" },
      runtime: {
        defaultToolProfile: DEFAULT_RUNTIME_TOOL_PROFILE,
        defaultTools: [...APP_SAFE_RUNTIME_TOOLS],
        toolHeavy: {
          available: false,
          skills: [],
        },
      },
      discovery: {
        companyProposals: true,
        manualCompanySeeds: true,
        chatHandoffs: true,
      },
      aiWebSearch: { available: true },
    });
    assert.doesNotMatch(JSON.stringify(body), /sk-ant-test|ANTHROPIC_API_KEY|APPLE|PASSWORD/);
    assert.equal(called, false);
  } finally {
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/runtime/config: reports no AI route and no discovery chat handoff when discovery chat skills are unavailable", async () => {
  const repoRoot = tempRepoWithSkills(["resume-extract", "evaluate-job", "ingest-profile"]);
  const server = await bootRouteServer(async () => {}, {
    repoRoot,
    env: {
      CAREERRAT_RUNTIME_SKILLS: "evaluate-job,resume-extract",
      CAREERRAT_CHAT_SKILLS: "ingest-profile",
    },
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/runtime/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      skills: ["resume-extract"],
      chatSkills: ["ingest-profile"],
      ai: { available: false, route: "none" },
      runtime: {
        defaultToolProfile: DEFAULT_RUNTIME_TOOL_PROFILE,
        defaultTools: [...APP_SAFE_RUNTIME_TOOLS],
        toolHeavy: {
          available: false,
          skills: [],
        },
      },
      discovery: {
        companyProposals: true,
        manualCompanySeeds: true,
        chatHandoffs: false,
      },
      aiWebSearch: { available: false },
    });
  } finally {
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the dedicated AI search stays available when the generic skill allowlist is explicitly empty", async () => {
  const repoRoot = tempRepoWithSkills(["intake-extract", "search-jobs"]);
  let called = false;
  const server = await bootRouteServer(
    async () => {
      called = true;
    },
    {
      repoRoot,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        CAREERRAT_RUNTIME_SKILLS: "",
      },
    }
  );
  try {
    const configResponse = await fetch(`${baseUrl(server)}/api/runtime/config`);
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.deepEqual(config.skills, []);
    assert.deepEqual(config.aiWebSearch, { available: true });

    const genericResponse = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "intake-extract", input: { path: "/fixture/resume.pdf" } }),
    });
    assert.equal(genericResponse.status, 400);
    assert.match((await genericResponse.json()).error, /allowed: none/);
    assert.equal(called, false);
  } finally {
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/runtime/config: reports unsandboxed tool-heavy execution as unavailable", async () => {
  const repoRoot = tempRepoWithSkills(["apply-job", "sync-status", "evaluate-job"]);
  const server = await bootRouteServer(async () => {}, {
    repoRoot,
    env: {
      CAREERRAT_RUNTIME_SKILLS: "apply-job,sync-status,evaluate-job",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      APPLE_ID_PASSWORD: "apple-secret",
    },
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/runtime/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.runtime, {
      defaultToolProfile: DEFAULT_RUNTIME_TOOL_PROFILE,
      defaultTools: [...APP_SAFE_RUNTIME_TOOLS],
      toolHeavy: {
        available: false,
        skills: [],
      },
    });
    assert.doesNotMatch(JSON.stringify(body), /sk-ant-secret|apple-secret|ANTHROPIC_API_KEY/);
  } finally {
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("POST /api/skill/run: dispatches only exact-read skills and rejects workspace workflows", async () => {
  const repoRoot = tempRepoWithSkills(["intake-extract", "resume-extract", "evaluate-job"]);
  const calls = [];
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-hermetic",
    CAREERRAT_RUNTIME_SKILLS: "intake-extract,resume-extract,evaluate-job",
  };
  const server = await bootRouteServer(
    async ({ skill, approvedReadPaths, onEvent }) => {
      calls.push({ skill, approvedReadPaths });
      onEvent({ type: "result", data: { ok: true, skill } });
    },
    { repoRoot, env }
  );

  try {
    for (const skill of ["intake-extract", "resume-extract"]) {
      const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill, input: { path: `/fixture/${skill}.pdf` } }),
      });
      assert.equal(res.status, 200);
      assert.match(await readSseBody(res), new RegExp(`\\"skill\\":\\"${skill}\\"`));
    }

    const rejected = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "evaluate-job", input: { qa: true } }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /not available through \/api\/skill\/run/i);
    assert.deepEqual(calls, [
      {
        skill: "intake-extract",
        approvedReadPaths: ["/fixture/intake-extract.pdf"],
      },
      {
        skill: "resume-extract",
        approvedReadPaths: ["/fixture/resume-extract.pdf"],
      },
    ]);
  } finally {
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Body validation — never reaches runSkillStream
// ---------------------------------------------------------------------------

test("POST /api/skill/run: 400 when body.skill is missing", async () => {
  let called = false;
  const server = await bootRouteServer(async () => {
    called = true;
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /skill.*required/);
    assert.equal(called, false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/skill/run: 400 on malformed JSON", async () => {
  const server = await bootRouteServer(async () => {});
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    assert.equal(res.status, 400);
    await res.json();
  } finally {
    await closeServer(server);
  }
});

test("POST /api/skill/run: 415 for a non-JSON content type", async () => {
  let called = false;
  const server = await bootRouteServer(async ({ onEvent }) => {
    called = true;
    onEvent({ type: "result", data: { ok: true } });
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ skill: "evaluate-job", input: "hi" }),
    });
    assert.equal(res.status, 415);
    assert.equal(called, false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/skill/run: 413 when the body exceeds the 1MB cap", async () => {
  const server = await bootRouteServer(async () => {});
  try {
    const oversized = JSON.stringify({
      skill: "evaluate-job",
      input: "x".repeat(1024 * 1024 + 10),
    });
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    assert.equal(res.status, 413);
    await res.json();
  } finally {
    await closeServer(server);
  }
});

test("POST /api/skill/run: rejects tool-heavy profile requests before streaming starts", async () => {
  let called = false;
  const server = await bootRouteServer(async ({ onEvent }) => {
    called = true;
    onEvent({ type: "result", data: { ok: false, unexpectedRun: true } });
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skill: "resume-extract",
        input: "hi",
        toolProfile: "tool-heavy",
      }),
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.doesNotMatch(res.headers.get("content-type") || "", /text\/event-stream/);
    const body = await res.json();
    assert.match(body.error, /unsupported.*tool-heavy/i);
    assert.equal(called, false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/skill/run: rejects app workflows before they reach the generic runtime", async () => {
  let called = false;
  const server = await bootRouteServer(async () => {
    called = true;
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skill: "apply-job",
        input: { appId: "app-1" },
        toolProfile: "tool-heavy",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /not available through \/api\/skill\/run/i);
    assert.equal(called, false);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Status-code mapping for validation failures from runSkillStream — these
// must land as a real HTTP status, not a 200 with an in-band SSE error,
// because runSkillStream is expected to fail BEFORE calling onEvent.
// ---------------------------------------------------------------------------

test("POST /api/skill/run: 400 when runSkillStream rejects SKILL_NOT_ALLOWED before streaming", async () => {
  const server = await bootRouteServer(async () => {
    const err = new Error("skill not allowed");
    err.code = "SKILL_NOT_ALLOWED";
    throw err;
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "resume-extract", input: "hi" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /skill not allowed/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/skill/run: 400 when runSkillStream rejects NO_AI_ROUTE before streaming", async () => {
  const server = await bootRouteServer(async () => {
    const err = new Error("no AI route configured");
    err.code = "NO_AI_ROUTE";
    throw err;
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "resume-extract", input: "hi" }),
    });
    assert.equal(res.status, 400);
    await res.json();
  } finally {
    await closeServer(server);
  }
});

test("POST /api/skill/run: 501 when runSkillStream rejects SDK_NOT_INSTALLED before streaming", async () => {
  const server = await bootRouteServer(async () => {
    const err = new Error("@anthropic-ai/claude-agent-sdk is not installed");
    err.code = "SDK_NOT_INSTALLED";
    throw err;
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "resume-extract", input: "hi" }),
    });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.match(body.error, /not installed/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/skill/run: an unrecognized error code before streaming is a 500", async () => {
  const server = await bootRouteServer(async () => {
    throw new Error("something unexpected");
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "resume-extract", input: "hi" }),
    });
    assert.equal(res.status, 500);
    await res.json();
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// SSE framing — once streaming has genuinely started
// ---------------------------------------------------------------------------

test("POST /api/skill/run: streams mapped events as SSE and passes skill/input through", async () => {
  let received = null;
  const server = await bootRouteServer(async ({ skill, input, onEvent }) => {
    received = { skill, input };
    onEvent({ type: "system", data: { subtype: "init" } });
    onEvent({ type: "result", data: { ok: true, durationMs: 42 } });
    return { ok: true, durationMs: 42 };
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "resume-extract", input: "/fixture/resume.pdf" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const text = await readSseBody(res);
    assert.match(text, /event: system\ndata: \{"subtype":"init"\}/);
    assert.match(text, /event: result\ndata: \{"ok":true,"durationMs":42\}/);
    assert.deepEqual(received, { skill: "resume-extract", input: "/fixture/resume.pdf" });
  } finally {
    await closeServer(server);
  }
});

test("POST /api/skill/run: a failure after streaming already started is reported in-band, not as a second status", async () => {
  const server = await bootRouteServer(async ({ onEvent }) => {
    onEvent({ type: "system", data: { subtype: "init" } });
    throw new Error("boom mid-stream");
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "resume-extract", input: "hi" }),
    });
    assert.equal(res.status, 200); // headers already committed before the throw
    const text = await readSseBody(res);
    assert.match(text, /event: system/);
    assert.match(text, /event: error\ndata: \{"message":"boom mid-stream"\}/);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Client-disconnect abort
// ---------------------------------------------------------------------------

test("POST /api/skill/run: aborts the underlying runSkillStream signal when the client disconnects", async () => {
  let sawAbort;
  const abortSeen = new Promise((resolve) => {
    sawAbort = resolve;
  });
  const server = await bootRouteServer(
    ({ signal, onEvent }) =>
      new Promise((resolve) => {
        onEvent({ type: "system", data: { subtype: "init" } });
        signal.addEventListener("abort", () => {
          sawAbort();
          resolve({ ok: false, aborted: true });
        });
        // Never resolves on its own — only the abort listener settles it,
        // simulating a long-running query the client walks away from.
      })
  );
  try {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl(server)}/api/skill/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "resume-extract", input: "hi" }),
      signal: controller.signal,
    });
    // Start reading, then abort the client request — this is what tears down
    // the server-side `req` and fires its 'close' event.
    const reader = res.body.getReader();
    await reader.read(); // consume the first "system" event so we know we're mid-stream
    controller.abort();
    await abortSeen;
  } finally {
    await closeServer(server);
  }
});
