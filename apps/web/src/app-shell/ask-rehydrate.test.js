// apps/web/src/app-shell/ask-rehydrate.test.js
// vitest coverage for G-09's rehydration decision logic — see
// ask-rehydrate.js's own header for what "the last completed turn" means and
// why an in-progress or failed turn is left alone.

import { describe, expect, it } from "vitest";

import { deriveLastCompletedTurn } from "./ask-rehydrate.js";

function intentMessage(overrides = {}) {
  return {
    id: "intent-1",
    sequence: 1,
    role: "user",
    kind: "intent",
    text: "Evaluate this job (application:app-acme).",
    intent: {
      type: "job.evaluate",
      entity: { type: "application", id: "app-acme" },
    },
    ...overrides,
  };
}

function actionResultMessage(overrides = {}) {
  return {
    id: "result-1",
    sequence: 2,
    role: "assistant",
    kind: "action_result",
    text: "This job clears your comp floor.",
    artifacts: [{ kind: "job_evaluation", evaluation: { verdict: "keep" } }],
    metadata: {
      intentMessageId: "intent-1",
      nextActions: [
        {
          label: "Prepare application",
          intent: {
            type: "job.generate-documents",
            entity: { type: "application", id: "app-acme" },
          },
        },
      ],
      engine: { label: "Claude" },
      elapsedMs: 4200,
    },
    ...overrides,
  };
}

describe("deriveLastCompletedTurn — empty/invalid input", () => {
  it("returns null for no messages", () => {
    expect(deriveLastCompletedTurn([])).toBeNull();
    expect(deriveLastCompletedTurn(null)).toBeNull();
    expect(deriveLastCompletedTurn(undefined)).toBeNull();
  });

  it("returns null when the last message isn't a turn-ending kind", () => {
    expect(deriveLastCompletedTurn([intentMessage()])).toBeNull(); // no reply yet
    expect(
      deriveLastCompletedTurn([{ id: "status-1", sequence: 1, role: "system", kind: "status" }])
    ).toBeNull();
    expect(
      deriveLastCompletedTurn([
        { id: "intake-1", sequence: 1, role: "assistant", kind: "intake", text: "captured" },
      ])
    ).toBeNull();
  });
});

describe("deriveLastCompletedTurn — completed action turn", () => {
  it("rebuilds a done action turn with its result card and follow-up actions intact", () => {
    const messages = [intentMessage(), actionResultMessage()];
    const turn = deriveLastCompletedTurn(messages);
    expect(turn).toMatchObject({
      kind: "action",
      status: "done",
      resultText: "This job clears your comp floor.",
      error: null,
      artifacts: [{ kind: "job_evaluation", evaluation: { verdict: "keep" } }],
      engine: { label: "Claude" },
      elapsedMs: 4200,
    });
    // Follow-up actions ride along on turn.metadata, exactly where
    // AskBarTurn's nextActions render pulls them from for a live turn.
    expect(turn.metadata.nextActions).toEqual([
      {
        label: "Prepare application",
        intent: {
          type: "job.generate-documents",
          entity: { type: "application", id: "app-acme" },
        },
      },
    ]);
    // Reused as-is by retryTurn -> commitAction if ever needed — same shape
    // commitAction's own `action` argument takes (label + intent).
    expect(turn.request).toEqual({
      label: "Evaluate this job (application:app-acme).",
      intent: {
        type: "job.evaluate",
        entity: { type: "application", id: "app-acme" },
      },
    });
  });

  it("still completes a company-review action_result even though the underlying search is running", () => {
    const messages = [
      intentMessage(),
      actionResultMessage({
        metadata: {
          intentMessageId: "intent-1",
          searchRunId: "run-1",
          searchTerminal: false,
          companyReview: true,
        },
        artifacts: [
          {
            kind: "company_proposals",
            batchId: "batch-1",
            proposals: [{ proposalId: "p1", company: { name: "Acme" } }],
          },
        ],
      }),
    ];
    const turn = deriveLastCompletedTurn(messages);
    expect(turn).toMatchObject({ kind: "action", status: "done" });
  });

  it("leaves an in-progress action alone (no completion message yet)", () => {
    const messages = [
      intentMessage(),
      actionResultMessage({
        metadata: { intentMessageId: "intent-1", searchRunId: "run-1", searchTerminal: false },
      }),
    ];
    expect(deriveLastCompletedTurn(messages)).toBeNull();
  });

  it("leaves a failed action alone", () => {
    const messages = [
      intentMessage(),
      { id: "error-1", sequence: 2, role: "assistant", kind: "action_error", text: "It broke." },
    ];
    expect(deriveLastCompletedTurn(messages)).toBeNull();
  });

  it("still completes when no matching intent message exists (e.g. a background search-completion append)", () => {
    const messages = [actionResultMessage({ metadata: { searchTerminal: true } })];
    const turn = deriveLastCompletedTurn(messages);
    expect(turn.kind).toBe("action");
    expect(turn.status).toBe("done");
    expect(turn.request).toBeNull();
  });
});

describe("deriveLastCompletedTurn — completed answer turn", () => {
  it("rebuilds a done answer turn, pairing it back to the user's question", () => {
    const messages = [
      { id: "q-1", sequence: 1, role: "user", kind: "text", text: "what's blocking my top role?" },
      {
        id: "a-1",
        sequence: 2,
        role: "assistant",
        kind: "text",
        text: "Nothing — it's ready for the next interview slot.",
        metadata: { engine: { label: "Claude" }, elapsedMs: 900 },
      },
    ];
    const turn = deriveLastCompletedTurn(messages);
    expect(turn).toMatchObject({
      kind: "answer",
      status: "done",
      resultText: "Nothing — it's ready for the next interview slot.",
      error: null,
      engine: { label: "Claude" },
      elapsedMs: 900,
      request: { text: "what's blocking my top role?", preview: null },
    });
  });

  it("leaves a failed answer alone", () => {
    const messages = [
      { id: "q-1", sequence: 1, role: "user", kind: "text", text: "what's blocking my top role?" },
      {
        id: "a-1",
        sequence: 2,
        role: "assistant",
        kind: "agent_error",
        text: "No AI engine is configured yet.",
        error: { code: "NO_AI_ROUTE" },
      },
    ];
    expect(deriveLastCompletedTurn(messages)).toBeNull();
  });

  it("ignores the imported onboarding transcript when nothing has used Ask since", () => {
    const messages = [
      {
        id: "onboarding-1",
        sequence: 1,
        role: "user",
        kind: "text",
        text: "I'm targeting senior platform roles.",
        metadata: { source: "onboarding" },
      },
      {
        id: "onboarding-2",
        sequence: 2,
        role: "assistant",
        kind: "text",
        text: "Got it — profile saved.",
        metadata: { source: "onboarding" },
      },
    ];
    expect(deriveLastCompletedTurn(messages)).toBeNull();
  });
});
