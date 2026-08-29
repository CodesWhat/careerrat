// tests/strategy-review.test.mjs — coverage for the native strategy-review Ask
// workflow's server-side compute (src/core/strategy/review.mjs):
// buildStrategyReviewContext, draftStrategyReview, applyStrategyRecommendation,
// stampStrategyReview. Follows the tempRepo/seed-helper convention established
// by tests/workspace-agent.test.mjs and the execFileSync CLI convention
// established by tests/health-cli.test.mjs (for the strategy-review.mjs CLI
// equivalence check).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import { candidateConfigGet, candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";
import { kvUpsert } from "../src/core/db/verbs/shared.mjs";
import { sourcedUpsertBatch } from "../src/core/db/verbs/sourced.mjs";
import {
  learningsAbsPath,
  learningsHeader,
  readLearnings,
  slugifyFamily,
} from "../src/core/profile/learnings.mjs";
import {
  applyStrategyRecommendation,
  buildStrategyReviewContext,
  draftStrategyReview,
  stampStrategyReview,
} from "../src/core/strategy/review.mjs";

const repo = join(import.meta.dirname, "..");
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-strategy-review-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

// A raw temp dir with no in-process db handle opened yet — for the CLI
// equivalence test, which seeds and stamps entirely through subprocess calls
// so it never contends with an in-process better-sqlite3 handle on the same
// file (mirrors tests/health-cli.test.mjs's own tempRepo()).
function tempRepoRaw() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-strategy-review-cli-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function seedApplication(repoRoot, overrides = {}) {
  const row = {
    id: `app-${Math.random().toString(36).slice(2, 8)}`,
    company: "Temporal Labs",
    role: "Applied AI Engineer",
    status: "applied",
    ...overrides,
  };
  appUpsert({ repoRoot, env: {}, row });
  return row;
}

function seedSourced(repoRoot, overrides = {}) {
  const row = {
    id: `sourced-${Math.random().toString(36).slice(2, 8)}`,
    company: "Temporal Labs",
    role: "Staff Platform Engineer",
    status: "sourced",
    ...overrides,
  };
  sourcedUpsertBatch({ repoRoot, env: {}, rows: [row] });
  return row;
}

function readApplication(repoRoot, id) {
  const row = openDb({ repoRoot, env: {} })
    .prepare("SELECT data FROM applications WHERE id = ?")
    .get(id);
  return row ? JSON.parse(row.data) : null;
}

function readSourced(repoRoot, id) {
  const row = openDb({ repoRoot, env: {} })
    .prepare("SELECT data FROM sourced WHERE id = ?")
    .get(id);
  return row ? JSON.parse(row.data) : null;
}

function latestActivityEvent(repoRoot) {
  const row = openDb({ repoRoot, env: {} })
    .prepare("SELECT data FROM activity_events ORDER BY rowid DESC LIMIT 1")
    .get();
  return row ? JSON.parse(row.data) : null;
}

function dataCli(repoRoot, args) {
  return JSON.parse(
    execFileSync(process.execPath, ["src/cli/data.mjs", "--root", repoRoot, "--json", ...args], {
      cwd: repo,
      encoding: "utf8",
    })
  );
}

function strategyReviewCli(repoRoot, args) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["src/cli/strategy-review.mjs", "--root", repoRoot, "--json", ...args],
      { cwd: repo, encoding: "utf8" }
    )
  );
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. buildStrategyReviewContext
// ---------------------------------------------------------------------------

