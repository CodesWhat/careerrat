// tests/intake-route.test.mjs — the HTTP surface for M9 Universal Intake
// (src/cli/intake-route.mjs), mounted on a bare addRoute Map wrapped in
// http.createServer, mirroring tests/data-route.test.mjs's bootServer() and
// tests/assist-route.test.mjs's fakeSdk() convention. `runSkillStream` and
// `chatRuntime` are hand-rolled stubs here — no real Agent SDK subprocess,
// no real chat-runtime session pump — so Lane A/B/C execution is fully
// observable and deterministic.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mountIntakeRoutes } from "../src/cli/intake-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { intakeCapture, intakeOne, intakeUpdate } from "../src/core/db/verbs.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-intake-route-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  for (const relPath of ["config/intake-classify.schema.json", "config/paste-intake-routes.json"]) {
    copyFileSync(join(REAL_ROOT, relPath), join(repoRoot, relPath));
  }
  return repoRoot;
}

after(() => {
  closeAll();
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

function fakeSdk(messages) {
  return {
    query: ({ options }) => {
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

function jsonReply(obj) {
  return `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
}

function classificationFixture(overrides = {}) {
  return {
    kind: "jd-text",
    entities: {
      company: null,
      role: null,
      url: null,
      statusTo: null,
      statusNote: null,
      contactName: null,
      contactEmail: null,
      interviewDate: null,
    },
    proposedAction: "Evaluate this posting against your gate.",
    confidence: 0.9,
    needsUser: false,
    needsUserReason: null,
    ...overrides,
  };
}

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountIntakeRoutes({
    addRoute,
    repoRoot,
    env: opts.env ?? PROXY_ENV,
    fetchImpl: opts.fetchImpl,
    loadSdk: opts.loadSdk,
    runSkillStream: opts.runSkillStream,
    chatRuntime: opts.chatRuntime,
  });

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

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

function seedApp(repoRoot, app) {
  seedApps(repoRoot, [app]);
}

function seedApps(repoRoot, apps) {
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      { meta: {}, applications: apps, sourced: [], sources: [], communications: [] },
      null,
      2
    )
  );
  importFromTracker({ repoRoot, sourceDir });
}

async function waitForPredicate(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitForPredicate: condition never became true");
}

// ---------------------------------------------------------------------------
// Fail-closed: no db file yet -> 409 on every route.
// ---------------------------------------------------------------------------

test("every /api/intake route 409s with the fail-closed message when no db exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const capture = await postJson(server, "/api/intake", { text: "hello" });
    assert.equal(capture.status, 409);
    assert.match(capture.body.error, /no database yet/);

    const list = await getJson(server, "/api/intake/list");
    assert.equal(list.status, 409);

    const one = await getJson(server, "/api/intake/one?id=x");
    assert.equal(one.status, 409);

    const classify = await postJson(server, "/api/intake/classify", { id: "x" });
    assert.equal(classify.status, 409);

    const confirm = await postJson(server, "/api/intake/confirm", { id: "x" });
    assert.equal(confirm.status, 409);

    const dismiss = await postJson(server, "/api/intake/dismiss", { id: "x" });
    assert.equal(dismiss.status, 409);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/intake — capture + validation
// ---------------------------------------------------------------------------

test("POST /api/intake: 400 on missing/blank text", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const missing = await postJson(server, "/api/intake", {});
    assert.equal(missing.status, 400);
    const blank = await postJson(server, "/api/intake", { text: "   " });
    assert.equal(blank.status, 400);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: 400 on an invalid explicit inputKind", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "hi",
      inputKind: "screenshot",
    });
    assert.equal(status, 400);
    assert.match(body.error, /"text" or "url"/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: captures text, classifies via the mocked AI route, ends at 'proposed' with a Lane B dispatch", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({ kind: "jd-text", entities: { company: "Acme", role: "SRE" } })
          )
        )
      ),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "We are hiring an SRE at Acme...",
    });
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.kind, "jd-text");
    assert.deepEqual(body.item.dispatch, {
      lane: "B",
      action: "run_skill",
      params: { skill: "evaluate-job" },
    });
    assert.equal(body.item.inputKind, "text");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: a bare URL auto-detects inputKind:'url' and skips AI when a known-ATS fetch resolves", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const url = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const server = await bootServer(repoRoot, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jobs: [
          {
            title: "Staff Engineer",
            absolute_url: url,
            location: { name: "Remote" },
            content: "<p>JD</p>",
          },
        ],
      }),
    }),
    loadSdk: async () => {
      throw new Error("must never be called — this posting resolves deterministically");
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", { text: url });
    assert.equal(status, 200);
    assert.equal(body.item.inputKind, "url");
    assert.equal(body.item.kind, "job-url");
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.classification.confidence, 1);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: an ambiguous/unclassifiable paste ends at 'needs_you'", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({
              kind: "other",
              needsUser: true,
              needsUserReason: "no clear owner",
            })
          )
        )
      ),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", { text: "a stray note" });
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    assert.equal(body.item.dispatch, null);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: a status-update paste naming only the company (no role) matches company_unique against the single tracked app, dispatches Lane A, and confirm actually writes the status", async () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  seedApps(repoRoot, [
    {
      id: "demo-app-1",
      company: "E Corp",
      role: "Staff Software Engineer",
      status: "applied",
      appliedAt: "2026-06-01",
    },
  ]);

  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({
              kind: "status-update",
              entities: {
                company: "E Corp",
                role: null,
                url: null,
                statusTo: "rejected",
                statusNote: "They passed after the final round, position filled internally.",
                contactName: null,
                contactEmail: null,
                interviewDate: null,
              },
              confidence: 0.95,
            })
          )
        )
      ),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "Just heard back from E Corp — they passed after the final round, position filled internally.",
    });
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.kind, "status-update");
    assert.equal(body.item.trackerMatch.matched, true);
    assert.equal(body.item.trackerMatch.confidence, "company_unique");
    assert.equal(body.item.trackerMatch.recordType, "application");
    assert.equal(body.item.trackerMatch.id, "demo-app-1");
    assert.deepEqual(body.item.dispatch, {
      lane: "A",
      action: "app_set_status",
      params: {
        applicationId: "demo-app-1",
        to: "rejected",
        note: "They passed after the final round, position filled internally.",
        matchedCompany: "E Corp",
        matchedRole: "Staff Software Engineer",
        matchedSummary: body.item.trackerMatch.summary,
      },
    });

    const confirmed = await postJson(server, "/api/intake/confirm", { id: body.item.id });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.item.status, "done");
    assert.equal(confirmed.body.item.result.applicationId, "demo-app-1");

    const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("demo-app-1");
    assert.equal(JSON.parse(row.data).status, "rejected");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: a company-only status-update stays needs_you when TWO tracked apps share that company (still ambiguous)", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedApps(repoRoot, [
    { id: "app-a", company: "E Corp", role: "Staff Software Engineer", status: "applied" },
    { id: "app-b", company: "E Corp", role: "Senior Backend Engineer", status: "interviewing" },
  ]);

  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({
              kind: "status-update",
              entities: {
                company: "E Corp",
                role: null,
                url: null,
                statusTo: "rejected",
                statusNote: "They passed.",
                contactName: null,
                contactEmail: null,
                interviewDate: null,
              },
              confidence: 0.9,
            })
          )
        )
      ),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "Just heard back from E Corp — they passed.",
    });
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    // dispatch is NOT null here (that only happens when the model itself
    // flags needsUser) — resolveIntakeDispatch ran, saw an unmatched
    // trackerMatch, and correctly refused to guess.
    assert.equal(body.item.dispatch.lane, null);
    assert.equal(body.item.dispatch.action, "needs_you");
    assert.match(body.item.dispatch.params.reason, /never guess/);
    assert.equal(body.item.trackerMatch.matched, false);
    assert.equal(body.item.trackerMatch.confidence, null);
    assert.equal(body.item.trackerMatch.companyHistory.length, 2);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// GET /api/intake/list, /api/intake/one
// ---------------------------------------------------------------------------

test("GET /api/intake/list + /api/intake/one round-trip a captured item", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "hello", inputKind: "text" });

  const server = await bootServer(repoRoot);
  try {
    const list = await getJson(server, "/api/intake/list");
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.items.map((i) => i.id),
      [id]
    );

    const one = await getJson(server, `/api/intake/one?id=${id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.item.id, id);

    const missing = await getJson(server, "/api/intake/one?id=nope");
    assert.equal(missing.status, 404);

    const noId = await getJson(server, "/api/intake/one");
    assert.equal(noId.status, 400);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/intake/classify (re-run)
// ---------------------------------------------------------------------------

test("POST /api/intake/classify: 404 for an unknown id, 400 for a missing id", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const missing = await postJson(server, "/api/intake/classify", {});
    assert.equal(missing.status, 400);
    const unknown = await postJson(server, "/api/intake/classify", { id: "nope" });
    assert.equal(unknown.status, 404);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/classify: 409 when the item is already confirmed", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  intakeUpdate({ repoRoot, id, patch: { status: "confirmed" } });
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/intake/classify", { id });
    assert.equal(status, 409);
    assert.match(body.error, /cannot be re-classified/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/classify: re-runs classification on an existing item and updates its status", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({
    repoRoot,
    rawInput: "some recruiter email text",
    inputKind: "text",
  });
  intakeUpdate({ repoRoot, id, patch: { status: "error", error: "first attempt failed" } });

  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(assistantTextRun(jsonReply(classificationFixture({ kind: "recruiter-email" })))),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake/classify", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.kind, "recruiter-email");
    assert.deepEqual(body.item.dispatch, {
      lane: "C",
      action: "chat_skill",
      params: { skill: "email-comms" },
    });
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/intake/confirm — Lane A/B/C execution
// ---------------------------------------------------------------------------

test("POST /api/intake/confirm: 400 missing id, 404 unknown id, 409 when not 'proposed'", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  intakeUpdate({ repoRoot, id, patch: { status: "needs_you" } });

  const server = await bootServer(repoRoot);
  try {
    const missing = await postJson(server, "/api/intake/confirm", {});
    assert.equal(missing.status, 400);

    const unknown = await postJson(server, "/api/intake/confirm", { id: "nope" });
    assert.equal(unknown.status, 404);

    const wrongStatus = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(wrongStatus.status, 409);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane A calls appSetStatus directly and settles at 'done'", async () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  seedApp(repoRoot, { id: "app-1", company: "Acme", role: "SRE", status: "applied" });

  const { id } = intakeCapture({ repoRoot, rawInput: "They rejected me", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "status-update",
      classification: classificationFixture({
        kind: "status-update",
        entities: { statusTo: "rejected" },
      }),
      trackerMatch: {
        matched: true,
        recordType: "application",
        id: "app-1",
        confidence: "exact_url",
      },
      dispatch: {
        lane: "A",
        action: "app_set_status",
        params: { applicationId: "app-1", to: "rejected", note: null },
      },
    },
  });

  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "done");
    assert.equal(body.item.result.applicationId, "app-1");

    const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-1");
    assert.equal(JSON.parse(row.data).status, "rejected");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane B fires runSkillStream in the background — 'running' immediately, 'done' once it settles", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "a JD", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "jd-text",
      classification: classificationFixture(),
      trackerMatch: null,
      dispatch: { lane: "B", action: "run_skill", params: { skill: "evaluate-job" } },
    },
  });

  let seenSkill = null;
  const server = await bootServer(repoRoot, {
    runSkillStream: async ({ skill }) => {
      seenSkill = skill;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, subtype: "success" };
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "running");
    assert.equal(seenSkill, "evaluate-job");

    await waitForPredicate(() => intakeOne({ repoRoot, id }).status === "done");
    const settled = intakeOne({ repoRoot, id });
    assert.deepEqual(settled.result, { ok: true, subtype: "success" });
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane B settles to 'error' when the background run rejects", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "a JD", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "jd-text",
      classification: classificationFixture(),
      trackerMatch: null,
      dispatch: { lane: "B", action: "run_skill", params: { skill: "evaluate-job" } },
    },
  });

  const server = await bootServer(repoRoot, {
    runSkillStream: async () => {
      throw new Error("skill run blew up");
    },
  });
  try {
    const { body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(body.item.status, "running");

    await waitForPredicate(() => intakeOne({ repoRoot, id }).status === "error");
    const settled = intakeOne({ repoRoot, id });
    assert.match(settled.error, /skill run blew up/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane C starts a new chat session when none is live", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "recruiter email text", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "recruiter-email",
      classification: classificationFixture({ kind: "recruiter-email" }),
      trackerMatch: null,
      dispatch: { lane: "C", action: "chat_skill", params: { skill: "email-comms" } },
    },
  });

  let startSessionCalled = null;
  const chatRuntime = {
    findBySkill: () => null,
    postMessage: () => {
      throw new Error("must not postMessage when no live session exists");
    },
    startSession: async ({ skill, input }) => {
      startSessionCalled = { skill, input };
      return { chatId: "chat-new", skill, state: "running" };
    },
  };

  const server = await bootServer(repoRoot, { chatRuntime });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "running");
    assert.equal(body.item.result.chatId, "chat-new");
    assert.equal(startSessionCalled.skill, "email-comms");
    assert.equal(startSessionCalled.input.intakeId, id);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane C reuses an existing live session via postMessage instead of starting a new one", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "recruiter email text", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "recruiter-email",
      classification: classificationFixture({ kind: "recruiter-email" }),
      trackerMatch: null,
      dispatch: { lane: "C", action: "chat_skill", params: { skill: "email-comms" } },
    },
  });

  let postMessageArgs = null;
  const chatRuntime = {
    findBySkill: (skill) =>
      skill === "email-comms" ? { chatId: "chat-live", skill, state: "idle" } : null,
    postMessage: (chatId, text) => {
      postMessageArgs = { chatId, text };
      return { accepted: true };
    },
    startSession: async () => {
      throw new Error("must not start a new session when one is already live");
    },
  };

  const server = await bootServer(repoRoot, { chatRuntime });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.result.chatId, "chat-live");
    assert.equal(postMessageArgs.chatId, "chat-live");
    assert.match(postMessageArgs.text, /recruiter email text/);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/intake/dismiss
// ---------------------------------------------------------------------------

test("POST /api/intake/dismiss: happy path from 'proposed', 409 from a non-dismissable status", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id: idA } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  intakeUpdate({ repoRoot, id: idA, patch: { status: "proposed" } });

  const { id: idB } = intakeCapture({ repoRoot, rawInput: "y", inputKind: "text" });
  // idB stays at "captured" — not in DISMISSABLE_STATUSES.

  const server = await bootServer(repoRoot);
  try {
    const ok = await postJson(server, "/api/intake/dismiss", { id: idA });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.status, "dismissed");

    const rejected = await postJson(server, "/api/intake/dismiss", { id: idB });
    assert.equal(rejected.status, 409);
  } finally {
    await closeServer(server);
  }
});
