import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { sourceConfigGet } from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const repo = join(import.meta.dirname, "..");
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-companies-cli-"));
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
  return JSON.parse(
    execFileSync(process.execPath, ["src/cli/data.mjs", "--root", repoRoot, "--json", ...args], {
      cwd: repo,
      encoding: "utf8",
    })
  );
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("careerrat companies writes DB source config in DB mode and does not create sourced-scan.json", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["candidate", "init"]);

  const add = jsonCli([
    "src/cli/companies.mjs",
    "--root",
    repoRoot,
    "--json",
    "--add",
    "Acme",
    "--url",
    "https://jobs.lever.co/acme",
    "--write",
  ]);
  assert.equal(add.status, "added");
  assert.equal(add.total, 1);

  const list = jsonCli(["src/cli/companies.mjs", "--root", repoRoot, "--json"]);
  assert.equal(list.total, 1);
  assert.equal(list.companies[0].name, "Acme");
  assert.equal(list.companies[0].provider, "lever");
  assert.equal(list.companies[0].enabled, true);
  assert.equal(list.companies[0].lastRunAt, null);

  const stored = sourceConfigGet({ repoRoot, name: "sourced-scan" });
  assert.deepEqual(stored.data.tracked_companies, [
    { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
  ]);
  assert.equal(existsSync(userPath({ repoRoot }, "config/sourced-scan.json")), false);
});

test("careerrat companies accepts an explicit supported provider for a branded ATS host", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["candidate", "init"]);

  const add = jsonCli([
    "src/cli/companies.mjs",
    "--root",
    repoRoot,
    "--json",
    "--add",
    "Example",
    "--url",
    "https://jobs.example.com/search",
    "--provider",
    "phenom",
    "--write",
  ]);
  assert.equal(add.status, "added");
  assert.equal(add.provider, "phenom");
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, [
    {
      name: "Example",
      careers_url: "https://jobs.example.com/search",
      provider: "phenom",
    },
  ]);
});

test("careerrat companies rejects local-parser as a network source", () => {
  const repoRoot = tempRepo();
  const result = runCli(
    [
      "src/cli/companies.mjs",
      "--root",
      repoRoot,
      "--add",
      "Unsafe",
      "--url",
      "https://jobs.example.com",
      "--provider",
      "local-parser",
      "--write",
    ],
    { expectedStatus: 2 }
  );
  assert.match(result.stderr, /Unsupported provider/i);
});
