// CR72 slice 72d: company-health and coaching.plan run on their own when their
// trigger is met. The follow-up is scheduled through an injected scheduler so
// the tests stay deterministic and never reach an AI route.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createWorkspaceAgentRuntime,
  executeWorkspaceIntent,
} from "../src/core/agent/workspace-agent.mjs";
import { workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appSetStatus, appUpsert } from "../src/core/db/verbs/app.mjs";
import { candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";

const roots = [];

after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-auto-follow-ups-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

function seed(repoRoot, overrides = {}) {
  const row = {
    id: "app-auto",
    company: "Riverside Health",
    role: "Registered Nurse",
    status: "applied",
    link: "https://jobs.example.test/riverside/rn",
    ...overrides,
  };
  appUpsert({ repoRoot, env: {}, row });
  return row;
}

// Collects the detached follow-ups so a test can await them.
function harness(repoRoot, extra = {}) {
  const pending = [];
  const healthCalls = [];
  const coachCalls = [];
  const base = {
    repoRoot,
    env: {},
    autoFollowUps: true,
    aiRouteAvailableImpl: () => true,
    scheduleAutoFollowUp: (run) => pending.push(run()),
    startCompanyHealthImpl: async (input) => {
      healthCalls.push(input);
      return { chat: { chatId: "ch-1", skill: "company-health", state: "running" } };
    },
    buildCoachingPlanImpl: async ({ applicationId }) => {
      coachCalls.push(applicationId);
      return {
        status: 200,
        body: { ok: true, data: { generatedAt: "2026-10-01T00:00:00.000Z", gaps: [] } },
      };
    },
    ...extra,
  };
  return {
    base,
    healthCalls,
    coachCalls,
    settle: () => Promise.all(pending.splice(0)),
  };
}

const outcome = (to, id = "app-auto") => ({
  type: "outcome.record",
  entity: { type: "application", id },
  input: { to },
});

test("a status change to interview auto-runs company-health once", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const h = harness(repoRoot);

  await executeWorkspaceIntent({ ...h.base, intent: outcome("interview") });
  await h.settle();
  assert.equal(h.healthCalls.length, 1);
  assert.match(h.healthCalls[0].request, /Riverside Health/);

  const thread = workspaceThreadRead({ repoRoot, env: {} });
  const intents = thread.messages.filter(
    (m) => m.kind === "intent" && m.intent.type === "company.health"
  );
  assert.equal(intents.length, 1);
  assert.equal(intents[0].intent.input.auto, true);

  // A new stage (offer) is a new run. Landing on interview again is not.
  await executeWorkspaceIntent({ ...h.base, intent: outcome("offer") });
  await h.settle();
  await executeWorkspaceIntent({ ...h.base, intent: outcome("interview") });
  await h.settle();
  assert.equal(h.healthCalls.length, 2);
});

test("company-health does not fire below fire_at_stage, when fresh, or with auto false", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const h = harness(repoRoot);
  await executeWorkspaceIntent({ ...h.base, intent: outcome("awaiting") });
  await h.settle();
  assert.equal(h.healthCalls.length, 0, "applied-band status is below interview");

  const freshRepo = tempRepo();
  seed(freshRepo, { companyHealth: { rating: "healthy", asOf: new Date().toISOString() } });
  const fresh = harness(freshRepo);
  await executeWorkspaceIntent({ ...fresh.base, intent: outcome("interview") });
  await fresh.settle();
  assert.equal(fresh.healthCalls.length, 0, "a fresh rating is reused");

  const offRepo = tempRepo();
  seed(offRepo);
  candidateConfigPatch({
    repoRoot: offRepo,
    env: {},
    name: "modes",
    patch: { company_health: { auto: false } },
  });
  const off = harness(offRepo);
  await executeWorkspaceIntent({ ...off.base, intent: outcome("interview") });
  await off.settle();
  assert.equal(off.healthCalls.length, 0, "auto: false disables it");
});

test("without autoFollowUps nothing is scheduled, so tests and CLI writes stay AI-free", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const h = harness(repoRoot, { autoFollowUps: false });
  await executeWorkspaceIntent({ ...h.base, intent: outcome("interview") });
  await h.settle();
  assert.equal(h.healthCalls.length, 0);
});

test("the runtime hook covers writes that bypass intents, like the tracker status route", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const h = harness(repoRoot);
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    startCompanyHealthImpl: h.base.startCompanyHealthImpl,
    scheduleAutoFollowUp: h.base.scheduleAutoFollowUp,
    aiRouteAvailableImpl: () => true,
  });
  const before = runtime.snapshotApplicationState();
  appSetStatus({ repoRoot, env: {}, id: "app-auto", to: "interview" });
  runtime.afterApplicationWrite(before);
  await h.settle();
  assert.equal(h.healthCalls.length, 1);
});

