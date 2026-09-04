import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkInstallScripts } from "../scripts/check-install-scripts.mjs";

// ---------------------------------------------------------------------------
// Fixtures: small lockPackages maps shaped like package-lock.json's
// `packages` field, with allowScripts blocks shaped like root package.json's.
// ---------------------------------------------------------------------------

const fixtureWorkspaces = ["apps/*"];

const cleanLockPackages = {
  "": { name: "fixture-root", version: "1.0.0" },
  "apps/web": { name: "@fixture/web", version: "0.0.0" },
  "node_modules/fsevents": { version: "2.3.2", hasInstallScript: true },
  "node_modules/esbuild": { version: "0.28.2", hasInstallScript: true },
  "node_modules/core-js": { version: "3.50.0", hasInstallScript: true },
  "node_modules/left-pad": { version: "1.3.0" },
  "node_modules/@fixture/workspace-link": { resolved: "apps/web", link: true },
};

const cleanAllowScripts = {
  "fsevents@2.3.2": true,
  "esbuild@0.28.2": true,
  "core-js": false,
};

test("reports clean when every scripted package is covered and every pinned key is installed", () => {
  const result = checkInstallScripts({
    allowScripts: cleanAllowScripts,
    lockPackages: cleanLockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.staleKeys, []);
  assert.deepEqual(result.uncovered, []);
});

test("flags a stale pinned key when the lockfile no longer has that name@version", () => {
  const allowScripts = {
    ...cleanAllowScripts,
    "esbuild@0.25.12": true, // Renovate bumped esbuild; this old pin never got removed.
  };
  const result = checkInstallScripts({
    allowScripts,
    lockPackages: cleanLockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.staleKeys, ["esbuild@0.25.12"]);
  assert.deepEqual(result.uncovered, []);
});

test("flags an uncovered package that declares an install script with no allowScripts entry", () => {
  const lockPackages = {
    ...cleanLockPackages,
    "node_modules/new-native-dep": { version: "4.2.0", hasInstallScript: true },
  };
  const result = checkInstallScripts({
    allowScripts: cleanAllowScripts,
    lockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.staleKeys, []);
  assert.deepEqual(result.uncovered, ["new-native-dep@4.2.0"]);
});

test("reports both a stale key and an uncovered package together", () => {
  const allowScripts = { ...cleanAllowScripts, "esbuild@0.25.12": true };
  const lockPackages = {
    ...cleanLockPackages,
    "node_modules/new-native-dep": { version: "4.2.0", hasInstallScript: true },
  };
  const result = checkInstallScripts({
    allowScripts,
    lockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.staleKeys, ["esbuild@0.25.12"]);
  assert.deepEqual(result.uncovered, ["new-native-dep@4.2.0"]);
});

test("a bare name key covers every installed version of that package", () => {
  const lockPackages = {
    ...cleanLockPackages,
    "node_modules/core-js": { version: "3.51.0", hasInstallScript: true }, // version bumped, still bare-covered
  };
  const result = checkInstallScripts({
    allowScripts: cleanAllowScripts,
    lockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, true);
});

test("skips workspace entries and workspace symlinks", () => {
  const lockPackages = {
    "": { name: "fixture-root", version: "1.0.0", hasInstallScript: true },
    "apps/web": { name: "@fixture/web", version: "0.0.0", hasInstallScript: true },
    "node_modules/@fixture/workspace-link": {
      resolved: "apps/web",
      link: true,
      hasInstallScript: true,
    },
  };
  const result = checkInstallScripts({
    allowScripts: {},
    lockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.uncovered, []);
});

test("derives the package name from the lockfile path, honoring an alias override", () => {
  const lockPackages = {
    "node_modules/web-vitals-soft-navs": {
      name: "web-vitals",
      version: "6.0.0",
      hasInstallScript: true,
    },
  };
  const result = checkInstallScripts({
    allowScripts: {},
    lockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.uncovered, ["web-vitals@6.0.0"]);
});

test("catches a scripted dependency nested under a workspace member's own node_modules", () => {
  // e.g. apps/website/node_modules/@types/node in the real lockfile: not
  // under root node_modules/, so a startsWith("node_modules/") check would
  // never see it.
  const lockPackages = {
    ...cleanLockPackages,
    "apps/website/node_modules/native-nested-dep": {
      version: "2.0.0",
      hasInstallScript: true,
    },
  };
  const result = checkInstallScripts({
    allowScripts: cleanAllowScripts,
    lockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.uncovered, ["native-nested-dep@2.0.0"]);
});

test("catches a scripted dependency nested under another dependency's node_modules", () => {
  const lockPackages = {
    ...cleanLockPackages,
    "node_modules/left-pad/node_modules/native-transitive-dep": {
      version: "1.1.0",
      hasInstallScript: true,
    },
  };
  const result = checkInstallScripts({
    allowScripts: cleanAllowScripts,
    lockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.uncovered, ["native-transitive-dep@1.1.0"]);
});

test("follows a non-workspace file link to its target and inspects the target", () => {
  // A link node whose resolved target isn't one of root package.json's
  // declared workspaces (only apps/* here) is a plain `file:` dependency,
  // not this repo's own package, it still needs allowScripts coverage.
  const lockPackages = {
    ...cleanLockPackages,
    "node_modules/@fixture/file-link": { resolved: "packages/native-thing", link: true },
    "packages/native-thing": { version: "9.9.9", hasInstallScript: true },
  };
  const result = checkInstallScripts({
    allowScripts: cleanAllowScripts,
    lockPackages,
    workspaces: fixtureWorkspaces,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.uncovered, ["native-thing@9.9.9"]);
});

test("fails closed when package-lock.json has no packages map (lockfileVersion 1 or malformed)", () => {
  assert.throws(
    () => checkInstallScripts({ allowScripts: {}, lockPackages: undefined }),
    /packages map/
  );
  assert.throws(() => checkInstallScripts({ allowScripts: {}, lockPackages: [] }), /packages map/);
});

// ---------------------------------------------------------------------------
// On-disk checks: binding.gyp scanning, missing node_modules, and a
// competing npm-shrinkwrap.json. These need a real directory tree, since
// `root` switches checkInstallScripts from pure lockfile comparison into
// also reading the filesystem.
// ---------------------------------------------------------------------------

function makeFixtureRoot() {
  return mkdtempSync(join(tmpdir(), "check-install-scripts-"));
}

test("catches an implicit node-gyp install script from a binding.gyp on disk", () => {
  const fixtureRoot = makeFixtureRoot();
  try {
    const pkgDir = join(fixtureRoot, "node_modules", "native-gyp-dep");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "binding.gyp"), "{}");

    const lockPackages = {
      ...cleanLockPackages,
      "node_modules/native-gyp-dep": { version: "1.0.0" }, // no hasInstallScript flag
    };
    const result = checkInstallScripts({
      allowScripts: cleanAllowScripts,
      lockPackages,
      workspaces: fixtureWorkspaces,
      root: fixtureRoot,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.uncovered, ["native-gyp-dep@1.0.0"]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("fails closed when node_modules is missing and --lock-only was not passed", () => {
  const fixtureRoot = makeFixtureRoot();
  try {
    assert.throws(
      () =>
        checkInstallScripts({
          allowScripts: cleanAllowScripts,
          lockPackages: cleanLockPackages,
          workspaces: fixtureWorkspaces,
          root: fixtureRoot,
        }),
      /node_modules is missing/
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("--lock-only skips the missing node_modules failure and the binding.gyp scan", () => {
  const fixtureRoot = makeFixtureRoot();
  try {
    const result = checkInstallScripts({
      allowScripts: cleanAllowScripts,
      lockPackages: cleanLockPackages,
      workspaces: fixtureWorkspaces,
      root: fixtureRoot,
      lockOnly: true,
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("fails closed when npm-shrinkwrap.json is present at the repo root", () => {
  const fixtureRoot = makeFixtureRoot();
  try {
    mkdirSync(join(fixtureRoot, "node_modules"), { recursive: true });
    writeFileSync(join(fixtureRoot, "npm-shrinkwrap.json"), "{}");

    assert.throws(
      () =>
        checkInstallScripts({
          allowScripts: cleanAllowScripts,
          lockPackages: cleanLockPackages,
          workspaces: fixtureWorkspaces,
          root: fixtureRoot,
        }),
      /npm-shrinkwrap\.json/
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
