import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { EXECUTABLE_INTENTS, executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import {
  normalizeWorkspaceIntent,
  WORKSPACE_INTENT_ENTITY_TYPES,
} from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  appMarkSubmitAttempt,
  appPersistEvaluation,
  appRegisterPacketQuestionCapture,
  appSetFields,
  appUpsert,
} from "../src/core/db/verbs/app.mjs";
import { candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";
import { missionCreate } from "../src/core/db/verbs/chat-first.mjs";
import { capturePacketJobBody } from "../src/core/packet/context.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-prepare-submit-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

function seedPreparedApplication(repoRoot, overrides = {}) {
  const evaluatedAt = "2026-08-19T00:00:00.000Z";
  const evaluation = { gate: "keep", fitScore: 91, evaluatedAt };
  const jdBody = "Build reliable platform systems for enterprise customers in production.";
  const jdPath = "workspace/jobs/example-platform-engineer.md";
  mkdirSync(join(repoRoot, "workspace", "jobs"), { recursive: true });
  writeFileSync(
    join(repoRoot, jdPath),
    [
      "---",
      'company: "Example Labs"',
      'role: "Platform Engineer"',
      "---",
      "",
      "# Job Description",
      "",
      jdBody,
      "",
    ].join("\n")
  );
  const basePacketManifest = {
    applicationId: "app-prepared",
    uploadReady: true,
    gaps: [],
    artifacts: { resumePdf: "workspace/tailored/example-resume.pdf" },
    provenance: {
      jd: {
        path: jdPath,
        sha256: createHash("sha256").update(jdBody).digest("hex"),
      },
      evaluation: {
        evaluatedAt,
        sha256: createHash("sha256")
          .update(JSON.stringify(stableValue(evaluation)))
          .digest("hex"),
      },
    },
  };
  const packetManifest = Object.hasOwn(overrides, "packetManifest")
    ? overrides.packetManifest == null
      ? overrides.packetManifest
      : { ...basePacketManifest, ...overrides.packetManifest }
    : basePacketManifest;
  const { packetManifest: _packetManifestOverride, ...rowOverrides } = overrides;
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-prepared",
      company: "Example Labs",
      role: "Platform Engineer",
      status: "reviewed-hold",
      link: "https://jobs.example.test/platform-engineer/apply",
      evaluation,
      artifacts: { jd: jdPath },
      packetManifest,
      ...rowOverrides,
    },
  });
}

function readApplication(repoRoot, id = "app-prepared") {
  const row = openDb({ repoRoot, env: {} })
    .prepare("SELECT data FROM applications WHERE id = ?")
    .get(id);
  return JSON.parse(row.data);
}

function prepareIntent(input, repoRoot, applicationId = "app-prepared") {
  const missionAttempt = repoRoot
    ? seedCurrentPrepareAttempt(repoRoot, {
        applicationId,
        missionId:
          applicationId === "app-prepared" ? "mission-prepare" : `mission-${applicationId}`,
      })
    : null;
  return {
    type: "job.prepare-submit",
    entity: { type: "application", id: applicationId },
    ...(input || missionAttempt
      ? { input: { ...(input || {}), ...(missionAttempt ? { missionAttempt } : {}) } }
      : {}),
  };
}

function legacyApplyIntent(input, repoRoot) {
  const missionAttempt = repoRoot ? seedCurrentPrepareAttempt(repoRoot) : null;
  return {
    type: "job.apply",
    entity: { type: "application", id: "app-prepared" },
    ...(input || missionAttempt
      ? { input: { ...(input || {}), ...(missionAttempt ? { missionAttempt } : {}) } }
      : {}),
  };
}

