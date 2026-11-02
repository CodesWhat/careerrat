// A search started from the terminal never visits AI Settings, so no installed
// AI program was ever selected and the AI steps quietly found "no route".
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { inspectInstalledRuntimeState } from "../src/cli/installed-runtime-route.mjs";
import { ensureInstalledRuntimeSelection } from "../src/core/ai/ensure-runtime-selection.mjs";
import { loadInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";

const roots = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "careerrat-ensure-runtime-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const READY_CAPS = {
  completion: true,
  structuredOutput: false,
  exactRead: false,
  publicWeb: false,
  tools: false,
};

// Real selection logic with fake detection and a "signed in" probe.
function inspectWith(runtimes) {
  return ({ repoRoot, env }) =>
    inspectInstalledRuntimeState({
      repoRoot,
      env,
      detectImpl: () => runtimes,
      probeImpl: async () => ({
        status: "ready",
        ready: true,
        action: null,
        capabilities: READY_CAPS,
      }),
    });
}

const claude = {
  id: "claude",
  name: "Claude",
  available: true,
  path: "/bin/claude",
  realPath: "/bin/claude",
  version: "2.0.0",
  binaryFingerprint: "a".repeat(64),
};

test("one installed signed-in CLI is selected for a CLI-started search", async () => {
  const repoRoot = tempRoot();
  const env = { CAREERRAT_NO_UPDATE_CHECK: "1" };
  assert.equal(loadInstalledRuntimeSelection({ repoRoot, env }).runtimeId, null);
  const result = await ensureInstalledRuntimeSelection({
    repoRoot,
    env,
    inspectImpl: inspectWith([claude]),
  });
  assert.equal(result.selected, "claude");
  assert.equal(loadInstalledRuntimeSelection({ repoRoot, env }).runtimeId, "claude");
});

test("with nothing installed the reason is plain words, not silence", async () => {
  const repoRoot = tempRoot();
  const result = await ensureInstalledRuntimeSelection({
    repoRoot,
    env: {},
    inspectImpl: inspectWith([{ ...claude, available: false }]),
  });
  assert.equal(result.selected, null);
  assert.match(result.reason, /No signed-in Claude or Codex/);
});

test("two ready CLIs are not chosen for the person", async () => {
  const repoRoot = tempRoot();
  const result = await ensureInstalledRuntimeSelection({
    repoRoot,
    env: {},
    inspectImpl: inspectWith([claude, { ...claude, id: "codex", name: "Codex" }]),
  });
  assert.equal(result.selected, null);
  assert.match(result.reason, /More than one AI program is ready/);
});

test("a workspace that already has an AI route is left alone", async () => {
  const repoRoot = tempRoot();
  let inspected = false;
  const result = await ensureInstalledRuntimeSelection({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test-0000000000" },
    inspectImpl: async () => {
      inspected = true;
      return { selectedId: null, runtimes: [] };
    },
  });
  assert.equal(inspected, false);
  assert.equal(result.selected, null);
});
