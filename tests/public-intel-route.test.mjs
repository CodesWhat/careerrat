import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mountDiscoveryRoutes } from "../src/cli/discovery-route.mjs";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

function fakeChatRuntime() {
  return {
    starts: [],
    startSession(args) {
      this.starts.push(args);
      throw new Error("public-intel local APIs must not start chat runtime");
    },
    findBySkill() {
      return null;
    },
  };
}

function bootServer(overrides = {}) {
  const routes = new Map();
  const chatRuntime = overrides.chatRuntime || fakeChatRuntime();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDiscoveryRoutes({
    addRoute,
    repoRoot: "/tmp/careerrat-public-intel-route-test",
    env: {},
    chatRuntime,
    loadAgentGuidance: () => null,
    now: NOW,
    ...overrides,
  });
  return { routes, chatRuntime };
}

async function invokeJson(server, method, path, payload) {
  const route = server.routes.get(`${method} ${path}`);
  assert.ok(route, `missing route: ${method} ${path}`);
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
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
  return { status: res.status, body: res.rawBody ? JSON.parse(res.rawBody) : {} };
}

function postJson(server, path, payload = {}) {
  return invokeJson(server, "POST", path, payload);
}

function getJson(server, path) {
  return invokeJson(server, "GET", path);
}

function assertNoRuntimeFallback(body) {
  const serialized = JSON.stringify(body);
  for (const token of [
    "/api/chat",
    "/api/skill/run",
    "chatId",
    "research-boards",
    "discover-companies",
    "search-jobs",
  ]) {
    assert.equal(
      serialized.includes(token),
      false,
      `response leaked runtime fallback token ${token}`
    );
  }
}

function source(path) {
  return readFileSync(`${REAL_ROOT}/${path}`, "utf8");
}

function sliceBetween(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing start marker ${start}`);
  const to = text.indexOf(end, from);
  assert.notEqual(to, -1, `missing end marker ${end}`);
  return text.slice(from, to);
}

test("public-intel local route slice has no hidden chat or retained skill runtime calls", () => {
  const routeSource = source("src/cli/discovery-route.mjs");
  const publicIntelSlice = sliceBetween(
    routeSource,
    'addRoute("GET", "/api/discovery/public-intel/state"',
    'addRoute("POST", "/api/discovery/company-proposals"'
  );

  for (const forbidden of [
    "startOrReuseDiscoveryChat",
    "chatRuntime.startSession",
    "chatRuntime.postMessage",
    "runSkillStream",
    "/api/chat",
    "/api/skill/run",
  ]) {
    assert.equal(
      publicIntelSlice.includes(forbidden),
      false,
      `public-intel route leaked ${forbidden}`
    );
  }
});

test("public scanner modules do not import retained skill runtime or chat seams", () => {
  for (const path of [
    "src/core/discovery/scanner-cascade.mjs",
    "src/core/discovery/public-page-extractor.mjs",
    "src/core/discovery/public-scanner-ai.mjs",
  ]) {
    const text = source(path);
    for (const forbidden of ["skill-runtime", "runSkillStream", "chatRuntime", "/api/skill/run"]) {
      assert.equal(text.includes(forbidden), false, `${path} leaked ${forbidden}`);
    }
  }
});

test("public-intel state, scan, review, and sync-preview routes are local and dependency-injected", async () => {
  const calls = [];
  const server = bootServer({
    publicIntelStateGetImpl: () => ({ ok: true, data: { preference: { enabled: true } } }),
    publicIntelScanImpl: async ({ body }) => {
      calls.push(["scan", body]);
      return { ok: true, data: { scanned: 1, reviewCreated: 0 } };
    },
    publicIntelReviewListImpl: () => ({
      ok: true,
      data: { items: [{ id: "review-1", reason: "ambiguous_public_page", version: 1 }] },
    }),
    publicIntelSyncPreviewImpl: () => ({
      ok: true,
      data: { companies: [], boards: [], careersPages: [] },
    }),
  });

  const state = await getJson(server, "/api/discovery/public-intel/state");
  assert.equal(state.status, 200);
  assert.equal(state.body.ok, true);
  assertNoRuntimeFallback(state.body);

  const scan = await postJson(server, "/api/discovery/public-intel/scan", {
    seeds: [{ name: "Acme AI", domain: "acme.example" }],
  });
  assert.equal(scan.status, 200);
  assert.deepEqual(calls, [["scan", { seeds: [{ name: "Acme AI", domain: "acme.example" }] }]]);
  assertNoRuntimeFallback(scan.body);

  const review = await getJson(server, "/api/discovery/public-intel/review");
  assert.equal(review.status, 200);
  assert.equal(review.body.data.items.length, 1);
  assertNoRuntimeFallback(review.body);

  const preview = await getJson(server, "/api/discovery/public-intel/sync-preview");
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.data, { companies: [], boards: [], careersPages: [] });
  assertNoRuntimeFallback(preview.body);
  assert.equal(server.chatRuntime.starts.length, 0);
});

test("public-intel scan route returns local scrub errors instead of chat or skill fallback", async () => {
  const server = bootServer({
    publicIntelScanImpl: async () => {
      const err = new Error("public payload includes private field at candidate.profile");
      err.code = "PUBLIC_INTEL_PRIVATE_FIELD";
      err.status = 400;
      throw err;
    },
  });

  const { status, body } = await postJson(server, "/api/discovery/public-intel/scan", {
    seeds: [{ name: "Private Leak", candidate: { full_name: "Private" } }],
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.code, "PUBLIC_INTEL_PRIVATE_FIELD");
  assert.match(body.error.message, /private field/);
  assertNoRuntimeFallback(body);
  assert.equal(server.chatRuntime.starts.length, 0);
});

test("public-intel review decisions enforce expected versions and action vocabulary", async () => {
  const decisions = [];
  const server = bootServer({
    publicIntelReviewDecisionImpl: async ({ body }) => {
      decisions.push(body);
      if (body.expectedVersion !== 3) {
        const err = new Error("review item changed");
        err.code = "CONFLICT";
        err.status = 409;
        throw err;
      }
      return {
        ok: true,
        data: {
          item: { id: body.itemId, status: "resolved", version: 4 },
          action: body.action,
        },
      };
    },
  });

  const conflict = await postJson(server, "/api/discovery/public-intel/review-decisions", {
    itemId: "review-1",
    expectedVersion: 2,
    action: "keep-public-metadata",
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "CONFLICT");

  const ok = await postJson(server, "/api/discovery/public-intel/review-decisions", {
    itemId: "review-1",
    expectedVersion: 3,
    action: "use-supported-ats",
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.action, "use-supported-ats");
  assert.deepEqual(
    decisions.map((body) => body.action),
    ["keep-public-metadata", "use-supported-ats"]
  );
});