test("buildStrategyReviewContext assembles funnel counts, targeting signals, and comp target/minimum, and never leaks current_base", () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-1",
    company: "Acme Freight",
    role: "Applied AI Engineer",
    status: "applied",
  });
  seedApplication(repoRoot, {
    id: "app-2",
    company: "Acme Freight",
    role: "Applied AI Engineer",
    status: "rejected",
  });
  seedApplication(repoRoot, {
    id: "app-3",
    company: "Riverside Health",
    role: "Staff Platform Engineer",
    status: "interview",
  });
  seedSourced(repoRoot, {
    id: "sourced-1",
    company: "Cyberdyne Systems",
    role: "Applied AI Engineer",
  });

  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "targeting",
    patch: {
      keep_signals: ["remote-first"],
      cut_signals: ["no-equity"],
      excluded_companies: ["Weyland-Yutani"],
      fit_bands: { high_min: 80, med_min: 60 },
    },
  });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: {
      compensation: {
        currency: "USD",
        current_base: 184500,
        target_base: 205000,
        minimum_base: 190000,
      },
    },
  });

  const context = buildStrategyReviewContext({
    repoRoot,
    env: {},
    now: new Date("2026-08-15T12:00:00.000Z"),
  });

  assert.equal(context.funnel.counts.apps, 3);
  assert.equal(context.funnel.counts.sourced, 1);
  assert.deepEqual(context.targeting.keep_signals, ["remote-first"]);
  assert.deepEqual(context.targeting.cut_signals, ["no-equity"]);
  assert.deepEqual(context.targeting.excluded_companies, ["Weyland-Yutani"]);
  assert.equal(context.compensation.currency, "USD");
  assert.equal(context.compensation.target_base, 205000);
  assert.equal(context.compensation.minimum_base, 190000);
  assert.equal("current_base" in context.compensation, false);

  const serialized = JSON.stringify(context);
  assert.ok(!serialized.includes("current_base"), "context must never mention current_base");
  assert.ok(!serialized.includes("184500"), "context must never carry the private comp figure");
});

// ---------------------------------------------------------------------------
// 2. draftStrategyReview — freshness gate
// ---------------------------------------------------------------------------

test("draftStrategyReview stays fresh with no new outcomes since the last stamp, and never calls the AI", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-1", status: "applied" });
  kvUpsert({
    repoRoot,
    env: {},
    key: "strategyReview",
    value: {
      lastReviewedAt: "2026-08-14T12:00:00.000Z",
      snapshot: { applied: 1, advanced: 0, rejected: 0, outcomes: 0, rejectedByFamily: null },
    },
  });

  const draft = await draftStrategyReview({
    repoRoot,
    env: {},
    now: new Date("2026-08-15T12:00:00.000Z"),
    runAI: async () => {
      throw new Error("must not call the AI when the review is fresh");
    },
  });

  assert.equal(draft.state, "fresh");
  assert.equal(draft.headline, "Nothing new since your last review.");
  assert.deepEqual(draft.recommendations, []);
  assert.ok(draft.lastReview);
  assert.equal(draft.lastReview.lastReviewedAt, "2026-08-14T12:00:00.000Z");
});

