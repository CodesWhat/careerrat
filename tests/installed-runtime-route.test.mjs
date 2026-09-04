import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, mock, test } from "node:test";

import {
  inspectInstalledRuntimeState,
  mountInstalledRuntimeRoutes,
} from "../src/cli/installed-runtime-route.mjs";
import {
  reserveGuidedSetupOwnership,
  writeGuidedSetupOwnership,
} from "../src/core/ai/guided-setup-ownership.mjs";
import {
  INSTALLED_RUNTIME_DEFINITIONS,
  isInstalledRuntimeBelowVersionBoundary,
  startInstalledRuntimeGuidedSetup,
} from "../src/core/ai/installed-runtimes.mjs";
import {
  loadInstalledRuntimeSelection,
  writeInstalledRuntimeSelection,
} from "../src/core/ai/runtime-selection.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const roots = new Set();
const VERIFIED_CAPABILITIES = Object.freeze({
  completion: true,
  structuredOutput: true,
  appWorkflows: true,
  exactRead: true,
  publicWeb: true,
  liveActivity: true,
  resumable: true,
});

function readyProbe() {
  return {
    status: "ready",
    ready: true,
    action: null,
    version: "0.149.1",
    capabilities: VERIFIED_CAPABILITIES,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function root() {
  const value = mkdtempSync(join(tmpdir(), "careerrat-runtime-route-"));
  roots.add(value);
  return value;
}

// A real-process-group stand-in for a resistant installer descendant, used
// to prove the route's activeGuidedSetups lock only releases once the
// process tree is actually dead, not the instant the leader (bash, in
// production) exits. The wrapper does NOT trap SIGTERM, so the group
// signal terminates it via Node's default handling, while the grandchild
// it forks still ignores SIGTERM and keeps running. The grandchild writes
// its OWN pid to pidFilePath, and only after registering its SIGTERM
// handler, so the test never races Node's own startup time in the new
// process.
function writeAsymmetricInstallerWrapperScript(wrapperPath) {
  writeFileSync(
    wrapperPath,
    [
      "import('node:child_process').then(({ spawn }) => {",
      "  spawn(",
      "    process.execPath,",
      "    [",
      "      '-e',",
      "      \"process.on('SIGTERM', () => {}); import('node:fs').then(({ writeFileSync }) => writeFileSync(process.argv[1], String(process.pid))); setInterval(() => {}, 1000);\",",
      "      process.argv[2],",
      "    ],",
      "    { stdio: 'ignore' }",
      "  );",
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8"
  );
}

// A real-process stand-in for a dead group leader with a live descendant:
// the leader spawns a descendant (inheriting the leader's process group,
// since it isn't itself detached) that ignores SIGTERM and keeps running,
// writes the descendant's pid to pidFilePath, then exits on its own. This
// is the shape finding 2 covers: `ps` can no longer name any identity for
// the leader's own pid once it's gone (null, not a mismatch), while
// process.kill(-leaderPid, 0) still succeeds because the descendant keeps
// the group alive.
function writeLeaderExitsDescendantSurvivesWrapperScript(wrapperPath) {
  writeFileSync(
    wrapperPath,
    [
      "import('node:child_process').then(({ spawn }) => {",
      "  const child = spawn(",
      "    process.execPath,",
      "    ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"],",
      "    { stdio: 'ignore' }",
      "  );",
      "  import('node:fs').then(({ writeFileSync }) => {",
      "    writeFileSync(process.argv[2], String(child.pid));",
      "    process.exit(0);",
      "  });",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );
}

// pathOrGetter accepts a getter as well as a plain string: the guided-setup
// tests below only know a pid file's path once the route has actually
// called startGuidedSetupImpl (after its own await on belowBoundaryImpl),
// which happens after this function is first invoked, so a plain string
// argument would capture "not yet pushed" and poll a stale undefined path.
async function waitForFileContent(pathOrGetter, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const path = typeof pathOrGetter === "function" ? pathOrGetter() : pathOrGetter;
    if (path && existsSync(path)) {
      const raw = readFileSync(path, "utf8").trim();
      if (raw) return raw;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for file content");
}

async function waitUntilProcessDead(pid, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const isAlive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (isAlive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !isAlive();
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.clear();
});

function boot({
  inventory,
  probes,
  env = { CAREERRAT_DESKTOP_SHELL: "1" },
  startSignInImpl,
  startGuidedSetupImpl,
  belowBoundaryImpl,
  platform,
  probeCustomImpl,
  onProbe,
  repoRoot = root(),
}) {
  const routes = new Map();
  const mounted = mountInstalledRuntimeRoutes({
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    repoRoot,
    env,
    detectImpl: () => inventory,
    probeImpl: (runtime, options) => {
      onProbe?.(runtime.id, options);
      return probes[runtime.id];
    },
    startSignInImpl,
    startGuidedSetupImpl,
    belowBoundaryImpl,
    platform,
    probeCustomImpl,
  });
  return { routes, repoRoot, env, ...mounted };
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

async function requestStream(server, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.headers = body === undefined ? {} : { "content-type": "application/json" };
  let status = null;
  let text = "";
  const res = {
    writeHead(value) {
      status = value;
      return this;
    },
    flushHeaders() {},
    on() {
      return this;
    },
    write(value = "") {
      text += value;
      return true;
    },
    end(value = "") {
      text += value;
    },
  };
  const handler = server.routes.get(`${method} ${path}`);
  assert.ok(handler, `missing ${method} ${path}`);
  await handler(req, res);
  const events = text
    .split("\n\n")
    .flatMap((frame) =>
      frame.startsWith("data: ") ? [JSON.parse(frame.slice("data: ".length))] : []
    );
  return { status, events };
}

const INVENTORY = [
  {
    id: "claude",
    name: "Claude Code",
    commandShape: "claude -p --output-format json",
    path: "/Users/morgan/.local/bin/claude",
    realPath: "/Users/morgan/.local/bin/claude",
    binaryFingerprint: "a".repeat(64),
    available: true,
    warning: null,
  },
  {
    id: "codex",
    name: "Codex",
    commandShape: "codex exec --json -",
    path: "/opt/homebrew/bin/codex",
    realPath: "/opt/homebrew/bin/codex",
    binaryFingerprint: "b".repeat(64),
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

test("inventory auto-selects the sole verified full-workflow CLI", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: readyProbe(),
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
  const selected = loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env });
  assert.equal(selected.runtimeId, "codex");
  assert.equal(selected.providerFallback, false);
  assert.deepEqual(selected.verification?.capabilities, VERIFIED_CAPABILITIES);
  assert.equal(selected.verification?.path, "/opt/homebrew/bin/codex");
  assert.equal(selected.verification?.realPath, "/opt/homebrew/bin/codex");
  assert.equal(selected.verification?.version, "0.149.1");
  assert.equal(selected.verification?.binaryFingerprint, "b".repeat(64));
  assert.equal(JSON.stringify(response.body).includes("morgan@example.com"), false);
  // The registry's installUrl passes through the route untouched — the
  // onboarding not-found row's "INSTALL GUIDE" link depends on this.
  assert.equal(
    response.body.runtimes.find(({ id }) => id === "gemini").installUrl,
    "https://github.com/google-gemini/gemini-cli"
  );
});

test("inventory exposes guidedSetupAvailable, matching exactly the guided-setup route's own gate", async () => {
  const probes = { claude: readyProbe(), codex: readyProbe() };

  const packagedMac = boot({
    inventory: INVENTORY,
    probes,
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
  });
  const packagedMacResponse = await request(packagedMac, "GET", "/api/settings/ai-runtimes");
  assert.equal(packagedMacResponse.body.guidedSetupAvailable, true);

  const browserDev = boot({
    inventory: INVENTORY,
    probes,
    env: {},
    platform: "darwin",
  });
  const browserDevResponse = await request(browserDev, "GET", "/api/settings/ai-runtimes");
  assert.equal(browserDevResponse.body.guidedSetupAvailable, false);

  const packagedLinux = boot({
    inventory: INVENTORY,
    probes,
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "linux",
  });
  const packagedLinuxResponse = await request(packagedLinux, "GET", "/api/settings/ai-runtimes");
  assert.equal(packagedLinuxResponse.body.guidedSetupAvailable, false);
});

test("a signed-in CLI without a usable completion stays unselected with a plain retry action", async () => {
  const probeCalls = [];
  const failedProbe = {
    status: "completion_probe_failed",
    ready: false,
    action: "retry",
    actionLabel: "Try again",
    probeMessage: "Codex is signed in, but it didn't return a usable test reply.",
    capabilityReason: "Codex is signed in, but it didn't return a usable test reply.",
    capabilities: {
      completion: false,
      structuredOutput: false,
      appWorkflows: false,
      exactRead: false,
      publicWeb: false,
      liveActivity: false,
      resumable: false,
    },
  };
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: failedProbe,
    },
    onProbe(runtimeId, options) {
      probeCalls.push({ runtimeId, options });
    },
  });

  const inventory = await request(server, "GET", "/api/settings/ai-runtimes");
  const codex = inventory.body.runtimes.find(({ id }) => id === "codex");
  assert.equal(inventory.body.selectedId, null);
  assert.equal(codex.selectable, false);
  assert.equal(codex.probeMessage, "Codex is signed in, but it didn't return a usable test reply.");
  assert.equal(codex.action, "retry");
  assert.equal(codex.actionLabel, "Try again");
  assert.equal(
    probeCalls.find(({ runtimeId }) => runtimeId === "codex").options.forceCompletionProbe,
    false
  );

  const retried = await request(server, "POST", "/api/settings/ai-runtime/probe", {
    runtimeId: "codex",
  });
  assert.equal(retried.status, 200);
  assert.deepEqual(
    probeCalls.slice(-2).map(({ runtimeId, options }) => ({
      runtimeId,
      forceCompletionProbe: options.forceCompletionProbe,
    })),
    [
      { runtimeId: "claude", forceCompletionProbe: false },
      { runtimeId: "codex", forceCompletionProbe: true },
    ]
  );

  const selected = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "codex",
  });
  assert.equal(selected.status, 409);
  assert.deepEqual(selected.body, {
    ok: false,
    code: "RUNTIME_PROBE_FAILED",
    error: "Codex is signed in, but it didn't return a usable test reply.",
    action: "retry",
    actionLabel: "Try again",
  });
});

