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
  writeFileSync(
    full,
    "# Application answers\n\n## What is your notice period?*\n\nNEEDS YOU\n",
    "utf8"
  );
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme",
      company: "Acme",
      role: "Accountant",
      status: "reviewed-hold",
      artifacts: { answersSource: answerPath },
      packetManifest: {
        applicationId: "app-acme",
        uploadReady: false,
        status: "reviewable",
        gapCount: 1,
        gaps: [
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q1",
            message: "Answer “What is your notice period?”.",
          },
        ],
        artifacts: { answersSource: answerPath },
      },
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
  assert.equal(result.answers[0].questionId, "q1");
  assert.equal(result.answers[0].confirmationRequired, true);
  assert.equal(existsSync(full), true);
  const markdown = readFileSync(full, "utf8");
  assert.match(markdown, /## What is your notice period\?\*\n\nNEEDS YOU/);
  assert.match(markdown, /careerrat-screening:what is your notice period/);
  assert.match(markdown, /My notice period is two weeks\./);
  const stored = JSON.parse(
    openDb({ repoRoot, env: {} })
      .prepare("SELECT data FROM applications WHERE id = ?")
      .get("app-acme").data
  );
  assert.equal(stored.artifacts.answers, answerPath);
});

test("a tracked one-off answer without a matching open packet gap is not confirmable", async () => {
  const { draftOneOffScreeningAnswers } = await import("../src/core/packet/one-off-answer.mjs");
  const repoRoot = tempRepo();
  const answerPath = "workspace/tailored/acme-no-gap-answers.md";
  const full = join(repoRoot, answerPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "# Application answers\n", "utf8");
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme-no-gap",
      company: "Acme",
      role: "Accountant",
      status: "reviewed-hold",
      artifacts: { answersSource: answerPath },
      packetManifest: {
        applicationId: "app-acme-no-gap",
        uploadReady: false,
        status: "reviewable",
        gapCount: 1,
        gaps: [
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q-location",
            message: "Answer “Can you work from our New York office?”.",
          },
        ],
        artifacts: { answersSource: answerPath },
      },
    },
  });

  const result = await draftOneOffScreeningAnswers({
    repoRoot,
    env: {},
    applicationId: "app-acme-no-gap",
    questionText: "What is your notice period?",
    captureQuestionsImpl: async () => ({
      questions: [{ id: "q-notice", label: "What is your notice period?" }],
      excluded: [],
    }),
    draftAnswersImpl: async () => ({
      answers: [
        {
          questionId: "q-notice",
          question: "What is your notice period?",
          answer: "My notice period is two weeks.",
          source: "profile",
          uploadReady: true,
        },
      ],
      ai: { used: false },
    }),
    buildContextImpl: () => ({ profile: {}, evidence: { claims: [] } }),
  });

  assert.equal(result.answers[0].questionId, "q-notice");
  assert.equal(result.answers[0].confirmationRequired, false);
});

test("confirmation refuses duplicate-label packet gaps when no exact question id is supplied", async () => {
  const { confirmOneOffScreeningAnswer } = await import("../src/core/packet/one-off-answer.mjs");
  const repoRoot = tempRepo();
  const answerPath = "workspace/tailored/acme-ambiguous-answers.md";
  const full = join(repoRoot, answerPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "# Application answers\n", "utf8");
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme-ambiguous",
      company: "Acme",
      role: "Accountant",
      status: "reviewed-hold",
      artifacts: { answersSource: answerPath },
      packetManifest: {
        applicationId: "app-acme-ambiguous",
        uploadReady: false,
        status: "reviewable",
        gapCount: 2,
        gaps: [
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q-one",
            message: "Answer “Confirm your availability”.",
          },
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q-two",
            message: "Answer “Confirm your availability”.",
          },
        ],
        artifacts: { answersSource: answerPath },
      },
    },
  });

  await assert.rejects(
    confirmOneOffScreeningAnswer({
      repoRoot,
      env: {},
      applicationId: "app-acme-ambiguous",
      question: "Confirm your availability",
      answer: "I am available in two weeks.",
    }),
    (error) => error?.code === "ANSWER_CONFIRMATION_AMBIGUOUS"
  );
  assert.equal(readFileSync(full, "utf8"), "# Application answers\n");
});