test("draftStrategyReview force:true bypasses the freshness gate and calls the AI anyway", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-1", status: "applied" });
  kvUpsert({
    repoRoot,
    env: {},
    key: "strategyReview",
    value: {
      lastReviewedAt: "2026-08-14T12:00:00.000Z",
      snapshot: { applied: 1, advanced: 0, rejected: 0, outcomes: 0, rejectedByFamily: null },
    },
  });

  let calls = 0;
  const draft = await draftStrategyReview({
    repoRoot,
    env: {},
    force: true,
    now: new Date("2026-08-15T12:00:00.000Z"),
    runAI: async () => {
      calls += 1;
      return {
        body: {
          ok: true,
          ai: { engine: { id: "claude", label: "Claude Code" } },
          data: { headline: "Forced review.", findings: [], recommendations: [] },
        },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(draft.state, "drafted");
  assert.equal(draft.headline, "Forced review.");
});

test("draftStrategyReview sends the frozen coach plan and abort signal to bounded AI", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-1", status: "applied" });
  const controller = new AbortController();
  const executionPlan = Object.freeze({
    version: 1,
    runtimeId: "codex",
    operation: "coach.deep",
    resolved: Object.freeze({ model: "gpt-5.4", effort: "high" }),
  });
  let seenOptions;

  const draft = await draftStrategyReview({
    repoRoot,
    env: {},
    force: true,
    executionPlan,
    signal: controller.signal,
    now: new Date("2026-08-15T12:00:00.000Z"),
    runAI: async (options) => {
      seenOptions = options;
      return {
        body: {
          ok: true,
          ai: { used: true },
          data: { headline: "Frozen review.", findings: [], recommendations: [] },
        },
      };
    },
  });

  assert.equal(draft.state, "drafted");
  assert.equal(seenOptions.executionPlan, executionPlan);
  assert.equal(seenOptions.signal, controller.signal);
});

test("draftStrategyReview drafts once enough new outcomes have accrued since the last stamp", async () => {
  const repoRoot = tempRepo();
  for (let i = 0; i < 5; i++) {
    seedApplication(repoRoot, { id: `app-rejected-${i}`, status: "rejected" });
  }
  kvUpsert({
    repoRoot,
    env: {},
    key: "strategyReview",
    value: {
      lastReviewedAt: "2026-08-14T12:00:00.000Z",
      snapshot: { applied: 0, advanced: 0, rejected: 0, outcomes: 0, rejectedByFamily: null },
    },
  });

  let calls = 0;
  const draft = await draftStrategyReview({
    repoRoot,
    env: {},
    now: new Date("2026-08-15T12:00:00.000Z"),
    runAI: async () => {
      calls += 1;
      return {
        body: {
          ok: true,
          ai: { engine: { id: "claude", label: "Claude Code" } },
          data: { headline: "Five new rejections.", findings: [], recommendations: [] },
        },
      };
    },
  });

  assert.equal(calls, 1, "5 new outcomes must clear STRATEGY_REVIEW_NEW_SIGNAL and call the AI");
  assert.equal(draft.state, "drafted");
  assert.equal(draft.headline, "Five new rejections.");
});

// ---------------------------------------------------------------------------
// 3. draftStrategyReview — manual degrade on AI failure
// ---------------------------------------------------------------------------

test("draftStrategyReview degrades to a manual, deterministic result when the AI route is unavailable, without throwing", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-1",
    company: "Acme Freight",
    role: "Applied AI Engineer",
    status: "rejected",
  });
  seedApplication(repoRoot, {
    id: "app-2",
    company: "Acme Freight",
    role: "Applied AI Engineer",
    status: "rejected",
  });
  seedApplication(repoRoot, {
    id: "app-3",
    company: "Acme Freight",
    role: "Applied AI Engineer",
    status: "rejected",
  });

  const draft = await draftStrategyReview({
    repoRoot,
    env: {},
    force: true,
    now: new Date("2026-08-15T12:00:00.000Z"),
    runAI: async () => ({
      body: {
        ok: false,
        error: { code: "NO_AI_ROUTE", message: "no ai route configured for this workspace" },
      },
    }),
  });

  assert.equal(draft.state, "manual");
  assert.deepEqual(draft.findings, []);
  assert.deepEqual(draft.recommendations, []);
  assert.ok(draft.manual);
  assert.equal(draft.manual.reason, "No AI engine was available for this review.");
  assert.equal(draft.manual.detail, "no ai route configured for this workspace");
  assert.equal(draft.manual.code, "NO_AI_ROUTE");
  assert.ok(draft.manual.surfaceSummary, "expected the deterministic recommendation to surface");
  assert.equal(typeof draft.manual.surfaceSummary.title, "string");
  assert.ok(draft.manual.surfaceSummary.title.length > 0);
});

// ---------------------------------------------------------------------------
// 4. draftStrategyReview — schema-shaped happy path (one recommendation per
//    type, MAX_RECOMMENDATIONS capping the 10 known types down to 8)
// ---------------------------------------------------------------------------

