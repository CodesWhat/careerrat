import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import { candidateConfigGet } from "../src/core/db/verbs/candidate.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-one-off-answer-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});

test("normalizes recurring screening questions without treating job-specific essays as reusable", async () => {
  const { isDurableScreeningQuestion, normalizeScreeningQuestionKey } = await import(
    "../src/core/packet/one-off-answer.mjs"
  );

  assert.equal(
    normalizeScreeningQuestionKey("  Q: Will you now or later require sponsorship?  "),
    "will you now or later require sponsorship"
  );
  assert.equal(
    isDurableScreeningQuestion("Are you authorized to work in the United States?"),
    true
  );
  assert.equal(isDurableScreeningQuestion("Would you relocate for this role?"), true);
  assert.equal(isDurableScreeningQuestion("What is your security clearance status?"), true);
  assert.equal(isDurableScreeningQuestion("Why do you want to work at Acme?"), false);
});

test("drafts one-off questions without overwriting a tracked packet capture and logs the answer", async () => {
  const { draftOneOffScreeningAnswers } = await import("../src/core/packet/one-off-answer.mjs");
  const repoRoot = tempRepo();
  const calls = { capture: [], activity: [] };

  const result = await draftOneOffScreeningAnswers({
    repoRoot,
    env: {},
    questionText: "Will you now or later require sponsorship?",
    captureQuestionsImpl: async (input) => {
      calls.capture.push(input);
      return {
        questions: [
          {
            id: "q1",
            label: "Will you now or later require sponsorship?",
            type: "text",
            required: true,
          },
        ],
        excluded: [],
      };
    },
    draftAnswersImpl: async () => ({
      answers: [
        {
          questionId: "q1",
          question: "Will you now or later require sponsorship?",
          answer: "No, I do not require sponsorship now or in the future.",
          source: "profile",
          evidenceIds: [],
          uploadReady: true,
          gap: null,
        },
      ],
      excludedQuestionIds: [],
      uploadReady: true,
      ai: { used: false },
      manual: { required: false },
    }),
    activityAppendImpl: (input) => calls.activity.push(input),
  });

  assert.equal(calls.capture.length, 1);
  assert.equal(calls.capture[0].applicationId, undefined);
  assert.equal(calls.capture[0].source, "paste");
  assert.equal(result.answers[0].source, "profile");
  assert.equal(result.answers[0].durable, true);
  assert.equal(result.answers[0].key, "will you now or later require sponsorship");
  assert.equal(result.persisted, false);
  assert.equal(calls.activity.length, 1);
  assert.equal(calls.activity[0].event.title, "Answered a screening question");
});

test("saving a reviewed durable answer writes candidate screening defaults and rejects job-specific prose", async () => {
  const { saveOneOffScreeningAnswer } = await import("../src/core/packet/one-off-answer.mjs");
  const repoRoot = tempRepo();

  const saved = await saveOneOffScreeningAnswer({
    repoRoot,
    env: {},
    question: "Will you now or later require sponsorship?",
    answer: "No, I do not require sponsorship now or in the future.",
  });

  assert.equal(saved.persisted, true);
  assert.equal(saved.key, "will you now or later require sponsorship");
  assert.equal(
    candidateConfigGet({ repoRoot, env: {} })["form-defaults"].screening_answers[saved.key],
    "No, I do not require sponsorship now or in the future."
  );

  await assert.rejects(
    saveOneOffScreeningAnswer({
      repoRoot,
      env: {},
      question: "Why do you want to work at Acme?",
      answer: "Acme's mission matches my background.",
    }),
    (error) => error?.code === "NON_DURABLE_ANSWER"
  );
});

test("a tracked one-off question appends to the existing answers artifact and stamps the application", async () => {
  const { draftOneOffScreeningAnswers } = await import("../src/core/packet/one-off-answer.mjs");
  const repoRoot = tempRepo();
  const answerPath = "workspace/tailored/acme-answers.md";
  const full = join(repoRoot, answerPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "# Application answers\n", "utf8");
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme",
      company: "Acme",
      role: "Accountant",
      status: "reviewed-hold",
      artifacts: { answersSource: answerPath },
    },
  });

  const result = await draftOneOffScreeningAnswers({
    repoRoot,
    env: {},
    applicationId: "app-acme",
    questionText: "What is your notice period?",
    captureQuestionsImpl: async () => ({
      questions: [{ id: "q1", label: "What is your notice period?", type: "text", required: true }],
      excluded: [],
    }),
    draftAnswersImpl: async () => ({
      answers: [
        {
          questionId: "q1",
          question: "What is your notice period?",
          answer: "My notice period is two weeks.",
          source: "profile",
          evidenceIds: [],
          uploadReady: true,
          gap: null,
        },
      ],
      excludedQuestionIds: [],
      uploadReady: true,
      ai: { used: false },
      manual: { required: false },
    }),
    buildContextImpl: () => ({ profile: {}, evidence: { claims: [] } }),
  });

  assert.equal(result.artifactPath, answerPath);
  assert.equal(existsSync(full), true);
  assert.match(readFileSync(full, "utf8"), /What is your notice period\?/);
  assert.match(readFileSync(full, "utf8"), /My notice period is two weeks\./);
  const stored = JSON.parse(
    openDb({ repoRoot, env: {} })
      .prepare("SELECT data FROM applications WHERE id = ?")
      .get("app-acme").data
  );
  assert.equal(stored.artifacts.answers, answerPath);
});
