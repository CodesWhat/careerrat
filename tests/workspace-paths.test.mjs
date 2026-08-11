import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  dataPath,
  dataRel,
  privateDataRoot,
  resolveUserPaths,
  userPath,
} from "../src/core/paths/workspace.mjs";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "careerrat-paths-"));
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

test("privateDataRoot still honors legacy ROLESTER_HOME when CAREERRAT_HOME is unset", () => {
  const repoRoot = tempRepo();
  const home = join(tempRepo(), "instance");
  try {
    const env = { ROLESTER_HOME: home };
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

test("CAREERRAT_HOME wins over legacy ROLESTER_HOME when both are set", () => {
  const repoRoot = tempRepo();
  const newHome = join(tempRepo(), "new-instance");
  const oldHome = join(tempRepo(), "old-instance");
  try {
    const env = { CAREERRAT_HOME: newHome, ROLESTER_HOME: oldHome };
    assert.equal(privateDataRoot({ repoRoot, env }), newHome);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(newHome, { recursive: true, force: true });
    rmSync(oldHome, { recursive: true, force: true });
  }
});

test("privateDataRoot keeps using a pre-existing .rolester dir when .careerrat doesn't exist yet", () => {
  const repoRoot = tempRepo();
  try {
    mkdirSync(join(repoRoot, ".rolester"), { recursive: true });
    assert.equal(privateDataRoot({ repoRoot }), join(repoRoot, ".rolester"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("privateDataRoot prefers .careerrat when both legacy .rolester and .careerrat exist", () => {
  const repoRoot = tempRepo();
  try {
    mkdirSync(join(repoRoot, ".rolester"), { recursive: true });
    mkdirSync(join(repoRoot, ".careerrat"), { recursive: true });
    assert.equal(privateDataRoot({ repoRoot }), join(repoRoot, ".careerrat"));
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
