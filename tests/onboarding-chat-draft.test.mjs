import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeOnboardingDraft, readOnboardingDraft } from "../src/cli/onboard-route.mjs";
import { candidateSetupInitialize, skillChatMessageAppend } from "../src/core/db/verbs.mjs";
import {
  collapseUnansweredOnboardingPrompts,
  onboardingHasUnansweredTurn,
} from "../src/core/onboarding/transcript-cleanup.mjs";

test("onboarding draft preserves the chat cursor and stable assistant event identity", () => {
  const normalized = normalizeOnboardingDraft({
    chatCursor: { chatId: "chat-1", eventId: 8 },
    transcript: [
      {
        id: "chat-chat-1-event-6",
        chatId: "chat-1",
        eventId: 6,
        role: "assistant",
        text: "Saved target roles.",
        blocks: [],
      },
    ],
  });

  assert.deepEqual(normalized.chatCursor, { chatId: "chat-1", eventId: 8 });
  assert.deepEqual(normalized.transcript[0], {
    id: "chat-chat-1-event-6",
    chatId: "chat-1",
    eventId: 6,
    role: "assistant",
    text: "Saved target roles.",
    blocks: [],
  });
});

test("onboarding draft preserves explicit binary answer mode from canonical metadata", () => {
  const normalized = normalizeOnboardingDraft({
    transcript: [
      {
        role: "assistant",
        text: "I need to confirm sponsorship. Reply yes or no.",
        metadata: { answerMode: "yes-no" },
      },
    ],
  });

  assert.deepEqual(normalized.transcript[0], {
    role: "assistant",
    text: "I need to confirm sponsorship. Reply yes or no.",
    answerMode: "yes-no",
    metadata: { answerMode: "yes-no" },
  });
});

test("onboarding draft removes internal system turns without treating them as candidate chat", () => {
  const normalized = normalizeOnboardingDraft({
    transcript: [
      {
        id: "internal",
        role: "user",
        text: "[SYSTEM] Candidate details saved. Continue with the next gap.",
        visibility: "internal",
      },
      { id: "candidate", role: "user", text: "Remote in the US works for me." },
    ],
  });

  assert.deepEqual(normalized.transcript, [
    { id: "candidate", role: "user", text: "Remote in the US works for me." },
  ]);
});

test("onboarding prompt cleanup preserves opposite-polarity questions", () => {
  const transcript = [
    { id: "targets", role: "assistant", text: "Which roles are you targeting?" },
    { id: "exclusions", role: "assistant", text: "Which roles are you not targeting?" },
  ];

  assert.deepEqual(
    collapseUnansweredOnboardingPrompts(transcript).map((message) => message.id),
    ["targets", "exclusions"]
  );
});

test("onboarding detects a question followed by examples as waiting for the user", () => {
  assert.equal(
    onboardingHasUnansweredTurn([
      {
        role: "assistant",
        text: "What kinds of companies sound good to you? For example, a small growing company, a stable large employer, or an organization whose work you care about.",
      },
    ]),
    true
  );
});

test("onboarding detects a question followed by a short consequence as waiting for the user", () => {
  const salaryQuestion = {
    id: "salary-question",
    role: "assistant",
    text: "What’s the lowest base salary you’d accept for any job? I’ll skip anything clearly below it.",
    blocks: [{ kind: "candidate_patch", status: "resolved" }],
  };

  assert.equal(onboardingHasUnansweredTurn([salaryQuestion]), true);
  assert.deepEqual(
    collapseUnansweredOnboardingPrompts([
      salaryQuestion,
      { ...salaryQuestion, id: "salary-repeat-1", blocks: [] },
      { ...salaryQuestion, id: "salary-repeat-2", blocks: [] },
    ]).map((message) => message.id),
    ["salary-repeat-2"]
  );
});

