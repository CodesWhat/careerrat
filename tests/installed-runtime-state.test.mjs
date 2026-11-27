import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  inspectInstalledRuntimeState,
  runtimeVerification,
} from "../src/core/ai/installed-runtime-state.mjs";
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
  const value = mkdtempSync(join(tmpdir(), "careerrat-runtime-state-"));
  roots.add(value);
  return value;
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.clear();
});

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

test("runtimeVerification returns null until the runtime has a real path, version, fingerprint and completion", () => {
  const runtime = {
    path: "/bin/claude",
    realPath: "/bin/claude",
    version: "1.0.0",
    binaryFingerprint: "A".repeat(64),
    capabilities: VERIFIED_CAPABILITIES,
  };
  assert.equal(runtimeVerification({ ...runtime, capabilities: { completion: false } }), null);
  assert.equal(runtimeVerification({ ...runtime, binaryFingerprint: "short" }), null);
  const verification = runtimeVerification(runtime);
  assert.equal(verification.binaryFingerprint, "a".repeat(64));
  assert.equal(verification.versionBoundaryState, "indeterminate");
  assert.equal(verification.testedMinimumVersion, null);
});
