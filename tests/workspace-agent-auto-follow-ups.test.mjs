// CR72 slice 72d: company-health and coaching.plan run on their own when their
// trigger is met. The follow-up is scheduled through an injected scheduler so
// the tests stay deterministic and never reach an AI route.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { planAutoFollowUps, snapshotApplicationState } from "../src/core/agent/cost-gate-auto.mjs";
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

test("an application created inside the write counts as new, so its review verdict still plans coaching", () => {
  const repoRoot = tempRepo();
  const before = snapshotApplicationState({ repoRoot, env: {} });
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-new",
      company: "Lakeside Clinic",
      role: "Charge Nurse",
      status: "evaluating",
      evaluation: {
        gate: "review",
        evaluatedAt: "2026-10-03T00:00:00.000Z",
        fitRisks: ["No charge nurse title on record"],
      },
    },
  });
  const due = planAutoFollowUps({ repoRoot, env: {}, before });
  assert.deepEqual(
    due.map((followUp) => [followUp.intent.type, followUp.intent.entity.id]),
    [["coaching.plan", "app-new"]]
  );
});

test("two writes landing together schedule one follow-up, not two", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const queued = [];
  const healthCalls = [];
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    startCompanyHealthImpl: async (input) => {
      healthCalls.push(input);
      return { chat: { chatId: "ch-2", skill: "company-health", state: "running" } };
    },
    scheduleAutoFollowUp: (run) => queued.push(run),
    aiRouteAvailableImpl: () => true,
  });
  const before = runtime.snapshotApplicationState();
  appSetStatus({ repoRoot, env: {}, id: "app-auto", to: "interview" });
  runtime.afterApplicationWrite(before);
  runtime.afterApplicationWrite(before);
  assert.equal(queued.length, 1);
  await Promise.all(queued.map((run) => run()));
  assert.equal(healthCalls.length, 1);
});

test("the AI-route probe runs inside the detached follow-up, never on the write's path", () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const queued = [];
  let probes = 0;
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    startCompanyHealthImpl: async () => ({ chat: { chatId: "ch-3", state: "running" } }),
    scheduleAutoFollowUp: (run) => queued.push(run),
    aiRouteAvailableImpl: () => {
      probes += 1;
      return true;
    },
  });
  const before = runtime.snapshotApplicationState();
  appSetStatus({ repoRoot, env: {}, id: "app-auto", to: "interview" });
  runtime.afterApplicationWrite(before);
  assert.equal(queued.length, 1);
  assert.equal(probes, 0);
});

test("an automatic company-health run that only reopens another check says it didn't start", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const h = harness(repoRoot, {
    startCompanyHealthImpl: async () => ({
      chat: { chatId: "ch-other", skill: "company-health", state: "running", reused: true },
    }),
  });
  await executeWorkspaceIntent({ ...h.base, intent: outcome("interview") });
  await h.settle();
  const texts = workspaceThreadRead({ repoRoot, env: {} }).messages.map((message) => message.text);
  assert.ok(texts.some((text) => /Didn't start the automatic company-health check/.test(text)));
});

// Cost gate recheck: the plan that scheduled a detached run can be stale by the
// time it executes.
test("a follow-up scheduled while due skips with a recorded reason when it is no longer due at run time", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot);
  const pending = [];
  const h = harness(repoRoot, { scheduleAutoFollowUp: (run) => pending.push(run) });

  await executeWorkspaceIntent({ ...h.base, intent: outcome("interview") });
  assert.equal(pending.length, 1, "due at schedule time");

  // The job is rejected before the detached run starts.
  appSetStatus({ repoRoot, env: {}, id: "app-auto", to: "rejected" });
  await Promise.all(pending.splice(0).map((run) => run()));

  assert.equal(h.healthCalls.length, 0, "no paid work");
  const thread = workspaceThreadRead({ repoRoot, env: {} });
  assert.equal(thread.messages.filter((m) => m.kind === "action_error").length, 0);
  assert.equal(
    thread.messages.filter((m) => m.kind === "intent" && m.intent.type === "company.health").length,
    0
  );
  const note = thread.messages.find((m) => m.kind === "status");
  assert.equal(note.metadata.autoFollowUp.skipped, "no-longer-due");
  assert.match(note.text, /no longer due/);
});