test("draftStrategyReview passes through a schema-shaped AI recommendation set and caps at MAX_RECOMMENDATIONS", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-1", status: "applied" });

  const recommendations = [
    {
      id: "rec-rerank",
      type: "rerank",
      title: "Re-rank the Acme role",
      rationale: "It has gone quiet longer than comparable roles.",
      evidenceCount: 3,
      proposal: { id: "app-1", toStatus: "reviewed-hold" },
    },
    {
      id: "rec-keep",
      type: "keep-signal",
      title: "Keep leaning into remote-first roles",
      rationale: "Remote-first roles are converting at a higher rate.",
      evidenceCount: 4,
      proposal: { signal: "remote-first" },
    },
    {
      id: "rec-cut",
      type: "cut-signal",
      title: "Cut roles requiring on-call rotations",
      rationale: "Every on-call-tagged role was rejected.",
      evidenceCount: 3,
      proposal: { signal: "on-call-rotation" },
    },
    {
      id: "rec-comp-target",
      type: "comp-target",
      title: "Raise the comp target",
      rationale: "Recent offers cleared the current target comfortably.",
      evidenceCount: 2,
      proposal: { amount: 205000 },
    },
    {
      id: "rec-comp-floor",
      type: "comp-floor",
      title: "Raise the comp floor",
      rationale: "The lowest recent offer still cleared this floor.",
      evidenceCount: 2,
      proposal: { amount: 190000 },
    },
    {
      id: "rec-exclude",
      type: "exclude-company",
      title: "Exclude Weyland-Yutani",
      rationale: "Two rejections cited a hiring freeze there.",
      evidenceCount: 2,
      proposal: { company: "Weyland-Yutani" },
    },
    {
      id: "rec-fit-bands",
      type: "fit-bands",
      title: "Tighten the high-fit band",
      rationale: "High-fit roles are converting well above the current threshold.",
      evidenceCount: 5,
      proposal: { patch: { high_min: 82 } },
    },
    {
      id: "rec-learning",
      type: "learning",
      title: "Record the recruiter-screen pattern",
      rationale: "Recruiter screens are converting at double the usual rate.",
      evidenceCount: 3,
      proposal: {
        family: "applied-ai-engineer",
        title: "Recruiter screens converting well",
        body: "Recruiter screens for this family are converting at roughly double the usual rate.",
      },
    },
    {
      id: "rec-writing",
      type: "writing-style",
      title: "Lead with quantified impact",
      rationale: "Cover letters that open with a number get further.",
      evidenceCount: 2,
      proposal: { text: "Lead with quantified impact in the first line." },
    },
    {
      id: "rec-other",
      type: "other",
      title: "Consider widening the search radius",
      rationale: "A few strong-fit roles were just outside the current radius.",
      evidenceCount: 1,
      proposal: { text: "Widen the geographic radius by 25 miles." },
    },
  ];

  const draft = await draftStrategyReview({
    repoRoot,
    env: {},
    force: true,
    now: new Date("2026-08-15T12:00:00.000Z"),
    runAI: async ({ schema }) => {
      const proposalSchema = schema.properties.recommendations.items.properties.proposal;
      assert.equal(proposalSchema.additionalProperties, false);
      assert.deepEqual(Object.keys(proposalSchema.properties).sort(), [
        "amount",
        "body",
        "company",
        "family",
        "id",
        "ids",
        "patch",
        "priority",
        "signal",
        "text",
        "title",
        "toStatus",
      ]);
      assert.deepEqual(Object.keys(proposalSchema.properties.patch.properties).sort(), [
        "fit_floor",
        "high_min",
        "med_min",
      ]);
      return {
        body: {
          ok: true,
          ai: { engine: { id: "claude", label: "Claude Code" } },
          data: {
            headline: "Ten candidate recommendations, capped at eight.",
            findings: [
              { id: "f1", title: "Remote-first roles convert best", evidence: "4 of 5 advanced." },
            ],
            recommendations,
          },
        },
      };
    },
  });

  assert.equal(draft.state, "drafted");
  assert.equal(draft.headline, "Ten candidate recommendations, capped at eight.");
  assert.equal(draft.recommendations.length, 8, "MAX_RECOMMENDATIONS must cap the 10 inputs to 8");
  assert.deepEqual(
    draft.recommendations.map((rec) => rec.type),
    recommendations.slice(0, 8).map((rec) => rec.type)
  );

  const rerank = draft.recommendations.find((rec) => rec.type === "rerank");
  assert.equal(rerank.title, "Re-rank the Acme role");
  assert.equal(rerank.rationale, "It has gone quiet longer than comparable roles.");
  assert.equal(rerank.evidenceCount, 3);
  assert.deepEqual(rerank.proposal, { id: "app-1", toStatus: "reviewed-hold" });

  const compTarget = draft.recommendations.find((rec) => rec.type === "comp-target");
  assert.deepEqual(compTarget.proposal, { amount: 205000 });

  const learning = draft.recommendations.find((rec) => rec.type === "learning");
  assert.deepEqual(learning.proposal, {
    family: "applied-ai-engineer",
    title: "Recruiter screens converting well",
    body: "Recruiter screens for this family are converting at roughly double the usual rate.",
  });

  assert.equal(draft.findings.length, 1);
  assert.equal(draft.findings[0].title, "Remote-first roles convert best");
});