function seedCurrentPrepareAttempt(
  repoRoot,
  {
    attemptId = "attempt-current",
    applicationId = "app-prepared",
    missionId = "mission-prepare",
  } = {}
) {
  missionCreate({
    repoRoot,
    env: {},
    id: missionId,
    title: "Prepare application",
    mode: "prepare-to-submit",
    steps: [
      {
        id: "prepare",
        label: "Prepare form",
        action: "prepare-submit",
        jobRef: { type: "application", id: applicationId },
      },
    ],
  });
  const db = openDb({ repoRoot, env: {} });
  const row = db
    .prepare("SELECT data FROM mission_steps WHERE mission_id = ? AND id = ?")
    .get(missionId, "prepare");
  const step = JSON.parse(row.data);
  step.status = "running";
  step.currentAttempt = {
    id: attemptId,
    fence: 1,
    status: "running",
    startedAt: "2026-08-27T14:00:00.000Z",
    leaseExpiresAt: "2099-08-27T14:10:00.000Z",
    idempotency: {
      key: `${missionId}:prepare`,
      classification: "receipt-required",
    },
    executionPlan: {
      policyVersion: 1,
      operation: "application.drafting",
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
    },
  };
  db.prepare("UPDATE mission_steps SET data = ? WHERE mission_id = ? AND id = ?").run(
    JSON.stringify(step),
    missionId,
    "prepare"
  );
  return {
    missionId,
    stepId: "prepare",
    attemptId: step.currentAttempt.id,
    fence: step.currentAttempt.fence,
    idempotencyKey: step.currentAttempt.idempotency.key,
    idempotencyClassification: step.currentAttempt.idempotency.classification,
  };
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("job.prepare-submit is executable only for application entities", () => {
  assert.deepEqual(WORKSPACE_INTENT_ENTITY_TYPES["job.prepare-submit"], ["application"]);
  assert.equal(EXECUTABLE_INTENTS.has("job.prepare-submit"), true);
  assert.deepEqual(normalizeWorkspaceIntent(prepareIntent()), prepareIntent());
  assert.throws(
    () =>
      normalizeWorkspaceIntent({
        type: "job.prepare-submit",
        entity: { type: "sourced", id: "source-1" },
      }),
    (error) => error.code === "BAD_INTENT_ENTITY"
  );
});

test("browser-touching application intents reject direct calls without a current mission attempt", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  let applyCalls = 0;

  for (const intent of [prepareIntent(), legacyApplyIntent({ resumeSession: true })]) {
    await assert.rejects(
      () =>
        executeWorkspaceIntent({
          repoRoot,
          env: {},
          intent,
          applyJobImpl: async () => {
            applyCalls += 1;
            return { available: true, verified: false, state: "awaiting-submit" };
          },
        }),
      (error) => error.code === "APPLICATION_MISSION_ATTEMPT_REQUIRED"
    );
  }
  assert.equal(applyCalls, 0);
});

test("browser-touching application intents reject forged and stale mission attempt ids", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  const current = seedCurrentPrepareAttempt(repoRoot);

  for (const missionAttempt of [
    { ...current, missionId: "mission-forged", stepId: "prepare" },
    {
      ...current,
      missionId: "mission-prepare",
      stepId: "prepare",
      attemptId: "attempt-stale",
    },
  ]) {
    await assert.rejects(
      () =>
        executeWorkspaceIntent({
          repoRoot,
          env: {},
          intent: prepareIntent({ missionAttempt }),
          applyJobImpl: async () => ({
            available: true,
            verified: false,
            state: "awaiting-submit",
          }),
        }),
      (error) => error.code === "APPLICATION_MISSION_ATTEMPT_STALE"
    );
  }
});

test("job.prepare-submit resumes a persisted KEEP packet in forced prepare-only mode", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "manual");
  const calls = [];
  const controller = new AbortController();

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent({ resumeSession: false, prepareOnly: false }, repoRoot),
    signal: controller.signal,
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        reason: "Review and submit in the supervised browser.",
        currentUrl: "https://jobs.example.test/platform-engineer/review",
        session: {
          provider: "test",
          filledCount: 5,
          uploadedCount: 1,
          unresolved: [],
          blockers: [],
          submitMode: "manual",
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].applicationId, "app-prepared");
  assert.equal(calls[0].prepareOnly, true);
  assert.equal(calls[0].input.resumeSession, true);
  assert.equal(calls[0].input.prepareOnly, true);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[0].input.executionPlan.runtimeId, "codex");
  assert.equal(calls[0].input.executionPlan.operation, "application.drafting");
  assert.equal(readApplication(repoRoot).status, "reviewed-hold");
  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "awaiting-submit");
  assert.equal(last.metadata.submissionVerified, false);
  assert.equal(last.artifacts[0].session.submitMode, "manual");
  assert.equal(JSON.stringify(last.metadata.nextActions).includes('"type":"job.apply"'), false);
});

