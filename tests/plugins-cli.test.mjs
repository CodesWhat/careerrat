// tests/plugins-cli.test.mjs
// node:test suite for the `careerrat plugins` CLI (src/cli/plugins.mjs) and the
// doctor plugins block it shares logic with (src/core/plugins/index.mjs's
// verifyBundledPlugins). This CLI is read-only: it lists and verifies the
// bundled plugin layer, it never enables, disables, or runs a plugin.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

function tempHome() {
  return mkdtempSync(join(tmpdir(), "careerrat-plugins-cli-"));
}

function runCli(script, args, home, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, CAREERRAT_HOME: home, ...extraEnv },
    encoding: "utf8",
  });
}

function writeBrokenPlugin(pluginsRoot) {
  const dir = join(pluginsRoot, "plugins", "broken-plugin");
  mkdirSync(dir, { recursive: true });
  // Missing required fields (version, description, reads, fetchHosts, entry) -
  // validateManifest must reject this outright.
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "broken-plugin" }, null, 2));
}

test("plugins list (text) includes the bundled example-echo plugin with its consent state", () => {
  const home = tempHome();
  try {
    const result = runCli("src/cli/plugins.mjs", ["list"], home);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /example-echo/);
    assert.match(result.stdout, /capability: none/);
    assert.match(result.stdout, /consent: allowed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugins list --json includes example-echo with an allowed consent state", () => {
  const home = tempHome();
  try {
    const result = runCli("src/cli/plugins.mjs", ["list", "--json"], home);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    const echo = parsed.plugins.find((p) => p.name === "example-echo");
    assert.ok(echo, "expected example-echo in --json output");
    assert.equal(echo.capability, null);
    assert.deepEqual(echo.fetchHosts, []);
    assert.equal(echo.allowed, true);
    assert.equal(echo.reason, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugins verify exits 0 on the shipped tree", () => {
  const home = tempHome();
  try {
    const result = runCli("src/cli/plugins.mjs", ["verify"], home);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /example-echo/);
    assert.match(result.stdout, /all verified/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugins verify --json exits 0 with an ok result for every bundled plugin on the shipped tree", () => {
  const home = tempHome();
  try {
    const result = runCli("src/cli/plugins.mjs", ["verify", "--json"], home);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.results.length > 0);
    assert.ok(parsed.results.every((r) => r.ok === true));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugins verify exits 1 and names the plugin when pointed at a broken manifest", () => {
  const home = tempHome();
  const pluginsRoot = tempHome();
  try {
    writeBrokenPlugin(pluginsRoot);
    const result = runCli("src/cli/plugins.mjs", ["verify"], home, {
      CAREERRAT_PLUGINS_ROOT: pluginsRoot,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}broken-plugin/);
    assert.match(result.stdout, /failed verification/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

test("plugins verify --json exits 1 and reports errors for the broken plugin", () => {
  const home = tempHome();
  const pluginsRoot = tempHome();
  try {
    writeBrokenPlugin(pluginsRoot);
    const result = runCli("src/cli/plugins.mjs", ["verify", "--json"], home, {
      CAREERRAT_PLUGINS_ROOT: pluginsRoot,
    });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    const broken = parsed.results.find((r) => r.name === "broken-plugin");
    assert.ok(broken, "expected broken-plugin in --json results");
    assert.equal(broken.ok, false);
    assert.ok(broken.errors.length > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

test("doctor --json includes a plugins block reporting the bundled example-echo plugin", () => {
  const home = tempHome();
  try {
    const result = runCli("src/cli/doctor.mjs", ["--json"], home);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.plugins, "expected a plugins block in doctor --json output");
    assert.ok(parsed.plugins.bundled >= 1);
    assert.equal(parsed.plugins.runnable, parsed.plugins.bundled);
    assert.deepEqual(parsed.plugins.invalid, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