test("a Claude below the tool boundary version is unselectable with an update reason and a retry action", async () => {
  const belowBoundaryProbe = {
    status: "update_required",
    ready: false,
    action: "retry",
    actionLabel: "Check again",
    version: "2.1.200",
    minimumVersion: "2.1.241",
    capabilities: {
      completion: true,
      structuredOutput: true,
      appWorkflows: true,
      exactRead: false,
      publicWeb: false,
      liveActivity: true,
      resumable: true,
    },
    probeMessage: "Update Claude Code to 2.1.241 or newer for secure CareerRat tool runs.",
    capabilityReason: "Update Claude Code to 2.1.241 or newer for secure CareerRat tool runs.",
  };
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: belowBoundaryProbe,
      codex: { status: "authentication_required", ready: false, action: "start_sign_in" },
    },
  });

  const inventory = await request(server, "GET", "/api/settings/ai-runtimes");
  const claude = inventory.body.runtimes.find(({ id }) => id === "claude");
  assert.equal(inventory.body.selectedId, null);
  assert.equal(claude.status, "update_required");
  assert.equal(claude.ready, false);
  assert.equal(claude.selectable, false);
  assert.equal(claude.version, "2.1.200");
  assert.equal(claude.minimumVersion, "2.1.241");
  assert.equal(claude.action, "retry");
  assert.equal(claude.actionLabel, "Check again");
  assert.equal(
    claude.capabilityReason,
    "Update Claude Code to 2.1.241 or newer for secure CareerRat tool runs."
  );

  const selected = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "claude",
  });
  assert.equal(selected.status, 409);
  assert.deepEqual(selected.body, {
    ok: false,
    code: "RUNTIME_PROBE_FAILED",
    error: "Update Claude Code to 2.1.241 or newer for secure CareerRat tool runs.",
    action: "retry",
    actionLabel: "Check again",
  });
});

test("AI preference routes load defaults and persist provider-neutral choices", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: readyProbe(),
    },
  });

  const initial = await request(server, "GET", "/api/settings/ai-preferences");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, {
    quality: "automatic",
    reasoning: "automatic",
    source: "default",
    updatedAt: null,
  });

  const saved = await request(server, "POST", "/api/settings/ai-preferences", {
    quality: "balanced",
    reasoning: "high",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, {
    quality: "balanced",
    reasoning: "high",
    source: "saved",
    updatedAt: saved.body.updatedAt,
  });
  assert.equal(Number.isNaN(Date.parse(saved.body.updatedAt)), false);

  const reloaded = await request(server, "GET", "/api/settings/ai-preferences");
  assert.deepEqual(reloaded.body, saved.body);
});

test("AI preference routes reject unknown fields and invalid choices cleanly", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: { claude: readyProbe(), codex: readyProbe() },
  });

  const unknown = await request(server, "POST", "/api/settings/ai-preferences", {
    quality: "best",
    reasoning: "high",
    model: "provider-specific-model",
  });
  assert.deepEqual(unknown, {
    status: 400,
    body: {
      ok: false,
      code: "AI_PREFERENCES_INVALID",
      error: "Only Paul quality and thinking depth can be changed here.",
    },
  });

  const invalid = await request(server, "POST", "/api/settings/ai-preferences", {
    quality: "provider-specific-model",
    reasoning: "high",
  });
  assert.deepEqual(invalid, {
    status: 400,
    body: {
      ok: false,
      code: "AI_PREFERENCES_INVALID",
      error: "Paul quality must be Automatic, Faster, Balanced, or Best.",
    },
  });
});

test("inventory leaves selection open when both a full runtime and completion runtime are ready", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: readyProbe(),
      codex: readyProbe(),
    },
  });
  const response = await request(server, "GET", "/api/settings/ai-runtimes");
  assert.equal(response.status, 200);
  assert.equal(response.body.selectedId, null);
  assert.equal(response.body.providerFallback, false);
  assert.deepEqual(
    response.body.runtimes.map(({ id, ready, selected }) => ({ id, ready, selected })),
    [
      { id: "claude", ready: true, selected: false },
      { id: "codex", ready: true, selected: false },
      { id: "gemini", ready: false, selected: false },
      { id: "custom", ready: false, selected: false },
    ]
  );
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: null,
    providerFallback: false,
    customCommand: null,
    verification: null,
  });
});

test("full-workflow runtimes stay selectable with capability-backed claims", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: readyProbe(),
      codex: readyProbe(),
    },
  });

  const inventory = await request(server, "GET", "/api/settings/ai-runtimes");
  const claude = inventory.body.runtimes.find(({ id }) => id === "claude");
  const codex = inventory.body.runtimes.find(({ id }) => id === "codex");
  const custom = inventory.body.runtimes.find(({ id }) => id === "custom");
  assert.equal(claude.selectable, true);
  assert.equal(codex.selectable, true);
  assert.equal(custom.selectable, false);
  assert.equal(codex.capabilityReason, null);

  const selectCodex = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "codex",
  });
  assert.equal(selectCodex.status, 200);
  assert.equal(selectCodex.body.selectedId, "codex");
});

