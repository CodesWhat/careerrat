import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, dbExists } from "../src/core/db/connection.mjs";
import { candidateConfigGet } from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const repo = join(import.meta.dirname, "..");
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-candidate-cli-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function runCli(args, { expectedStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    expectedStatus,
    `expected ${args.join(" ")} to exit ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

function jsonCli(args, options) {
  const result = runCli(args, options);
  return JSON.parse(result.stdout);
}

function dataCli(repoRoot, args) {
  return jsonCli(["src/cli/data.mjs", "--root", repoRoot, "--json", ...args]);
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

test("careerrat gate writes DB candidate config in DB mode and does not create candidate YAML", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["candidate", "init"]);

  const comp = jsonCli([
    "src/cli/gate.mjs",
    "--root",
    repoRoot,
    "--json",
    "comp-floor",
    "200000",
    "--write",
    "--confirm",
  ]);
  assert.equal(comp.written, true);

  const excluded = jsonCli([
    "src/cli/gate.mjs",
    "--root",
    repoRoot,
    "--json",
    "exclude-company",
    "BadCo",
    "--write",
    "--confirm",
  ]);
  assert.equal(excluded.written, true);

  const config = candidateConfigGet({ repoRoot });
  assert.equal(config.profile.compensation.minimum_base, 200000);
  assert.deepEqual(config.targeting.excluded_companies, ["BadCo"]);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/targeting.yml")), false);
});

test("careerrat automation writes DB candidate automation in DB mode and does not scaffold YAML", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["candidate", "init"]);

  jsonCli([
    "src/cli/automation.mjs",
    "--root",
    repoRoot,
    "--json",
    "enable",
    "mail_access",
    "--write",
  ]);
  jsonCli([
    "src/cli/automation.mjs",
    "--root",
    repoRoot,
    "--json",
    "enable",
    "mail_access",
    "gmail",
    "--write",
  ]);
  jsonCli(["src/cli/automation.mjs", "--root", repoRoot, "--json", "consent", "gmail", "--write"]);

  const config = candidateConfigGet({ repoRoot });
  assert.equal(config.automation.capabilities.mail_access.enabled, true);
  assert.equal(config.automation.capabilities.mail_access.platforms.gmail, true);
  assert.equal(config.automation.consent.gmail, true);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/automation.yml")), false);
});

test("careerrat ingest greenfield init/check use DB setup instead of candidate YAML", () => {
  const repoRoot = tempRepo();

  const init = jsonCli(["src/cli/ingest.mjs", "--root", repoRoot, "--json"]);
  assert.equal(init.mode, "db");
  assert.equal(init.ok, true);
  assert.equal(dbExists({ repoRoot }), true);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);

  const incomplete = jsonCli(["src/cli/ingest.mjs", "--root", repoRoot, "--check", "--json"], {
    expectedStatus: 1,
  });
  assert.equal(incomplete.mode, "db");
  assert.equal(incomplete.ok, false);

  dataCli(repoRoot, [
    "candidate",
    "patch",
    "profile",
    "--data",
    JSON.stringify({ candidate: { full_name: "SQLite Candidate", email: "sqlite@example.com" } }),
  ]);
  dataCli(repoRoot, [
    "candidate",
    "patch",
    "targeting",
    "--data",
    JSON.stringify({
      role_buckets: [{ name: "AI Platform", titles: ["AI Platform Engineer"] }],
    }),
  ]);

  const complete = jsonCli(["src/cli/ingest.mjs", "--root", repoRoot, "--check", "--json"]);
  assert.equal(complete.mode, "db");
  assert.equal(complete.ok, true);
});

test("careerrat ingest --write-config exports DB candidate setup to compatibility YAML", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["candidate", "init"]);
  dataCli(repoRoot, [
    "candidate",
    "patch",
    "profile",
    "--data",
    JSON.stringify({
      candidate: { full_name: "Export Candidate", email: "export@example.com" },
    }),
  ]);
  dataCli(repoRoot, [
    "candidate",
    "patch",
    "targeting",
    "--data",
    JSON.stringify({
      role_buckets: [{ name: "AI Platform", titles: ["AI Platform Engineer"] }],
      tracked_companies: ["OpenAI"],
    }),
  ]);
  dataCli(repoRoot, [
    "candidate",
    "limits",
    "upsert",
    "--data",
    JSON.stringify({
      company: "OpenAI",
      cap: { max: 4, window_days: 180 },
      status: "caution",
    }),
  ]);

  const result = jsonCli(["src/cli/ingest.mjs", "--root", repoRoot, "--write-config", "--json"]);

  assert.equal(result.mode, "db");
  assert.deepEqual(result.wrote, [
    ".careerrat/candidate/profile.yml",
    ".careerrat/candidate/targeting.yml",
    ".careerrat/candidate/evidence.yml",
    ".careerrat/candidate/honesty.yml",
    ".careerrat/candidate/form-defaults.yml",
    ".careerrat/candidate/modes.yml",
    ".careerrat/candidate/application-limits.yml",
    ".careerrat/config/search-sources.yml",
    ".careerrat/candidate/AGENTS.md",
  ]);
  assert.ok(result.wrote.includes(".careerrat/candidate/profile.yml"));
  assert.ok(result.wrote.includes(".careerrat/candidate/targeting.yml"));
  assert.ok(result.wrote.includes(".careerrat/candidate/application-limits.yml"));
  assert.ok(result.wrote.includes(".careerrat/candidate/evidence.yml"));
  assert.ok(result.wrote.includes(".careerrat/config/search-sources.yml"));
  assert.equal(result.wrote.includes(".careerrat/candidate/stories.yml"), false);
  assert.equal(result.wrote.includes(".careerrat/candidate/writing-style.md"), false);
  assert.ok(existsSync(userPath({ repoRoot }, "candidate/profile.yml")));
  assert.match(
    readFileSync(userPath({ repoRoot }, "candidate/profile.yml"), "utf8"),
    /Export Candidate/
  );
  assert.match(
    readFileSync(userPath({ repoRoot }, "candidate/application-limits.yml"), "utf8"),
    /OpenAI/
  );
});
