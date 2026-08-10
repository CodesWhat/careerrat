import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";

import { mountInstalledRuntimeRoutes } from "../src/cli/installed-runtime-route.mjs";
import { loadInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";

const roots = new Set();

function root() {
  const value = mkdtempSync(join(tmpdir(), "rolester-runtime-route-"));
  roots.add(value);
  return value;
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.clear();
});

function boot({
  inventory,
  probes,
  env = { ROLESTER_DESKTOP_SHELL: "1" },
  openTerminalImpl,
  probeCustomImpl,
}) {
  const repoRoot = root();
  const routes = new Map();
  mountInstalledRuntimeRoutes({
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    repoRoot,
    env,
    detectImpl: () => inventory,
    probeImpl: (runtime) => probes[runtime.id],
    openTerminalImpl,
    probeCustomImpl,
  });
  return { routes, repoRoot, env };
}

async function request(server, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.headers = body === undefined ? {} : { "content-type": "application/json" };
  let status = null;
  let text = "";
  const res = {
    writeHead(value) {
      status = value;
      return this;
    },
    end(value = "") {
      text += value;
    },
  };
  const handler = server.routes.get(`${method} ${path}`);
  assert.ok(handler, `missing ${method} ${path}`);
  await handler(req, res);
  return { status, body: JSON.parse(text) };
}

const INVENTORY = [
  {
    id: "claude",
    name: "Claude Code",
    commandShape: "claude -p --output-format json",
    path: "/Users/morgan/.local/bin/claude",
    available: true,
    warning: null,
  },
  {
    id: "codex",
    name: "Codex",
    commandShape: "codex exec --json -",
    path: "/opt/homebrew/bin/codex",
    available: true,
    warning: null,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    commandShape: "gemini -p",
    path: null,
    available: false,
    warning: "reduced",
    installUrl: "https://github.com/google-gemini/gemini-cli",
  },
];

test("inventory probes installed CLIs, auto-selects the first ready one, and persists it", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "open_terminal" },
      codex: { status: "ready", ready: true, action: null },
    },
  });
  const response = await request(server, "GET", "/api/settings/ai-runtimes");
  assert.equal(response.status, 200);
  assert.equal(response.body.selectedId, "codex");
  assert.equal(response.body.providerFallback, false);
  assert.deepEqual(
    response.body.runtimes.map(({ id, status, ready, selected }) => ({
      id,
      status,
      ready,
      selected,
    })),
    [
      { id: "claude", status: "authentication_required", ready: false, selected: false },
      { id: "codex", status: "ready", ready: true, selected: true },
      { id: "gemini", status: "not_installed", ready: false, selected: false },
      { id: "custom", status: "not_installed", ready: false, selected: false },
    ]
  );
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: "codex",
    providerFallback: false,
    customCommand: null,
  });
  assert.equal(JSON.stringify(response.body).includes("morgan@example.com"), false);
  // The registry's installUrl passes through the route untouched — the
  // onboarding not-found row's "INSTALL GUIDE" link depends on this.
  assert.equal(
    response.body.runtimes.find(({ id }) => id === "gemini").installUrl,
    "https://github.com/google-gemini/gemini-cli"
  );
});

test("Open Terminal is an explicit user action with a fixed sign-in command", async () => {
  const opened = [];
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "open_terminal" },
      codex: { status: "ready", ready: true, action: null },
    },
    openTerminalImpl: (runtime) => opened.push(runtime),
  });
  const response = await request(server, "POST", "/api/settings/ai-runtime/open-terminal", {
    runtimeId: "claude",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.signInCommand, "claude auth login");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].id, "claude");
});

test("selection rejects an unavailable or unauthenticated runtime with an actionable code", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "open_terminal" },
      codex: { status: "ready", ready: true, action: null },
    },
  });
  const signedOut = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "claude",
  });
  assert.equal(signedOut.status, 409);
  assert.equal(signedOut.body.code, "RUNTIME_AUTH_REQUIRED");
  assert.equal(signedOut.body.action, "open_terminal");

  const missing = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "gemini",
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "RUNTIME_NOT_AVAILABLE");
});

