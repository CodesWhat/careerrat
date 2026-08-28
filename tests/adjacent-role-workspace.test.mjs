import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  createWorkspaceAgentRuntime,
  recordWorkspaceSearchCompletion,
} from "../src/core/agent/workspace-agent.mjs";
import { workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
} from "../src/core/db/verbs/candidate.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-adjacent-workspace-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  candidateSetupInitialize({ repoRoot, env: {} });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: {
      candidate: {
        full_name: "Morgan Example",
        headline: "Lead bartender and service trainer",
        domain: "hospitality",
      },
      location: { home: "New York, NY", onsite: true },
    },
  });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Primary",
          priority: "primary",
          titles: ["Lead Bartender", "Beverage Manager"],
        },
      ],
      keep_signals: ["guest experience", "team development"],
      cut_signals: [],
    },
  });
  candidateEvidenceMerge({
    repoRoot,
    env: {},
    claims: [
      {
        id: "service-001",
        claim: "Ran high-volume guest service and resolved escalations.",
        evidence: "Led service recovery during busy shifts.",
        role_signals: ["guest operations", "event logistics"],
      },
      {
        id: "training-001",
        claim: "Trained and coached new staff.",
        evidence: "Owned onboarding and shift coaching.",
        role_signals: ["staff training", "team coordination"],
      },
    ],
  });
  return repoRoot;
}

function completedZeroRun(id = "manual-search-zero") {
  return {
    id,
    purpose: "manual-search",
    status: "completed",
    summary: {
      attemptedSources: 4,
      scanned: 90,
      presented: 0,
      filtered: 90,
      reconciled: 90,
      errorCount: 0,
      errors: [],
    },
  };
}

function coachingCall(calls) {
  return async (input) => {
    calls.push(input);
    assert.equal(input.aiOperation, "coach.deep");
    return {
      model: "installed:claude",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            roles: [
              { title: "Event operations", evidence_refs: ["service-001"] },
              { title: "Guest operations", evidence_refs: ["service-001"] },
              { title: "Training and enablement", evidence_refs: ["training-001"] },
            ],
          }),
        },
      ],
    };
  };
}

after(() => {
  closeAll();
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});

