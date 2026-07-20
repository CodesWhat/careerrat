// tests/discovery-route.test.mjs
// HTTP tests for the supervised discovery pipeline route. The route owns only
// orchestration: Quick Start prep stays in onboard-route.mjs, durable next-step
// state stays in doctor/agent-guidance, and visible transcripts stay in the
// existing chat runtime.

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { buildDiscoveryKickoff, mountDiscoveryRoutes } from "../src/cli/discovery-route.mjs";

function fakeChatRuntime() {
  const starts = [];
  const live = new Map();
  return {
    starts,
    startSession({ skill, input }) {
      starts.push({ skill, input });
      const session = { chatId: `${skill}-chat`, skill, state: "running" };
      live.set(skill, session);
      return session;
    },
    findBySkill(skill) {
      return live.get(skill) || null;
    },
    setLive(skill, session = { chatId: `${skill}-existing`, skill, state: "idle" }) {
      live.set(skill, session);
    },
  };
}

function bootServer({
  chatRuntime = fakeChatRuntime(),
  prepareQuickStart = () => ({
    status: 200,
    body: {
      ok: true,
      readiness: { search_ready: true, gate_ready: false, apply_ready: false },
      missing: { gate_ready: ["compensation floor"], apply_ready: ["evidence claims"] },
      nextSkill: "research-boards",
      nextMessage:
        "Search sources are ready. Run research-boards next, then discover-companies before the first search-jobs sweep.",
    },
  }),
  loadAgentGuidance = () => ({
    nextSkill: "research-boards",
    message: "Ask your agent to run research-boards next.",
    ctaLabel: "Run research-boards",
  }),
} = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDiscoveryRoutes({
    addRoute,
    repoRoot: "/tmp/rolester-discovery-route-test",
    env: {},
    chatRuntime,
    prepareQuickStart,
    loadAgentGuidance,
  });

  return { server: { routes }, chatRuntime };
}

async function postJson(server, path, payload = {}) {
  return invokeJson(server, "POST", path, payload);
}

async function getJson(server, path) {
  return invokeJson(server, "GET", path);
}

async function closeServer() {}

async function invokeJson(server, method, path, payload) {
  const route = server.routes.get(`${method} ${path}`);
  assert.ok(route, `missing route: ${method} ${path}`);

  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const req = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]);
  req.method = method;
  req.url = path;

  const res = {
    status: null,
    headers: null,
    rawBody: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(chunk = "") {
      this.rawBody += chunk;
      resolveEnded();
      return this;
    },
  };

  await route(req, res);
  if (res.status === null) await ended;
  const body = res.rawBody ? JSON.parse(res.rawBody) : {};
  return { status: res.status, body };
}

test("buildDiscoveryKickoff includes server-selected outbound-safe candidate context", () => {
  const kickoff = buildDiscoveryKickoff({
    skill: "research-boards",
    message: "Find more sources.",
    candidateContext: {
      role_buckets: [{ titles: ["Platform Engineer"] }],
      location: { remote: true },
    },
  });
  assert.match(kickoff, /Outbound-safe candidate context/);
  assert.match(kickoff, /Platform Engineer/);
  assert.match(kickoff, /"remote":true/);
});

