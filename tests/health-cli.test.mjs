// tests/health-cli.test.mjs — coverage for `careerrat health record`
// (src/cli/health.mjs), the CLI wrapper the company-health skill's STEP 5
// documents (SKILL.md): dry run by default, --write to commit through the
// shared companyHealthSet verb. Mirrors tests/companies-cli.test.mjs and
// tests/data-cli-batch3.test.mjs's execFileSync/spawnSync CLI-testing
// convention rather than importing the CLI module (it's a top-level script
// that reads process.argv and calls process.exit).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";

const repo = join(import.meta.dirname, "..");
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-health-cli-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function dataCli(repoRoot, args) {
  return JSON.parse(
    execFileSync(process.execPath, ["src/cli/data.mjs", "--root", repoRoot, "--json", ...args], {
      cwd: repo,
      encoding: "utf8",
    })
  );
}

// health.mjs exits 1 (not 0) on a refused/invalid payload, so a "refusal"
// case has to go through the catch branch — execFileSync throws on a
// non-zero exit, carrying the captured stdout/stderr on the error object.
function healthCli(repoRoot, args, { expectFailure = false } = {}) {
  try {
    const out = execFileSync(
      process.execPath,
      ["src/cli/health.mjs", "--root", repoRoot, "--json", ...args],
      { cwd: repo, encoding: "utf8" }
    );
    if (expectFailure)
      throw new Error(`expected ${args.join(" ")} to exit non-zero but it exited 0`);
    return { status: 0, json: JSON.parse(out) };
  } catch (err) {
    if (!expectFailure) throw err;
    return { status: err.status, json: JSON.parse(err.stdout) };
  }
}

function writePayload(repoRoot, name, payload) {
  const path = join(repoRoot, name);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A hospital-system fixture (domain-neutral, matches the repo convention).
const validPayload = {
  rating: "watch",
  forFunction: "clinical staffing",
  asOf: "2026-08-10",
  provenance: "built-from-data",
  dimensions: { layoffRisk: "elevated" },
  crossCut: ["stability"],
  fitDelta: -3,
  rationale: "A hiring freeze was announced for non-clinical roles at this hospital system.",
};

function seedApp(repoRoot) {
  dataCli(repoRoot, ["init"]);
  dataCli(repoRoot, [
    "app",
    "upsert",
    "--data",
    JSON.stringify({
      id: "app-riverside",
      company: "Riverside Health",
      role: "Registered Nurse",
      status: "reviewed-hold",
    }),
  ]);
}

test("careerrat health record is a dry run by default and previews the target row without writing", () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);
  const file = writePayload(repoRoot, "health.json", validPayload);

  const { json } = healthCli(repoRoot, ["record", "app-riverside", "--file", file]);
  assert.equal(json.ok, true);
  assert.equal(json.dryRun, true);
  assert.equal(json.id, "app-riverside");
  assert.equal(json.rating, "watch");
  assert.equal(json.forFunction, "clinical staffing");
  assert.equal(json.fitDelta, -3);
  assert.deepEqual(json.host, {
    table: "applications",
    company: "Riverside Health",
    role: "Registered Nurse",
  });

  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-riverside");
  assert.equal(JSON.parse(row.data).companyHealth, undefined, "a dry run must not write anything");
});

test("careerrat health record --write commits the rating through the shared companyHealthSet verb", () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);
  const file = writePayload(repoRoot, "health.json", validPayload);

  const { json } = healthCli(repoRoot, ["record", "app-riverside", "--file", file, "--write"]);
  assert.equal(json.ok, true);
  assert.equal(json.written, true);
  assert.equal(json.table, "applications");
  assert.equal(json.companyHealth.rating, "watch");
  assert.equal(json.companyHealth.fitDelta, -3);

  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-riverside");
  const stored = JSON.parse(row.data);
  assert.equal(stored.companyHealth.rating, "watch");
  assert.equal(stored.companyHealth.forFunction, "clinical staffing");
});

test("careerrat health record refuses an invalid payload before writing anything, even with --write", () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);
  const file = writePayload(repoRoot, "health.json", { ...validPayload, rating: "excellent" });

  const { status, json } = healthCli(
    repoRoot,
    ["record", "app-riverside", "--file", file, "--write"],
    { expectFailure: true }
  );
  assert.equal(status, 1);
  assert.equal(json.ok, false);
  assert.match(json.error, /rating/i);

  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-riverside");
  assert.equal(JSON.parse(row.data).companyHealth, undefined);
});

test("careerrat health record --write on a sourced role writes companyHealth onto the sourced row", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["init"]);
  dataCli(repoRoot, [
    "sourced",
    "upsert-batch",
    "--data",
    JSON.stringify([
      {
        id: "sourced-riverside",
        company: "Riverside Health",
        role: "Registered Nurse",
        status: "sourced",
      },
    ]),
  ]);
  const file = writePayload(repoRoot, "health.json", validPayload);

  const { json } = healthCli(repoRoot, ["record", "sourced-riverside", "--file", file, "--write"]);
  assert.equal(json.ok, true);
  assert.equal(json.table, "sourced");

  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM sourced WHERE id = ?").get("sourced-riverside");
  assert.equal(JSON.parse(row.data).companyHealth.rating, "watch");
});