test("a zero-result completion persists a reload-safe multi-select without changing targets", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    callAIImpl: coachingCall(calls),
  });

  const result = await runtime.recordSearchCompletion({ run: completedZeroRun() });
  const promptMessage = result.messages.at(-1);
  assert.equal(calls.length, 1);
  assert.equal(promptMessage.metadata.careerCoach.stage, "role-selection");
  assert.equal(promptMessage.metadata.choicePrompt.mode, "multi");
  assert.match(promptMessage.text, /search may be too narrow/i);
  assert.doesNotMatch(promptMessage.text, /\{|```|careerrat:/i);
  assert.deepEqual(candidateConfigGet({ repoRoot, env: {} }).targeting.role_buckets[0].titles, [
    "Lead Bartender",
    "Beverage Manager",
  ]);

  closeAll();
  const reloaded = workspaceThreadRead({ repoRoot, env: {} });
  const durable = reloaded.messages.at(-1);
  assert.equal(durable.id, promptMessage.id);
  assert.equal(durable.metadata.choicePrompt.state, "pending");
  assert.deepEqual(
    durable.metadata.choicePrompt.options.map((option) => option.label),
    ["Event operations", "Guest operations", "Training and enablement"]
  );
});

test("typed role choices ask for a separate confirmation before one idempotent expansion", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const starts = [];
  const startManualSearchImpl = async (input) => {
    starts.push(input);
    return {
      ok: true,
      reused: false,
      run: {
        id: "manual-search-expanded",
        purpose: "manual-search",
        status: "running",
        label: "Searching",
        metadata: { searchExecutionId: input.searchExecutionId },
      },
      sources: { deterministicSources: { attempted: 4 } },
    };
  };
  const runSearchInBackgroundImpl = async ({ runId }) => ({
    id: runId,
    purpose: "manual-search",
    status: "completed",
    summary: {
      attemptedSources: 4,
      scanned: 40,
      presented: 2,
      filtered: 38,
      reconciled: 40,
      errorCount: 0,
    },
  });
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    callAIImpl: coachingCall(calls),
    startManualSearchImpl,
    runSearchInBackgroundImpl,
  });
  const first = await runtime.recordSearchCompletion({ run: completedZeroRun("zero-typed") });
  const selection = first.messages.at(-1).metadata.choicePrompt;

  const selected = await runtime.runTurn({
    text: "Event operations and Training and enablement",
  });
  const confirmationMessage = selected.messages.at(-1);
  const confirmation = confirmationMessage.metadata.choicePrompt;
  assert.equal(confirmationMessage.metadata.careerCoach.stage, "confirm-expansion");
  assert.equal(confirmation.mode, "binary");
  assert.match(confirmationMessage.text, /add those as stretch targets and run a new search/i);
  assert.equal(starts.length, 0);
  assert.equal(calls.length, 1, "the deterministic choice handoff must not call Paul again");
  assert.deepEqual(candidateConfigGet({ repoRoot, env: {} }).targeting.role_buckets[0].titles, [
    "Lead Bartender",
    "Beverage Manager",
  ]);
  assert.deepEqual(selection.selectedOptionIds, undefined);

  closeAll();
  const restarted = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    callAIImpl: async () => {
      throw new Error("confirmation must not call the model");
    },
    startManualSearchImpl,
    runSearchInBackgroundImpl,
  });
  const unifiedEvents = [];
  restarted.registerAiWebSearchStarter({
    available: true,
    start: async ({ searchExecutionId, deterministic }) => {
      unifiedEvents.push(`ai:${searchExecutionId}:${deterministic.status}`);
      return { ok: true, run: { status: "completed" } };
    },
  });
  const afterReload = workspaceThreadRead({ repoRoot, env: {} });
  const durableConfirmation = afterReload.messages.at(-1).metadata.choicePrompt;
  assert.equal(durableConfirmation.id, confirmation.id);

  const confirmed = await restarted.runTurn({
    text: "Yes",
    choice: { promptId: confirmation.id, version: 1, optionIds: ["yes"] },
  });
  const expectedExecutionId = `career-coach-${confirmation.id}`;
  await restarted.waitForUnifiedSearch(expectedExecutionId);
  assert.match(confirmed.messages.at(-1).text, /added .* as stretch targets/i);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].searchExecutionId, expectedExecutionId);
  assert.deepEqual(unifiedEvents, [`ai:${expectedExecutionId}:succeeded`]);
  const config = candidateConfigGet({ repoRoot, env: {} });
  const exploration = config.targeting.role_buckets.find(
    (bucket) => bucket.name === "Career exploration"
  );
  assert.deepEqual(exploration, {
    name: "Career exploration",
    priority: "stretch",
    titles: ["Event operations", "Training and enablement"],
    notes: "Candidate-confirmed adjacent directions from career coaching.",
  });

  await assert.rejects(
    restarted.runTurn({
      text: "Yes",
      choice: { promptId: confirmation.id, version: 1, optionIds: ["yes"] },
    }),
    (error) => error.code === "STALE_CHOICE_PROMPT"
  );
  assert.equal(starts.length, 1);
  await restarted.shutdownSourcingWorkers();
});

test("a clicked role followed by a typed no leaves targeting and search untouched", async () => {
  const repoRoot = tempRepo();
  const starts = [];
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    callAIImpl: coachingCall([]),
    startManualSearchImpl: async (input) => {
      starts.push(input);
      throw new Error("declining must not start a search");
    },
  });
  const first = await runtime.recordSearchCompletion({ run: completedZeroRun("zero-decline") });
  const selection = first.messages.at(-1).metadata.choicePrompt;
  const option = selection.options[0];
  const selected = await runtime.runTurn({
    text: option.label,
    choice: { promptId: selection.id, version: 1, optionIds: [option.id] },
  });
  const confirmation = selected.messages.at(-1).metadata.choicePrompt;
  const declined = await runtime.runTurn({ text: "No" });

  assert.equal(declined.messages.at(-1).text, "Got it. I left your targets and search alone.");
  assert.equal(starts.length, 0);
  assert.equal(
    candidateConfigGet({ repoRoot, env: {} }).targeting.role_buckets.some(
      (bucket) => bucket.name === "Career exploration"
    ),
    false
  );
  assert.equal(
    declined.messages.find((message) => message.id === confirmation.messageId).metadata.choicePrompt
      .state,
    "resolved"
  );
});

test("restart recovery adds one missing coaching prompt and never duplicates it", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  recordWorkspaceSearchCompletion({ repoRoot, env: {}, run: completedZeroRun("zero-recovery") });
  assert.equal(workspaceThreadRead({ repoRoot, env: {} }).messages.length, 1);

  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    callAIImpl: coachingCall(calls),
  });
  await runtime.recoverAdjacentRoleCoaching();
  assert.equal(workspaceThreadRead({ repoRoot, env: {} }).messages.length, 2);
  assert.equal(calls.length, 0, "startup recovery must use the instant saved-evidence fallback");

  closeAll();
  const restarted = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    callAIImpl: coachingCall(calls),
  });
  await restarted.recoverAdjacentRoleCoaching();
  const messages = workspaceThreadRead({ repoRoot, env: {} }).messages;
  assert.equal(messages.length, 2);
  assert.equal(calls.length, 0);
  assert.equal(messages.at(-1).metadata.careerCoach.searchRunId, "zero-recovery");
});

test("restart recovery preserves an AI web search's attempted and found counts", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  recordWorkspaceSearchCompletion({
    repoRoot,
    env: {},
    run: {
      id: "ai-zero-recovery",
      purpose: "ai-web-search",
      status: "completed",
      summary: {
        searched: 3,
        found: 0,
        new: 0,
        errors: [],
        errorCount: 0,
      },
    },
  });
  closeAll();

  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    callAIImpl: coachingCall(calls),
  });
  await runtime.recoverAdjacentRoleCoaching();
  const messages = workspaceThreadRead({ repoRoot, env: {} }).messages;
  assert.equal(calls.length, 0);
  assert.equal(messages.at(-1).metadata.careerCoach.searchRunId, "ai-zero-recovery");
});
