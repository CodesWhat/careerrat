import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { EXECUTABLE_INTENTS, executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import {
  normalizeWorkspaceIntent,
  WORKSPACE_INTENT_ENTITY_TYPES,
} from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appRegisterPacketQuestionCapture, appUpsert } from "../src/core/db/verbs/app.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-prepare-submit-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

function seedPreparedApplication(repoRoot, overrides = {}) {
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-prepared",
      company: "Example Labs",
      role: "Platform Engineer",
      status: "reviewed-hold",
      link: "https://jobs.example.test/platform-engineer/apply",
      evaluation: { gate: "keep", fitScore: 91 },
      packetManifest: {
        applicationId: "app-prepared",
        uploadReady: true,
        gaps: [],
        artifacts: { resumePdf: "workspace/tailored/example-resume.pdf" },
      },
      ...overrides,
    },
  });
}

function readApplication(repoRoot) {
  const row = openDb({ repoRoot, env: {} })
    .prepare("SELECT data FROM applications WHERE id = ?")
    .get("app-prepared");
  return JSON.parse(row.data);
}

function prepareIntent(input) {
  return {
    type: "job.prepare-submit",
    entity: { type: "application", id: "app-prepared" },
    ...(input ? { input } : {}),
  };
}

function legacyApplyIntent(input) {
  return {
    type: "job.apply",
    entity: { type: "application", id: "app-prepared" },
    ...(input ? { input } : {}),
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

test("job.prepare-submit resumes a persisted KEEP packet in forced prepare-only mode", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent({ resumeSession: false, prepareOnly: false }),
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
  assert.equal(readApplication(repoRoot).status, "reviewed-hold");
  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "awaiting-submit");
  assert.equal(last.metadata.submissionVerified, false);
  assert.equal(last.artifacts[0].session.submitMode, "manual");
  assert.equal(JSON.stringify(last.metadata.nextActions).includes('"type":"job.apply"'), false);
});

test("job.apply is forced through the same prepare-only boundary and can never mark an application applied", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: legacyApplyIntent({ resumeSession: true, prepareOnly: false }),
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
  assert.equal(readApplication(repoRoot).status, "reviewed-hold");
  assert.equal(readApplication(repoRoot).appliedAt, undefined);
  const last = result.messages.at(-1);
  assert.equal(last.metadata.submissionVerified, false);
  assert.match(last.text, /not marked Applied/i);
});

test("job.prepare-submit forwards a focus-only request to the retained supervised session", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  const calls = [];

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent({ resumeSession: true, focusSession: true }),
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
    intent: prepareIntent(),
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
    intent: prepareIntent(),
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

test("job.prepare-submit never records an application even if an executor claims submission", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(),
    applyJobImpl: async () => ({
      available: true,
      verified: true,
      state: "submitted",
      submittedAt: "2026-08-23T18:00:00.000Z",
      confirmation: "Application received",
    }),
  });

  const application = readApplication(repoRoot);
  assert.equal(application.status, "reviewed-hold");
  assert.equal(application.appliedAt, undefined);
  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "manual-handoff");
  assert.equal(last.metadata.submissionVerified, false);
  assert.equal(JSON.stringify(last).includes('"type":"job.apply"'), false);
  assert.match(last.text, /not marked Applied/i);
});

test("job.prepare-submit never hands a live-question recovery off to job.apply", async () => {
  const repoRoot = tempRepo();
  seedPreparedApplication(repoRoot);
  const generations = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: prepareIntent(),
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
  assert.equal(last.metadata.nextActions[1].intent.type, "job.prepare-submit");
  assert.equal(readApplication(repoRoot).status, "reviewed-hold");
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
    intent: prepareIntent(),
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
    intent: prepareIntent(),
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
