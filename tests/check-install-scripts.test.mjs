import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkInstallScripts } from "../scripts/check-install-scripts.mjs";

// ---------------------------------------------------------------------------
// This checker now loads the real dependency tree with @npmcli/arborist and
// reuses arborist's own identity matcher and install-script walk, instead of
// reimplementing npm's allowScripts semantics. Every fixture below is
// therefore a real, on-disk package.json + package-lock.json (and, where the
// scenario needs the on-disk checks, a real node_modules), not a hand-shaped
// in-memory object. A real Arborist tree is what these tests exercise.
//
// Every scenario tagged [codex-305-r3] is a direct regression for a finding
// in the third adversarial review (/tmp/codex-305-r3.md) that the old
// hand-rolled matcher got wrong.
// ---------------------------------------------------------------------------

function makeFixtureRoot() {
  // realpath: on macOS, os.tmpdir() lives under a /tmp -> /private/tmp
  // symlink. Arborist reports node.realpath post-symlink-resolution, so a
  // file: policy key built from the un-resolved tmpdir path would never
  // string-equal it.
  return realpathSync(mkdtempSync(join(tmpdir(), "check-install-scripts-")));
}

function removeFixtureRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

// Writes a root package.json and a lockfileVersion 3 package-lock.json whose
// packages[""] entry mirrors it, plus whatever extra `packages` entries the
// scenario needs. `rootExtra` typically carries `dependencies`/`workspaces`,
// since a node needs a real incoming dependency edge for arborist's own
// `isRegistryDependency`/`isWorkspace` getters to resolve the way they would
// against a real npm-generated lockfile.
function writeManifests(root, { rootExtra = {}, packages = {} }) {
  const rootPkg = { name: "fixture-root", version: "1.0.0", ...rootExtra };
  writeFileSync(join(root, "package.json"), JSON.stringify(rootPkg, null, 2));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify(
      {
        name: "fixture-root",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": rootPkg, ...packages },
      },
      null,
      2
    )
  );
}

function writeWorkspaceMember(root, relPath, content) {
  const dir = join(root, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(content, null, 2));
  return dir;
}

function writeInstalledPackage(root, relPath, content) {
  const dir = join(root, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(content, null, 2));
  return dir;
}

// For actual-mode (loadActual) fixtures that only care about on-disk script
// discovery, not lockfile-driven stale-key matching: writes just the root
// package.json plus a minimal, self-consistent package-lock.json (packages[""]
// mirrors rootPkg, no dependency entries). checkInstallScripts now always
// loads a virtual tree in actual mode too (for stale-key matching against the
// lockfile rather than the possibly platform-pruned on-disk tree), so
// loadVirtual needs a package-lock.json to exist even when a scenario never
// exercises staleKeys.
function writeRootManifestOnly(root, rootPkg) {
  writeFileSync(join(root, "package.json"), JSON.stringify(rootPkg, null, 2));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify(
      {
        name: rootPkg.name,
        version: rootPkg.version,
        lockfileVersion: 3,
        requires: true,
        packages: { "": rootPkg },
      },
      null,
      2
    )
  );
}

// ---------------------------------------------------------------------------
// Basics: clean tree, bad allowScripts values, stale/uncovered reporting.
// ---------------------------------------------------------------------------

