import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateApplicationLimitUpsert,
  candidateConfigPatch,
  candidateSetupInitialize,
} from "../src/core/db/verbs.mjs";
import {
  candidateConfigSource,
  loadCandidateConfig,
  loadCandidateDoc,
} from "../src/core/profile/config-store.mjs";
import { stringifyYaml } from "../src/core/profile/yaml.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-config-store-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("loadCandidateDoc reads legacy YAML when no SQLite database exists", () => {
  const repoRoot = tempRepo();
  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  writeFileSync(
    join(repoRoot, "candidate/profile.yml"),
    `${stringifyYaml({
      candidate: { full_name: "Legacy Person", email: "legacy@example.com" },
    })}\n`
  );

  assert.equal(candidateConfigSource({ repoRoot }), "legacy");
  const profile = loadCandidateDoc("profile", { repoRoot });
  assert.equal(profile.candidate.full_name, "Legacy Person");
});

test("loadCandidateConfig prefers SQLite over stale legacy YAML in DB mode", () => {
  const repoRoot = tempRepo();
  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  writeFileSync(
    join(repoRoot, "candidate/profile.yml"),
    `${stringifyYaml({
      candidate: { full_name: "Stale YAML", email: "stale@example.com" },
    })}\n`
  );

  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { candidate: { full_name: "SQLite Person", email: "db@example.com" } },
  });

  const config = loadCandidateConfig({ repoRoot });
  assert.equal(config.mode, "db");
  assert.equal(config.profile.candidate.full_name, "SQLite Person");
  assert.equal(loadCandidateDoc("profile", { repoRoot }).candidate.email, "db@example.com");
});

test("loadCandidateDoc reads DB application limits instead of stale compatibility YAML", () => {
  const repoRoot = tempRepo();
  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  writeFileSync(
    join(repoRoot, "candidate/application-limits.yml"),
    `${stringifyYaml({
      companies: [{ company: "Stale YAML", scope: "all-roles", status: "blocked" }],
    })}\n`
  );

  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  candidateApplicationLimitUpsert({
    repoRoot,
    row: { company: "SQLite Limits", cap: { max: 2, window_days: 60 }, status: "caution" },
  });

  const limits = loadCandidateDoc("application-limits", { repoRoot });
  assert.equal(limits.companies.length, 1);
  assert.equal(limits.companies[0].company, "SQLite Limits");
  assert.deepEqual(limits.companies[0].cap, { max: 2, window_days: 60 });
});