test("job.apply keeps the user-owned Submit boundary and records a verified submission", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "manual");
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: legacyApplyIntent({ resumeSession: true, prepareOnly: false }, repoRoot),
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        available: true,
        verified: true,
        state: "submitted",
        submittedAt: "2026-08-24T18:00:00.000Z",
        confirmation: "Application received",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].prepareOnly, true);
  assert.equal(calls[0].input.prepareOnly, true);
  assert.equal(readApplication(repoRoot).status, "applied");
  assert.equal(readApplication(repoRoot).appliedAt, "2026-08-24T18:00:00.000Z");
  const last = result.messages.at(-1);
  assert.equal(last.metadata.submissionVerified, true);
  assert.equal(last.metadata.state, "applied");
  assert.equal(last.metadata.nextActions, undefined);
});

test("job.prepare-submit forwards a focus-only request to the retained supervised session", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  const calls = [];

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent({ resumeSession: true, focusSession: true }, repoRoot),
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        reason: "Focused the prepared browser session.",
        currentUrl: "https://jobs.example.test/platform-engineer/review",
        session: { provider: "test", focused: true, prepareOnly: true },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].focusSession, true);
  assert.equal(calls[0].prepareOnly, true);
  assert.equal(calls[0].input.focusSession, true);
  assert.equal(readApplication(repoRoot).status, "reviewed-hold");
});

test("job.prepare-submit does not block form filling on an optional cover-letter review", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot, {
    packetManifest: {
      applicationId: "app-prepared",
      uploadReady: false,
      gaps: [
        {
          kind: "coverLetter",
          code: "COVER_LETTER_CONFIRMATION",
          message: "Review and confirm the cover letter proof points.",
        },
      ],
      artifacts: { resumePdf: "workspace/tailored/example-resume.pdf" },
    },
  });
  let applyCalls = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async () => {
      applyCalls += 1;
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        reason: "Review the filled form.",
        session: { provider: "test", filledCount: 4, submitMode: "manual" },
      };
    },
  });

  assert.equal(applyCalls, 1);
  assert.equal(result.messages.at(-1).metadata.state, "awaiting-submit");
  assert.equal(readApplication(repoRoot).status, "reviewed-hold");
});

test("job.prepare-submit blocks before opening a browser when persisted safety state is incomplete", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot, { packetManifest: undefined });
  let applyCalls = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async () => {
      applyCalls += 1;
      return { verified: false, state: "awaiting-submit" };
    },
  });

  assert.equal(applyCalls, 0);
  assert.equal(result.messages.at(-1).metadata.state, "blocked");
  assert.match(result.messages.at(-1).text, /packet/i);
  assert.equal(readApplication(repoRoot).status, "reviewed-hold");
});

test("job.prepare-submit rebuilds a legacy packet with no JD and evaluation provenance", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot, {
    packetManifest: {
      applicationId: "app-prepared",
      uploadReady: true,
      gaps: [],
      artifacts: { resumePdf: "workspace/tailored/example-resume.pdf" },
      provenance: undefined,
    },
  });
  let generateCalls = 0;
  let applyCalls = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    generateDocumentsImpl: async () => {
      generateCalls += 1;
      return {
        status: "reviewable",
        uploadReady: false,
        gaps: [{ kind: "review", code: "PACKET_PROVENANCE_REQUIRED", message: "Rebuild." }],
        artifacts: {},
      };
    },
    applyJobImpl: async () => {
      applyCalls += 1;
      return { available: true, verified: false, state: "awaiting-submit" };
    },
  });

  assert.equal(generateCalls, 1);
  assert.equal(applyCalls, 0);
  assert.equal(result.messages.at(-1).metadata.state, "blocked");
  assert.match(result.messages.at(-1).text, /packet inputs changed|rebuilt/i);
});