// NEEDS YOU auto-resume.
const QUESTION = "Why do you want to work at Riverside Health?";

function resumeHarness(repoRoot, { applyResult, confirmQuestion = QUESTION } = {}) {
  const base = harness(repoRoot);
  const applyCalls = [];
  const confirmed = [];
  return {
    ...base,
    applyCalls,
    confirmed,
    options: {
      ...base.base,
      evaluateJobImpl: async ({ body }) => ({
        status: 200,
        body: {
          ok: true,
          data: {
            applicationId: body.applicationId,
            gate: "keep",
            fitScore: 92,
            fitReasons: ["Strong fit"],
            manual: { required: false },
          },
        },
      }),
      generateDocumentsImpl: async () => ({
        status: "ready",
        uploadReady: true,
        gaps: [],
        artifacts: {},
      }),
      confirmScreeningAnswerImpl: async ({ applicationId, question, answer }) => {
        confirmed.push(question);
        return {
          applicationId,
          answers: [{ question: question || confirmQuestion, answer, key: "q" }],
          packetManifest: { uploadReady: true, gaps: [] },
        };
      },
      resolveMissionExecutionPlanImpl: ({ operation }) => ({
        policyVersion: 1,
        operation,
        runtimeId: "codex",
        adapterVersion: 1,
        requested: { quality: "best", reasoning: "medium" },
        resolved: {
          quality: "best",
          reasoning: "medium",
          model: "gpt-5.6-sol",
          modelSource: "alias",
          effort: "medium",
          speedTier: null,
        },
        fallback: null,
      }),
      saveScreeningAnswerImpl: async (input) => ({ key: input.key, persisted: true }),
      applyJobImpl: async (input) => {
        applyCalls.push({ submitMode: input.submitMode, prepareOnly: input.prepareOnly });
        if (applyResult) return applyResult(input);
        return input.submitMode === "auto"
          ? { verified: true, submittedAt: "2026-11-18T12:00:00.000Z" }
          : { available: true, verified: false, state: "awaiting-submit", session: {} };
      },
    },
  };
}

const confirmIntent = (question = QUESTION, id = "app-auto") => ({
  type: "screening.answer-confirm",
  entity: { type: "application", id },
  input: { questionId: "q1", question, answer: "I want to care for my community." },
});

// A packet that already passed the evaluate-job gate, as it is when a job pauses
// on an open question: current evaluation, JD and provenance on record.
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function pausedOverrides(repoRoot, extra = {}) {
  const evaluation = {
    gate: "keep",
    fitScore: 92,
    evaluatedAt: "2026-11-18T11:00:00.000Z",
  };
  const body = "Care for patients across the Riverside Health network.";
  const jdPath = "workspace/jobs/riverside-rn.md";
  mkdirSync(join(repoRoot, "workspace", "jobs"), { recursive: true });
  writeFileSync(
    join(repoRoot, jdPath),
    `---\ncompany: "Riverside Health"\nrole: "Registered Nurse"\n---\n\n# Job Description\n\n${body}\n`,
    "utf8"
  );
  return {
    status: "reviewed-hold",
    evaluation,
    artifacts: { jd: jdPath },
    packetManifest: {
      uploadReady: true,
      gaps: [],
      provenance: {
        jd: { path: jdPath, sha256: createHash("sha256").update(body).digest("hex") },
        evaluation: {
          evaluatedAt: evaluation.evaluatedAt,
          sha256: createHash("sha256")
            .update(JSON.stringify(stableValue(evaluation)))
            .digest("hex"),
        },
      },
    },
    ...extra,
  };
}

const app = (repoRoot, id = "app-auto") =>
  JSON.parse(
    openDb({ repoRoot, env: {} }).prepare("SELECT data FROM applications WHERE id = ?").get(id).data
  );

test("auto mode: saving the last open answer re-runs the apply and submits once, a second save does not", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot, pausedOverrides(repoRoot));
  const h = resumeHarness(repoRoot);

  await executeWorkspaceIntent({ ...h.options, intent: confirmIntent() });
  await h.settle();
  assert.deepEqual(h.applyCalls, [{ submitMode: "auto", prepareOnly: false }]);
  assert.equal(app(repoRoot).status, "applied");

  await executeWorkspaceIntent({ ...h.options, intent: confirmIntent() });
  await h.settle();
  assert.equal(h.applyCalls.length, 1, "no second submit");
});

