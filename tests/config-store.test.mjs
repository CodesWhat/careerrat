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
  loadAgentCandidateConfig,
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
      location: { home: "London, UK", remote: true },
    })}\n`
  );

  assert.equal(candidateConfigSource({ repoRoot }), "legacy");
  const profile = loadCandidateDoc("profile", { repoRoot });
  assert.equal(profile.candidate.full_name, "Legacy Person");
  assert.equal(profile.location.remote_scope, "home-country");
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
    patch: {
      candidate: { full_name: "SQLite Person", email: "db@example.com" },
    },
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
    row: {
      company: "SQLite Limits",
      cap: { max: 2, window_days: 60 },
      status: "caution",
    },
  });

  const limits = loadCandidateDoc("application-limits", { repoRoot });
  assert.equal(limits.companies.length, 1);
  assert.equal(limits.companies[0].company, "SQLite Limits");
  assert.deepEqual(limits.companies[0].cap, { max: 2, window_days: 60 });
});

test("loadAgentCandidateConfig strips voluntary self-identification from legacy YAML", () => {
  const repoRoot = tempRepo();
  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  writeFileSync(
    join(repoRoot, "candidate/form-defaults.yml"),
    `${stringifyYaml({
      expected_base: 180000,
      screening_answers: { "travel up to 10": "Yes" },
      voluntary_self_identification: {
        enabled: true,
        default_action: "decline_when_available",
        confirmed_at: "2026-08-26T12:00:00Z",
        answers: {
          "race ethnicity": {
            value: "private legacy answer",
            confirmed_at: "2026-08-26T12:00:00Z",
          },
        },
      },
    })}\n`
  );

  const config = loadAgentCandidateConfig({ repoRoot });
  assert.equal(config.mode, "legacy");
  assert.equal(config["form-defaults"].expected_base, 180000);
  assert.equal(config["form-defaults"].screening_answers["travel up to 10"], "Yes");
  assert.equal(Object.hasOwn(config["form-defaults"], "voluntary_self_identification"), false);
  assert.doesNotMatch(JSON.stringify(config), /private legacy answer/);
});

test("loadAgentCandidateConfig strips voluntary self-identification from DB config", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  candidateConfigPatch({
    repoRoot,
    name: "form-defaults",
    patch: {
      expected_base: 190000,
      screening_answers: { "travel up to 10": "No" },
      voluntary_self_identification: {
        enabled: true,
        default_action: "leave_blank",
        confirmed_at: "2026-08-26T12:00:00Z",
        answers: {
          "race ethnicity": {
            value: "private database answer",
            confirmed_at: "2026-08-26T12:00:00Z",
          },
        },
      },
    },
  });

  const config = loadAgentCandidateConfig({ repoRoot });
  assert.equal(config.mode, "db");
  assert.equal(config["form-defaults"].expected_base, 190000);
  assert.equal(config["form-defaults"].screening_answers["travel up to 10"], "No");
  assert.equal(Object.hasOwn(config["form-defaults"], "voluntary_self_identification"), false);
  assert.doesNotMatch(JSON.stringify(config), /private database answer/);
});