test("job.prepare-submit rebuilds after the JD is recaptured and reevaluated", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  capturePacketJobBody({
    repoRoot,
    env: {},
    applicationId: "app-prepared",
    body: "Lead a newly expanded platform reliability and customer migration program.",
    sourceUrl: "https://jobs.example.test/platform-engineer/apply",
  });
  const reevaluation = {
    gate: "keep",
    fitScore: 94,
    evaluatedAt: "2026-08-20T00:00:00.000Z",
  };
  appPersistEvaluation({
    repoRoot,
    env: {},
    id: "app-prepared",
    evaluation: reevaluation,
    projection: { evaluation: reevaluation },
  });
  const generations = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    generateDocumentsImpl: async ({ body }) => {
      generations.push(body);
      return {
        status: "reviewable",
        uploadReady: false,
        gaps: [{ kind: "review", code: "PACKET_PROVENANCE_STALE", message: "Rebuild." }],
        artifacts: {},
      };
    },
    applyJobImpl: async () => {
      throw new Error("stale documents reached the browser");
    },
  });

  assert.equal(generations.length, 1);
  assert.equal(generations[0].force, true);
  assert.equal(result.messages.at(-1).metadata.state, "blocked");
});

test("job.prepare-submit records Applied when the executor verifies the user's submission", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async () => ({
      available: true,
      verified: true,
      state: "submitted",
      submittedAt: "2026-08-23T18:00:00.000Z",
      confirmation: "Application received",
    }),
  });

  const application = readApplication(repoRoot);
  assert.equal(application.status, "applied");
  assert.equal(application.appliedAt, "2026-08-23T18:00:00.000Z");
  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "applied");
  assert.equal(last.metadata.submissionVerified, true);
  assert.equal(last.metadata.nextActions, undefined);
  assert.equal(JSON.stringify(last).includes('"type":"job.apply"'), false);
  assert.match(last.text, /verified.*recorded.*Applied/i);
});

test("job.prepare-submit never hands a live-question recovery off to job.apply", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  const generations = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async () => {
      appRegisterPacketQuestionCapture({
        repoRoot,
        env: {},
        id: "app-prepared",
        path: "workspace/jobs/example-rendered.questions.json",
        questions: [
          { id: "q1", label: "Why this role?" },
          { id: "rendered-travel", label: "Would you be willing to travel?", required: true },
        ],
        excluded: [],
      });
      return {
        available: true,
        verified: false,
        state: "questions-captured",
        questionCaptureUpdated: true,
        session: { provider: "test" },
      };
    },
    generateDocumentsImpl: async ({ body }) => {
      generations.push({
        force: body.force,
        answerableIds: readApplication(repoRoot).packetManifest.questions.answerableIds,
      });
      return {
        status: "needs-input",
        uploadReady: false,
        gaps: [
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            message: "Answer “Would you be willing to travel?”.",
          },
        ],
        artifacts: {},
      };
    },
  });

  assert.deepEqual(generations, [{ force: true, answerableIds: ["q1", "rendered-travel"] }]);
  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "blocked");
  assert.equal(last.metadata.submissionVerified, false);
  assert.equal(JSON.stringify(last).includes('"type":"job.apply"'), false);
  assert.equal(
    last.metadata.nextActions.some((action) => action.intent?.type === "job.prepare-submit"),
    false
  );
  assert.equal(readApplication(repoRoot).status, "reviewed-hold");
});

test("job.prepare-submit treats open answer gaps as current packet lineage", async () => {
  const repoRoot = tempRepo();
  const openGap = {
    kind: "answers",
    code: "ANSWER_CONFIRMATION_REQUIRED",
    questionId: "rendered-travel",
    message: "Answer “Would you be willing to travel?”.",
  };
  seedPreparedApplication(repoRoot, {
    packetManifest: {
      applicationId: "app-prepared",
      uploadReady: false,
      status: "reviewable",
      gapCount: 1,
      gaps: [openGap],
      questions: {
        source: "workspace/jobs/example-rendered.questions.json",
        answerableCount: 2,
        excludedCount: 0,
        answerableIds: ["q1", "rendered-travel"],
        excludedIds: [],
      },
      answerLineage: {
        answeredQuestionIds: ["q1"],
        skippedQuestionIds: [],
        excludedQuestionIds: [],
        source: "workspace/jobs/example-rendered.questions.json",
      },
      artifacts: { resumePdf: "workspace/tailored/example-resume.pdf" },
    },
  });
  let generateCalls = 0;
  let applyCalls = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    generateDocumentsImpl: async () => {
      generateCalls += 1;
      return {
        status: "reviewable",
        uploadReady: false,
        gaps: [openGap],
        artifacts: {},
      };
    },
    applyJobImpl: async () => {
      applyCalls += 1;
      return { available: true, verified: false, state: "awaiting-submit" };
    },
  });

  assert.equal(generateCalls, 0);
  assert.equal(applyCalls, 0);
  assert.equal(result.messages.at(-1).metadata.state, "blocked");
  assert.match(result.messages.at(-1).text, /open items/i);
});

