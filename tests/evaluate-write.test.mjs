// `careerrat evaluate <job> --write` saves the verdict that run produced through
// appPersistEvaluation, so coach-gaps and review approval can run from the
// terminal. The CLI gate is deterministic, so there is no AI to stub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildCoachingPlan } from "../src/core/coaching/plan.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";

const repo = join(import.meta.dirname, "..");
const homes = [];
after(() => {
  closeAll();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const GOOD_JD = `---
company: Acme
role: Staff Engineer
---

# Job Description

We are hiring a Staff Engineer to own our platform. You will lead design reviews,
mentor engineers and ship services in production. Compensation is not listed.
`;

const SHORT_JD = "---\ncompany: Acme\nrole: Staff Engineer\n---\n\n# Job Description\n\nHi.\n";

function envFor(dir) {
  return { ...process.env, CAREERRAT_HOME: dir, CAREERRAT_NO_UPDATE_CHECK: "1" };
}

function workspace({ db = true, jd = GOOD_JD } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-eval-write-"));
  homes.push(dir);
  mkdirSync(join(dir, "workspace/jobs"), { recursive: true });
  writeFileSync(join(dir, "workspace/jobs/acme.md"), jd);
  if (db) {
    const sourceDir = join(dir, "seed");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "tracker.json"),
      JSON.stringify({
        meta: {},
        applications: [
          { id: "app-acme", company: "Acme", role: "Staff Engineer", status: "reviewed-hold" },
        ],
        sourced: [{ id: "src-globex", company: "Globex", role: "Analyst" }],
        sources: [],
        communications: [],
      })
    );
    const env = envFor(dir);
    importFromTracker({ repoRoot: repo, env, sourceDir });
    candidateConfigPatch({
      repoRoot: repo,
      env,
      name: "profile",
      patch: { compensation: { minimum_base: 150000, currency: "USD" } },
      recordActivity: false,
    });
    candidateConfigPatch({
      repoRoot: repo,
      env,
      name: "targeting",
      patch: { keep_signals: ["platform"], cut_signals: [], excluded_companies: [] },
      recordActivity: false,
    });
  }
  return dir;
}

function run(dir, args) {
  return spawnSync(process.execPath, ["src/cli/evaluate.mjs", ...args], {
    cwd: repo,
    env: envFor(dir),
    encoding: "utf8",
  });
}

function appRow(dir, id = "app-acme") {
  const db = openDb({ repoRoot: repo, env: envFor(dir) });
  return JSON.parse(db.prepare("SELECT data FROM applications WHERE id = ?").get(id).data);
}

test("--write saves a typed review verdict that the coach-gaps precondition reads", async () => {
  const dir = workspace();
  const coach = () =>
    buildCoachingPlan({ repoRoot: repo, env: envFor(dir), applicationId: "app-acme" });
  const before = await coach();
  assert.equal(before.status, 409, "no verdict yet, so coaching must not apply");
  assert.equal(before.body.code, "COACHING_NOT_APPLICABLE");

  const result = run(dir, ["workspace/jobs/acme.md", "--write", "--json"]);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(
    { saved: out.saved.saved, id: out.saved.id, gate: out.saved.gate },
    { saved: true, id: "app-acme", gate: "review" }
  );

  const app = appRow(dir);
  // The coach-gaps trigger: evaluation.gate === "review" with non-empty fitRisks.
  assert.equal(app.evaluation.gate, "review");
  assert.ok(Array.isArray(app.evaluation.fitRisks) && app.evaluation.fitRisks.length > 0);
  assert.ok(app.evaluation.evaluatedAt);
  assert.equal(app.evaluation.applicationId, "app-acme");
  assert.equal(app.gate, "review");
  assert.equal(app.fitBasis, "evaluated");

  const after = await coach();
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.deepEqual(
    after.body.data.gaps.map((g) => g.gapText),
    app.evaluation.fitRisks
  );
});

test("--write names the job id and gate in the human output", () => {
  const dir = workspace();
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.match(result.stdout, /Saved on app-acme \(gate: review\)\./);
});

test("--write --app saves on an explicit application id", () => {
  const dir = workspace();
  const result = run(dir, ["workspace/jobs/acme.md", "--write", "--app", "app-acme"]);
  assert.match(result.stdout, /Saved on app-acme/);
  const missing = run(dir, ["workspace/jobs/acme.md", "--write", "--app", "nope"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No application with id "nope"/);
});

test("a legacy workspace refuses --write with a plain message and saves nothing", () => {
  const dir = workspace({ db: false });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--write needs a database workspace/);
  assert.match(result.stderr, /nothing was saved/);
});

test("a job with no readable text is not saved as a verdict", () => {
  const dir = workspace({ jd: SHORT_JD });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Not saved/);
  assert.equal(appRow(dir).evaluation, undefined);
  assert.equal(appRow(dir).gate, undefined);
});

test("a job that is only a sourced lead is not saved", () => {
  const dir = workspace({
    jd: GOOD_JD.replace("Acme", "Globex").replace("Staff Engineer", "Analyst"),
  });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only a sourced lead/);
});

test("without --write nothing is written", () => {
  const dir = workspace();
  const result = run(dir, ["workspace/jobs/acme.md"]);
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stdout, /Saved on/);
  assert.equal(appRow(dir).evaluation, undefined);
});

test("a misspelled flag is rejected instead of silently skipping the save", () => {
  const dir = workspace();
  const result = run(dir, ["workspace/jobs/acme.md", "--wrtie"]);
  assert.equal(result.status, 64, "must not collide with the review exit code 2");
  assert.match(result.stderr, /unknown option --wrtie/);
});
