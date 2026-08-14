import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-data-cli-candidate-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function dataCli(repoRoot, args) {
  const out = execFileSync(
    process.execPath,
    ["src/cli/data.mjs", "--root", repoRoot, "--json", ...args],
    {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    }
  );
  return JSON.parse(out);
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

test("careerrat data candidate init/get/patch/evidence use SQLite without writing candidate YAML", () => {
  const repoRoot = tempRepo();

  const init = dataCli(repoRoot, ["candidate", "init"]);
  assert.equal(init.ok, true);

  dataCli(repoRoot, [
    "candidate",
    "patch",
    "profile",
    "--data",
    JSON.stringify({ candidate: { full_name: "Ida Rhodes", email: "ida@example.com" } }),
  ]);
  dataCli(repoRoot, [
    "candidate",
    "patch",
    "targeting",
    "--data",
    JSON.stringify({
      role_buckets: [{ name: "AI Systems", titles: ["AI Systems Engineer"] }],
      tracked_companies: ["OpenAI", "Anthropic"],
    }),
  ]);
  dataCli(repoRoot, [
    "candidate",
    "evidence",
    "--data",
    JSON.stringify([{ claim: "Built a scheduling engine", evidence: "Resume" }]),
  ]);

  const read = dataCli(repoRoot, ["candidate", "get"]);
  assert.equal(read.profile.candidate.full_name, "Ida Rhodes");
  assert.equal(read.targeting.role_buckets[0].priority, "primary");
  assert.deepEqual(read.targeting.tracked_companies, ["OpenAI", "Anthropic"]);
  assert.equal(read.evidence.claims[0].id, "seed-001");
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
});

test("careerrat data candidate limits upsert writes application limits in SQLite", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["candidate", "init"]);

  const upsert = dataCli(repoRoot, [
    "candidate",
    "limits",
    "upsert",
    "--data",
    JSON.stringify({
      company: "OpenAI",
      scope: "all-roles",
      cap: { max: 4, window_days: 180 },
      status: "caution",
    }),
  ]);
  assert.equal(upsert.ok, true);

  const read = dataCli(repoRoot, ["candidate", "get"]);
  assert.equal(read["application-limits"].companies.length, 1);
  assert.equal(read["application-limits"].companies[0].company, "OpenAI");
  assert.deepEqual(read["application-limits"].companies[0].cap, {
    max: 4,
    window_days: 180,
  });
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/application-limits.yml")), false);
});