test("confirmation refuses an exact gap id paired with a different question without mutating state", async () => {
  const { confirmOneOffScreeningAnswer } = await import("../src/core/packet/one-off-answer.mjs");
  const repoRoot = tempRepo();
  const answerPath = "workspace/tailored/acme-mismatched-answer.md";
  const full = join(repoRoot, answerPath);
  mkdirSync(dirname(full), { recursive: true });
  const originalMarkdown = [
    "# Application answers",
    "",
    "## What is your notice period?",
    "",
    "NEEDS YOU",
    "",
    "## Can you work from New York?",
    "",
    "NEEDS YOU",
    "",
  ].join("\n");
  writeFileSync(full, originalMarkdown, "utf8");
  const packetManifest = {
    applicationId: "app-acme-mismatched-answer",
    uploadReady: false,
    status: "reviewable",
    gapCount: 2,
    gaps: [
      {
        kind: "answers",
        code: "ANSWER_CONFIRMATION_REQUIRED",
        questionId: "q-notice",
        message: "Answer “What is your notice period?”.",
      },
      {
        kind: "answers",
        code: "ANSWER_CONFIRMATION_REQUIRED",
        questionId: "q-location",
        message: "Answer “Can you work from New York?”.",
      },
    ],
    artifacts: { answersSource: answerPath },
  };
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme-mismatched-answer",
      company: "Acme",
      role: "Accountant",
      status: "reviewed-hold",
      artifacts: { answersSource: answerPath },
      packetManifest,
    },
  });

  await assert.rejects(
    confirmOneOffScreeningAnswer({
      repoRoot,
      env: {},
      applicationId: "app-acme-mismatched-answer",
      questionId: "q-notice",
      question: "Can you work from New York?",
      answer: "Yes, I can work from New York.",
    }),
    (error) => error?.code === "ANSWER_CONFIRMATION_MISMATCH"
  );

  assert.equal(readFileSync(full, "utf8"), originalMarkdown);
  const stored = JSON.parse(
    openDb({ repoRoot, env: {} })
      .prepare("SELECT data FROM applications WHERE id = ?")
      .get("app-acme-mismatched-answer").data
  );
  assert.deepEqual(stored.packetManifest, packetManifest);
});