test("Advanced provider fallback is explicit, durable, and reversible", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "ready", ready: true, action: null },
      codex: { status: "ready", ready: true, action: null },
    },
  });
  const provider = await request(server, "POST", "/api/settings/ai-runtime/select", {
    providerFallback: true,
  });
  assert.equal(provider.status, 200);
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: null,
    providerFallback: true,
    customCommand: null,
  });

  const local = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "claude",
  });
  assert.equal(local.status, 200);
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: "claude",
    providerFallback: false,
    customCommand: null,
  });
});

test("custom/test runs the probe once and never persists anything", async () => {
  const calls = [];
  const server = boot({
    inventory: INVENTORY,
    probes: {},
    probeCustomImpl: async (args) => {
      calls.push(args);
      return { ok: true, elapsedMs: 420, output: "ack" };
    },
  });
  const response = await request(server, "POST", "/api/settings/ai-runtime/custom/test", {
    command: "~/bin/my-agent --name sonnet",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, elapsedMs: 420, output: "ack" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "~/bin/my-agent --name sonnet");
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: null,
    providerFallback: false,
    customCommand: null,
  });
});

test("custom/test surfaces a probe failure without persisting anything", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {},
    probeCustomImpl: async () => ({ ok: false, error: "Exited with status 1." }),
  });
  const response = await request(server, "POST", "/api/settings/ai-runtime/custom/test", {
    command: "broken-agent",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: false, error: "Exited with status 1." });
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: null,
    providerFallback: false,
    customCommand: null,
  });
});

test("custom/test rejects a blank command without invoking the probe", async () => {
  const calls = [];
  const server = boot({
    inventory: INVENTORY,
    probes: {},
    probeCustomImpl: async (args) => {
      calls.push(args);
      return { ok: true, elapsedMs: 1 };
    },
  });
  const response = await request(server, "POST", "/api/settings/ai-runtime/custom/test", {
    command: "   ",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { ok: false, error: "command is required" });
  assert.equal(calls.length, 0);
});

test("custom/select persists the custom command and it appears as the selected 'custom' entry", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "open_terminal" },
      codex: { status: "ready", ready: true, action: null },
    },
  });
  const select = await request(server, "POST", "/api/settings/ai-runtime/custom/select", {
    command: "~/bin/my-agent --name sonnet",
  });
  assert.equal(select.status, 200);
  assert.deepEqual(select.body, {
    ok: true,
    selectedId: "custom",
    customCommand: "~/bin/my-agent --name sonnet",
  });
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: "custom",
    providerFallback: false,
    customCommand: "~/bin/my-agent --name sonnet",
  });

  const inventoryResponse = await request(server, "GET", "/api/settings/ai-runtimes");
  assert.equal(inventoryResponse.status, 200);
  assert.equal(inventoryResponse.body.selectedId, "custom");
  const customEntry = inventoryResponse.body.runtimes.find(({ id }) => id === "custom");
  assert.deepEqual(customEntry, {
    id: "custom",
    name: "Custom command",
    commandShape: "~/bin/my-agent --name sonnet",
    path: "~/bin/my-agent --name sonnet",
    available: true,
    warning: null,
    status: "ready_unverified",
    ready: true,
    action: null,
    selected: true,
  });
});

test("custom/select rejects a blank command without persisting anything", async () => {
  const server = boot({ inventory: INVENTORY, probes: {} });
  const response = await request(server, "POST", "/api/settings/ai-runtime/custom/select", {
    command: "",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { ok: false, error: "command is required" });
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: null,
    providerFallback: false,
    customCommand: null,
  });
});

test("selecting a detected runtime after a custom command was chosen nulls customCommand (current intended behavior)", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "ready", ready: true, action: null },
      codex: { status: "ready", ready: true, action: null },
    },
  });
  const custom = await request(server, "POST", "/api/settings/ai-runtime/custom/select", {
    command: "~/bin/my-agent",
  });
  assert.equal(custom.status, 200);
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: "custom",
    providerFallback: false,
    customCommand: "~/bin/my-agent",
  });

  const generic = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "claude",
  });
  assert.equal(generic.status, 200);
  // writeInstalledRuntimeSelection() only keeps customCommand when
  // runtimeId === "custom" — selecting any other runtime clears it, so a
  // stale custom command never lingers behind a different active runtime.
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: "claude",
    providerFallback: false,
    customCommand: null,
  });
});