test("backend support and workflow capability rules follow the installed definition registry", async () => {
  const supportDefinition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === "hermes");
  const capabilityDefinition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === "codex");
  const previousSupported = supportDefinition.supported;
  const previousAccepted = supportDefinition.acceptedCapabilities;
  const previousCapabilities = capabilityDefinition.capabilities;
  const previousAcceptedCapabilities = capabilityDefinition.acceptedCapabilities;
  supportDefinition.supported = true;
  supportDefinition.acceptedCapabilities = supportDefinition.capabilities;
  capabilityDefinition.capabilities = Object.freeze({
    ...previousCapabilities,
    workspaceEvidence: true,
  });
  capabilityDefinition.acceptedCapabilities = Object.freeze({
    ...previousAcceptedCapabilities,
    workspaceEvidence: true,
  });

  try {
    const server = boot({
      inventory: [
        ...INVENTORY,
        {
          id: "hermes",
          name: "Hermes Agent",
          commandShape: "hermes acp",
          path: "/Users/morgan/.local/bin/hermes",
          available: true,
          warning: null,
        },
      ],
      probes: {
        claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
        codex: { status: "authentication_required", ready: false, action: "start_sign_in" },
        hermes: readyProbe(),
      },
    });

    const response = await request(server, "GET", "/api/settings/ai-runtimes");
    const hermes = response.body.runtimes.find(({ id }) => id === "hermes");
    assert.equal(hermes.supported, true);
    assert.equal(hermes.selectable, true);

    const completeServer = boot({
      inventory: INVENTORY,
      probes: {
        claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
        codex: {
          ...readyProbe(),
          capabilities: {
            ...VERIFIED_CAPABILITIES,
            workspaceEvidence: true,
            providerDiagnostic: true,
          },
        },
      },
    });
    const completeInventory = await request(completeServer, "GET", "/api/settings/ai-runtimes");
    const completeCodex = completeInventory.body.runtimes.find(({ id }) => id === "codex");
    assert.equal(completeCodex.selectable, true);
    assert.equal(completeCodex.capabilities.workspaceEvidence, true);
    assert.equal("providerDiagnostic" in completeCodex.capabilities, false);

    const incompleteServer = boot({
      inventory: INVENTORY,
      probes: {
        claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
        codex: readyProbe(),
      },
    });
    const incompleteInventory = await request(incompleteServer, "GET", "/api/settings/ai-runtimes");
    const incompleteCodex = incompleteInventory.body.runtimes.find(({ id }) => id === "codex");
    assert.equal(incompleteCodex.selectable, true);
  } finally {
    if (previousSupported === undefined) delete supportDefinition.supported;
    else supportDefinition.supported = previousSupported;
    supportDefinition.acceptedCapabilities = previousAccepted;
    capabilityDefinition.capabilities = previousCapabilities;
    capabilityDefinition.acceptedCapabilities = previousAcceptedCapabilities;
  }
});

test("selection accepts a completion-ready runtime with unrelated capabilities unverified", async () => {
  for (const missingCapability of Object.keys(VERIFIED_CAPABILITIES).filter(
    (capability) => capability !== "completion"
  )) {
    const server = boot({
      inventory: INVENTORY,
      probes: {
        claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
        codex: {
          ...readyProbe(),
          capabilities: {
            ...VERIFIED_CAPABILITIES,
            [missingCapability]: false,
          },
        },
      },
    });

    const response = await request(server, "POST", "/api/settings/ai-runtime/select", {
      runtimeId: "codex",
    });

    assert.equal(response.status, 200, `${missingCapability} must not block selection`);
    assert.equal(response.body.selectedId, "codex");
    assert.equal(
      loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }).runtimeId,
      "codex"
    );
  }
});

test("selection still rejects a runtime without verified completion", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: {
        ...readyProbe(),
        capabilities: { ...VERIFIED_CAPABILITIES, completion: false },
      },
    },
  });

  const response = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "codex",
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, "RUNTIME_CAPABILITY_UNSUPPORTED");
  assert.equal(
    loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }).runtimeId,
    null
  );
});

test("an unaccepted adapter remains diagnostic-only even after a successful full-capability probe", async () => {
  const probed = [];
  const server = boot({
    inventory: [
      ...INVENTORY,
      {
        id: "hermes",
        name: "Hermes Agent",
        commandShape: "hermes acp",
        path: "/Users/morgan/.local/bin/hermes",
        available: true,
        warning: null,
      },
    ],
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: { status: "authentication_required", ready: false, action: "start_sign_in" },
      hermes: readyProbe(),
    },
    startSignInImpl: () => {
      throw new Error("unsupported runtime sign-in must not start");
    },
    onProbe: (runtimeId) => probed.push(runtimeId),
  });

  const inventory = await request(server, "GET", "/api/settings/ai-runtimes");
  const hermes = inventory.body.runtimes.find(({ id }) => id === "hermes");
  assert.equal(hermes.supported, false);
  assert.equal(hermes.status, "detected_unverified");
  assert.equal(hermes.ready, false);
  assert.equal(hermes.selectable, false);
  assert.deepEqual(probed.sort(), ["claude", "codex"]);
  assert.equal(inventory.body.selectedId, null);

  const selection = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "hermes",
  });
  assert.equal(selection.status, 409);
  assert.equal(selection.body.code, "RUNTIME_NOT_SUPPORTED");

  const signIn = await request(server, "POST", "/api/settings/ai-runtime/sign-in", {
    runtimeId: "hermes",
  });
  assert.equal(signIn.status, 409);
  assert.equal(signIn.body.code, "RUNTIME_NOT_SUPPORTED");
});

test("a ready-looking probe without explicit capability evidence remains unselectable", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: { status: "ready", ready: true, action: null },
    },
  });

  const inventory = await request(server, "GET", "/api/settings/ai-runtimes");
  const codex = inventory.body.runtimes.find(({ id }) => id === "codex");
  assert.equal(codex.ready, true);
  assert.equal(codex.selectable, false);
  assert.equal(codex.capabilities.completion, false);
  assert.equal(inventory.body.selectedId, null);
});

test("inventory preserves a stale selection when the runtime remains completion-ready", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "signed_out", ready: false, action: "start_sign_in" },
      codex: readyProbe(),
    },
  });
  writeInstalledRuntimeSelection({
    repoRoot: server.repoRoot,
    env: server.env,
    runtimeId: "codex",
    providerFallback: false,
  });

  const response = await request(server, "GET", "/api/settings/ai-runtimes");
  assert.equal(response.status, 200);
  assert.equal(response.body.selectedId, "codex");
  assert.equal(response.body.runtimes.find(({ id }) => id === "codex").selected, true);
  const selection = loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env });
  assert.equal(selection.runtimeId, "codex");
  assert.deepEqual(selection.verification?.capabilities, VERIFIED_CAPABILITIES);
});

test("custom commands can be tested but remain unselectable", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {},
    probeCustomImpl: async () => ({ ok: true, elapsedMs: 4, output: "ok" }),
  });
  const probe = await request(server, "POST", "/api/settings/ai-runtime/custom/test", {
    command: "/safe/custom-agent",
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.ok, true);

  const inventory = await request(server, "GET", "/api/settings/ai-runtimes");
  assert.equal(inventory.body.runtimes.find(({ id }) => id === "custom").selectable, false);
});

test("runtime probe returns the requested runtime's current readiness", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: readyProbe(),
    },
  });

  const response = await request(server, "POST", "/api/settings/ai-runtime/probe", {
    runtimeId: "codex",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(
    {
      id: response.body.runtime.id,
      status: response.body.runtime.status,
      ready: response.body.runtime.ready,
    },
    { id: "codex", status: "ready", ready: true }
  );
});

test("runtime probe rejects an unknown runtime id", async () => {
  const server = boot({ inventory: INVENTORY, probes: {} });

  const response = await request(server, "POST", "/api/settings/ai-runtime/probe", {
    runtimeId: "not-a-runtime",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { ok: false, code: "RUNTIME_UNKNOWN" });
});

test("ready Codex is selectable for the full CareerRat workflow", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: readyProbe(),
    },
  });

  const inventory = await request(server, "GET", "/api/settings/ai-runtimes");
  const codex = inventory.body.runtimes.find(({ id }) => id === "codex");
  assert.equal(codex.selectable, true);
  assert.equal(codex.capabilityTier, "task_tools");
  assert.deepEqual(codex.capabilities, {
    completion: true,
    structuredOutput: true,
    appWorkflows: true,
    exactRead: true,
    publicWeb: true,
    liveActivity: true,
    resumable: true,
    taskTools: true,
    research: true,
  });
  assert.equal(inventory.body.selectedId, "codex");

  const selected = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "codex",
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.selectedId, "codex");
});