test("grouped confirmation reconciles every exact answer gap and preserves unrelated gaps", async () => {
  const { confirmOneOffScreeningAnswer } = await import("../src/core/packet/one-off-answer.mjs");
  const repoRoot = tempRepo();
  const answerPath = "workspace/tailored/acme-grouped-answers.md";
  const full = join(repoRoot, answerPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    [
      "# Application answers",
      "",
      "## What is your notice period?",
      "",
      "NEEDS YOU",
      "",
      "## Can you work from New York?",
      "",
      "NEEDS YOU",
      "",
      "## What are your salary expectations?",
      "",
      "NEEDS YOU",
      "",
    ].join("\n"),
    "utf8"
  );
  const gaps = [
    {
      kind: "answers",
      code: "ANSWER_CONFIRMATION_REQUIRED",
      questionId: "q-notice",
      message: "Answer “What is your notice period?”.",
    },
    {
      kind: "answers",
      code: "ANSWER_CONFIRMATION_REQUIRED",
      questionId: "q-location",
      message: "Answer “Can you work from New York?”.",
    },
    {
      kind: "answers",
      code: "ANSWER_CONFIRMATION_REQUIRED",
      questionId: "q-comp",
      message: "Answer “What are your salary expectations?”.",
    },
  ];
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme-grouped",
      company: "Acme",
      role: "Accountant",
      status: "reviewed-hold",
      artifacts: { answersSource: answerPath },
      packetManifest: {
        applicationId: "app-acme-grouped",
        generatedAt: "2026-08-24T12:00:00.000Z",
        uploadReady: false,
        status: "reviewable",
        gapCount: gaps.length,
        gaps,
        artifacts: { answersSource: answerPath },
      },
    },
  });

  const result = await confirmOneOffScreeningAnswer({
    repoRoot,
    env: {},
    applicationId: "app-acme-grouped",
    answers: [
      {
        questionId: "q-notice",
        question: "What is your notice period?",
        answer: "My notice period is two weeks.",
      },
      {
        questionId: "q-location",
        question: "Can you work from New York?",
        answer: "Yes, I can work from New York.",
      },
    ],
  });

  assert.equal(result.packetManifest.gapCount, 1);
  assert.deepEqual(result.packetManifest.gaps, [gaps[2]]);
  assert.equal(result.answers.length, 2);
  assert.deepEqual(result.packetManifest.confirmedAnswers, [
    {
      questionId: "q-notice",
      question: "What is your notice period?",
      answer: "My notice period is two weeks.",
      confirmedAt: result.packetManifest.confirmedAnswers[0].confirmedAt,
    },
    {
      questionId: "q-location",
      question: "Can you work from New York?",
      answer: "Yes, I can work from New York.",
      confirmedAt: result.packetManifest.confirmedAnswers[1].confirmedAt,
    },
  ]);
  const markdown = readFileSync(full, "utf8");
  assert.match(markdown, /## What is your notice period\?\n\nMy notice period is two weeks\./);
  assert.match(markdown, /## Can you work from New York\?\n\nYes, I can work from New York\./);
  assert.match(markdown, /## What are your salary expectations\?\n\nNEEDS YOU/);
});

test("confirming a tracked one-off answer reconciles only its packet gap through the packet writer", async () => {
  const { confirmOneOffScreeningAnswer } = await import("../src/core/packet/one-off-answer.mjs");
  assert.equal(typeof confirmOneOffScreeningAnswer, "function");

  const repoRoot = tempRepo();
  const answerPath = "workspace/tailored/acme-answers.md";
  const full = join(repoRoot, answerPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "# Application answers\n", "utf8");
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme-confirm",
      company: "Acme",
      role: "Accountant",
      status: "reviewed-hold",
      artifacts: { answersSource: answerPath },
      packetManifest: {
        applicationId: "app-acme-confirm",
        generatedAt: "2026-08-24T12:00:00.000Z",
        uploadReady: false,
        status: "reviewable",
        gapCount: 2,
        gaps: [
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q-notice",
            message: "Answer “What is your notice period?”.",
          },
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q-location",
            message: "Answer “Can you work from our New York office?”.",
          },
        ],
        artifacts: { answersSource: answerPath },
      },
    },
  });

  const result = await confirmOneOffScreeningAnswer({
    repoRoot,
    env: {},
    applicationId: "app-acme-confirm",
    questionId: "q-notice",
    question: "What is your notice period?",
    answer: "My notice period is two weeks.",
  });

  assert.equal(result.persisted, true);
  assert.equal(result.packetManifest.gapCount, 1);
  assert.equal(result.packetManifest.uploadReady, false);
  assert.equal(result.packetManifest.status, "reviewable");
  assert.deepEqual(result.packetManifest.gaps, [
    {
      kind: "answers",
      code: "ANSWER_CONFIRMATION_REQUIRED",
      questionId: "q-location",
      message: "Answer “Can you work from our New York office?”.",
    },
  ]);
  assert.equal(result.packetManifest.artifacts.answers, answerPath);
  assert.equal(result.packetManifest.artifacts.answersSource, answerPath);

  const stored = JSON.parse(
    openDb({ repoRoot, env: {} })
      .prepare("SELECT data FROM applications WHERE id = ?")
      .get("app-acme-confirm").data
  );
  assert.equal(stored.artifacts.answers, answerPath);
  assert.equal(stored.artifacts.answersSource, answerPath);
  assert.equal(typeof stored.artifacts.answersGeneratedAt, "string");
  assert.deepEqual(stored.packetManifest, result.packetManifest);
  assert.match(readFileSync(full, "utf8"), /What is your notice period\?/);
  assert.match(readFileSync(full, "utf8"), /My notice period is two weeks\./);
});