test("job.prepare-submit rebuilds a packet whose answer lineage predates its saved live questions", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot, {
    packetManifest: {
      applicationId: "app-prepared",
      uploadReady: true,
      gaps: [],
      questions: {
        source: "workspace/jobs/example-rendered.questions.json",
        answerableCount: 2,
        excludedCount: 0,
        answerableIds: ["q1", "rendered-travel"],
        excludedIds: [],
      },
      answerLineage: {
        answeredQuestionIds: ["q1"],
        excludedQuestionIds: [],
        source: "workspace/jobs/example-rendered.questions.json",
      },
      artifacts: { resumePdf: "workspace/tailored/example-resume.pdf" },
    },
  });
  const generations = [];
  let applyCalls = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async () => {
      applyCalls += 1;
      return { available: true, verified: false, state: "awaiting-submit" };
    },
    generateDocumentsImpl: async ({ body }) => {
      generations.push(body);
      return {
        status: "reviewable",
        uploadReady: false,
        gaps: [
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            message: "Answer “Would you be willing to travel?”.",
          },
        ],
        artifacts: { answers: "workspace/tailored/example-answers.md" },
      };
    },
  });

  assert.equal(applyCalls, 0, "the stale packet is reviewed before the browser can resume");
  assert.equal(generations.length, 1);
  assert.equal(generations[0].force, true);
  assert.equal(generations[0].applyIntent, true);
  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "blocked");
  assert.equal(last.metadata.blockingGapCount, 1);
  assert.match(last.text, /captured application questions changed/i);
  assert.match(last.artifacts[0].gaps[0].message, /willing to travel/i);
});

test("job.prepare-submit treats an intentionally skipped optional question as current lineage", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot, {
    packetManifest: {
      applicationId: "app-prepared",
      uploadReady: true,
      gaps: [],
      questions: {
        source: "workspace/jobs/example-rendered.questions.json",
        answerableCount: 4,
        excludedCount: 0,
        answerableIds: ["q1", "q2", "q3", "portfolio"],
        excludedIds: [],
      },
      answerLineage: {
        answeredQuestionIds: ["q1", "q2", "q3"],
        skippedQuestionIds: ["portfolio"],
        excludedQuestionIds: [],
        source: "workspace/jobs/example-rendered.questions.json",
      },
      artifacts: { resumePdf: "workspace/tailored/example-resume.pdf" },
    },
  });
  let generateCalls = 0;
  let applyCalls = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    generateDocumentsImpl: async () => {
      generateCalls += 1;
      throw new Error("current lineage must not regenerate");
    },
    applyJobImpl: async () => {
      applyCalls += 1;
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        reason: "Review the prepared form.",
        session: { provider: "test", filledCount: 3, submitMode: "manual" },
      };
    },
  });

  assert.equal(generateCalls, 0);
  assert.equal(applyCalls, 1);
  assert.equal(result.messages.at(-1).metadata.state, "awaiting-submit");
});

function setSubmitMode(repoRoot, mode) {
  candidateConfigPatch({ repoRoot, env: {}, name: "automation", patch: { submit: mode } });
}

test("submit auto: job.prepare-submit calls the executor unlocked and records a verified Applied", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        available: true,
        verified: true,
        state: "submitted",
        submittedAt: "2026-10-26T18:00:00.000Z",
        confirmation: "thank you for applying",
        artifacts: [
          { kind: "submission_confirmation", title: "Verified", path: "workspace/captures/x.png" },
        ],
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].prepareOnly, false);
  assert.equal(calls[0].submitMode, "auto");
  assert.equal(calls[0].input.prepareOnly, false);
  assert.equal(calls[0].input.submitMode, "auto");
  const application = readApplication(repoRoot);
  assert.equal(application.status, "applied");
  assert.equal(application.appliedAt, "2026-10-26T18:00:00.000Z");
  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "applied");
  assert.equal(last.metadata.submissionVerified, true);
  assert.equal(last.artifacts[0].kind, "submission_confirmation");
});