test("reports clean when every scripted package is covered, including by a bare-name key across a version bump", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: { dependencies: { esbuild: "0.28.2", "core-js": "3.51.0", "left-pad": "1.3.0" } },
      packages: {
        "node_modules/esbuild": {
          version: "0.28.2",
          resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz",
          hasInstallScript: true,
        },
        "node_modules/core-js": {
          version: "3.51.0", // bumped past whatever the bare-name key was written against
          resolved: "https://registry.npmjs.org/core-js/-/core-js-3.51.0.tgz",
          hasInstallScript: true,
        },
        "node_modules/left-pad": {
          version: "1.3.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
        },
      },
    });
    const result = await checkInstallScripts({
      allowScripts: { "esbuild@0.28.2": true, "core-js": false },
      root,
      lockOnly: true,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.staleKeys, []);
    assert.deepEqual(result.uncovered, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test("throws when an allowScripts value is null (npm only recognizes a literal boolean)", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {});
    await assert.rejects(
      checkInstallScripts({ allowScripts: { esbuild: null }, root }),
      /allowScripts\["esbuild"\] must be strictly true or false/
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("throws when an allowScripts value is a string (npm only recognizes a literal boolean)", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {});
    await assert.rejects(
      checkInstallScripts({ allowScripts: { esbuild: "true" }, root }),
      /allowScripts\["esbuild"\] must be strictly true or false/
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("flags a stale pinned key when npm's own matcher no longer matches anything installed", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: { dependencies: { esbuild: "0.28.2" } },
      packages: {
        "node_modules/esbuild": {
          version: "0.28.2", // Renovate bumped esbuild; the old pin never got removed.
          resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz",
          hasInstallScript: true,
        },
      },
    });
    const result = await checkInstallScripts({
      allowScripts: { "esbuild@0.28.2": true, "esbuild@0.25.12": true },
      root,
      lockOnly: true,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.staleKeys, ["esbuild@0.25.12"]);
    assert.deepEqual(result.uncovered, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test("flags an uncovered package that declares an install script with no allowScripts entry", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: { dependencies: { "new-native-dep": "4.2.0" } },
      packages: {
        "node_modules/new-native-dep": {
          version: "4.2.0",
          resolved: "https://registry.npmjs.org/new-native-dep/-/new-native-dep-4.2.0.tgz",
          hasInstallScript: true,
        },
      },
    });
    const result = await checkInstallScripts({ allowScripts: {}, root, lockOnly: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.staleKeys, []);
    assert.deepEqual(result.uncovered, ["new-native-dep@4.2.0"]);
  } finally {
    removeFixtureRoot(root);
  }
});

test("reports both a stale key and an uncovered package together", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: { dependencies: { esbuild: "0.28.2", "new-native-dep": "4.2.0" } },
      packages: {
        "node_modules/esbuild": {
          version: "0.28.2",
          resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz",
        },
        "node_modules/new-native-dep": {
          version: "4.2.0",
          resolved: "https://registry.npmjs.org/new-native-dep/-/new-native-dep-4.2.0.tgz",
          hasInstallScript: true,
        },
      },
    });
    const result = await checkInstallScripts({
      allowScripts: { "esbuild@0.25.12": true },
      root,
      lockOnly: true,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.staleKeys, ["esbuild@0.25.12"]);
    assert.deepEqual(result.uncovered, ["new-native-dep@4.2.0"]);
  } finally {
    removeFixtureRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Identity: registry, file, remote, and git. [codex-305-r3]
// ---------------------------------------------------------------------------

test("[codex-305-r3] a tarball resolved as trusted@1.2.3 but claiming impostor@9.9.9 is not covered by impostor@9.9.9", async () => {
  // The old checker trusted the lockfile entry's own `name`/`version` fields
  // (attacker-controlled: they come from the published tarball's own
  // package.json). npm's real identity is the resolved tarball URL. A
  // manifest that lies about its own name must not be able to borrow another
  // package's review.
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: { dependencies: { trusted: "1.2.3" } },
      packages: {
        "node_modules/trusted": {
          name: "impostor",
          version: "9.9.9",
          resolved: "https://registry.npmjs.org/trusted/-/trusted-1.2.3.tgz",
          hasInstallScript: true,
        },
      },
    });
    const spoofed = await checkInstallScripts({
      allowScripts: { "impostor@9.9.9": true },
      root,
      lockOnly: true,
    });
    assert.equal(spoofed.ok, false);
    assert.deepEqual(spoofed.uncovered, ["trusted@1.2.3"]);

    const real = await checkInstallScripts({
      allowScripts: { "trusted@1.2.3": true },
      root,
      lockOnly: true,
    });
    assert.equal(real.ok, true);
  } finally {
    removeFixtureRoot(root);
  }
});

test("[codex-305-r3] a file directory dependency is not covered by a registry-style name@version key", async () => {
  const root = makeFixtureRoot();
  try {
    writeWorkspaceMember(root, "packages/native-thing", {
      name: "native-thing",
      version: "9.9.9",
      scripts: { install: "node-gyp rebuild" },
    });
    writeManifests(root, {
      rootExtra: { dependencies: { "native-thing": "file:packages/native-thing" } },
      packages: {
        "packages/native-thing": { name: "native-thing", version: "9.9.9", hasInstallScript: true },
        "node_modules/native-thing": { resolved: "packages/native-thing", link: true },
      },
    });

    const byNameVersion = await checkInstallScripts({
      allowScripts: { "native-thing@9.9.9": true },
      root,
      lockOnly: true,
    });
    assert.equal(byNameVersion.ok, false);
    assert.deepEqual(byNameVersion.uncovered, ["file:../packages/native-thing"]);

    const byFileKey = await checkInstallScripts({
      allowScripts: { [`file:${join(root, "packages/native-thing")}`]: true },
      root,
      lockOnly: true,
    });
    assert.equal(byFileKey.ok, true);
  } finally {
    removeFixtureRoot(root);
  }
});