test("confirming replaces the matching rendered NEEDS YOU answer without disturbing other questions", async () => {
  const { confirmOneOffScreeningAnswer } = await import("../src/core/packet/one-off-answer.mjs");
  const repoRoot = tempRepo();
  const answerPath = "workspace/tailored/acme-rendered-answers.md";
  const full = join(repoRoot, answerPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    [
      "# Application Answers",
      "",
      "## What is your notice period?*",
      "",
      "NEEDS YOU",
      "",
      "## Can you work from our New York office?*",
      "",
      "NEEDS YOU: confirm the required schedule.",
      "",
      "<!-- careerrat-screening:what is your notice period -->",
      "**Q:** What is your notice period?",
      "",
      "**A:** My notice period is two weeks.",
      "<!-- /careerrat-screening:what is your notice period -->",
      "",
    ].join("\n"),
    "utf8"
  );
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme-rendered-confirm",
      company: "Acme",
      role: "Accountant",
      status: "reviewed-hold",
      artifacts: { answersSource: answerPath },
      packetManifest: {
        applicationId: "app-acme-rendered-confirm",
        generatedAt: "2026-08-24T12:00:00.000Z",
        uploadReady: false,
        status: "reviewable",
        gapCount: 2,
        gaps: [
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q-notice",
            message: "Answer “What is your notice period?*”.",
          },
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q-location",
            message: "Answer “Can you work from our New York office?*”.",
          },
        ],
        artifacts: { answersSource: answerPath },
      },
    },
  });

  await confirmOneOffScreeningAnswer({
    repoRoot,
    env: {},
    applicationId: "app-acme-rendered-confirm",
    questionId: "q-notice",
    question: "What is your notice period?",
    answer: "My notice period is two weeks.",
  });

  const markdown = readFileSync(full, "utf8");
  assert.match(markdown, /## What is your notice period\?\*\n\nMy notice period is two weeks\./);
  assert.doesNotMatch(markdown, /careerrat-screening:what is your notice period/);
  assert.match(
    markdown,
    /## Can you work from our New York office\?\*\n\nNEEDS YOU: confirm the required schedule\./
  );
  assert.equal((markdown.match(/My notice period is two weeks\./g) || []).length, 1);
});

test("confirming an answer cannot clear a packet gap without a tracked answers artifact", async () => {
  const { confirmOneOffScreeningAnswer } = await import("../src/core/packet/one-off-answer.mjs");
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme-missing-answers",
      company: "Acme",
      role: "Accountant",
      status: "reviewed-hold",
      packetManifest: {
        applicationId: "app-acme-missing-answers",
        generatedAt: "2026-08-24T12:00:00.000Z",
        uploadReady: false,
        status: "reviewable",
        gapCount: 1,
        gaps: [
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q-notice",
            message: "Answer “What is your notice period?”.",
          },
        ],
        artifacts: {},
      },
    },
  });

  await assert.rejects(
    confirmOneOffScreeningAnswer({
      repoRoot,
      env: {},
      applicationId: "app-acme-missing-answers",
      questionId: "q-notice",
      question: "What is your notice period?",
      answer: "My notice period is two weeks.",
    }),
    (error) => error?.code === "BAD_PACKET_ARTIFACT"
  );

  const stored = JSON.parse(
    openDb({ repoRoot, env: {} })
      .prepare("SELECT data FROM applications WHERE id = ?")
      .get("app-acme-missing-answers").data
  );
  assert.equal(stored.packetManifest.gapCount, 1);
  assert.equal(stored.packetManifest.uploadReady, false);
  assert.equal(stored.artifacts?.answers, undefined);
});