test("POST /api/discovery/quick-start prepares sources and starts the visible research-boards chat", async () => {
  const { server, chatRuntime } = await bootServer();
  try {
    const { status, body } = await postJson(server, "/api/discovery/quick-start");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.chat.skill, "research-boards");
    assert.equal(body.locks.gateReady, false);
    assert.equal(body.locks.applyReady, false);
    assert.equal(chatRuntime.starts.length, 1);
    assert.equal(chatRuntime.starts[0].skill, "research-boards");
    assert.match(
      chatRuntime.starts[0].input,
      /research-boards -> discover-companies -> search-jobs/
    );
    assert.match(chatRuntime.starts[0].input, /Do not run evaluate-job/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/discovery/quick-start returns 501 when no AI route can start the handoff", async () => {
  const chatRuntime = fakeChatRuntime();
  chatRuntime.startSession = () => {
    const err = new Error("no AI route configured");
    err.code = "NO_AI_ROUTE";
    throw err;
  };
  const { server } = await bootServer({ chatRuntime });
  try {
    const { status, body } = await postJson(server, "/api/discovery/quick-start");
    assert.equal(status, 501);
    assert.equal(body.ok, false);
    assert.match(body.error, /no AI route configured/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/discovery/next starts the current dashboard-guided discovery skill", async () => {
  const { server, chatRuntime } = await bootServer({
    loadAgentGuidance: () => ({
      nextSkill: "discover-companies",
      message: "Ask your agent to run discover-companies next before search-jobs.",
      ctaLabel: "Run discover-companies",
    }),
  });
  try {
    const { status, body } = await postJson(server, "/api/discovery/next");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.guidance.nextSkill, "discover-companies");
    assert.equal(body.chat.skill, "discover-companies");
    assert.equal(chatRuntime.starts.length, 1);
    assert.equal(chatRuntime.starts[0].skill, "discover-companies");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/discovery/next returns 501 when no AI route can start the handoff", async () => {
  const chatRuntime = fakeChatRuntime();
  chatRuntime.startSession = () => {
    const err = new Error("no AI route configured");
    err.code = "NO_AI_ROUTE";
    throw err;
  };
  const { server } = await bootServer({ chatRuntime });
  try {
    const { status, body } = await postJson(server, "/api/discovery/next");
    assert.equal(status, 501);
    assert.equal(body.ok, false);
    assert.match(body.error, /no AI route configured/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/discovery/next refuses non-discovery guidance without starting a chat", async () => {
  const { server, chatRuntime } = await bootServer({
    loadAgentGuidance: () => ({
      nextSkill: "evaluate-job",
      message: "Ask your agent to evaluate a sourced role.",
      ctaLabel: "Run evaluate-job",
    }),
  });
  try {
    const { status, body } = await postJson(server, "/api/discovery/next");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.locked, true);
    assert.equal(body.chat, null);
    assert.equal(chatRuntime.starts.length, 0);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/discovery/next reuses an active chat for the guided skill", async () => {
  const chatRuntime = fakeChatRuntime();
  chatRuntime.setLive("discover-companies", {
    chatId: "existing-company-chat",
    skill: "discover-companies",
    state: "idle",
  });
  const { server } = await bootServer({
    chatRuntime,
    loadAgentGuidance: () => ({
      nextSkill: "discover-companies",
      message: "Ask your agent to run discover-companies next before search-jobs.",
    }),
  });
  try {
    const { status, body } = await postJson(server, "/api/discovery/next");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.chat.chatId, "existing-company-chat");
    assert.equal(body.chat.reused, true);
    assert.equal(body.activeDiscoveryChat.skill, "discover-companies");
    assert.equal(chatRuntime.starts.length, 0);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/discovery/next starts the guided skill instead of reusing a different active discovery chat", async () => {
  const chatRuntime = fakeChatRuntime();
  chatRuntime.setLive("search-jobs", {
    chatId: "existing-search-chat",
    skill: "search-jobs",
    state: "running",
  });
  const { server } = await bootServer({
    chatRuntime,
    loadAgentGuidance: () => ({
      nextSkill: "research-boards",
      message: "Ask your agent to run research-boards next.",
    }),
  });
  try {
    const { status, body } = await postJson(server, "/api/discovery/next");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.chat.skill, "research-boards");
    assert.equal(body.chat.chatId, "research-boards-chat");
    assert.equal(body.chat.reused, undefined);
    assert.equal(chatRuntime.starts.length, 1);
    assert.equal(chatRuntime.starts[0].skill, "research-boards");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/discovery/state returns guidance and the active discovery chat without starting work", async () => {
  const chatRuntime = fakeChatRuntime();
  chatRuntime.setLive("search-jobs", {
    chatId: "search-chat",
    skill: "search-jobs",
    state: "running",
  });
  const { server } = await bootServer({
    chatRuntime,
    loadAgentGuidance: () => ({
      nextSkill: "search-jobs",
      message: "Ask your agent to run search-jobs next for the first sweep.",
    }),
  });
  try {
    const { status, body } = await getJson(server, "/api/discovery/state");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.guidance.nextSkill, "search-jobs");
    assert.equal(body.activeDiscoveryChat.chatId, "search-chat");
    assert.equal(chatRuntime.starts.length, 0);
  } finally {
    await closeServer(server);
  }
});
