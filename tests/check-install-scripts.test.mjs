import assert from "node:assert/strict";
import test from "node:test";

import { checkInstallScripts } from "../scripts/check-install-scripts.mjs";

// ---------------------------------------------------------------------------
// Fixtures: small lockPackages maps shaped like package-lock.json's
// `packages` field, with allowScripts blocks shaped like root package.json's.
// ---------------------------------------------------------------------------

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
  const result = checkInstallScripts({ allowScripts, lockPackages: cleanLockPackages });
  assert.equal(result.ok, false);
  assert.deepEqual(result.staleKeys, ["esbuild@0.25.12"]);
  assert.deepEqual(result.uncovered, []);
});

test("flags an uncovered package that declares an install script with no allowScripts entry", () => {
  const lockPackages = {
    ...cleanLockPackages,
    "node_modules/new-native-dep": { version: "4.2.0", hasInstallScript: true },
  };
  const result = checkInstallScripts({ allowScripts: cleanAllowScripts, lockPackages });
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
  const result = checkInstallScripts({ allowScripts, lockPackages });
  assert.equal(result.ok, false);
  assert.deepEqual(result.staleKeys, ["esbuild@0.25.12"]);
  assert.deepEqual(result.uncovered, ["new-native-dep@4.2.0"]);
});

test("a bare name key covers every installed version of that package", () => {
  const lockPackages = {
    ...cleanLockPackages,
    "node_modules/core-js": { version: "3.51.0", hasInstallScript: true }, // version bumped, still bare-covered
  };
  const result = checkInstallScripts({ allowScripts: cleanAllowScripts, lockPackages });
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
  const result = checkInstallScripts({ allowScripts: {}, lockPackages });
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
  const result = checkInstallScripts({ allowScripts: {}, lockPackages });
  assert.equal(result.ok, false);
  assert.deepEqual(result.uncovered, ["web-vitals@6.0.0"]);
});

test("handles an empty allowScripts block and an empty lockfile without throwing", () => {
  assert.deepEqual(checkInstallScripts({ allowScripts: undefined, lockPackages: undefined }), {
    staleKeys: [],
    uncovered: [],
    ok: true,
  });
});