// ---------------------------------------------------------------------------
// 5. applyStrategyRecommendation — per recommendation type
// ---------------------------------------------------------------------------

test("applyStrategyRecommendation rerank: a single id patches that one row's priority", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-1", status: "applied" });

  const result = await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: {
      type: "rerank",
      title: "Bump priority",
      proposal: { id: "app-1", priority: 2 },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.result.rows, ["app-1"]);
  assert.equal(result.result.count, 1);
  assert.equal(readApplication(repoRoot, "app-1").priority, 2);
});

test("applyStrategyRecommendation rerank: ids[] applies to up to 5 rows, and rejects a 6th", async () => {
  const repoRoot = tempRepo();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const row = seedSourced(repoRoot, { id: `sourced-rerank-${i}`, status: "sourced" });
    ids.push(row.id);
  }

  const result = await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: {
      type: "rerank",
      title: "Re-rank the top 5",
      proposal: { ids, toStatus: "reviewed-hold" },
    },
  });

  assert.equal(result.result.count, 5);
  for (const id of ids) {
    assert.equal(readSourced(repoRoot, id).status, "reviewed-hold");
  }

  await assert.rejects(
    applyStrategyRecommendation({
      repoRoot,
      env: {},
      recommendation: {
        type: "rerank",
        title: "Over the cap",
        proposal: { ids: [...ids, "sourced-rerank-extra"], toStatus: "reviewed-hold" },
      },
    }),
    (error) => error.code === "STRATEGY_APPLY_INVALID"
  );
});

test("applyStrategyRecommendation rerank: a stale id fails the whole batch before any row is written", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-live", status: "applied" });

  await assert.rejects(
    applyStrategyRecommendation({
      repoRoot,
      env: {},
      recommendation: {
        type: "rerank",
        title: "Batch with a gone row",
        proposal: { ids: ["app-live", "app-gone"], priority: "low" },
      },
    }),
    (error) => error.code === "STRATEGY_APPLY_STALE"
  );

  assert.equal(readApplication(repoRoot, "app-live").priority, undefined);
});

test("applyStrategyRecommendation rerank rejects an unrecognized status and a malformed priority before writing", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-1", status: "applied" });

  await assert.rejects(
    applyStrategyRecommendation({
      repoRoot,
      env: {},
      recommendation: {
        type: "rerank",
        title: "Typo status",
        proposal: { ids: ["app-1"], toStatus: "banana-tier" },
      },
    }),
    (error) => error.code === "STRATEGY_APPLY_INVALID"
  );

  await assert.rejects(
    applyStrategyRecommendation({
      repoRoot,
      env: {},
      recommendation: {
        type: "rerank",
        title: "Object priority",
        proposal: { ids: ["app-1"], priority: { level: "high" } },
      },
    }),
    (error) => error.code === "STRATEGY_APPLY_INVALID"
  );

  const row = readApplication(repoRoot, "app-1");
  assert.equal(row.status, "applied");
  assert.equal(row.priority, undefined);
});

