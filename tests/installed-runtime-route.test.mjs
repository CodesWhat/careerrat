import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";

import {
  inspectInstalledRuntimeState,
  mountInstalledRuntimeRoutes,
} from "../src/cli/installed-runtime-route.mjs";
import { INSTALLED_RUNTIME_DEFINITIONS } from "../src/core/ai/installed-runtimes.mjs";
import {
  loadInstalledRuntimeSelection,
  writeInstalledRuntimeSelection,
} from "../src/core/ai/runtime-selection.mjs";

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
}) {
  const repoRoot = root();
  const routes = new Map();
  mountInstalledRuntimeRoutes({
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
    belowBoundaryImpl: async () => false,
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
      return true;
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
    belowBoundaryImpl: async () => false,
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