test("submit auto: job.apply resumes with the same unlocked executor call", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");
  const calls = [];

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: legacyApplyIntent({ resumeSession: true }, repoRoot),
    applyJobImpl: async (input) => {
      calls.push(input);
      return { available: true, verified: true, state: "submitted", confirmation: "ok" };
    },
  });

  assert.equal(calls[0].prepareOnly, false);
  assert.equal(calls[0].submitMode, "auto");
  assert.equal(readApplication(repoRoot).status, "applied");
});

test("submit auto: a focus-only request never unlocks submit", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");
  const calls = [];

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent({ resumeSession: true, focusSession: true }, repoRoot),
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        session: { provider: "test" },
      };
    },
  });

  assert.equal(calls[0].prepareOnly, true);
  assert.equal(calls[0].submitMode, "manual");
});

test("submit auto: submitted-unverified leaves the status alone and records a note, next action and thread message", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async () => ({
      available: true,
      verified: false,
      state: "submitted-unverified",
      reason: 'CareerRat clicked "Submit application" but no confirmation page appeared.',
      currentUrl: "https://jobs.example.test/platform-engineer/apply",
      artifacts: [
        {
          kind: "submission_attempt",
          title: "Page after submit (no confirmation seen)",
          path: "workspace/captures/attempt.png",
        },
      ],
    }),
  });

  const application = readApplication(repoRoot);
  assert.equal(application.status, "reviewed-hold");
  assert.equal(application.appliedAt, undefined);
  assert.match(application.statusNote, /no confirmation page/i);
  assert.match(application.nextAction, /confirm|check/i);
  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "submitted-unverified");
  assert.equal(last.metadata.submissionVerified, false);
  assert.match(last.metadata.reason, /no confirmation page/);
  assert.match(last.text, /submitted.*no confirmation/i);
  assert.match(last.text, /not marked Applied/i);
  assert.equal(
    last.artifacts.some((item) => item.path === "workspace/captures/attempt.png"),
    true
  );
  assert.equal(
    last.metadata.nextActions.some(
      (action) => action.intent.type === "application.record-external"
    ),
    true
  );
});

test("submit auto: a declined click puts Paul's reason in the thread text and metadata", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async () => ({
      available: true,
      verified: false,
      state: "awaiting-submit",
      reason: "Review the live form and submit it in the supervised browser.",
      session: {
        provider: "test",
        submitMode: "auto",
        autoSubmitStopped: { reason: "1 required field still needs an answer" },
      },
    }),
  });

  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "awaiting-submit");
  assert.deepEqual(last.metadata.autoSubmitStopped, {
    reason: "1 required field still needs an answer",
  });
  assert.match(
    last.text,
    /^CareerRat filled the form but stopped before submitting: 1 required field still needs an answer\./
  );
  assert.match(last.text, /not marked Applied/i);
});

test("submit manual: an awaiting-submit thread message keeps the original press-submit copy", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "manual");

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async () => ({
      available: true,
      verified: false,
      state: "awaiting-submit",
      reason: "Review the live form and submit it in the supervised browser.",
      session: { provider: "test", submitMode: "manual", filledCount: 2 },
    }),
  });

  const last = result.messages.at(-1);
  assert.equal(last.metadata.autoSubmitStopped, undefined);
  assert.equal(
    last.text,
    'CareerRat filled 2 fields. Review the live form and submit it in the supervised browser. Open the application, check the answers and attachments, finish any remaining fields, and press submit when everything looks right. Then return here and choose "I applied". This application was not marked Applied.'
  );
});

