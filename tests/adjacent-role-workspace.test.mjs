import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  createWorkspaceAgentRuntime,
  executeWorkspaceIntent,
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

test("typed role choices apply the expansion directly, once, with an Undo", async () => {
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

  const applied = await runtime.runTurn({
    text: "Event operations and Training and enablement",
  });
  const expectedExecutionId = `career-coach-${selection.id}`;
  await runtime.waitForUnifiedSearch(expectedExecutionId);
  const appliedMessage = applied.messages.find(
    (message) => message.metadata?.careerCoach?.stage === "expansion-applied"
  );
  assert.ok(appliedMessage, "the expansion applies with no second confirm step");
  assert.equal(
    applied.messages.some(
      (message) => message.metadata?.careerCoach?.stage === "confirm-expansion"
    ),
    false
  );
  assert.match(appliedMessage.text, /added .* as stretch targets/i);
  assert.equal(calls.length, 1, "the deterministic choice handoff must not call Paul again");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].searchExecutionId, expectedExecutionId);
  const config = candidateConfigGet({ repoRoot, env: {} });
  assert.deepEqual(
    config.targeting.role_buckets.find((bucket) => bucket.name === "Career exploration"),
    {
      name: "Career exploration",
      priority: "stretch",
      titles: ["Event operations", "Training and enablement"],
      notes: "Candidate-confirmed adjacent directions from career coaching.",
    }
  );

  const entry = appliedMessage.artifacts.find((artifact) => artifact.kind === "knowledge_write");
  assert.equal(entry.target, "candidate_config:targeting");
  assert.equal(entry.path, "role_buckets");
  assert.equal(entry.revertible, true);
  const undo = appliedMessage.metadata.nextActions.find(
    (action) => action.intent.type === "knowledge.revert"
  );
  assert.ok(undo);

  await assert.rejects(
    runtime.runTurn({
      text: "Event operations",
      choice: { promptId: selection.id, version: 1, optionIds: [selection.options[0].id] },
    }),
    (error) => error.code === "STALE_CHOICE_PROMPT"
  );
  assert.equal(starts.length, 1);

  const undone = await executeWorkspaceIntent({ repoRoot, env: {}, intent: undo.intent });
  assert.match(JSON.stringify(undone), /Undid: Target roles/);
  assert.equal(
    candidateConfigGet({ repoRoot, env: {} }).targeting.role_buckets.some(
      (bucket) => bucket.name === "Career exploration"
    ),
    false
  );
  await runtime.shutdownSourcingWorkers();
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
