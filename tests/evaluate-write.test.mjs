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

function workspace({ db = true, jd = GOOD_JD, apps } = {}) {
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
        applications: apps || [
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

function jd({ company = "Acme", role = "Staff Engineer", extra = "" } = {}) {
  return GOOD_JD.replace("company: Acme", `company: ${company}`).replace(
    "role: Staff Engineer",
    `role: ${role}\n${extra}`.trimEnd()
  );
}

const CAREERS = "https://acme.example/careers";
const STAFF = { id: "app-staff", company: "Acme", role: "Staff Engineer", status: "reviewed-hold" };
const ACCOUNTANT = {
  id: "app-acct",
  company: "Acme",
  role: "Accountant",
  status: "reviewed-hold",
};

function assertRefused(dir, result, pattern, ids = ["app-staff", "app-acct"]) {
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, pattern);
  for (const id of ids) assert.equal(appRow(dir, id).evaluation, undefined);
}

test("a shared careers URL does not land a Staff Engineer verdict on the Accountant", () => {
  const dir = workspace({
    apps: [{ ...ACCOUNTANT, link: CAREERS }],
    jd: jd({ extra: `source: ${CAREERS}` }),
  });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assertRefused(dir, result, /only other roles at that company.*app-acct.*--app/s, ["app-acct"]);
});

test("a frontmatter id pointing at a different role or company is refused", () => {
  const apps = [STAFF, ACCOUNTANT, { id: "app-glx", company: "Globex", role: "Staff Engineer" }];
  const role = workspace({ apps, jd: jd({ extra: "appId: app-acct" }) });
  assertRefused(
    role,
    run(role, ["workspace/jobs/acme.md", "--write"]),
    /says it belongs to app-acct.*--app <id>/s,
    ["app-acct"]
  );
  const company = workspace({ apps, jd: jd({ extra: "applicationId: app-glx" }) });
  assertRefused(
    company,
    run(company, ["workspace/jobs/acme.md", "--write"]),
    /says it belongs to app-glx/,
    ["app-glx"]
  );
});

test("a frontmatter id that agrees with the posting still saves", () => {
  const dir = workspace({ apps: [STAFF, ACCOUNTANT], jd: jd({ extra: "appId: app-staff" }) });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.match(result.stdout, /Saved on app-staff/);
  assert.equal(appRow(dir, "app-acct").evaluation, undefined);
});

test("two matching applications are refused as ambiguous with both ids listed", () => {
  const dir = workspace({
    apps: [STAFF, { ...STAFF, id: "app-staff-2", status: "applied" }],
  });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assertRefused(dir, result, /more than one application \(app-staff, app-staff-2\)/, [
    "app-staff",
    "app-staff-2",
  ]);
});

test("a specific posting URL outranks a different company+role match", () => {
  const url = "https://acme.example/careers/accountant-123";
  const dir = workspace({
    apps: [STAFF, { ...ACCOUNTANT, link: url }],
    jd: jd({ extra: `source: ${url}` }),
  });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.match(result.stdout, /Saved on app-acct/);
  assert.equal(appRow(dir, "app-staff").evaluation, undefined);
});

test("a specific posting URL writes to the matching application", () => {
  const url = "https://acme.example/careers/accountant-123?utm_source=x";
  const dir = workspace({
    apps: [STAFF, { ...ACCOUNTANT, link: "https://acme.example/careers/accountant-123" }],
    jd: jd({ role: "Controller", extra: `source: ${url}` }),
  });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.match(result.stdout, /Saved on app-acct/);
  assert.equal(appRow(dir, "app-staff").evaluation, undefined);
});

test("a company+role match writes to the right application", () => {
  const dir = workspace({ apps: [ACCOUNTANT, STAFF] });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.match(result.stdout, /Saved on app-staff/);
  assert.equal(appRow(dir, "app-acct").evaluation, undefined);
});

test("--app with a different company is refused, a different role is allowed", () => {
  const dir = workspace({ apps: [STAFF, { id: "app-glx", company: "Globex", role: "Analyst" }] });
  const wrong = run(dir, ["workspace/jobs/acme.md", "--write", "--app", "app-glx"]);
  assertRefused(dir, wrong, /different company/, ["app-glx"]);
  const roleOnly = workspace({ apps: [ACCOUNTANT] });
  const ok = run(roleOnly, ["workspace/jobs/acme.md", "--write", "--app", "app-acct"]);
  assert.match(ok.stdout, /Saved on app-acct/);
});

function seedSourced(dir, row) {
  const db = openDb({ repoRoot: repo, env: envFor(dir) });
  db.prepare("INSERT INTO sourced (id, data) VALUES (?, ?)").run(row.id, JSON.stringify(row));
}

test("an exact sourced URL refuses even when a same-title application exists", () => {
  const url = "https://acme.example/jobs/222";
  const dir = workspace({
    apps: [{ ...STAFF, link: "https://acme.example/jobs/111" }],
    jd: jd({ extra: `source: ${url}` }),
  });
  seedSourced(dir, { id: "src-222", company: "Acme", role: "Staff Engineer", link: url });
  assertRefused(dir, run(dir, ["workspace/jobs/acme.md", "--write"]), /only a sourced lead/, [
    "app-staff",
  ]);
});

test("a stale frontmatter id cannot override an exact sourced URL", () => {
  for (const key of ["appId", "applicationId"]) {
    const oldUrl = "https://acme.example/opening/old";
    const newUrl = "https://acme.example/opening/new";
    const dir = workspace({
      apps: [{ ...STAFF, id: "app-old", link: oldUrl }],
      jd: jd({ extra: `source: ${newUrl}\n${key}: app-old` }),
    });
    seedSourced(dir, { id: "src-new", company: "Acme", role: "Staff Engineer", link: newUrl });
    assertRefused(dir, run(dir, ["workspace/jobs/acme.md", "--write"]), /only a sourced lead/, [
      "app-old",
    ]);
    assert.equal(appRow(dir, "app-old").status, "reviewed-hold");
  }
});

test("an exact application URL that disagrees with the frontmatter id is refused naming both", () => {
  const url = "https://acme.example/opening/new";
  const dir = workspace({
    apps: [
      { ...STAFF, id: "app-old", link: "https://acme.example/opening/old" },
      { ...STAFF, id: "app-new", link: url },
    ],
    jd: jd({ extra: `source: ${url}\nappId: app-old` }),
  });
  assertRefused(
    dir,
    run(dir, ["workspace/jobs/acme.md", "--write"]),
    /says it belongs to app-old.*app-new.*--app <id>/s,
    ["app-old", "app-new"]
  );
});

test("a frontmatter id that agrees with the exact posting URL saves", () => {
  const url = "https://acme.example/opening/new";
  const dir = workspace({
    apps: [
      { ...STAFF, id: "app-old", link: "https://acme.example/opening/old" },
      { ...STAFF, id: "app-new", link: url },
    ],
    jd: jd({ extra: `source: ${url}\nappId: app-new` }),
  });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.match(result.stdout, /Saved on app-new/);
  assert.equal(appRow(dir, "app-old").evaluation, undefined);
});

test("--app still overrides a stale frontmatter id and an exact sourced URL", () => {
  const newUrl = "https://acme.example/opening/new";
  const dir = workspace({
    apps: [{ ...STAFF, id: "app-old", link: "https://acme.example/opening/old" }],
    jd: jd({ extra: `source: ${newUrl}\nappId: app-gone` }),
  });
  seedSourced(dir, { id: "src-new", company: "Acme", role: "Staff Engineer", link: newUrl });
  const result = run(dir, ["workspace/jobs/acme.md", "--write", "--app", "app-old"]);
  assert.match(result.stdout, /Saved on app-old/);
});

test("Engineering Manager does not match the only Marketing Manager application", () => {
  const dir = workspace({
    apps: [{ id: "app-mm", company: "Acme", role: "Marketing Manager" }],
    jd: jd({ role: "Engineering Manager" }),
  });
  assertRefused(dir, run(dir, ["workspace/jobs/acme.md", "--write"]), /only other roles/, [
    "app-mm",
  ]);
});

test("an exact title wins over a longer similar title", () => {
  const dir = workspace({
    apps: [
      { id: "app-se", company: "Acme", role: "Software Engineer" },
      { id: "app-sem", company: "Acme", role: "Software Engineering Manager" },
    ],
    jd: jd({ role: "Software Engineer" }),
  });
  const result = run(dir, ["workspace/jobs/acme.md", "--write"]);
  assert.match(result.stdout, /Saved on app-se\b/);
  assert.equal(appRow(dir, "app-sem").evaluation, undefined);
});

test("a seniority prefix still matches the base title", () => {
  const dir = workspace({
    apps: [{ id: "app-be", company: "Acme", role: "Backend Engineer" }],
    jd: jd({ role: "Senior Backend Engineer" }),
  });
  assert.match(run(dir, ["workspace/jobs/acme.md", "--write"]).stdout, /Saved on app-be/);
});

test("Registered Nurse does not fuzzy-match Nurse Manager", () => {
  const dir = workspace({
    apps: [{ id: "app-nm", company: "Acme", role: "Nurse Manager" }],
    jd: jd({ role: "Registered Nurse" }),
  });
  assertRefused(dir, run(dir, ["workspace/jobs/acme.md", "--write"]), /only other roles/, [
    "app-nm",
  ]);
});

test("ATS board roots are not specific postings, posting URLs are", async () => {
  const { isSpecificPostingUrl } = await import("../src/core/evaluate/persist.mjs");
  for (const root of [
    "https://jobs.lever.co/acme",
    "https://boards.greenhouse.io/acme",
    "https://jobs.ashbyhq.com/acme",
    "https://apply.workable.com/acme",
    "https://apply.workable.com/acme/",
    "https://acme.workable.com/",
    "https://acme.workable.com",
    "https://acme.wd1.myworkdayjobs.com/External",
    "https://acme.wd1.myworkdayjobs.com/en-US/External",
  ]) {
    assert.equal(isSpecificPostingUrl(root), false, root);
  }
  for (const posting of [
    "https://jobs.lever.co/acme/5a1b2c3d-0000-4000-8000-123456789abc",
    "https://boards.greenhouse.io/acme/jobs/4567",
    "https://jobs.ashbyhq.com/acme/5a1b2c3d-0000-4000-8000-123456789abc",
    "https://apply.workable.com/acme/j/ABC123DEF4",
    "https://acme.workable.com/j/ABC123",
    "https://acme.wd1.myworkdayjobs.com/External/job/Remote/Engineer_R-1",
    "https://acme.example/careers?gh_jid=123",
  ]) {
    assert.equal(isSpecificPostingUrl(posting), true, posting);
  }
});