test("submit auto: a verified thread message keeps the submission packet next to the receipt", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async () => ({
      available: true,
      verified: true,
      state: "submitted",
      confirmation: "thank you for applying",
      artifacts: [
        { kind: "submission_confirmation", title: "Verified", path: "workspace/captures/x.png" },
        {
          kind: "submission_packet",
          title: "What was sent",
          answers: [{ label: "Full name", value: "Jordan Rivera" }],
          attachments: [{ label: "Resume/CV", name: "resume.pdf" }],
        },
      ],
    }),
  });

  const last = result.messages.at(-1);
  const kinds = last.artifacts.map((artifact) => artifact.kind);
  assert.deepEqual(kinds, [
    "submission_confirmation",
    "submission_packet",
    "application_status_receipt",
  ]);
  assert.deepEqual(last.artifacts[1].answers, [{ label: "Full name", value: "Jordan Rivera" }]);
});

test("submit manual: an explicit manual setting keeps the executor in prepare-only mode", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "manual");
  const calls = [];

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        session: { provider: "test" },
      };
    },
  });

  assert.equal(calls[0].prepareOnly, true);
  assert.equal(calls[0].submitMode, "manual");
  assert.equal(calls[0].input.prepareOnly, true);
});

test("submit auto: a CUT gate still refuses before any browser call", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot, {
    evaluation: { gate: "cut", fitScore: 20, evaluatedAt: "2026-08-19T00:00:00.000Z" },
  });
  setSubmitMode(repoRoot, "auto");
  let applyCalls = 0;

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: prepareIntent(null, repoRoot),
      applyJobImpl: async () => {
        applyCalls += 1;
        return { available: true, verified: true, state: "submitted" };
      },
    }),
    { code: "PACKET_GATE_REQUIRED" }
  );

  assert.equal(applyCalls, 0);
  assert.equal(readApplication(repoRoot).status, "reviewed-hold");
});

const unverifiedExecution = () => ({
  available: true,
  verified: false,
  state: "submitted-unverified",
  reason: 'CareerRat clicked "Submit application" but no confirmation page appeared.',
  currentUrl: "https://jobs.example.test/platform-engineer/apply",
  artifacts: [
    { kind: "submission_attempt", title: "After submit", path: "workspace/captures/a.png" },
  ],
});

test("submit auto: submitted-unverified persists submitAttemptedAt on the application row", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    now: () => new Date("2026-10-26T19:00:00.000Z"),
    applyJobImpl: async () => unverifiedExecution(),
  });

  const application = readApplication(repoRoot);
  assert.equal(application.submitAttemptedAt, "2026-10-26T19:00:00.000Z");
  assert.equal(application.status, "reviewed-hold");
});

test("submit auto: a fresh run on an already submitted-unverified application never unlocks submit and says why", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");
  const intent = prepareIntent(null, repoRoot);
  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent,
    applyJobImpl: async () => unverifiedExecution(),
  });

  const calls = [];
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent,
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        reason: "Review the form.",
        session: { provider: "test" },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].prepareOnly, true);
  assert.equal(calls[0].submitMode, "manual");
  assert.equal(calls[0].input.prepareOnly, true);
  const last = result.messages.at(-1);
  assert.match(last.text, /already pressed Submit once without a confirmation/i);
  assert.match(last.text, /will not press it again/i);
});

test("submit auto: the marker is history once the application is recorded as applied", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot, {
    status: "applied",
    submitAttemptedAt: "2026-10-26T19:00:00.000Z",
  });
  setSubmitMode(repoRoot, "auto");
  const calls = [];

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async (input) => {
      calls.push(input);
      return { available: true, verified: true, state: "submitted", confirmation: "ok" };
    },
  });

  assert.equal(calls[0].prepareOnly, false);
  assert.equal(readApplication(repoRoot).submitAttemptedAt, "2026-10-26T19:00:00.000Z");
});

test("submit auto: a different application in the same workspace still auto-submits", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot, { submitAttemptedAt: "2026-10-26T19:00:00.000Z" });
  seedPreparedApplication(repoRoot, {
    id: "app-other",
    packetManifest: { applicationId: "app-other" },
  });
  setSubmitMode(repoRoot, "auto");
  const calls = [];

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot, "app-other"),
    applyJobImpl: async (input) => {
      calls.push(input);
      return { available: true, verified: true, state: "submitted", confirmation: "ok" };
    },
  });

  assert.equal(calls[0].applicationId, "app-other");
  assert.equal(calls[0].prepareOnly, false);
  assert.equal(calls[0].submitMode, "auto");
  assert.equal(readApplication(repoRoot, "app-other").status, "applied");
});

