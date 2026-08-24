import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeOnboardingDraft, readOnboardingDraft } from "../src/cli/onboard-route.mjs";
import { candidateSetupInitialize, skillChatMessageAppend } from "../src/core/db/verbs.mjs";

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
