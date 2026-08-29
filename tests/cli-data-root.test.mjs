// CLI-level regression coverage for the npm-install data-root bug: `careerrat`,
// physically placed at a real `<prefix>/lib/node_modules/careerrat` install
// topology, must never write user data inside its own package directory. This is
// the shape a plain `npm install -g careerrat` (no --force, same version) used to
// wipe on every reinstall, because privateDataRoot() defaulted to repoRoot/.careerrat
// unconditionally. Everything below exercises the real bin/careerrat.mjs entrypoint
// as a subprocess, not the internal helpers directly (those are covered in
// tests/workspace-paths.test.mjs), the layer that would have caught the bug.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isPackageInstall } from "../src/core/paths/workspace.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Builds a throwaway tree shaped like a real npm global install:
//   <base>/lib/node_modules/careerrat/{bin,src,config,templates,package.json}
// with node_modules symlinked back to the real repo's (already-installed)
// dependencies, so the copy boots without a separate `npm install`. Only the
// files package.json#files actually publishes are copied, matching what a real
// `npm install -g careerrat` puts on disk.
function buildInstalledFixture() {
  // Resolve once, up front: on macOS, tmpdir() sits under /var, itself a symlink to
  // /private/var, and Node's ESM loader resolves that symlink when it computes
  // bin/careerrat.mjs's own import.meta.url. Without resolving base first, the
  // repoRoot the CLI sees ends up /private-prefixed while HOME (an env var string,
  // never touched by fs resolution) doesn't, and the two stop string-matching for
  // reasons that have nothing to do with the anchor logic under test.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-cli-install-")));
  const packageDir = join(base, "lib", "node_modules", "careerrat");
  mkdirSync(packageDir, { recursive: true });
  for (const entry of ["bin", "src", "config", "templates", "package.json", "AGENTS.md"]) {
    cpSync(join(REPO_ROOT, entry), join(packageDir, entry), { recursive: true });
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(packageDir, "node_modules"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  return { base, packageDir, home };
}

function runCli(packageDir, home, args) {
  return spawnSync(process.execPath, [join(packageDir, "bin/careerrat.mjs"), ...args], {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

test("careerrat init, run from a real npm-install layout, anchors data at ~/.careerrat and writes nothing into the package dir", () => {
  const { base, packageDir, home } = buildInstalledFixture();
  try {
    const res = runCli(packageDir, home, ["init"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Data root: .*[\\/]home[\\/]\.careerrat$/m);
    assert.equal(
      existsSync(join(packageDir, ".careerrat")),
      false,
      "init must never create .careerrat inside the package directory"
    );
    assert.equal(existsSync(join(home, ".careerrat", "db", "careerrat.db")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("careerrat, run from an npm-install layout with data stranded in the old package-dir default, warns loudly without moving anything", () => {
  const { base, packageDir, home } = buildInstalledFixture();
  try {
    const stranded = join(packageDir, ".careerrat");
    mkdirSync(stranded, { recursive: true });
    writeFileSync(join(stranded, "tracker.json"), "{}\n");

    const res = runCli(packageDir, home, ["doctor", "--json"]);
    assert.match(res.stderr, /Found user data still inside the package directory/);
    assert.match(res.stderr, new RegExp(`mv "${stranded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    // A warning is not a migration: the stranded data must still be sitting
    // exactly where it was, untouched.
    assert.equal(existsSync(join(stranded, "tracker.json")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("careerrat update hard-refuses (no network hit) when the package dir still has stranded data", () => {
  const { base, packageDir, home } = buildInstalledFixture();
  try {
    const stranded = join(packageDir, ".careerrat");
    mkdirSync(stranded, { recursive: true });
    writeFileSync(join(stranded, "tracker.json"), "{}\n");

    const res = runCli(packageDir, home, ["update"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^REFUSING\. Found user data still inside the package directory/);
    // Refusing happens before the version check, so this never touches npm/network.
    assert.doesNotMatch(res.stderr, /Checking npm for careerrat/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("careerrat update --help prints usage and exits 0 instead of self-updating", () => {
  const { base, packageDir, home } = buildInstalledFixture();
  try {
    const res = runCli(packageDir, home, ["update", "--help"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage: careerrat update \[options\]/);
    assert.doesNotMatch(res.stdout, /Checking npm for careerrat/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("careerrat update -h behaves the same as --help", () => {
  const { base, packageDir, home } = buildInstalledFixture();
  try {
    const res = runCli(packageDir, home, ["update", "-h"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage: careerrat update \[options\]/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("careerrat update rejects an unknown flag instead of silently ignoring it", () => {
  const { base, packageDir, home } = buildInstalledFixture();
  try {
    const res = runCli(packageDir, home, ["update", "--bogus-flag"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Unknown option for update: --bogus-flag/);
    assert.match(res.stdout, /Usage: careerrat update \[options\]/);
    assert.doesNotMatch(res.stdout, /Checking npm for careerrat/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("this worktree's own checkout root is not classified as an npm install", () => {
  // Sanity check that the fixture-builder's install topology (lib/node_modules/careerrat)
  // is what actually triggers the new behavior, and that running these same tests
  // in-place, from a checkout, is unaffected.
  assert.equal(isPackageInstall(REPO_ROOT), false);
});