test("a Codex probe without completion evidence stays visible but unselectable", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: {
        status: "unsupported_capability",
        ready: false,
        action: null,
        capabilities: {
          completion: false,
          structuredOutput: false,
          appWorkflows: false,
          exactRead: false,
          publicWeb: false,
          liveActivity: false,
          resumable: false,
        },
        capabilityReason: "Update Codex.",
      },
    },
  });
  const inventory = await request(server, "GET", "/api/settings/ai-runtimes");
  const codex = inventory.body.runtimes.find(({ id }) => id === "codex");
  assert.equal(codex.selectable, false);
  assert.deepEqual(codex.capabilities, {
    completion: false,
    structuredOutput: false,
    appWorkflows: false,
    exactRead: false,
    publicWeb: false,
    liveActivity: false,
    resumable: false,
    taskTools: false,
    research: false,
  });
  assert.equal(codex.capabilityTier, "detected_unverified");
});

test("sign-in starts the allowlisted CLI flow without opening a terminal window", async () => {
  const started = [];
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: readyProbe(),
    },
    startSignInImpl: (runtime) => {
      started.push(runtime);
      return { signInCommand: "claude auth login", reused: false };
    },
  });
  const response = await request(server, "POST", "/api/settings/ai-runtime/sign-in", {
    runtimeId: "claude",
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.signInCommand, "claude auth login");
  assert.equal(response.body.reused, false);
  assert.equal(started.length, 1);
  assert.equal(started[0].id, "claude");
});

test("sign-in rejects an unknown runtime id without starting a process", async () => {
  const started = [];
  const server = boot({
    inventory: INVENTORY,
    probes: {},
    startSignInImpl: (runtime) => started.push(runtime),
  });

  const response = await request(server, "POST", "/api/settings/ai-runtime/sign-in", {
    runtimeId: "not-a-runtime",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { ok: false, code: "RUNTIME_NOT_AVAILABLE" });
  assert.deepEqual(started, []);
});

test("desktop zero-runtime setup opens the allowlisted Claude guide", async () => {
  const started = [];
  const server = boot({
    inventory: INVENTORY.map((runtime) => ({ ...runtime, available: false, path: null })),
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    startGuidedSetupImpl: async (runtimeId, { onOutput, onStart }) => {
      started.push(runtimeId);
      onStart();
      onOutput("Installing Claude Code…");
      return {
        runtimeId,
        installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
      };
    },
  });

  const response = await requestStream(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.events, [
    {
      type: "started",
      runtimeId: "claude",
      installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    },
    { type: "output", message: "Installing Claude Code…" },
    { type: "done", runtimeId: "claude" },
  ]);
  assert.deepEqual(started, ["claude"]);
});

test("desktop zero-runtime setup reports an in-app installer launch failure", async () => {
  const error = new Error("installer process could not start");
  error.code = "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED";
  const server = boot({
    inventory: INVENTORY.map((runtime) => ({ ...runtime, available: false, path: null })),
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    startGuidedSetupImpl: async () => {
      throw error;
    },
  });

  const response = await request(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });

  assert.equal(response.status, 500);
  assert.equal(response.body.code, "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED");
  assert.equal(response.body.error, "CareerRat could not start the in-app Claude installer.");
});

test("desktop zero-runtime setup streams a clear retry when installation fails", async () => {
  const error = new Error("installer exited 1");
  error.code = "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED";
  const server = boot({
    inventory: INVENTORY.map((runtime) => ({ ...runtime, available: false, path: null })),
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    startGuidedSetupImpl: async (_runtimeId, { onOutput, onStart }) => {
      onStart();
      onOutput("Downloading Claude Code…");
      throw error;
    },
  });

  const response = await requestStream(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.events, [
    {
      type: "started",
      runtimeId: "claude",
      installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    },
    { type: "output", message: "Downloading Claude Code…" },
    {
      type: "error",
      code: "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED",
      message: "Claude Code did not finish installing. Check your connection and try again.",
    },
  ]);
});

test("guided setup rejects unsupported, installed, and non-desktop requests", async () => {
  const started = [];
  const options = {
    probes: {},
    platform: "darwin",
    startGuidedSetupImpl: (runtimeId) => started.push(runtimeId),
    belowBoundaryImpl: async () => "at_or_above",
  };
  const unsupported = boot({
    ...options,
    inventory: INVENTORY.map((runtime) => ({ ...runtime, available: false, path: null })),
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
  });
  const unsupportedResponse = await request(
    unsupported,
    "POST",
    "/api/settings/ai-runtime/guided-setup",
    { runtimeId: "codex" }
  );
  assert.equal(unsupportedResponse.status, 409);
  assert.equal(unsupportedResponse.body.code, "RUNTIME_GUIDED_SETUP_UNSUPPORTED");

  const installed = boot({
    ...options,
    inventory: INVENTORY,
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
  });
  const installedResponse = await request(
    installed,
    "POST",
    "/api/settings/ai-runtime/guided-setup",
    { runtimeId: "claude" }
  );
  assert.equal(installedResponse.status, 409);
  assert.equal(installedResponse.body.code, "RUNTIME_ALREADY_INSTALLED");

  const browser = boot({
    ...options,
    inventory: INVENTORY.map((runtime) => ({ ...runtime, available: false, path: null })),
    env: {},
  });
  const browserResponse = await request(browser, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  assert.equal(browserResponse.status, 409);
  assert.equal(browserResponse.body.code, "RUNTIME_GUIDED_SETUP_UNAVAILABLE");
  assert.deepEqual(started, []);
});

test("guided setup lets an in-place update run for a below-boundary Claude but still refuses one already at the version boundary", async () => {
  const boundaryCalls = [];
  const started = [];
  const belowBoundary = boot({
    inventory: INVENTORY,
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    startGuidedSetupImpl: async (runtimeId, { onOutput, onStart }) => {
      started.push(runtimeId);
      onStart();
      onOutput("Updating Claude Code…");
      return {
        runtimeId,
        installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
      };
    },
    belowBoundaryImpl: async (runtime, options) => {
      boundaryCalls.push({ runtimeId: runtime.id, ...options });
      return "below";
    },
  });
  const updateResponse = await requestStream(
    belowBoundary,
    "POST",
    "/api/settings/ai-runtime/guided-setup",
    { runtimeId: "claude" }
  );
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(updateResponse.events, [
    {
      type: "started",
      runtimeId: "claude",
      installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    },
    { type: "output", message: "Updating Claude Code…" },
    { type: "done", runtimeId: "claude" },
  ]);
  assert.deepEqual(started, ["claude"]);
  assert.equal(boundaryCalls.length, 1);
  assert.equal(boundaryCalls[0].runtimeId, "claude");
  assert.equal(boundaryCalls[0].env.CAREERRAT_DESKTOP_CLI_ONLY, "1");
  assert.equal(boundaryCalls[0].platform, "darwin");

  const atBoundary = boot({
    inventory: INVENTORY,
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    startGuidedSetupImpl: (runtimeId) => started.push(runtimeId),
    belowBoundaryImpl: async () => "at_or_above",
  });
  const refusedResponse = await request(
    atBoundary,
    "POST",
    "/api/settings/ai-runtime/guided-setup",
    { runtimeId: "claude" }
  );
  assert.equal(refusedResponse.status, 409);
  assert.equal(refusedResponse.body.code, "RUNTIME_ALREADY_INSTALLED");
  assert.deepEqual(started, ["claude"]);
});

test("guided setup refuses an indeterminate version probe instead of guessing", async () => {
  const started = [];
  const server = boot({
    inventory: INVENTORY,
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    startGuidedSetupImpl: (runtimeId) => started.push(runtimeId),
    belowBoundaryImpl: async () => "indeterminate",
  });
  const response = await request(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "RUNTIME_VERSION_INDETERMINATE");
  assert.deepEqual(started, []);
});

test("guided setup never launches the installer if the request disconnects while the boundary probe is in flight", async () => {
  const repoRoot = root();
  const routes = new Map();
  const started = [];
  const probeGate = deferred();
  let capturedSignal = null;
  mountInstalledRuntimeRoutes({
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    repoRoot,
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    detectImpl: () => INVENTORY,
    probeImpl: () => readyProbe(),
    startGuidedSetupImpl: (runtimeId) => {
      started.push(runtimeId);
      return Promise.resolve({ runtimeId, installCommand: "curl -fsSL https://x | bash" });
    },
    belowBoundaryImpl: async (_runtime, options) => {
      capturedSignal = options.signal;
      await probeGate.promise;
      return "below";
    },
    platform: "darwin",
  });

  const req = Readable.from([Buffer.from(JSON.stringify({ runtimeId: "claude" }))]);
  req.headers = { "content-type": "application/json" };
  let closeHandler = null;
  const res = {
    on(event, handler) {
      if (event === "close") closeHandler = handler;
      return this;
    },
    writeHead() {
      return this;
    },
    flushHeaders() {},
    write() {
      return true;
    },
    end() {},
  };
  const handler = routes.get("POST /api/settings/ai-runtime/guided-setup");
  const pending = handler(req, res);

  // Give the route a turn to reach the boundary probe and register the close
  // handler before the probe settles, exactly like a real disconnect racing
  // an in-flight version check. readJsonBodyCapped awaits the request body
  // stream first, so this needs a real macrotask, not just microtasks.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(closeHandler, "close handler must be registered before the probe settles");
  closeHandler();
  probeGate.resolve();
  await pending;

  assert.equal(capturedSignal?.aborted, true);
  assert.deepEqual(started, []);
});

test("guided setup refuses malformed real version-probe output instead of authorizing an update", async () => {
  // Wires the real isInstalledRuntimeBelowVersionBoundary/classifyRuntimeVersionBoundary
  // through the actual route (belowBoundaryImpl is only spawnImpl-faked, not
  // mocked away), so this proves the route itself refuses on shapes an
  // adversarial or buggy install could plausibly print: an extra numeric
  // component tacked onto the version, and a lone version-shaped substring
  // sitting in otherwise unrelated prose.
  function malformedVersionChild(stdout) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdout, "utf8"));
      queueMicrotask(() => child.emit("close", 0, null));
    });
    return child;
  }

  for (const stdout of ["2.1.200.999 (Claude Code)", "protocol 2.1.200; version unavailable"]) {
    const started = [];
    const server = boot({
      inventory: INVENTORY,
      probes: {},
      env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
      platform: "darwin",
      startGuidedSetupImpl: (runtimeId) => started.push(runtimeId),
      belowBoundaryImpl: (runtime, options) =>
        isInstalledRuntimeBelowVersionBoundary(runtime, {
          ...options,
          spawnImpl: () => malformedVersionChild(stdout),
        }),
    });
    const response = await request(server, "POST", "/api/settings/ai-runtime/guided-setup", {
      runtimeId: "claude",
    });
    assert.equal(response.status, 409, stdout);
    assert.equal(response.body.code, "RUNTIME_VERSION_INDETERMINATE", stdout);
    assert.deepEqual(started, [], stdout);
  }
});

