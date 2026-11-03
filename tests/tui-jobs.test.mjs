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
  const app = row("a", pay(176000, 204000), {
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

test("pay is read from saved base and total pay text, and vague text stays unknown", (t) => {
  const note = (id, base, more = {}) => row(id, null, { base, ...more });
  const ctx = fixture(t, {
    sourced: [
      note("a-range-k", "$150k-$200k"),
      note("b-commas", "$176,000 - $204,000"),
      note("c-unlisted", "unlisted"),
      note("d-vague", "Competitive"),
      note("e-extras", "$90k-$110k + equity"),
      note("f-euro", "\u20ac90-110k"),
      note("g-empty", ""),
      note("h-null", null),
      note("i-total", "unlisted", { tc: "$300k-$360k + equity" }),
    ],
  });
  const data = readJobs(ctx);
  const byId = (view, id) => view.jobs.find((job) => job.id === id).pay;
  const view = viewJobs(data);
  assert.deepEqual([byId(view, "a-range-k").min, byId(view, "a-range-k").max], [150000, 200000]);
  assert.deepEqual([byId(view, "b-commas").min, byId(view, "b-commas").max], [176000, 204000]);
  assert.deepEqual([byId(view, "e-extras").min, byId(view, "e-extras").max], [90000, 110000]);
  assert.equal(byId(view, "a-range-k").currency, "USD");
  assert.equal(byId(view, "a-range-k").source, "saved-note");
  for (const id of ["c-unlisted", "d-vague", "g-empty", "h-null", "i-total"]) {
    const pay = byId(view, id);
    assert.deepEqual([pay.min, pay.max, pay.comparable], [null, null, false], id);
  }
  assert.equal(byId(view, "f-euro").currency, "EUR");
  assert.equal(byId(view, "f-euro").comparable, false);
  // Highest first really orders by pay; unknown and other currencies sort last.
  assert.deepEqual(
    view.jobs.map((job) => job.id),
    [
      "b-commas",
      "a-range-k",
      "e-extras",
      "c-unlisted",
      "d-vague",
      "f-euro",
      "g-empty",
      "h-null",
      "i-total",
    ]
  );
  assert.deepEqual(
    viewJobs(data, { order: "asc" })
      .jobs.slice(0, 3)
      .map((job) => job.id),
    ["e-extras", "a-range-k", "b-commas"]
  );
  const earnings = viewJobs(data, { basis: "annual-earnings" });
  assert.equal(earnings.jobs[0].id, "i-total");
  assert.deepEqual([earnings.jobs[0].pay.min, earnings.jobs[0].pay.max], [300000, 360000]);
  assert.equal(earnings.jobs[1].pay.comparable, false);
});

test("a saved evaluation's pay wins over the free-text note", (t) => {
  const ctx = fixture(t, {
    sourced: [row("both", pay(100000, 120000), { base: "$300k-$400k" })],
  });
  const job = viewJobs(readJobs(ctx)).jobs[0];
  assert.deepEqual([job.pay.min, job.pay.max, job.pay.source], [100000, 120000, "job-description"]);
});

test("fit falls back to the score and verdict saved on the job", (t) => {
  const ctx = fixture(t, {
    sourced: [
      row("gated", null, { fitScore: 84, gate: { gate: "KEEP", action: "apply" } }),
      row("bucketed", null, { fitScore: 40, fitBucket: "stretch" }),
      row("both", null, { fitScore: 70, gate: { gate: "REVIEW" }, fitBucket: "med" }),
      row("zero", null, { fitScore: 0, fitBucket: "cut" }),
      row("bare", null, { gate: null }),
      row("evaluated", { gate: "keep", fitScore: 91 }, { fitScore: 12 }),
    ],
  });
  const fit = Object.fromEntries(viewJobs(readJobs(ctx)).jobs.map((job) => [job.id, job.fit]));
  assert.equal(fit.gated.label, "84 KEEP");
  assert.equal(fit.bucketed.label, "40 stretch");
  assert.equal(fit.both.label, "70 REVIEW");
  assert.equal(fit.zero.label, "0 cut");
  assert.deepEqual(fit.bare, { score: null, verdict: null, label: null });
  assert.equal(fit.evaluated.label, "91 keep");
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

test("background search progress is read from the same canonical snapshot", async (t) => {
  const { sourcingRunStart, sourcingRunProgress } = await import(
    "../src/core/db/verbs/sourcing-runs.mjs"
  );
  const ctx = fixture(t, { applications: [], sourced: [] }, true);
  const { run } = sourcingRunStart({ ...ctx, purpose: "manual-search" });
  sourcingRunProgress({
    ...ctx,
    id: run.id,
    progress: { completedSources: 2, totalSources: 7, foundCount: 3 },
  });
  const before = readFileSync(join(ctx.env.CAREERRAT_HOME, "db/careerrat.db"));
  const data = readJobs(ctx);
  assert.equal(data.searchRuns[0].id, run.id);
  assert.equal(data.searchRuns[0].progress.foundCount, 3);
  assert.deepEqual(readFileSync(join(ctx.env.CAREERRAT_HOME, "db/careerrat.db")), before);
});
