import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";

const RETIRED_HTML_ROUTES = [
  "/answer",
  "/chat",
  "/evaluate",
  "/onboard",
  "/packet",
  "/search",
  "/tracker",
];
const RETIRED_HTML_BUILDERS = [
  "src/core/ai/answer-page.mjs",
  "src/core/onboarding/chat-page.mjs",
  "src/core/onboarding/onboard-page.mjs",
  "src/core/onboarding/packet-page.mjs",
  "src/core/onboarding/search-page.mjs",
];

function tempRepoWithSkills(skillNames = []) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-app-route-guard-"));
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

test("retired standalone HTML routes resolve nowhere outside the React app", async () => {
  const repoRoot = tempRepoWithSkills(["ingest-profile"]);
  const dev = await bootServer(repoRoot);
  try {
    for (const route of RETIRED_HTML_ROUTES) {
      const res = await fetch(`${baseUrl(dev)}${route}`);
      assert.equal(res.status, 404, `${route} must stay retired`);
      const body = await res.text();
      assert.match(body, /Product app route: \/app/);
      assert.doesNotMatch(body, /user-selected chat page/i);
    }
  } finally {
    teardown(dev, repoRoot);
  }
});

test("the React app is the only HTML product route and retired builders cannot reappear", () => {
  const server = readFileSync("src/cli/tracker-dev.mjs", "utf8");
  const security = readFileSync("src/core/tracker/request-security.mjs", "utf8");

  assert.match(server, /url === "\/app" \|\| url\.startsWith\("\/app\/"\)/);
  assert.match(server, /url === "\/"[\s\S]*Location: "\/app"/);
  for (const route of RETIRED_HTML_ROUTES) {
    assert.equal(server.includes(`addRoute("GET", "${route}"`), false);
    assert.equal(security.includes(`url === "${route}"`), false);
  }
  for (const file of RETIRED_HTML_BUILDERS) {
    assert.equal(existsSync(file), false, `${file} must stay deleted`);
  }
});

test("tracker-dev only watches canonical data events and never starts the retired tracker renderer", () => {
  const server = readFileSync("src/cli/tracker-dev.mjs", "utf8");

  assert.doesNotMatch(server, /TRACKER_CLI|renderOnce|rerenderAndReload|scheduleRerender/);
  assert.doesNotMatch(server, /watch\(TRACKER_SRC_DIR|watch\(CANDIDATE_DIR/);
  assert.doesNotMatch(server, /event:\s*reload/);
  assert.match(server, /broadcastEvent\("tracker-update"\)/);
  assert.match(server, /broadcastEvent\("activity-update"\)/);
});

test("retiring standalone pages preserves the chat API used by the chat-first shell", async () => {
  const repoRoot = tempRepoWithSkills(["ingest-profile"]);
  const dev = await bootServer(repoRoot);
  try {
    const health = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const sessions = await fetch(`${baseUrl(dev)}/api/chat/list`);
    assert.equal(sessions.status, 200);
    assert.deepEqual(await sessions.json(), []);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("createDevServer accepts the injected chat runtime used by shell tests", async () => {
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