test("a second concurrent guided-setup request is refused, and a retry after cleanup succeeds", async () => {
  const started = [];
  const gate = deferred();
  const server = boot({
    inventory: INVENTORY,
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    belowBoundaryImpl: async () => "below",
    startGuidedSetupImpl: async (runtimeId, { onStart }) => {
      started.push(runtimeId);
      onStart();
      await gate.promise;
      return { runtimeId, installCommand: "curl -fsSL https://claude.ai/install.sh | bash" };
    },
  });

  const first = requestStream(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  // Give the first request a turn to acquire the lock and start streaming
  // before the second one races it.
  await new Promise((resolve) => setImmediate(resolve));

  const second = await request(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "RUNTIME_GUIDED_SETUP_IN_PROGRESS");

  gate.resolve();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(started, ["claude"]);

  // The lock is released only once the first install's promise has settled,
  // so a retry after that point must be admitted rather than refused again.
  const retry = await requestStream(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(started, ["claude", "claude"]);
});

test("a cancelled guided-setup request does not release the lock until a resistant descendant is actually dead, and a follow-up request is admitted only afterwards", async () => {
  // Real production startInstalledRuntimeGuidedSetup, not a fake: this
  // proves the route's activeGuidedSetups lock is only ever released after
  // the real function's own group-SIGKILL cleanup has actually run, not
  // the instant its promise handler fires.
  const setupRoot = root();
  const wrapperPath = join(setupRoot, "wrapper.mjs");
  writeAsymmetricInstallerWrapperScript(wrapperPath);
  const pidFilePaths = [];
  let installAttempt = 0;

  const server = boot({
    inventory: INVENTORY,
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    belowBoundaryImpl: async () => "below",
    startGuidedSetupImpl: (runtimeId, options) => {
      installAttempt += 1;
      const pidFilePath = join(setupRoot, `grandchild-${installAttempt}.pid`);
      pidFilePaths.push(pidFilePath);
      return startInstalledRuntimeGuidedSetup(runtimeId, {
        ...options,
        spawnImpl: (_command, _args, spawnOptions) =>
          spawn(process.execPath, [wrapperPath, pidFilePath], spawnOptions),
      });
    },
  });

  // A minimal streaming-response harness that, unlike requestStream, keeps
  // the "close" listener the route registers so this test can trigger a
  // real client disconnect mid-install.
  function guidedSetupHarness() {
    let closeHandler = null;
    const res = {
      on(event, handler) {
        if (event === "close") closeHandler = handler;
        return this;
      },
      writeHead() {
        return this;
      },
      flushHeaders() {},
      write() {
        return true;
      },
      end() {},
    };
    const req = Readable.from([Buffer.from(JSON.stringify({ runtimeId: "claude" }))]);
    req.headers = { "content-type": "application/json" };
    const handler = server.routes.get("POST /api/settings/ai-runtime/guided-setup");
    return {
      pending: handler(req, res),
      cancel() {
        assert.ok(closeHandler, "close handler must be registered before cancellation");
        closeHandler();
      },
    };
  }

  const firstInstall = guidedSetupHarness();
  const firstGrandchildPid = Number(await waitForFileContent(() => pidFilePaths[0]));
  assert.ok(
    Number.isInteger(firstGrandchildPid) && firstGrandchildPid > 0,
    "first install's grandchild pid was recorded"
  );

  // A second request while the first is still mid-flight must be refused,
  // proving the lock is actually held.
  const concurrent = await request(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  assert.equal(concurrent.status, 409);
  assert.equal(concurrent.body.code, "RUNTIME_GUIDED_SETUP_IN_PROGRESS");

  firstInstall.cancel();
  await firstInstall.pending;

  assert.equal(
    await waitUntilProcessDead(firstGrandchildPid),
    true,
    "the first install's descendant must not survive cancellation"
  );

  // Only now, with the process tree actually dead, must a follow-up be
  // admitted rather than refused a second time.
  const secondInstall = guidedSetupHarness();
  const secondGrandchildPid = Number(await waitForFileContent(() => pidFilePaths[1]));
  assert.ok(
    Number.isInteger(secondGrandchildPid) && secondGrandchildPid > 0,
    "the follow-up request was admitted and actually started a new installer"
  );

  secondInstall.cancel();
  await secondInstall.pending;
  assert.equal(
    await waitUntilProcessDead(secondGrandchildPid),
    true,
    "the follow-up install's descendant must not survive cancellation either"
  );
});

test("a remount of the routes (simulating a relaunch) refuses while the recorded installer group is alive, and reclaims once it's dead", async () => {
  const repoRoot = root();
  const env = { CAREERRAT_DESKTOP_CLI_ONLY: "1" };
  // A real, detached, long-lived process group standing in for a prior
  // mount's still-running installer: detached so its own pid is also its
  // process-group id, exactly what writeGuidedSetupOwnership records for a
  // real guided-setup run and what the admission check's
  // process.kill(-pid, 0) targets.
  const survivor = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { detached: true, stdio: "ignore" }
  );
  await new Promise((resolve) => survivor.once("spawn", resolve));
  writeGuidedSetupOwnership({ repoRoot, env, runtimeId: "claude", pid: survivor.pid });

  try {
    const relaunched = boot({
      repoRoot,
      inventory: INVENTORY,
      probes: {},
      env,
      platform: "darwin",
      belowBoundaryImpl: async () => "below",
      startGuidedSetupImpl: async () => {
        throw new Error("must not run while a prior installer's process group is still alive");
      },
    });

    const refused = await request(relaunched, "POST", "/api/settings/ai-runtime/guided-setup", {
      runtimeId: "claude",
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "RUNTIME_GUIDED_SETUP_IN_PROGRESS");

    process.kill(-survivor.pid, "SIGKILL");
    assert.equal(
      await waitUntilProcessDead(survivor.pid),
      true,
      "the stand-in survivor process must actually die"
    );

    const started = [];
    const relaunchedAgain = boot({
      repoRoot,
      inventory: INVENTORY,
      probes: {},
      env,
      platform: "darwin",
      belowBoundaryImpl: async () => "below",
      startGuidedSetupImpl: async (runtimeId, { onStart }) => {
        started.push(runtimeId);
        onStart();
        return { runtimeId, installCommand: "curl -fsSL https://claude.ai/install.sh | bash" };
      },
    });
    const admitted = await requestStream(
      relaunchedAgain,
      "POST",
      "/api/settings/ai-runtime/guided-setup",
      { runtimeId: "claude" }
    );
    assert.equal(admitted.status, 200);
    assert.deepEqual(started, ["claude"]);
  } finally {
    try {
      process.kill(-survivor.pid, "SIGKILL");
    } catch {
      // Already dead by the time cleanup runs.
    }
  }
});

test("a dead group leader with a live descendant is not mistaken for a reused pid: a relaunch is refused while the descendant lives and admitted once it dies", async () => {
  const repoRoot = root();
  const env = { CAREERRAT_DESKTOP_CLI_ONLY: "1" };
  const setupRoot = root();
  const wrapperPath = join(setupRoot, "wrapper.mjs");
  const pidFilePath = join(setupRoot, "descendant.pid");
  writeLeaderExitsDescendantSurvivesWrapperScript(wrapperPath);

  // A real, detached leader (own process group) that spawns a descendant,
  // records the descendant's pid, then exits on its own, leaving the
  // descendant alive in the leader's now-leaderless process group.
  const leader = spawn(process.execPath, [wrapperPath, pidFilePath], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => leader.once("spawn", resolve));
  const leaderPid = leader.pid;
  writeGuidedSetupOwnership({ repoRoot, env, runtimeId: "claude", pid: leaderPid });

  const descendantPid = Number(await waitForFileContent(pidFilePath));
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, "descendant pid was recorded");
  assert.equal(
    await waitUntilProcessDead(leaderPid),
    true,
    "the leader must actually exit on its own before the admission checks below run"
  );
  const descendantAlive = () => {
    try {
      process.kill(descendantPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(descendantAlive(), true, "the descendant must still be alive once the leader exits");

  try {
    const relaunched = boot({
      repoRoot,
      inventory: INVENTORY,
      probes: {},
      env,
      platform: "darwin",
      belowBoundaryImpl: async () => "below",
      startGuidedSetupImpl: async () => {
        throw new Error("must not run while the descendant is still alive");
      },
    });

    // `ps` can no longer name any identity for the leader's own (now gone)
    // pid: null, not a mismatch. The group is still alive through the
    // descendant, so this must stay refused rather than reading the null
    // identity as evidence of pid reuse and reclaiming.
    const refused = await request(relaunched, "POST", "/api/settings/ai-runtime/guided-setup", {
      runtimeId: "claude",
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "RUNTIME_GUIDED_SETUP_IN_PROGRESS");

    process.kill(descendantPid, "SIGKILL");
    assert.equal(
      await waitUntilProcessDead(descendantPid),
      true,
      "the descendant must actually die"
    );

    const started = [];
    const relaunchedAgain = boot({
      repoRoot,
      inventory: INVENTORY,
      probes: {},
      env,
      platform: "darwin",
      belowBoundaryImpl: async () => "below",
      startGuidedSetupImpl: async (runtimeId, { onStart }) => {
        started.push(runtimeId);
        onStart();
        return { runtimeId, installCommand: "curl -fsSL https://claude.ai/install.sh | bash" };
      },
    });
    const admitted = await requestStream(
      relaunchedAgain,
      "POST",
      "/api/settings/ai-runtime/guided-setup",
      { runtimeId: "claude" }
    );
    assert.equal(admitted.status, 200);
    assert.deepEqual(started, ["claude"]);
  } finally {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // Already dead by the time cleanup runs.
    }
  }
});

test("a malformed ownership record is reclaimed rather than blocking admission", async () => {
  const repoRoot = root();
  const env = { CAREERRAT_DESKTOP_CLI_ONLY: "1" };
  const lockFile = userPath({ repoRoot, env }, ".internal/ai-runtime-guided-setup.lock.json");
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, "{ this is not valid json", "utf8");

  const started = [];
  const server = boot({
    repoRoot,
    inventory: INVENTORY,
    probes: {},
    env,
    platform: "darwin",
    belowBoundaryImpl: async () => "below",
    startGuidedSetupImpl: async (runtimeId, { onStart }) => {
      started.push(runtimeId);
      onStart();
      return { runtimeId, installCommand: "curl -fsSL https://claude.ai/install.sh | bash" };
    },
  });

  const response = await requestStream(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(started, ["claude"]);
  assert.equal(
    existsSync(lockFile),
    false,
    "reclaiming a malformed record must also remove the stale file itself"
  );
});

test("graceful shutdown aborts an active installer and confirms its process group is gone afterward", async () => {
  const setupRoot = root();
  const wrapperPath = join(setupRoot, "wrapper.mjs");
  writeAsymmetricInstallerWrapperScript(wrapperPath);
  const pidFilePath = join(setupRoot, "grandchild.pid");

  const server = boot({
    inventory: INVENTORY,
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    belowBoundaryImpl: async () => "below",
    startGuidedSetupImpl: (runtimeId, options) =>
      startInstalledRuntimeGuidedSetup(runtimeId, {
        ...options,
        spawnImpl: (_command, _args, spawnOptions) =>
          spawn(process.execPath, [wrapperPath, pidFilePath], spawnOptions),
      }),
  });

  // Same minimal streaming harness as the cancellation test above, kept
  // local since this test never needs to trigger a client-side "close":
  // shutdownGuidedSetups aborts the request's own controller directly.
  function guidedSetupHarness() {
    const res = {
      on() {
        return this;
      },
      writeHead() {
        return this;
      },
      flushHeaders() {},
      write() {
        return true;
      },
      end() {},
    };
    const req = Readable.from([Buffer.from(JSON.stringify({ runtimeId: "claude" }))]);
    req.headers = { "content-type": "application/json" };
    const handler = server.routes.get("POST /api/settings/ai-runtime/guided-setup");
    return handler(req, res);
  }

  const pending = guidedSetupHarness();
  const grandchildPid = Number(await waitForFileContent(pidFilePath));
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild pid was recorded");

  await server.shutdownGuidedSetups();
  await pending;

  assert.equal(
    await waitUntilProcessDead(grandchildPid),
    true,
    "graceful shutdown must not leave the installer's descendant running"
  );
});

test("a request admitted once shutdown has been flagged is refused with 503 and never reaches the installer", async () => {
  const started = [];
  const server = boot({
    inventory: INVENTORY,
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    belowBoundaryImpl: async () => "below",
    startGuidedSetupImpl: async (runtimeId, { onStart }) => {
      started.push(runtimeId);
      onStart();
      return { runtimeId, installCommand: "curl -fsSL https://claude.ai/install.sh | bash" };
    },
  });

  // Nothing is in flight, so this only sets the permanent flag: the guided
  // -setup route checks it both right after body parsing and again
  // immediately before admission.
  await server.shutdownGuidedSetups();

  const response = await request(server, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "RUNTIME_GUIDED_SETUP_SHUTTING_DOWN");
  assert.deepEqual(started, [], "the installer must never run once shutdown has been flagged");
});

test("shutdownGuidedSetups returns within its own bound even when a descendant's death is never confirmed", async () => {
  const setupRoot = root();
  const wrapperPath = join(setupRoot, "wrapper.mjs");
  writeAsymmetricInstallerWrapperScript(wrapperPath);
  const pidFilePath = join(setupRoot, "grandchild.pid");

  const server = boot({
    inventory: INVENTORY,
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    belowBoundaryImpl: async () => "below",
    startGuidedSetupImpl: (runtimeId, options) =>
      startInstalledRuntimeGuidedSetup(runtimeId, {
        ...options,
        // An internal bound well past shutdownGuidedSetups's own (much
        // smaller) bound below, and an isGroupAliveImpl that always reports
        // alive: this request's own promise stays pending long after
        // shutdownGuidedSetups has already returned, simulating a
        // descendant whose death can never be confirmed.
        groupDeathTimeoutMs: 300,
        groupDeathPollIntervalMs: 10,
        isGroupAliveImpl: () => true,
        spawnImpl: (_command, _args, spawnOptions) =>
          spawn(process.execPath, [wrapperPath, pidFilePath], spawnOptions),
      }),
  });

  function guidedSetupHarness() {
    const res = {
      on() {
        return this;
      },
      writeHead() {
        return this;
      },
      flushHeaders() {},
      write() {
        return true;
      },
      end() {},
    };
    const req = Readable.from([Buffer.from(JSON.stringify({ runtimeId: "claude" }))]);
    req.headers = { "content-type": "application/json" };
    const handler = server.routes.get("POST /api/settings/ai-runtime/guided-setup");
    return handler(req, res);
  }

  const pending = guidedSetupHarness();
  const grandchildPid = Number(await waitForFileContent(pidFilePath));
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild pid was recorded");

  const startedAt = Date.now();
  await server.shutdownGuidedSetups({ timeoutMs: 60 });
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 200,
    `shutdownGuidedSetups must return within its own bound regardless of the installer's own confirmation timeout, took ${elapsed}ms`
  );

  // The real SIGKILL was still dispatched underneath the faked liveness
  // check above, so the descendant actually dies; confirm that for real
  // (independent of the fake) and let the underlying request settle on its
  // own STOP_UNCONFIRMED bound afterward, so nothing leaks past this test.
  assert.equal(await waitUntilProcessDead(grandchildPid, { timeoutMs: 2000 }), true);
  await pending;
});

test("shutdownGuidedSetups's default outer bound outlasts the installer's own default cleanup bound instead of racing a shorter timer", async () => {
  // Mocked (not real) time, and a fake in-memory child rather than a real
  // process: the whole point here is the production DEFAULT bounds on both
  // sides -- the installer's own grace-then-confirm cleanup
  // (RUNTIME_TERMINATION_GRACE_MS + GUIDED_SETUP_GROUP_DEATH_TIMEOUT_MS,
  // installed-runtimes.mjs) against the route's own outer shutdown bound
  // (GUIDED_SETUP_SHUTDOWN_TIMEOUT_MS, installed-runtime-route.mjs) --
  // without spending real wall-clock seconds waiting them out or racing a
  // real process's own (fast, unrepresentative) death against the clock.
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 999_999;
  child.kill = () => {};
  let spawned = false;

  const server = boot({
    inventory: INVENTORY,
    probes: {},
    env: { CAREERRAT_DESKTOP_CLI_ONLY: "1" },
    platform: "darwin",
    belowBoundaryImpl: async () => "below",
    startGuidedSetupImpl: (runtimeId, options) =>
      startInstalledRuntimeGuidedSetup(runtimeId, {
        ...options,
        spawnImpl: () => {
          queueMicrotask(() => {
            spawned = true;
            child.emit("spawn");
          });
          return child;
        },
        // Group liveness stays true for the whole inner bound: the shape a
        // descendant that never confirms dead takes, and exactly what the
        // outer shutdown bound has to tolerate without cutting the
        // installer's own cleanup short.
        isGroupAliveImpl: () => true,
      }),
  });

  function guidedSetupHarness() {
    const res = {
      on() {
        return this;
      },
      writeHead() {
        return this;
      },
      flushHeaders() {},
      write() {
        return true;
      },
      end() {},
    };
    const req = Readable.from([Buffer.from(JSON.stringify({ runtimeId: "claude" }))]);
    req.headers = { "content-type": "application/json" };
    const handler = server.routes.get("POST /api/settings/ai-runtime/guided-setup");
    return handler(req, res);
  }

  const pending = guidedSetupHarness();
  // Real timers still, since mock.timers isn't enabled yet: a bounded real
  // wait for the fake spawn to land, same shape waitForFileContent above
  // uses for a real process's pid file.
  const spawnDeadline = Date.now() + 2000;
  while (!spawned && Date.now() < spawnDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(spawned, true, "the fake installer must have been spawned before shutdown runs");

  let pendingSettled = false;
  pending.then(
    () => {
      pendingSettled = true;
    },
    () => {
      pendingSettled = true;
    }
  );

  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    // No override on either side: exercises the real production defaults
    // end to end.
    const shutdownPromise = server.shutdownGuidedSetups();
    let shutdownSettled = false;
    shutdownPromise.then(() => {
      shutdownSettled = true;
    });

    // Advance past the grace period (250ms) alone first, in its own tick:
    // mock.timers.tick() snaps the mocked Date straight to the requested
    // target before running any callback due within it, so the
    // group-death confirmation's own deadline (computed from Date.now()
    // inside the escalation callback) must be established at exactly
    // 250ms, not folded into one larger jump together with the ticks
    // below.
    mock.timers.tick(250);
    await Promise.resolve();
    await Promise.resolve();

    // Now advance into the group-death confirmation wait, but stay short
    // of its default 5000ms timeout (cumulative 5100ms < the ~5250ms inner
    // bound): neither the underlying request nor shutdownGuidedSetups
    // itself may have settled yet.
    mock.timers.tick(4850);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      pendingSettled,
      false,
      "the underlying guided-setup request must still be pending mid-way through the inner bound"
    );
    assert.equal(
      shutdownSettled,
      false,
      "shutdownGuidedSetups must not resolve before the installer's own cleanup confirms/gives up"
    );

    // Advance past the inner bound (grace + group-death confirmation
    // timeout, ~5250ms total) but still far short of the outer shutdown
    // bound (well under 8000ms): the installer's own cleanup gives up
    // (RUNTIME_GUIDED_SETUP_STOP_UNCONFIRMED, retaining its lock) on its
    // own, and shutdownGuidedSetups must resolve only once that happens.
    mock.timers.tick(300);
    await shutdownPromise;
    assert.equal(
      pendingSettled,
      true,
      "shutdownGuidedSetups must not resolve before the underlying request has actually settled"
    );
  } finally {
    mock.timers.reset();
  }
});

test("two guided-setup admissions on separate mounts race the durable reservation, and the second is refused", async () => {
  const repoRoot = root();
  const env = { CAREERRAT_DESKTOP_CLI_ONLY: "1" };
  const gate = deferred();
  const started = [];

  const mountA = boot({
    repoRoot,
    inventory: INVENTORY,
    probes: {},
    env,
    platform: "darwin",
    belowBoundaryImpl: async () => {
      // Held here, after mountA's own reservation has already been written
      // (reservation happens before probing), so mountB's admission below
      // races an existing, pid-less record rather than an empty one.
      await gate.promise;
      return "below";
    },
    startGuidedSetupImpl: async (runtimeId, { onStart }) => {
      started.push(`A:${runtimeId}`);
      onStart();
      return { runtimeId, installCommand: "curl -fsSL https://claude.ai/install.sh | bash" };
    },
  });

  const mountB = boot({
    repoRoot,
    inventory: INVENTORY,
    probes: {},
    env,
    platform: "darwin",
    belowBoundaryImpl: async () => "below",
    startGuidedSetupImpl: async () => {
      throw new Error("mountB must never reach the installer while mountA's reservation is live");
    },
  });

  const first = requestStream(mountA, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  // Give mountA's handler a turn to reach and pass its own reservation
  // before mountB races it.
  await new Promise((resolve) => setImmediate(resolve));

  const second = await request(mountB, "POST", "/api/settings/ai-runtime/guided-setup", {
    runtimeId: "claude",
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "RUNTIME_GUIDED_SETUP_IN_PROGRESS");

  gate.resolve();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(started, ["A:claude"]);
});

test("a pid-less reservation older than the stale bound is reclaimed, but a fresh one still blocks admission", async () => {
  const repoRoot = root();
  const env = { CAREERRAT_DESKTOP_CLI_ONLY: "1" };

  // Fresh: a crash between admission and spawn just happened; nothing
  // should reclaim this yet.
  writeGuidedSetupOwnership({ repoRoot, env, runtimeId: "claude", pid: null });
  let reservation = reserveGuidedSetupOwnership({
    repoRoot,
    env,
    platform: "darwin",
    runtimeId: "claude",
  });
  assert.ok(reservation.error, "a fresh pid-less reservation must still block admission");
  assert.equal(reservation.error.code, "RUNTIME_GUIDED_SETUP_IN_PROGRESS");

  // Older than the stale bound: no installer legitimately runs that long
  // without ever reaching spawn, so this must be reclaimed.
  writeGuidedSetupOwnership({
    repoRoot,
    env,
    runtimeId: "claude",
    pid: null,
    startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  });
  reservation = reserveGuidedSetupOwnership({
    repoRoot,
    env,
    platform: "darwin",
    runtimeId: "claude",
  });
  assert.ok(reservation.generation, "a stale pid-less reservation must be reclaimed");
});

test("a live process occupying a reused process-group id with no verifiable identity is reclaimed only once stale", async () => {
  const repoRoot = root();
  const env = { CAREERRAT_DESKTOP_CLI_ONLY: "1" };
  const lockFile = userPath({ repoRoot, env }, ".internal/ai-runtime-guided-setup.lock.json");

  // A real, detached, long-lived process standing in for an unrelated
  // process the OS has since handed the original installer's reused
  // process-group id: its own pid is also its process-group id (detached),
  // matching what process.kill(-pid, 0) checks.
  const unrelated = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { detached: true, stdio: "ignore" }
  );
  await new Promise((resolve) => unrelated.once("spawn", resolve));

  function writeRawRecord(startedAt) {
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({
        runtimeId: "claude",
        pid: unrelated.pid,
        generation: "reused-pgid-generation",
        // No captured identity: simulates a record this fix predates (or
        // one written where `ps` couldn't run), so admission can't tell
        // this live pid apart from the real installer by identity alone
        // and has to fall back to the stale bound instead.
        pidStartedAt: null,
        startedAt,
      }),
      "utf8"
    );
  }

  try {
    writeRawRecord(new Date().toISOString());
    let reservation = reserveGuidedSetupOwnership({
      repoRoot,
      env,
      platform: "darwin",
      runtimeId: "claude",
    });
    assert.ok(reservation.error, "a fresh record on a live pid must still block admission");
    assert.equal(reservation.error.code, "RUNTIME_GUIDED_SETUP_IN_PROGRESS");

    writeRawRecord(new Date(Date.now() - 31 * 60 * 1000).toISOString());
    reservation = reserveGuidedSetupOwnership({
      repoRoot,
      env,
      platform: "darwin",
      runtimeId: "claude",
    });
    assert.ok(
      reservation.generation,
      "a stale record on a reused process-group id must be reclaimed"
    );
  } finally {
    try {
      process.kill(-unrelated.pid, "SIGKILL");
    } catch {
      // Already dead by the time cleanup runs.
    }
  }
});

test("selection rejects an unavailable or unauthenticated runtime with an actionable code", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: readyProbe(),
    },
  });
  const signedOut = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "claude",
  });
  assert.equal(signedOut.status, 409);
  assert.equal(signedOut.body.code, "RUNTIME_AUTH_REQUIRED");
  assert.equal(signedOut.body.action, "start_sign_in");

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
      claude: readyProbe(),
      codex: readyProbe(),
    },
  });
  const provider = await request(server, "POST", "/api/settings/ai-runtime/select", {
    providerFallback: true,
  });
  assert.equal(provider.status, 200);
  assert.equal(provider.body.providerFallbackAllowed, true);
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: null,
    providerFallback: true,
    customCommand: null,
    verification: null,
  });

  const local = await request(server, "POST", "/api/settings/ai-runtime/select", {
    runtimeId: "claude",
  });
  assert.equal(local.status, 200);
  const localSelection = loadInstalledRuntimeSelection({
    repoRoot: server.repoRoot,
    env: server.env,
  });
  assert.equal(localSelection.runtimeId, "claude");
  assert.deepEqual(localSelection.verification?.capabilities, VERIFIED_CAPABILITIES);
});