test("submitAttemptedAt is not settable through the generic appSetFields path", () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot, { submitAttemptedAt: "2026-10-26T19:00:00.000Z" });

  assert.throws(
    () =>
      appSetFields({
        repoRoot,
        env: {},
        id: "app-prepared",
        patch: { submitAttemptedAt: null },
      }),
    { code: "APP_FIELDS_FORBIDDEN" }
  );
  assert.equal(readApplication(repoRoot).submitAttemptedAt, "2026-10-26T19:00:00.000Z");
});

test("appMarkSubmitAttempt sets the marker once and never overwrites it", () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);

  const first = appMarkSubmitAttempt({
    repoRoot,
    env: {},
    id: "app-prepared",
    at: "2026-10-26T19:00:00.000Z",
  });
  const second = appMarkSubmitAttempt({
    repoRoot,
    env: {},
    id: "app-prepared",
    at: "2026-10-27T01:00:00.000Z",
  });

  assert.equal(first.marked, true);
  assert.equal(second.marked, false);
  assert.equal(second.at, "2026-10-26T19:00:00.000Z");
  assert.equal(readApplication(repoRoot).submitAttemptedAt, "2026-10-26T19:00:00.000Z");
});

test("submit auto: the executor gets a hook that persists the marker before any click", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");
  let markerAtHook = "unset";

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    now: new Date("2026-10-26T20:00:00.000Z"),
    applyJobImpl: async (input) => {
      assert.equal(typeof input.onSubmitAttempt, "function");
      await input.onSubmitAttempt({ applicationId: input.applicationId });
      markerAtHook = readApplication(repoRoot).submitAttemptedAt;
      return { available: true, verified: true, state: "submitted", confirmation: "ok" };
    },
  });

  assert.equal(markerAtHook, "2026-10-26T20:00:00.000Z");
});

test("submit auto: a committed marker counts even when the tracker export after it fails", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");
  let hookError = null;

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    now: new Date("2026-10-26T21:00:00.000Z"),
    applyJobImpl: async (input) => {
      // Force exportToTracker to fail after the marker commits: a directory at
      // the tracker.json path makes the atomic write throw EISDIR.
      const trackerPath = userPath({ repoRoot, env: {} }, "workspace/tracker.json");
      rmSync(trackerPath, { force: true });
      mkdirSync(trackerPath, { recursive: true });
      try {
        await input.onSubmitAttempt({ applicationId: input.applicationId });
      } catch (error) {
        hookError = error;
      }
      rmSync(trackerPath, { recursive: true, force: true });
      return { available: true, verified: true, state: "submitted", confirmation: "ok" };
    },
  });

  assert.equal(hookError, null, "a committed marker must not abort the submit");
  assert.equal(readApplication(repoRoot).submitAttemptedAt, "2026-10-26T21:00:00.000Z");
});

test("submit manual: no submit-attempt hook is passed", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "manual");
  const calls = [];

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(null, repoRoot),
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        session: { provider: "test" },
      };
    },
  });

  assert.equal(calls[0].onSubmitAttempt, undefined);
});

test("submit auto: an abort right after the click still leaves the marker and a fresh run refuses", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  setSubmitMode(repoRoot, "auto");
  const intent = prepareIntent(null, repoRoot);

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent,
      now: () => new Date("2026-10-26T21:00:00.000Z"),
      applyJobImpl: async (input) => {
        await input.onSubmitAttempt({ applicationId: input.applicationId });
        const abort = new Error("aborted after click");
        abort.name = "AbortError";
        throw abort;
      },
    })
  );
  assert.equal(readApplication(repoRoot).submitAttemptedAt, "2026-10-26T21:00:00.000Z");

  const calls = [];
  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent,
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        session: { provider: "test" },
      };
    },
  });
  assert.equal(calls[0].prepareOnly, true);
  assert.equal(calls[0].submitMode, "manual");
  assert.equal(calls[0].onSubmitAttempt, undefined);
});