test("applyStrategyRecommendation keep-signal/cut-signal/exclude-company append through the DB gate path", async () => {
  const repoRoot = tempRepo();

  await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: {
      type: "keep-signal",
      title: "Keep remote-first",
      proposal: { signal: "remote-first" },
    },
  });
  await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: {
      type: "cut-signal",
      title: "Cut on-call",
      proposal: { signal: "on-call-rotation" },
    },
  });
  await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: {
      type: "exclude-company",
      title: "Exclude Weyland-Yutani",
      proposal: { company: "Weyland-Yutani" },
    },
  });

  const targeting = candidateConfigGet({ repoRoot, env: {} }).targeting;
  assert.ok(targeting.keep_signals.includes("remote-first"));
  assert.ok(targeting.cut_signals.includes("on-call-rotation"));
  assert.ok(targeting.excluded_companies.includes("Weyland-Yutani"));
});

test("applyStrategyRecommendation comp-target/comp-floor set the compensation config through the DB gate path", async () => {
  const repoRoot = tempRepo();

  await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: { type: "comp-target", title: "Raise target", proposal: { amount: 205000 } },
  });
  await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: { type: "comp-floor", title: "Raise floor", proposal: { amount: 190000 } },
  });

  const compensation = candidateConfigGet({ repoRoot, env: {} }).profile.compensation;
  assert.equal(compensation.target_base, 205000);
  assert.equal(compensation.minimum_base, 190000);
});

test("applyStrategyRecommendation comp-target rejects a non-numeric amount as invalid, not a server error", async () => {
  const repoRoot = tempRepo();

  await assert.rejects(
    applyStrategyRecommendation({
      repoRoot,
      env: {},
      recommendation: {
        type: "comp-target",
        title: "Bad amount",
        proposal: { amount: "a lot" },
      },
    }),
    (error) => error.code === "STRATEGY_APPLY_INVALID"
  );
});

test("applyStrategyRecommendation comp writes never return current_base (it would persist into the thread)", async () => {
  const repoRoot = tempRepo();
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: {
      compensation: {
        currency: "USD",
        current_base: 184500,
        target_base: 200000,
        minimum_base: 185000,
      },
    },
  });

  const applied = await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: { type: "comp-target", title: "Raise target", proposal: { amount: 210000 } },
  });

  const serialized = JSON.stringify(applied);
  assert.ok(!serialized.includes("current_base"), "apply result must never mention current_base");
  assert.ok(
    !serialized.includes("184500"),
    "apply result must never carry the current base figure"
  );
  assert.equal(applied.result.changed, true);
  assert.ok(applied.result.summary, "apply result should carry a card-ready summary");

  const repeat = await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: { type: "comp-target", title: "Raise target", proposal: { amount: 210000 } },
  });
  const repeatSerialized = JSON.stringify(repeat);
  assert.ok(!repeatSerialized.includes("current_base"));
  assert.equal(repeat.result.changed, false);
});

test("applyStrategyRecommendation fit-bands patches only the allowed keys through candidateConfigPatch", async () => {
  const repoRoot = tempRepo();

  const result = await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: {
      type: "fit-bands",
      title: "Tighten fit bands",
      proposal: { patch: { high_min: 82, med_min: 61 } },
    },
  });

  assert.equal(result.ok, true);
  const fitBands = candidateConfigGet({ repoRoot, env: {} }).targeting.fit_bands;
  assert.equal(fitBands.high_min, 82);
  assert.equal(fitBands.med_min, 61);

  await assert.rejects(
    applyStrategyRecommendation({
      repoRoot,
      env: {},
      recommendation: {
        type: "fit-bands",
        title: "Bad key",
        proposal: { patch: { current_base: 1 } },
      },
    }),
    (error) => error.code === "STRATEGY_APPLY_INVALID"
  );
});