test("runtime inspection does not replace an explicit selection made while probes are pending", async () => {
  const repoRoot = root();
  const env = { CAREERRAT_DESKTOP_SHELL: "1" };
  const probesStarted = deferred();
  const releaseProbes = deferred();
  let probeCount = 0;

  writeInstalledRuntimeSelection({
    repoRoot,
    env,
    runtimeId: "codex",
    providerFallback: false,
  });
  const inspection = inspectInstalledRuntimeState({
    repoRoot,
    env,
    detectImpl: () => INVENTORY,
    probeImpl: async () => {
      probeCount += 1;
      if (probeCount === 2) probesStarted.resolve();
      await releaseProbes.promise;
      return readyProbe();
    },
  });

  await probesStarted.promise;
  writeInstalledRuntimeSelection({
    repoRoot,
    env,
    runtimeId: "claude",
    providerFallback: false,
  });
  releaseProbes.resolve();

  const state = await inspection;
  assert.equal(state.selectedId, "claude");
  assert.equal(state.providerFallback, false);
  assert.equal(
    state.runtimes.find(({ id }) => id === "claude").selected,
    true,
    "the inspection response must reflect the newer explicit choice"
  );
  assert.equal(loadInstalledRuntimeSelection({ repoRoot, env }).runtimeId, "claude");
});

