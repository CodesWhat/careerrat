import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  findUserDataLeaks,
  refreshUpdateCacheInBackground,
} from "../src/core/update/update-core.mjs";

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("findUserDataLeaks catches candidate/workspace entries regardless of case", () => {
  // CareerRat ships on case-insensitive filesystems (APFS, NTFS), where
  // "Candidate/x" and "candidate/x" are the same real path. A case-sensitive
  // guard would let a differently-cased tarball entry extract straight over
  // the user's real candidate/ or workspace/ directory.
  const leaks = findUserDataLeaks([
    "Candidate/resume.json",
    "CANDIDATE/profile.yml",
    "candidate/evidence.json",
    "Workspace/tracker.json",
    "src/index.mjs",
  ]);
  assert.deepEqual(leaks, [
    "Candidate/resume.json",
    "CANDIDATE/profile.yml",
    "candidate/evidence.json",
    "Workspace/tracker.json",
  ]);
});

test("findUserDataLeaks catches a leaked .careerrat/ data root", () => {
  // Since the data root moved, candidate/, workspace/, config/, internal/ and the
  // sqlite db all nest under .careerrat/, so a tarball carrying any of them shows up
  // only under that one prefix and the two bare legacy prefixes would never see it.
  const leaks = findUserDataLeaks([
    ".careerrat/candidate/resume.json",
    ".careerrat/workspace/tracker.json",
    ".CareerRat/internal/ai.env",
    "./.careerrat/db/careerrat.sqlite",
    "careerrat-data/notes.md",
    "src/index.mjs",
  ]);
  assert.deepEqual(leaks, [
    ".careerrat/candidate/resume.json",
    ".careerrat/workspace/tracker.json",
    ".CareerRat/internal/ai.env",
    "./.careerrat/db/careerrat.sqlite",
  ]);
});

test("findUserDataLeaks catches legacy .internal/ and the generated config files", () => {
  // resolveUserPaths treats these as user-owned too, so an archive carrying them
  // would extract straight over live state. config/ is matched by exact filename,
  // not by prefix, because it also ships schemas and *.example.* that must pass.
  const leaks = findUserDataLeaks([
    ".internal/ai.env",
    "./.INTERNAL/tracker-dev.log",
    "config/search-sources.yml",
    "config/search-sources.json",
    "config/sourced-scan.json",
    "config/ai.json",
    "config/careerrat.schema.json",
    "config/search-sources.example.yml",
    "config/paste-intake-routes.json",
    "src/index.mjs",
  ]);
  assert.deepEqual(leaks, [
    ".internal/ai.env",
    "./.INTERNAL/tracker-dev.log",
    "config/search-sources.yml",
    "config/search-sources.json",
    "config/sourced-scan.json",
    "config/ai.json",
  ]);
});

test("findUserDataLeaks still exempts workspace/.gitkeep regardless of case", () => {
  const leaks = findUserDataLeaks([
    "workspace/.gitkeep",
    "Workspace/.GITKEEP",
    "WORKSPACE/.gitkeep",
  ]);
  assert.deepEqual(leaks, []);
});

test("findUserDataLeaks catches a leading ./ and backslash path-separator variants", () => {
  const leaks = findUserDataLeaks([
    "./candidate/resume.json",
    ".\\Candidate\\profile.yml",
    "candidate\\evidence.json",
    "./src/index.mjs",
  ]);
  assert.deepEqual(leaks, [
    "./candidate/resume.json",
    ".\\Candidate\\profile.yml",
    "candidate\\evidence.json",
  ]);
});

test("findUserDataLeaks does not false-positive on a lookalike directory name", () => {
  const leaks = findUserDataLeaks(["candidate-templates/blank.json", "workspaceship/readme.md"]);
  assert.deepEqual(leaks, []);
});

test("refreshUpdateCacheInBackground forces Electron's detached child into Node mode", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-update-core-"));
  const careerratHome = join(repoRoot, "careerrat-home");
  const resultPath = join(repoRoot, "electron-run-as-node.txt");

  try {
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    writeFileSync(
      join(repoRoot, "scripts/update-check.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(resultPath)}, String(process.env.ELECTRON_RUN_AS_NODE ?? ""));\n`
    );

    const pathCtx = {
      repoRoot,
      env: { ...process.env, CAREERRAT_HOME: careerratHome },
    };
    refreshUpdateCacheInBackground(pathCtx, repoRoot);

    await waitForFile(resultPath);
    assert.equal(readFileSync(resultPath, "utf8"), "1");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// The detached child writes into CAREERRAT_HOME on its own schedule, seconds
// after the parent process has already exited. That is correct for a real
// install: the cache lands in time for the user's next command. It is wrong for
// a test that points CAREERRAT_HOME at a tempdir and deletes it as soon as
// spawnSync returns, because the write can land mid-delete and throw ENOTEMPTY
// on a directory unrelated to whatever was being asserted.
//
// Measured before the opt-out existed: a `careerrat doctor` run against a fresh
// temp home had 0 files at exit and 1 file (internal/update-check.json) seven
// seconds later.
test("refreshUpdateCacheInBackground spawns nothing when CAREERRAT_NO_UPDATE_CHECK is set", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-update-optout-"));
  const resultPath = join(repoRoot, "child-ran.txt");

  try {
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    writeFileSync(
      join(repoRoot, "scripts/update-check.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(resultPath)}, "ran");\n`
    );

    const pathCtx = {
      repoRoot,
      env: {
        ...process.env,
        CAREERRAT_HOME: join(repoRoot, "careerrat-home"),
        CAREERRAT_NO_UPDATE_CHECK: "1",
      },
    };
    refreshUpdateCacheInBackground(pathCtx, repoRoot);

    // Give a child that should not exist ample time to prove otherwise. The
    // sibling test above shows the real child lands well inside this window.
    await waitForFile(resultPath, 2_000);
    assert.equal(
      existsSync(resultPath),
      false,
      "the detached update child should not have spawned"
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("refreshUpdateCacheInBackground still spawns when the opt-out is absent or empty", async () => {
  for (const optOut of [undefined, "", "   "]) {
    const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-update-onvalue-"));
    const resultPath = join(repoRoot, "child-ran.txt");

    try {
      mkdirSync(join(repoRoot, "scripts"), { recursive: true });
      writeFileSync(
        join(repoRoot, "scripts/update-check.mjs"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(resultPath)}, "ran");\n`
      );

      const env = { ...process.env, CAREERRAT_HOME: join(repoRoot, "careerrat-home") };
      if (optOut === undefined) delete env.CAREERRAT_NO_UPDATE_CHECK;
      else env.CAREERRAT_NO_UPDATE_CHECK = optOut;

      refreshUpdateCacheInBackground({ repoRoot, env }, repoRoot);

      await waitForFile(resultPath);
      assert.equal(
        existsSync(resultPath),
        true,
        `the update child must still run for opt-out value ${JSON.stringify(optOut)}`
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
});