test("applyStrategyRecommendation learning appends the learning file and logs an activity event", async () => {
  const repoRoot = tempRepo();

  const result = await applyStrategyRecommendation({
    repoRoot,
    env: {},
    recommendation: {
      type: "learning",
      title: "Record the recruiter-screen pattern",
      proposal: {
        family: "applied-ai-engineer",
        title: "Recruiter screens converting well",
        body: "Recruiter screens for this family are converting at roughly double the usual rate.",
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.ok, true);
  assert.equal(result.result.family, "applied-ai-engineer");

  const text = readLearnings("applied-ai-engineer", { root: repoRoot });
  assert.match(text, /Recruiter screens converting well/);
  assert.match(text, /converting at roughly double the usual rate/);

  const event = latestActivityEvent(repoRoot);
  assert.ok(event, "expected an activity event to be logged");
  assert.equal(event.type, "system");
  assert.match(event.title, /Learning recorded/);
  assert.ok(event.tags.includes("operation:learnings:append"));
  assert.ok(event.tags.includes("skill:reevaluate-strategy"));
});

test("applyStrategyRecommendation refuses writing-style/other as unsupported, and a garbage type as invalid", async () => {
  const repoRoot = tempRepo();

  await assert.rejects(
    applyStrategyRecommendation({
      repoRoot,
      env: {},
      recommendation: {
        type: "writing-style",
        title: "Lead with impact",
        proposal: { text: "Lead with quantified impact." },
      },
    }),
    (error) => error.code === "STRATEGY_APPLY_UNSUPPORTED"
  );

  await assert.rejects(
    applyStrategyRecommendation({
      repoRoot,
      env: {},
      recommendation: {
        type: "other",
        title: "Widen radius",
        proposal: { text: "Widen the search radius." },
      },
    }),
    (error) => error.code === "STRATEGY_APPLY_UNSUPPORTED"
  );

  await assert.rejects(
    applyStrategyRecommendation({
      repoRoot,
      env: {},
      recommendation: { type: "not-a-real-type", title: "Bogus", proposal: {} },
    }),
    (error) => error.code === "STRATEGY_APPLY_INVALID"
  );
});

// ---------------------------------------------------------------------------
// 6. stampStrategyReview
// ---------------------------------------------------------------------------

test("stampStrategyReview persists the strategyReview marker and logs a system activity event", () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-1", status: "rejected" });
  seedApplication(repoRoot, { id: "app-2", status: "accepted" });

  const stamp = stampStrategyReview({
    repoRoot,
    env: {},
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  });

  assert.equal(stamp.ok, true);
  assert.equal(stamp.strategyReview.lastReviewedAt, "2026-08-15T12:00:00.000Z");
  assert.equal(stamp.strategyReview.snapshot.applied, 2);
  assert.equal(stamp.strategyReview.snapshot.rejected, 1);
  assert.equal(stamp.strategyReview.snapshot.advanced, 1);
  assert.equal(stamp.strategyReview.snapshot.outcomes, 2);
  assert.ok(stamp.event);
  assert.equal(stamp.event.type, "system");
  assert.ok(stamp.event.tags.includes("skill:reevaluate-strategy"));
  assert.ok(stamp.event.tags.includes("operation:strategy:review"));

  const kvRow = openDb({ repoRoot, env: {} })
    .prepare("SELECT data FROM kv WHERE key = 'strategyReview'")
    .get();
  assert.deepEqual(JSON.parse(kvRow.data), stamp.strategyReview);
});

test("careerrat strategy-review stamp --write (DB mode) shares stampStrategyReview's write and activity log", () => {
  const repoRoot = tempRepoRaw();
  dataCli(repoRoot, ["init"]);
  dataCli(repoRoot, [
    "app",
    "upsert",
    "--data",
    JSON.stringify({
      id: "app-1",
      company: "Temporal Labs",
      role: "Applied AI Engineer",
      status: "rejected",
    }),
  ]);
  dataCli(repoRoot, [
    "app",
    "upsert",
    "--data",
    JSON.stringify({
      id: "app-2",
      company: "Temporal Labs",
      role: "Staff Platform Engineer",
      status: "accepted",
    }),
  ]);

  const result = strategyReviewCli(repoRoot, [
    "stamp",
    "--write",
    "--at",
    "2026-08-15T12:00:00.000Z",
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.written, true);
  assert.equal(result.strategyReview.lastReviewedAt, "2026-08-15T12:00:00.000Z");
  assert.equal(result.strategyReview.snapshot.applied, 2);
  assert.equal(result.strategyReview.snapshot.advanced, 1);
  assert.equal(result.strategyReview.snapshot.rejected, 1);
  assert.equal(result.strategyReview.snapshot.outcomes, 2);
  assert.ok(result.strategyReview.snapshot.rejectedByFamily);
  assert.equal(Object.keys(result.strategyReview.snapshot.rejectedByFamily).length, 1);

  const db = openDb({ repoRoot, env: {} });
  const kvRow = db.prepare("SELECT data FROM kv WHERE key = 'strategyReview'").get();
  assert.deepEqual(JSON.parse(kvRow.data), result.strategyReview);

  const activityRow = db
    .prepare("SELECT data FROM activity_events ORDER BY rowid DESC LIMIT 1")
    .get();
  const event = JSON.parse(activityRow.data);
  assert.equal(event.type, "system");
  assert.ok(event.tags.includes("skill:reevaluate-strategy"));
  assert.ok(event.tags.includes("operation:strategy:review"));
});

// ---------------------------------------------------------------------------
// compactLearnings separator back-compat
// ---------------------------------------------------------------------------

// formatEntry() writes `## <date>: <title>` since the em-dash copy sweep, but it
// wrote `## <date> — <title>` before it. Learning files are append-only and live
// in the candidate's own gitignored workspace, so a real user's file can hold
// entries in either form, and often both. compactLearnings returning headings
// means a parse failure is silent: a file that matches nothing is indistinguishable
// from a family with no learnings yet.
test("buildStrategyReviewContext reads learning headings written with either separator", () => {
  const repoRoot = tempRepo();
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "targeting",
    patch: {
      role_buckets: [
        { name: "Applied AI Engineer", priority: "primary", titles: ["Applied AI Engineer"] },
      ],
    },
  });

  // compactLearnings derives families straight from targeting.role_buckets[].name
  // via slugifyFamily, not through the role classifier.
  const family = slugifyFamily("Applied AI Engineer");
  const absPath = learningsAbsPath(family, repoRoot);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(
    absPath,
    [
      learningsHeader(family),
      "",
      "## 2026-07-01 — Recruiter screens stall without a comp range",
      "",
      "Body of the pre-sweep entry.",
      "",
      "## 2026-08-01: Take-homes convert better than live coding",
      "",
      "Body of the post-sweep entry.",
      "",
      // computeAppend's date check is prefix-anchored (`/^\d{4}-\d{2}-\d{2}/`,
      // no `$`), so `careerrat learnings --date 2026-08-10T14:30:00Z` is accepted
      // and written. A colon separator matched without requiring trailing
      // whitespace stops at the first colon on the line, which is inside the
      // time, and the entry parses as date "2026-08-10T14" with the rest of the
      // timestamp glued onto the front of the title. Silent, and it feeds a
      // mangled title into strategy review.
      "## 2026-08-10T14:30:00Z: Panel loops need a written brief",
      "",
      "Body of an entry whose date carries a time.",
      "",
      // A title may itself contain a colon. The separator is the first colon
      // FOLLOWED BY whitespace, not the first colon.
      "## 2026-08-12: Onsite: bring a written question list",
      "",
      "Body of an entry whose title contains a colon.",
      "",
    ].join("\n")
  );

  const context = buildStrategyReviewContext({
    repoRoot,
    env: {},
    now: new Date("2026-08-15T12:00:00.000Z"),
  });

  const entry = context.learnings.find((item) => item.family === family);
  assert.ok(
    entry,
    `no learnings entry for family ${family} in ${JSON.stringify(context.learnings)}`
  );
  assert.deepEqual(
    entry.entries.map((e) => e.date),
    ["2026-07-01", "2026-08-01", "2026-08-10T14:30:00Z", "2026-08-12"],
    "both the em-dash entry and the colon entry must be read, and a date carrying a time must survive intact"
  );
  assert.equal(entry.entries[0].title, "Recruiter screens stall without a comp range");
  assert.equal(entry.entries[1].title, "Take-homes convert better than live coding");
  assert.equal(entry.entries[2].title, "Panel loops need a written brief");
  assert.equal(entry.entries[3].title, "Onsite: bring a written question list");
});