test("no AI route skips the follow-up with a short note and no error", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const h = harness(repoRoot, { aiRouteAvailableImpl: () => false });
  await executeWorkspaceIntent({ ...h.base, intent: outcome("interview") });
  await h.settle();
  assert.equal(h.healthCalls.length, 0);
  const thread = workspaceThreadRead({ repoRoot, env: {} });
  assert.equal(thread.messages.filter((m) => m.kind === "action_error").length, 0);
  const note = thread.messages.find((m) => m.kind === "status");
  assert.match(note.text, /no AI is set up/);
});

test("a failing company-health follow-up lands as an action_error and the status change stands", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const h = harness(repoRoot, {
    startCompanyHealthImpl: async () => {
      throw new Error("search backend down");
    },
  });
  const result = await executeWorkspaceIntent({ ...h.base, intent: outcome("interview") });
  await h.settle();
  assert.equal(result.messages.at(-1).kind, "action_result");
  const errorsOf = () =>
    workspaceThreadRead({ repoRoot, env: {} }).messages.filter((m) => m.kind === "action_error");
  assert.equal(errorsOf().length, 1);
  assert.equal(errorsOf()[0].entity.id, "app-auto");

  // Offer is a new stage and fails once. Coming back to interview is not retried.
  await executeWorkspaceIntent({ ...h.base, intent: outcome("offer") });
  await h.settle();
  await executeWorkspaceIntent({ ...h.base, intent: outcome("interview") });
  await h.settle();
  assert.equal(errorsOf().length, 2);
});

const evalRow = {
  id: "app-eval",
  company: "Acme Platform",
  role: "Platform Engineer",
  status: "reviewed-hold",
  link: "https://jobs.example.test/acme/platform",
};
const evalIntent = { type: "job.evaluate", entity: { type: "application", id: "app-eval" } };

// An evaluateJobImpl that persists the evaluation the way the real one does.
function evaluating(repoRoot, evaluation) {
  return async () => {
    appUpsert({ repoRoot, env: {}, row: { ...evalRow, evaluation } });
    return { status: 200, body: { ok: true, data: evaluation } };
  };
}

test("an evaluation at review with fitRisks auto-runs coaching.plan once", async () => {
  const repoRoot = tempRepo();
  appUpsert({ repoRoot, env: {}, row: evalRow });
  const evaluation = {
    gate: "review",
    fitScore: 68,
    evaluatedAt: "2026-10-01T00:00:00.000Z",
    fitRisks: ["No direct Kubernetes production experience on record"],
  };
  const h = harness(repoRoot, { evaluateJobImpl: evaluating(repoRoot, evaluation) });

  await executeWorkspaceIntent({ ...h.base, intent: evalIntent });
  await h.settle();
  assert.deepEqual(h.coachCalls, ["app-eval"]);

  // The same evaluation delivered again never fires a second plan.
  await executeWorkspaceIntent({ ...h.base, intent: evalIntent });
  await h.settle();
  assert.equal(h.coachCalls.length, 1);

  // A genuinely new evaluation does.
  const next = { ...evaluation, evaluatedAt: "2026-10-02T00:00:00.000Z" };
  await executeWorkspaceIntent({
    ...h.base,
    evaluateJobImpl: evaluating(repoRoot, next),
    intent: evalIntent,
  });
  await h.settle();
  assert.equal(h.coachCalls.length, 2);
});

test("keep, cut and review without fitRisks never auto-run coaching.plan", async () => {
  const repoRoot = tempRepo();
  appUpsert({ repoRoot, env: {}, row: evalRow });
  const h = harness(repoRoot);
  const cases = [
    { gate: "keep", fitRisks: ["Some risk"] },
    { gate: "cut", fitRisks: ["Some risk"] },
    { gate: "review", fitRisks: [] },
  ];
  for (const [index, partial] of cases.entries()) {
    const evaluation = {
      fitScore: 50,
      evaluatedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
      ...partial,
    };
    await executeWorkspaceIntent({
      ...h.base,
      evaluateJobImpl: evaluating(repoRoot, evaluation),
      intent: evalIntent,
    });
    await h.settle();
  }
  assert.equal(h.coachCalls.length, 0);
});

test("a failing coaching.plan follow-up records an action_error and the evaluation still succeeds", async () => {
  const repoRoot = tempRepo();
  appUpsert({ repoRoot, env: {}, row: evalRow });
  const evaluation = {
    gate: "review",
    fitScore: 60,
    evaluatedAt: "2026-10-03T00:00:00.000Z",
    fitRisks: ["A named gap"],
  };
  const h = harness(repoRoot, {
    evaluateJobImpl: evaluating(repoRoot, evaluation),
    buildCoachingPlanImpl: async () => ({
      status: 500,
      body: { ok: false, code: "COACHING_PLAN_ERROR", error: { message: "boom" } },
    }),
  });
  const result = await executeWorkspaceIntent({ ...h.base, intent: evalIntent });
  await h.settle();
  assert.equal(result.messages.at(-1).kind, "action_result");
  const errors = workspaceThreadRead({ repoRoot, env: {} }).messages.filter(
    (m) => m.kind === "action_error"
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, "COACHING_PLAN_ERROR");
});