test("runtime auto-selection does not replace provider fallback enabled while probes are pending", async () => {
  const repoRoot = root();
  const env = { CAREERRAT_DESKTOP_SHELL: "1" };
  const probesStarted = deferred();
  const releaseProbes = deferred();
  let probeCount = 0;

  const inspection = inspectInstalledRuntimeState({
    repoRoot,
    env,
    detectImpl: () => INVENTORY,
    probeImpl: async (runtime) => {
      probeCount += 1;
      if (probeCount === 2) probesStarted.resolve();
      await releaseProbes.promise;
      return runtime.id === "codex"
        ? readyProbe()
        : { status: "authentication_required", ready: false, action: "start_sign_in" };
    },
  });

  await probesStarted.promise;
  writeInstalledRuntimeSelection({
    repoRoot,
    env,
    runtimeId: null,
    providerFallback: true,
  });
  releaseProbes.resolve();

  const state = await inspection;
  assert.equal(state.selectedId, null);
  assert.equal(state.providerFallback, true);
  assert.equal(
    state.runtimes.some(({ selected }) => selected),
    false,
    "provider fallback must remain the active choice"
  );
  assert.equal(loadInstalledRuntimeSelection({ repoRoot, env }).providerFallback, true);
});

test("packaged desktop rejects and heals provider fallback before the renderer can use it", async () => {
  const server = boot({
    inventory: INVENTORY,
    probes: {
      claude: { status: "authentication_required", ready: false, action: "start_sign_in" },
      codex: { status: "authentication_required", ready: false, action: "start_sign_in" },
    },
    env: {
      CAREERRAT_DESKTOP_SHELL: "1",
      CAREERRAT_DESKTOP_CLI_ONLY: "1",
    },
  });
  writeInstalledRuntimeSelection({
    repoRoot: server.repoRoot,
    env: server.env,
    runtimeId: null,
    providerFallback: true,
  });

  const inventory = await request(server, "GET", "/api/settings/ai-runtimes");
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.providerFallbackAllowed, false);
  assert.equal(inventory.body.providerFallback, false);
  assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: server.repoRoot, env: server.env }), {
    runtimeId: null,
    providerFallback: false,
    customCommand: null,
    verification: null,
  });

  const selection = await request(server, "POST", "/api/settings/ai-runtime/select", {
    providerFallback: true,
  });
  assert.equal(selection.status, 409);
  assert.equal(selection.body.code, "PROVIDER_FALLBACK_UNAVAILABLE");
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
    verification: null,
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
    verification: null,
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
