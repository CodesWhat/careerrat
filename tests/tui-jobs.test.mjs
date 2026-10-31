import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { sourcedPromote } from "../src/core/db/verbs/sourced.mjs";
import { readJobs, viewJobs } from "../src/core/tui/jobs.mjs";

function fixture(t, tracker, db = false) {
  const root = mkdtempSync(join(tmpdir(), "careerrat-tui-jobs-"));
  const env = { CAREERRAT_HOME: join(root, "person") };
  const workspace = join(env.CAREERRAT_HOME, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "tracker.json"), JSON.stringify(tracker));
  if (db) importFromTracker({ repoRoot: root, env, sourceDir: workspace });
  t.after(() => {
    closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { repoRoot: root, env, workspace };
}

const pay = (minBase, maxBase, more = {}) => ({
  compensation: {
    minBase,
    maxBase,
    currency: "USD",
    basis: "base",
    source: "job-description",
    ...more,
  },
});
const row = (id, evaluation, more = {}) => ({
  id,
  company: id,
  role: "Engineer",
  status: "sourced",
  evaluation,
  ...more,
});

test("legacy browsing preserves complete job records and doesn't create a database", (t) => {
  const app = row("a", pay(190000, 220000), {
    status: "technical interview",
    artifacts: { jd: "workspace/jobs/a.md" },
    conversations: [{ notes: "Prior round" }],
  });
  const ctx = fixture(t, { applications: [app], sourced: [row("b", null)] });
  const before = readFileSync(join(ctx.workspace, "tracker.json"));
  const result = readJobs(ctx);
  assert.equal(result.mode, "legacy");
  assert.deepEqual(result.jobs.find((job) => job.id === "a").record, app);
  assert.equal(result.jobs.find((job) => job.id === "a").stage.id, "interview");
  assert.equal(result.jobs.find((job) => job.id === "b").stage.id, "sourced");
  assert.deepEqual(readFileSync(join(ctx.workspace, "tracker.json")), before);
  assert.equal(existsSync(join(ctx.env.CAREERRAT_HOME, "db")), false);
});

test("database browsing reads canonical rows even when compatibility export is stale", (t) => {
  const ctx = fixture(
    t,
    { meta: { version: 7 }, applications: [row("canonical", pay(1, 2))], sourced: [] },
    true
  );
  writeFileSync(join(ctx.workspace, "tracker.json"), '{"applications":[]}');
  const before = readFileSync(join(ctx.env.CAREERRAT_HOME, "db/careerrat.db"));
  const result = readJobs(ctx);
  assert.equal(result.mode, "database");
  assert.equal(result.jobs[0].id, "canonical");
  assert.equal(result.version, 7);
  assert.deepEqual(readFileSync(join(ctx.env.CAREERRAT_HOME, "db/careerrat.db")), before);
  assert.equal(readFileSync(join(ctx.workspace, "tracker.json"), "utf8"), '{"applications":[]}');
});

test("a promoted sourced job remains one row with the same selection identity", (t) => {
  const ctx = fixture(t, { applications: [], sourced: [row("stable", pay(100, 120))] }, true);
  const first = readJobs(ctx);
  sourcedPromote({ ...ctx, id: "stable" });
  const next = viewJobs(readJobs(ctx), { selectedId: first.jobs[0].id });
  assert.equal(next.jobs.length, 1);
  assert.equal(next.selectedId, "stable");
  assert.equal(next.jobs[0].kind, "application");
});

test("pay ordering keeps estimates, unknown and other currencies after comparable advertised pay", (t) => {
  const ctx = fixture(t, {
    applications: [],
    sourced: [
      row("low", pay(150, 170)),
      row("unknown", null),
      row("market", pay(999, 1000, { source: "market" })),
      row("cad", pay(500, 600, { currency: "CAD" })),
      row("high", pay(200, 250)),
    ],
  });
  const data = readJobs(ctx);
  assert.deepEqual(
    viewJobs(data, { order: "desc" })
      .jobs.slice(0, 2)
      .map((j) => j.id),
    ["high", "low"]
  );
  assert.deepEqual(
    viewJobs(data, { order: "asc" })
      .jobs.slice(0, 2)
      .map((j) => j.id),
    ["low", "high"]
  );
  assert.equal(viewJobs(data).jobs.find((j) => j.id === "cad").pay.comparable, false);
  assert.equal(viewJobs(data).jobs.find((j) => j.id === "market").pay.source, "market");
});

test("pay view explicitly separates annual earnings and uses upper endpoint to break equal lower bounds", (t) => {
  const ctx = fixture(t, {
    sourced: [
      row("narrow", pay(100, 120)),
      row("wide", pay(100, 180)),
      row(
        "earnings",
        pay(null, null, {
          basis: "annual-earnings",
          minAnnualEarnings: 500,
          maxAnnualEarnings: 600,
        })
      ),
    ],
  });
  const data = readJobs(ctx);
  assert.deepEqual(
    viewJobs(data)
      .jobs.slice(0, 2)
      .map((j) => j.id),
    ["wide", "narrow"]
  );
  const earnings = viewJobs(data, { basis: "annual-earnings" });
  assert.equal(earnings.jobs[0].id, "earnings");
  assert.equal(earnings.jobs[0].pay.min, 500);
  assert.equal(viewJobs(data).jobs.find((job) => job.id === "earnings").pay.min, 500);
});

test("filtering uses lifecycle stage and restores a valid visible selection", (t) => {
  const ctx = fixture(t, {
    applications: [
      row("interview", null, { status: "2nd phone interview" }),
      row("rejected", null, { status: "rejected" }),
    ],
    sourced: [row("lead", null)],
  });
  const data = readJobs(ctx);
  assert.equal(
    viewJobs(data, { stage: "interview", selectedId: "rejected" }).selectedId,
    "interview"
  );
  assert.equal(viewJobs(data, { stage: "offer" }).selectedId, null);
  assert.deepEqual(
    viewJobs(data, { stage: "sourced" }).jobs.map((j) => j.id),
    ["lead"]
  );
});

test("missing workspaces browse empty without initializing anything", (t) => {
  const ctx = fixture(t, {});
  rmSync(ctx.env.CAREERRAT_HOME, { recursive: true });
  assert.deepEqual(readJobs(ctx).jobs, []);
  assert.equal(existsSync(ctx.env.CAREERRAT_HOME), false);
});

test("explicit data roots isolate people and malformed legacy data is not silently empty", (t) => {
  const first = fixture(t, { sourced: [row("first", null)] });
  const second = fixture(t, { sourced: [row("second", null)] });
  assert.equal(readJobs(first).jobs[0].id, "first");
  assert.equal(readJobs(second).jobs[0].id, "second");
  writeFileSync(join(first.workspace, "tracker.json"), "broken");
  assert.throws(() => readJobs(first), /JSON|Unexpected/);
});
