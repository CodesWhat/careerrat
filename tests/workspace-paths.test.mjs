import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  dataPath,
  dataRel,
  isPackageInstall,
  privateDataRoot,
  resolveUserPaths,
  strandedPackageDataDir,
  userPath,
} from "../src/core/paths/workspace.mjs";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "careerrat-paths-"));
}

// Builds a repoRoot at <base>/<...segments>/node_modules/careerrat, mirroring every
// real npm-install topology this fix has to detect: global (.../lib/node_modules/careerrat),
// local/project dependency (<project>/node_modules/careerrat), npx's cache
// (~/.npm/_npx/<hash>/node_modules/careerrat), and pnpm's virtual store, where Node
// resolves symlinks by default when computing import.meta.url, so a pnpm-linked
// package still resolves to its real path under .pnpm/careerrat@x.y.z/node_modules/careerrat
// (whose parent's basename is still "node_modules").
function tempInstalledPackageRoot(...segments) {
  const base = tempRepo();
  const dir = join(base, ...segments, "node_modules", "careerrat");
  mkdirSync(dir, { recursive: true });
  return { base, repoRoot: dir };
}

test("privateDataRoot defaults new installs to .careerrat", () => {
  const repoRoot = tempRepo();
  try {
    assert.equal(privateDataRoot({ repoRoot }), join(repoRoot, ".careerrat"));
    assert.equal(dataRel("candidate/profile.yml"), ".careerrat/candidate/profile.yml");
    assert.equal(
      dataPath({ repoRoot }, "workspace/tracker.json"),
      join(repoRoot, ".careerrat", "workspace", "tracker.json")
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("privateDataRoot honors CAREERRAT_HOME for portable/private instance data", () => {
  const repoRoot = tempRepo();
  const home = join(tempRepo(), "instance");
  try {
    const env = { CAREERRAT_HOME: home };
    assert.equal(privateDataRoot({ repoRoot, env }), home);
    assert.equal(
      dataPath({ repoRoot, env }, "candidate/profile.yml"),
      join(home, "candidate", "profile.yml")
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("privateDataRoot honors an injected env's home instead of the process's own", () => {
  // Every other read in the resolver goes through the injected env, so reading the
  // process home directly would silently ignore a caller that passed one.
  const installed = join("/x", "node_modules", "careerrat");
  assert.equal(
    privateDataRoot({ repoRoot: installed, env: { HOME: "/tmp/injected" } }),
    join("/tmp/injected", ".careerrat")
  );
  assert.equal(
    privateDataRoot({ repoRoot: installed, env: { USERPROFILE: "/tmp/winhome" } }),
    join("/tmp/winhome", ".careerrat")
  );
  // An env with neither still resolves, and CAREERRAT_HOME keeps beating both.
  assert.equal(privateDataRoot({ repoRoot: installed, env: {} }), join(homedir(), ".careerrat"));
  assert.equal(
    privateDataRoot({
      repoRoot: installed,
      env: { HOME: "/tmp/injected", CAREERRAT_HOME: "/tmp/explicit" },
    }),
    "/tmp/explicit"
  );
});

test("a legacy workspace holding only .snapshots still reads as legacy", () => {
  // The case that needs restore is a workspace whose tracker.json is gone or
  // corrupt, which drops every WORKSPACE_RUNTIME_FILES hit. If .snapshots didn't
  // count as payload, the probe would read that workspace as empty and repoint at
  // the new data root, so `careerrat restore` would find zero snapshots.
  const repoRoot = tempRepo();
  try {
    mkdirSync(join(repoRoot, "workspace", ".snapshots"), { recursive: true });
    writeFileSync(join(repoRoot, "workspace", ".snapshots", "tracker-2026-01-01.json"), "{}");
    const paths = resolveUserPaths({ repoRoot, env: {} });
    assert.equal(paths.workspaceDir, join(repoRoot, "workspace"));
    assert.equal(paths.usingLegacy, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveUserPaths prefers legacy repo-root data only when it already exists", () => {
  const repoRoot = tempRepo();
  try {
    mkdirSync(join(repoRoot, "candidate"), { recursive: true });
    mkdirSync(join(repoRoot, "workspace"), { recursive: true });
    mkdirSync(join(repoRoot, "config"), { recursive: true });
    mkdirSync(join(repoRoot, ".internal"), { recursive: true });
    writeFileSync(join(repoRoot, "workspace", "tracker.json"), "{}\n");
    writeFileSync(join(repoRoot, "config", "search-sources.yml"), "searches: []\n");

    const paths = resolveUserPaths({ repoRoot });
    assert.equal(paths.candidateDir, join(repoRoot, "candidate"));
    assert.equal(paths.workspaceDir, join(repoRoot, "workspace"));
    assert.equal(paths.generatedConfigDir, join(repoRoot, "config"));
    assert.equal(paths.internalDir, join(repoRoot, ".internal"));
    assert.equal(paths.usingLegacy, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveUserPaths uses .careerrat for new repos and creates no directories by resolving", () => {
  const repoRoot = tempRepo();
  try {
    mkdirSync(join(repoRoot, "workspace", "jobs"), { recursive: true });
    writeFileSync(join(repoRoot, "workspace", "jobs", ".gitkeep"), "");

    const paths = resolveUserPaths({ repoRoot });
    assert.equal(paths.candidateDir, join(repoRoot, ".careerrat", "candidate"));
    assert.equal(paths.workspaceDir, join(repoRoot, ".careerrat", "workspace"));
    assert.equal(paths.generatedConfigDir, join(repoRoot, ".careerrat", "config"));
    assert.equal(paths.internalDir, join(repoRoot, ".careerrat", "internal"));
    assert.equal(paths.usingLegacy, false);
    assert.equal(existsSync(join(repoRoot, ".careerrat")), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("userPath maps known private path prefixes and leaves product paths in repo", () => {
  const repoRoot = tempRepo();
  try {
    const ctx = { repoRoot };
    assert.equal(
      userPath(ctx, "candidate/evidence.yml"),
      join(repoRoot, ".careerrat", "candidate", "evidence.yml")
    );
    assert.equal(
      userPath(ctx, "workspace/jobs/acme.md"),
      join(repoRoot, ".careerrat", "workspace", "jobs", "acme.md")
    );
    assert.equal(
      userPath(ctx, "config/search-sources.yml"),
      join(repoRoot, ".careerrat", "config", "search-sources.yml")
    );
    assert.equal(
      userPath(ctx, ".internal/tracker-dev.pid"),
      join(repoRoot, ".careerrat", "internal", "tracker-dev.pid")
    );
    assert.equal(
      userPath(ctx, "templates/profile.example.yml"),
      join(repoRoot, "templates", "profile.example.yml")
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// --- npm-install anchor detection (the regression this hotfix closes) -------------

test("isPackageInstall is false for a git-checkout-shaped repoRoot", () => {
  const repoRoot = tempRepo();
  try {
    assert.equal(isPackageInstall(repoRoot), false);
    // A worktree checkout (how this very hotfix is developed) is not one level
    // under a literal node_modules directory either.
    const worktree = join(repoRoot, ".claude", "worktrees", "hotfix-0168");
    mkdirSync(worktree, { recursive: true });
    assert.equal(isPackageInstall(worktree), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("isPackageInstall is true for every real npm install topology", () => {
  const shapes = [
    ["lib"], // npm global: <prefix>/lib/node_modules/careerrat
    ["project"], // npm local/project dependency: <project>/node_modules/careerrat
    [".npm", "_npx", "abc123"], // npx cache
    ["node_modules", ".pnpm", "careerrat@1.0.0"], // pnpm virtual store (post symlink-resolution)
  ];
  for (const segments of shapes) {
    const { base, repoRoot } = tempInstalledPackageRoot(...segments);
    try {
      assert.equal(
        isPackageInstall(repoRoot),
        true,
        `expected install shape for ${segments.join("/")}`
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("privateDataRoot anchors an npm-installed repoRoot at ~/.careerrat, never inside the package dir, the bug this hotfix fixes", () => {
  const { base, repoRoot } = tempInstalledPackageRoot("lib");
  try {
    const dataRoot = privateDataRoot({ repoRoot });
    assert.equal(dataRoot, join(homedir(), ".careerrat"));
    assert.notEqual(dataRoot, join(repoRoot, ".careerrat"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("privateDataRoot anchors global and local/project npm installs at the SAME home root (one job search, not one per project)", () => {
  const global = tempInstalledPackageRoot("lib");
  const local = tempInstalledPackageRoot("some-project");
  try {
    assert.equal(
      privateDataRoot({ repoRoot: global.repoRoot }),
      privateDataRoot({ repoRoot: local.repoRoot })
    );
  } finally {
    rmSync(global.base, { recursive: true, force: true });
    rmSync(local.base, { recursive: true, force: true });
  }
});

test("privateDataRoot keeps a git checkout anchored at repoRoot/.careerrat (byte-for-byte unchanged, no regression)", () => {
  const repoRoot = tempRepo();
  try {
    assert.equal(privateDataRoot({ repoRoot }), join(repoRoot, ".careerrat"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("CAREERRAT_HOME (absolute) wins outright regardless of install shape", () => {
  const { base, repoRoot } = tempInstalledPackageRoot("lib");
  const home = join(tempRepo(), "instance");
  try {
    const env = { CAREERRAT_HOME: home };
    assert.equal(privateDataRoot({ repoRoot, env }), home);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("CAREERRAT_HOME (relative) still resolves against repoRoot, even for an installed repoRoot: unforced, no real caller sets it relatively", () => {
  const { base, repoRoot } = tempInstalledPackageRoot("lib");
  try {
    const env = { CAREERRAT_HOME: "instance-data" };
    assert.equal(privateDataRoot({ repoRoot, env }), join(repoRoot, "instance-data"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveUserPaths still probes legacy top-level candidate/workspace/config/.internal against repoRoot for an installed package (unchanged legacy machinery)", () => {
  const { base, repoRoot } = tempInstalledPackageRoot("lib");
  try {
    mkdirSync(join(repoRoot, "candidate"), { recursive: true });
    const paths = resolveUserPaths({ repoRoot });
    assert.equal(paths.candidateDir, join(repoRoot, "candidate"));
    assert.equal(paths.usingLegacy, true);
    // Everything NOT covered by the legacy probe still anchors at the new home root.
    assert.equal(paths.workspaceDir, join(homedir(), ".careerrat", "workspace"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- stranded package data (old broken default left data inside the package) ------

test("strandedPackageDataDir is null for a checkout, even one with a real .careerrat payload (that's the correct root there, not stranded)", () => {
  const repoRoot = tempRepo();
  try {
    mkdirSync(join(repoRoot, ".careerrat"), { recursive: true });
    writeFileSync(join(repoRoot, ".careerrat", "tracker.json"), "{}\n");
    assert.equal(strandedPackageDataDir({ repoRoot }), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("strandedPackageDataDir is null for a fresh npm install with no leftover package-dir data", () => {
  const { base, repoRoot } = tempInstalledPackageRoot("lib");
  try {
    assert.equal(strandedPackageDataDir({ repoRoot }), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("strandedPackageDataDir ignores a placeholder-only .careerrat/ (.gitkeep, .DS_Store) inside an install", () => {
  const { base, repoRoot } = tempInstalledPackageRoot("lib");
  try {
    const dir = join(repoRoot, ".careerrat");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gitkeep"), "");
    assert.equal(strandedPackageDataDir({ repoRoot }), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("strandedPackageDataDir flags a non-placeholder .careerrat/ left inside an npm-installed package dir", () => {
  const { base, repoRoot } = tempInstalledPackageRoot("lib");
  try {
    const dir = join(repoRoot, ".careerrat");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tracker.json"), "{}\n");
    assert.equal(strandedPackageDataDir({ repoRoot }), dir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