test("auto mode: two saves landing together schedule one resume", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot, pausedOverrides(repoRoot));
  const pending = [];
  const h = resumeHarness(repoRoot);
  const options = { ...h.options, scheduleAutoFollowUp: (run) => pending.push(run) };

  await executeWorkspaceIntent({ ...options, intent: confirmIntent() });
  await executeWorkspaceIntent({ ...options, intent: confirmIntent() });
  assert.equal(pending.length, 1);
  await Promise.all(pending.splice(0).map((run) => run()));
  assert.equal(h.applyCalls.length, 1);
});

test("auto mode: an attestation answer re-runs the apply but never submits", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot, pausedOverrides(repoRoot));
  const h = resumeHarness(repoRoot);

  await executeWorkspaceIntent({
    ...h.options,
    intent: confirmIntent("Did you use AI to prepare this application?"),
  });
  await h.settle();
  assert.deepEqual(h.applyCalls, [{ submitMode: "manual", prepareOnly: true }]);
  assert.equal(app(repoRoot).status, "reviewed-hold");
  const held = workspaceThreadRead({ repoRoot, env: {} }).messages.find(
    (m) => m.metadata?.autoResume?.held
  );
  assert.match(held.text, /won't press Submit.*vouch for your answers or disclose AI use/);
});

test("auto mode: a LinkedIn job re-runs the apply but never submits", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot, pausedOverrides(repoRoot, { link: "https://www.linkedin.com/jobs/view/12345/" }));
  const h = resumeHarness(repoRoot, {});

  await executeWorkspaceIntent({
    ...h.options,
    resolveJobUrlImpl: async () => ({ url: null }),
    intent: confirmIntent(),
  });
  await h.settle();
  assert.notEqual(app(repoRoot).status, "applied");
  assert.ok(
    h.applyCalls.every((call) => call.submitMode !== "auto"),
    "no auto submit on LinkedIn"
  );
  const held = workspaceThreadRead({ repoRoot, env: {} }).messages.find(
    (m) => m.metadata?.autoResume?.held
  );
  assert.match(held.text, /LinkedIn/);
});

test("auto mode: an unresolved required upload re-runs the apply and pauses without submitting", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot, pausedOverrides(repoRoot));
  const h = resumeHarness(repoRoot, {
    applyResult: () => ({
      available: true,
      verified: false,
      state: "awaiting-submit",
      reason: "A required upload is unresolved.",
      session: {
        provider: "orca",
        unresolved: [{ label: "Transcript", required: true, kind: "file" }],
        blockers: [],
        submitMode: "auto",
      },
    }),
  });

  await executeWorkspaceIntent({ ...h.options, intent: confirmIntent() });
  await h.settle();
  assert.equal(h.applyCalls.length, 1);
  assert.equal(app(repoRoot).status, "reviewed-hold");
  const last = workspaceThreadRead({ repoRoot, env: {} }).messages.at(-1);
  assert.equal(last.metadata.state, "awaiting-submit");
  assert.equal(last.metadata.submissionVerified, false);
});

test("supervised mode: saving the last answer offers the Resume button and does not re-run", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot, pausedOverrides(repoRoot));
  candidateConfigPatch({ repoRoot, env: {}, name: "automation", patch: { submit: "manual" } });
  const h = resumeHarness(repoRoot);

  const result = await executeWorkspaceIntent({ ...h.options, intent: confirmIntent() });
  await h.settle();
  assert.equal(h.applyCalls.length, 0);
  assert.equal(result.messages.at(-1).metadata.nextActions[0].intent.type, "job.prepare-submit");
});

test("auto mode with autoFollowUps off (CLI, tests) never re-runs", async () => {
  const repoRoot = tempRepo();
  seed(repoRoot, pausedOverrides(repoRoot));
  const h = resumeHarness(repoRoot);
  await executeWorkspaceIntent({ ...h.options, autoFollowUps: false, intent: confirmIntent() });
  await h.settle();
  assert.equal(h.applyCalls.length, 0);
});
