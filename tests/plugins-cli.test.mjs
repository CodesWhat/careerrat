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

// CI's pinned npm 12.0.2 shapes `npm pack --json`'s output differently from
// the npm this repo's contributors run locally (verified: npm 11.19.0 here
// emits a top-level array `[{...}]`; npm 12.0.2, against this same
// workspaces-root package.json, emits a top-level object keyed by package
// name, `{"careerrat": {...}}`). `const [pkg] = JSON.parse(...)` array-
// destructures the parsed JSON directly, so under npm 12.0.2 that throws
// "TypeError: object is not iterable" instead of ever reaching the
// assertions below. Accepting either shape holds this test on both without
// weakening what it actually checks.
function firstPackedPackage(json) {
  return Array.isArray(json) ? json[0] : Object.values(json)[0];
}

test("npm pack ships the bundled example-echo plugin (manifest + entry)", () => {
  // --ignore-scripts skips the "prepack" build of apps/web — this test only
  // cares about which paths package.json's `files` allowlist ships, not
  // about producing a real tarball.
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const pkg = firstPackedPackage(JSON.parse(result.stdout));
  const paths = pkg.files.map((f) => f.path);
  assert.ok(
    paths.includes("plugins/example-echo/manifest.json"),
    "npm pack must ship the bundled plugin's manifest.json"
  );
  assert.ok(
    paths.includes("plugins/example-echo/index.mjs"),
    "npm pack must ship the bundled plugin's entry file"
  );
});

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
    assert.equal(parsed.plugins.error, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor --json still parses and reports the failure when the plugins path is a regular file", () => {
  const home = tempHome();
  const pluginsRoot = tempHome();
  try {
    // A regular file sitting where the `plugins/` directory should be -
    // readdirSync on it throws ENOTDIR, which must never escape as an
    // unhandled crash that skips doctor's JSON envelope.
    writeFileSync(join(pluginsRoot, "plugins"), "not a directory");
    const result = runCli("src/cli/doctor.mjs", ["--json"], home, {
      CAREERRAT_PLUGINS_ROOT: pluginsRoot,
    });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.plugins.error, "expected a directory-level plugins error");
    assert.equal(parsed.plugins.bundled, 0);
    assert.deepEqual(parsed.plugins.invalid, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

test("doctor --json still parses and reports the failure when CAREERRAT_PLUGINS_ROOT points nowhere", () => {
  const home = tempHome();
  const missingRoot = join(tmpdir(), `careerrat-missing-plugins-root-${Date.now()}`);
  try {
    const result = runCli("src/cli/doctor.mjs", ["--json"], home, {
      CAREERRAT_PLUGINS_ROOT: missingRoot,
    });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.plugins.error, "expected a directory-level plugins error");
    assert.equal(parsed.plugins.bundled, 0);
    assert.deepEqual(parsed.plugins.invalid, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