test("onboarding draft read fills a stale browser transcript from canonical skill chat history", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-onboarding-chat-draft-"));
  const env = {};
  try {
    candidateSetupInitialize({ repoRoot, env });
    for (const message of [
      { role: "assistant", text: "Which locations work for you?" },
      { role: "user", text: "Remote in the US works for me." },
      { role: "assistant", text: "What is your minimum base salary?" },
      {
        role: "user",
        text: "[SYSTEM] The user confirmed the location. Continue.",
        visibility: "internal",
      },
    ]) {
      skillChatMessageAppend({ repoRoot, env, skill: "ingest-profile", ...message });
    }
    const internalDir = join(repoRoot, ".careerrat", "internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(
      join(internalDir, "onboarding-draft.json"),
      JSON.stringify({
        transcript: [{ role: "assistant", text: "Which locations work for you?", blocks: [] }],
      }),
      "utf8"
    );

    const draft = readOnboardingDraft({ repoRoot, env });
    assert.deepEqual(
      draft.transcript.map(({ role, text }) => ({ role, text })),
      [
        { role: "assistant", text: "Which locations work for you?" },
        { role: "user", text: "Remote in the US works for me." },
        { role: "assistant", text: "What is your minimum base salary?" },
      ]
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("onboarding draft read collapses only duplicate unanswered prompts", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-onboarding-chat-collapse-"));
  const env = {};
  try {
    candidateSetupInitialize({ repoRoot, env });
    for (const message of [
      {
        role: "assistant",
        text: "Which work arrangements would you accept: remote, hybrid, on-site, or relocation?",
      },
      { role: "user", text: "Dropped resume: jordan-resume.md" },
      {
        role: "assistant",
        text: "I have your home base as Brooklyn. Which arrangements would you accept: remote, hybrid, on-site, or relocation?",
      },
      { role: "user", text: "Remote and hybrid work for me." },
      { role: "assistant", text: "Which roles are you targeting?" },
      { role: "assistant", text: "What salary are you targeting?" },
    ]) {
      skillChatMessageAppend({ repoRoot, env, skill: "ingest-profile", ...message });
    }

    const draft = readOnboardingDraft({ repoRoot, env });
    assert.deepEqual(
      draft.transcript.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "Dropped resume: jordan-resume.md" },
        {
          role: "assistant",
          text: "I have your home base as Brooklyn. Which arrangements would you accept: remote, hybrid, on-site, or relocation?",
        },
        { role: "user", text: "Remote and hybrid work for me." },
        { role: "assistant", text: "Which roles are you targeting?" },
        { role: "assistant", text: "What salary are you targeting?" },
      ]
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("onboarding draft read repairs prefaced and prematurely stacked historical questions", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-onboarding-chat-history-"));
  const env = {};
  try {
    candidateSetupInitialize({ repoRoot, env });
    for (const message of [
      {
        role: "assistant",
        text: "Got it. What’s your LinkedIn profile URL?",
      },
      { role: "assistant", text: "What’s your LinkedIn profile URL?" },
      { role: "user", text: "https://linkedin.com/in/example" },
      {
        role: "assistant",
        text: "Are there any role families or seniority levels you want to exclude?",
      },
      {
        role: "assistant",
        text: "What’s the minimum base salary a fully remote role needs to offer?",
      },
      { role: "user", text: "Exclude people management and frontend-only roles." },
      {
        role: "assistant",
        text: "Saved those exclusions. What’s the minimum base salary a fully remote role needs to offer?",
      },
      {
        role: "assistant",
        text: "What’s the minimum base salary a fully remote role needs to offer?",
      },
      { role: "user", text: "$180,000 base" },
    ]) {
      skillChatMessageAppend({ repoRoot, env, skill: "ingest-profile", ...message });
    }

    const draft = readOnboardingDraft({ repoRoot, env });
    assert.deepEqual(
      draft.transcript.map(({ role, text }) => ({ role, text })),
      [
        { role: "assistant", text: "What’s your LinkedIn profile URL?" },
        { role: "user", text: "https://linkedin.com/in/example" },
        {
          role: "assistant",
          text: "Are there any role families or seniority levels you want to exclude?",
        },
        { role: "user", text: "Exclude people management and frontend-only roles." },
        {
          role: "assistant",
          text: "What’s the minimum base salary a fully remote role needs to offer?",
        },
        { role: "user", text: "$180,000 base" },
      ]
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