test("[codex-305-r3] a registry-shaped remote tarball URL is not covered by name@version, only by the exact URL", async () => {
  const root = makeFixtureRoot();
  try {
    const url = "https://mirror.example.com/shady-remote/-/shady-remote-1.0.0.tgz";
    writeManifests(root, {
      rootExtra: { dependencies: { "shady-remote": url } },
      packages: {
        "node_modules/shady-remote": { version: "1.0.0", resolved: url, hasInstallScript: true },
      },
    });

    const byNameVersion = await checkInstallScripts({
      allowScripts: { "shady-remote@1.0.0": true },
      root,
      lockOnly: true,
    });
    assert.equal(byNameVersion.ok, false);
    assert.deepEqual(byNameVersion.uncovered, [url]);

    const byUrl = await checkInstallScripts({
      allowScripts: { [url]: true },
      root,
      lockOnly: true,
    });
    assert.equal(byUrl.ok, true);
  } finally {
    removeFixtureRoot(root);
  }
});

test("[codex-305-r3] hosted git forms (github: shorthand, git+https, git+ssh) all cover the same resolved dependency", async () => {
  const root = makeFixtureRoot();
  try {
    const sha = "abc123def4567890abc123def4567890abc123d";
    writeManifests(root, {
      rootExtra: { dependencies: { "git-dep": `github:user/repo#${sha}` } },
      packages: {
        "node_modules/git-dep": {
          version: "1.0.0",
          resolved: `git+ssh://git@github.com/user/repo.git#${sha}`,
          hasInstallScript: true,
        },
      },
    });

    for (const key of [
      `github:user/repo#${sha.slice(0, 7)}`,
      `git+https://github.com/user/repo.git#${sha.slice(0, 7)}`,
      `git+ssh://git@github.com/user/repo.git#${sha.slice(0, 7)}`,
    ]) {
      const result = await checkInstallScripts({
        allowScripts: { [key]: true },
        root,
        lockOnly: true,
      });
      assert.equal(result.ok, true, `expected "${key}" to cover the resolved git dependency`);
    }

    const wrongSha = await checkInstallScripts({
      allowScripts: { "github:user/repo#deadbeef": true },
      root,
      lockOnly: true,
    });
    assert.equal(wrongSha.ok, false);
    assert.deepEqual(wrongSha.uncovered, [`git+ssh://git@github.com/user/repo.git#${sha}`]);
  } finally {
    removeFixtureRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Workspaces: resolved by arborist itself (@npmcli/map-workspaces), not a
// hand-rolled glob. [codex-305-r3]
// ---------------------------------------------------------------------------

test("skips workspace members and their node_modules symlinks", async () => {
  const root = makeFixtureRoot();
  try {
    writeWorkspaceMember(root, "apps/web", { name: "@fixture/web", version: "0.0.0" });
    writeManifests(root, {
      rootExtra: { workspaces: ["apps/*"] },
      packages: {
        "apps/web": { name: "@fixture/web", version: "0.0.0", hasInstallScript: true },
        "node_modules/@fixture/web": { resolved: "apps/web", link: true, hasInstallScript: true },
      },
    });
    const result = await checkInstallScripts({ allowScripts: {}, root, lockOnly: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.uncovered, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test("[codex-305-r3] a zero-segment ** workspace glob matches packages/web (packages/**/web)", async () => {
  const root = makeFixtureRoot();
  try {
    writeWorkspaceMember(root, "packages/web", { name: "@fixture/web-zero-seg", version: "0.0.0" });
    writeManifests(root, {
      rootExtra: { workspaces: ["packages/**/web"] },
      packages: {
        "packages/web": {
          name: "@fixture/web-zero-seg",
          version: "0.0.0",
          hasInstallScript: true,
        },
        "node_modules/@fixture/web-zero-seg": { resolved: "packages/web", link: true },
      },
    });
    const result = await checkInstallScripts({ allowScripts: {}, root, lockOnly: true });
    assert.equal(
      result.ok,
      true,
      "packages/web must be recognized as the workspace, not a bare dependency"
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("[codex-305-r3] a later positive pattern that overlaps an earlier negation cancels the negation entirely (npm's real @npmcli/map-workspaces behavior, not simple last-match-wins)", async () => {
  // This is the case a hand-rolled "last matching glob wins, evaluated
  // per-path" model gets wrong. @npmcli/map-workspaces processes patterns in
  // declaration order and, when a later positive pattern is itself matched
  // by an earlier negation, drops that negation from the pattern set
  // entirely (see node_modules/@npmcli/map-workspaces/lib/index.js,
  // appendNegatedPatterns), not just for the path that triggered it. So
  // `["packages/*", "!packages/vendor-*", "packages/vendor-special"]`
  // re-includes packages/vendor-native too, because "packages/vendor-special"
  // matches the "packages/vendor-*" negation and voids it globally. A
  // dependency this checker used to (correctly, per that reading of the RFC)
  // treat as "still needs checking" is, under npm's actual resolution, a real
  // workspace member and must be skipped.
  const root = makeFixtureRoot();
  try {
    writeWorkspaceMember(root, "packages/vendor-native", {
      name: "vendor-native",
      version: "1.0.0",
    });
    writeWorkspaceMember(root, "packages/vendor-special", {
      name: "vendor-special",
      version: "1.0.0",
    });
    writeManifests(root, {
      rootExtra: { workspaces: ["packages/*", "!packages/vendor-*", "packages/vendor-special"] },
      packages: {
        "packages/vendor-native": {
          name: "vendor-native",
          version: "1.0.0",
          hasInstallScript: true,
        },
        "packages/vendor-special": {
          name: "vendor-special",
          version: "1.0.0",
          hasInstallScript: true,
        },
        "node_modules/vendor-native": { resolved: "packages/vendor-native", link: true },
        "node_modules/vendor-special": { resolved: "packages/vendor-special", link: true },
      },
    });
    const result = await checkInstallScripts({ allowScripts: {}, root, lockOnly: true });
    assert.equal(
      result.ok,
      true,
      "both vendor-native and vendor-special resolve as real workspaces"
    );
  } finally {
    removeFixtureRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Registry policy key shapes: bare wildcard and exact-version disjunction
// accepted, semver ranges rejected. [codex-305-r3]
// ---------------------------------------------------------------------------

test("[codex-305-r3] pkg@* and an exact-version disjunction are accepted registry policy forms; semver ranges are rejected", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: { dependencies: { "wild-pkg": "3.0.0" } },
      packages: {
        "node_modules/wild-pkg": {
          version: "3.0.0",
          resolved: "https://registry.npmjs.org/wild-pkg/-/wild-pkg-3.0.0.tgz",
          hasInstallScript: true,
        },
      },
    });

    const star = await checkInstallScripts({
      allowScripts: { "wild-pkg@*": true },
      root,
      lockOnly: true,
    });
    assert.equal(star.ok, true);

    const disjunction = await checkInstallScripts({
      allowScripts: { "wild-pkg@1.0.0 || 3.0.0": true },
      root,
      lockOnly: true,
    });
    assert.equal(disjunction.ok, true);

    const caretRange = await checkInstallScripts({
      allowScripts: { "wild-pkg@^3.0.0": true },
      root,
      lockOnly: true,
    });
    assert.equal(
      caretRange.ok,
      false,
      "a semver range must not silently allow versions never reviewed"
    );
    assert.deepEqual(caretRange.uncovered, ["wild-pkg@3.0.0"]);
  } finally {
    removeFixtureRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Nested install locations: under a workspace member's own node_modules, and
// under another dependency's node_modules.
// ---------------------------------------------------------------------------

test("catches a scripted dependency nested under a workspace member's own node_modules", async () => {
  const root = makeFixtureRoot();
  try {
    writeWorkspaceMember(root, "apps/website", {
      name: "@fixture/website",
      version: "0.0.0",
      dependencies: { "native-nested-dep": "2.0.0" },
    });
    writeManifests(root, {
      rootExtra: { workspaces: ["apps/*"] },
      packages: {
        "apps/website": {
          name: "@fixture/website",
          version: "0.0.0",
          dependencies: { "native-nested-dep": "2.0.0" },
        },
        "apps/website/node_modules/native-nested-dep": {
          version: "2.0.0",
          resolved: "https://registry.npmjs.org/native-nested-dep/-/native-nested-dep-2.0.0.tgz",
          hasInstallScript: true,
        },
      },
    });
    const result = await checkInstallScripts({ allowScripts: {}, root, lockOnly: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.uncovered, ["native-nested-dep@2.0.0"]);
  } finally {
    removeFixtureRoot(root);
  }
});

test("catches a scripted dependency nested under another dependency's node_modules", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: { dependencies: { "left-pad": "1.3.0" } },
      packages: {
        "node_modules/left-pad": {
          version: "1.3.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
          dependencies: { "native-transitive-dep": "1.1.0" },
        },
        "node_modules/left-pad/node_modules/native-transitive-dep": {
          version: "1.1.0",
          resolved:
            "https://registry.npmjs.org/native-transitive-dep/-/native-transitive-dep-1.1.0.tgz",
          hasInstallScript: true,
        },
      },
    });
    const result = await checkInstallScripts({ allowScripts: {}, root, lockOnly: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.uncovered, ["native-transitive-dep@1.1.0"]);
  } finally {
    removeFixtureRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Lockfile failures: fail closed rather than silently pass.
// ---------------------------------------------------------------------------

test("fails closed when package-lock.json is missing entirely", async () => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture-root", version: "1.0.0" })
    );
    await assert.rejects(
      checkInstallScripts({ allowScripts: {}, root, lockOnly: true }),
      /could not load the dependency tree|package-lock\.json/
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("fails closed when package-lock.json is malformed JSON", async () => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture-root", version: "1.0.0" })
    );
    writeFileSync(join(root, "package-lock.json"), "{ not json");
    await assert.rejects(
      checkInstallScripts({ allowScripts: {}, root, lockOnly: true }),
      /could not load the dependency tree/
    );
  } finally {
    removeFixtureRoot(root);
  }
});

// ---------------------------------------------------------------------------
// On-disk checks (loadActual): binding.gyp, gypfile:false, prepare on a
// non-registry dependency, bundled and platform-inert deps.
// [codex-305-r3]
// ---------------------------------------------------------------------------

test("catches an implicit node-gyp install script from a binding.gyp on disk", async () => {
  const root = makeFixtureRoot();
  try {
    writeRootManifestOnly(root, {
      name: "fixture-root",
      version: "1.0.0",
      dependencies: { "native-gyp-dep": "1.0.0" },
    });
    const dir = writeInstalledPackage(root, "node_modules/native-gyp-dep", {
      name: "native-gyp-dep",
      version: "1.0.0",
    });
    writeFileSync(join(dir, "binding.gyp"), "{}");

    const result = await checkInstallScripts({ allowScripts: {}, root });
    assert.equal(result.ok, false);
    assert.deepEqual(result.uncovered, ["native-gyp-dep@1.0.0"]);
  } finally {
    removeFixtureRoot(root);
  }
});

test("[codex-305-r3] gypfile:false suppresses the implicit node-gyp script even with a binding.gyp on disk", async () => {
  const root = makeFixtureRoot();
  try {
    writeRootManifestOnly(root, {
      name: "fixture-root",
      version: "1.0.0",
      dependencies: { "opted-out-gyp-dep": "1.0.0" },
    });
    const dir = writeInstalledPackage(root, "node_modules/opted-out-gyp-dep", {
      name: "opted-out-gyp-dep",
      version: "1.0.0",
      gypfile: false,
    });
    writeFileSync(join(dir, "binding.gyp"), "{}");

    const result = await checkInstallScripts({ allowScripts: {}, root });
    assert.equal(
      result.ok,
      true,
      "gypfile:false must suppress the synthetic install script npm would skip too"
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("catches a prepare-only script on a non-registry (file) dependency", async () => {
  const root = makeFixtureRoot();
  try {
    writeInstalledPackage(root, "packages/prepare-only-dep", {
      name: "prepare-only-dep",
      version: "1.0.0",
      scripts: { prepare: "tsc" },
    });
    writeRootManifestOnly(root, {
      name: "fixture-root",
      version: "1.0.0",
      dependencies: { "prepare-only-dep": "file:packages/prepare-only-dep" },
    });
    mkdirSync(join(root, "node_modules"));
    const target = join(root, "packages/prepare-only-dep");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(target, join(root, "node_modules/prepare-only-dep"), "dir");

    const result = await checkInstallScripts({ allowScripts: {}, root });
    assert.equal(result.ok, false);
    assert.deepEqual(result.uncovered, ["file:../packages/prepare-only-dep"]);
  } finally {
    removeFixtureRoot(root);
  }
});

test("[codex-305-r4] an approved Darwin-only dependency absent from node_modules is not reported stale in actual mode", async () => {
  // Regression for the fourth adversarial review: stale-key matching used to
  // check the approved key against the same tree loadActual walks, so on a
  // Linux/Windows CI runner an approved macOS-only optional dependency (e.g.
  // fsevents) is never written to node_modules and its key wrongly looked
  // stale, failing every non-Darwin job. Stale-key matching must instead use
  // the lockfile's virtual tree, which records the dependency regardless of
  // which platform actually installed it.
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: { optionalDependencies: { fsevents: "2.3.3" } },
      packages: {
        "node_modules/fsevents": {
          version: "2.3.3",
          resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
          hasInstallScript: true,
          optional: true,
          os: ["darwin"],
        },
      },
    });
    // No node_modules/fsevents folder: on this (non-Darwin) runner, a real
    // `npm ci` never writes an optional dependency whose os field excludes
    // the current platform.
    mkdirSync(join(root, "node_modules"));

    const result = await checkInstallScripts({
      allowScripts: { "fsevents@2.3.3": true },
      root,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.staleKeys, []);
    assert.deepEqual(result.uncovered, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test("[codex-305-r3] a bundled dependency's install script is never flagged (bundled scripts never run and can't be allowlisted)", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: { dependencies: { "bundler-pkg": "1.0.0" } },
      packages: {
        "node_modules/bundler-pkg": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/bundler-pkg/-/bundler-pkg-1.0.0.tgz",
          bundleDependencies: ["bundled-native"],
        },
        "node_modules/bundler-pkg/node_modules/bundled-native": {
          version: "9.9.9",
          hasInstallScript: true,
          inBundle: true,
        },
      },
    });
    const result = await checkInstallScripts({ allowScripts: {}, root, lockOnly: true });
    assert.equal(result.ok, true, "a bundled dependency's script must never appear as uncovered");
  } finally {
    removeFixtureRoot(root);
  }
});

test("[codex-305-r3] a win32-only optional dependency is excluded on a non-Windows runner", async () => {
  // loadActual would never see this at all (a real `npm ci` on Linux/macOS
  // never writes a win32-only optional dependency's folder), so this
  // exercises the case that actually needs the checker's own platform check:
  // --lock-only, where the full cross-platform lockfile is visible.
  if (process.platform === "win32") return;
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {
      rootExtra: {
        dependencies: { "win32-only": "2.0.0" },
        optionalDependencies: { "win32-only": "2.0.0" },
      },
      packages: {
        "node_modules/win32-only": {
          version: "2.0.0",
          resolved: "https://registry.npmjs.org/win32-only/-/win32-only-2.0.0.tgz",
          hasInstallScript: true,
          optional: true,
          os: ["win32"],
        },
      },
    });
    const result = await checkInstallScripts({ allowScripts: {}, root, lockOnly: true });
    assert.equal(
      result.ok,
      true,
      "an optional dependency that can't install on this platform must not be flagged"
    );
  } finally {
    removeFixtureRoot(root);
  }
});

// ---------------------------------------------------------------------------
// node_modules / npm-shrinkwrap.json guards.
// ---------------------------------------------------------------------------

test("fails closed when node_modules is missing and --lock-only was not passed", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {});
    await assert.rejects(
      checkInstallScripts({ allowScripts: {}, root }),
      /node_modules is missing/
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("--lock-only skips the missing node_modules failure and the binding.gyp scan", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {});
    const result = await checkInstallScripts({ allowScripts: {}, root, lockOnly: true });
    assert.equal(result.ok, true);
  } finally {
    removeFixtureRoot(root);
  }
});

test("fails closed when npm-shrinkwrap.json is present at the repo root", async () => {
  const root = makeFixtureRoot();
  try {
    writeManifests(root, {});
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "npm-shrinkwrap.json"), "{}");
    await assert.rejects(checkInstallScripts({ allowScripts: {}, root }), /npm-shrinkwrap\.json/);
  } finally {
    removeFixtureRoot(root);
  }
});
