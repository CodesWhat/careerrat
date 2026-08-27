import { describe, expect, it, vi } from "vitest";
import {
  buildDeepIngestProposalItem,
  buildDeepIngestReview,
  buildProposalsAndRefresh,
  captureSourceAndRefresh,
  decideProposalAndRefresh,
  removeSourceAndRefresh,
  resolveDeepIngestTextDecision,
  retrySourceAndRefresh,
} from "./deep-ingest-controller.js";

function proposal(overrides = {}) {
  return {
    id: "proposal-1",
    sourceId: "source-1",
    lane: "story_bank",
    status: "review_needed",
    version: 3,
    proposal: {
      payload: {
        title: "Billing migration",
        summary: "Led the billing migration across three services.",
        result: "Reduced reconciliation time by 31%.",
      },
      supportingQuote: "Reduced reconciliation time by 31%.",
      validation: { status: "valid" },
    },
    ...overrides,
  };
}

function state(overrides = {}) {
  const pending = proposal();
  return {
    sources: [
      {
        id: "source-1",
        sourceKind: "paste",
        status: "proposal_ready",
        textPreview: "Led the billing migration across three services.",
      },
    ],
    proposals: [pending],
    reviewQueue: [pending],
    confirmed: {
      evidence: [{ id: "evidence-1" }],
      storyBank: [{ id: "story-1" }],
      honestyBoundaries: [],
      writingVoice: [],
      roleSignals: [],
    },
    counts: { sources: 1, proposals: 1, reviewQueue: 1, openGaps: 0, confirmed: 2 },
    ...overrides,
  };
}

describe("deep ingest chat-first controller", () => {
  it.each([
    ["Confirm", "confirm"],
    ["yes, confirm this", "confirm"],
    ["looks good", "confirm"],
    ["Defer", "defer"],
    ["review this later", "defer"],
    ["not now", "defer"],
    ["Reject", "reject"],
    ["not relevant", "reject"],
    ["skip this", "reject"],
  ])("routes typed %s through the active proposal decision", (text, decision) => {
    const row = proposal();

    expect(resolveDeepIngestTextDecision({ text, proposals: [row] })).toEqual({
      proposal: row,
      decision,
    });
  });

  it("does not turn ordinary pasted material or an empty queue into a proposal decision", () => {
    expect(
      resolveDeepIngestTextDecision({
        text: "Led the billing migration and reduced reconciliation time by 31%.",
        proposals: [proposal()],
      })
    ).toBeNull();
    expect(resolveDeepIngestTextDecision({ text: "Confirm", proposals: [] })).toBeNull();
  });

  it("builds review cards from the durable queue and filters scan placeholders", () => {
    const scanStub = proposal({
      id: "scan-stub",
      proposal: {
        payload: {},
        supportingQuote: "",
        validation: { status: "source_scanned" },
      },
    });
    const manualFallback = proposal({
      id: "manual-fallback",
      proposal: {
        status: "manual_fallback",
        payload: {},
        supportingQuote: "",
        validation: { status: "valid" },
      },
    });
    const review = buildDeepIngestReview(
      state({
        proposals: [proposal(), scanStub, manualFallback],
        reviewQueue: [proposal(), scanStub, manualFallback],
        counts: { sources: 1, proposals: 3, reviewQueue: 3, openGaps: 0, confirmed: 2 },
      })
    );

    expect(review.proposals).toEqual([
      expect.objectContaining({
        id: "proposal-1",
        title: "Billing migration",
        summary: "Led the billing migration across three services.",
        supportingQuote: "Reduced reconciliation time by 31%.",
      }),
    ]);
    expect(review.counts).toEqual({
      sources: 1,
      proposals: 3,
      reviewQueue: 1,
      confirmed: 2,
      openGaps: 0,
    });
    expect(review.evidenceItems).toContain("2 confirmed items");
    expect(review.lastSession).toContain("Pasted notes");
  });

  it("falls back to review-needed proposals when reviewQueue is not present", () => {
    const confirmed = proposal({ id: "confirmed", status: "confirmed" });
    const input = state({ proposals: [proposal(), confirmed] });
    delete input.reviewQueue;

    expect(buildDeepIngestReview(input).proposals.map((row) => row.id)).toEqual(["proposal-1"]);
  });

  it.each(["failed", "manual_fallback"])(
    "gives a %s source plain recovery guidance and retry/remove controls",
    (status) => {
      const review = buildDeepIngestReview(
        state({
          sources: [
            {
              id: "source-failed",
              sourceKind: "paste",
              status,
              textPreview: "Career notes that could not be read.",
            },
          ],
          proposals: [],
          reviewQueue: [],
        })
      );

      expect(review.sources[0]).toMatchObject({
        id: "source-failed",
        statusLabel: "CareerRat couldn't read this source. Try again or remove it.",
        canAnalyze: false,
        canRetry: true,
        canRemove: true,
      });
    }
  );

  it("preserves lane-specific payload fields in reviewer edits", () => {
    expect(
      buildDeepIngestProposalItem(proposal(), {
        title: "Reviewer title",
        summary: "Reviewer summary",
        supportingQuote: "Reviewer quote",
      })
    ).toEqual({
      title: "Reviewer title",
      summary: "Reviewer summary",
      result: "Reduced reconciliation time by 31%.",
      sourceId: "source-1",
      supportingQuote: "Reviewer quote",
    });
  });

  it.each([
    [
      "paste",
      "Long pasted career notes",
      { targetShape: "auto", sourceKind: "paste", text: "Long pasted career notes" },
    ],
    [
      "repo",
      "https://github.com/example/work",
      { targetShape: "auto", sourceKind: "repo", url: "https://github.com/example/work" },
    ],
    [
      "repo",
      "/Users/example/work",
      { targetShape: "auto", sourceKind: "repo", repoPath: "/Users/example/work" },
    ],
  ])("captures %s input and refetches the durable state", async (kind, value, payload) => {
    const next = state();
    const api = {
      submitDeepIngestSource: vi.fn().mockResolvedValue({ source: { id: "source-1" } }),
      getDeepIngestState: vi.fn().mockResolvedValue(next),
    };

    const result = await captureSourceAndRefresh({ api, kind, value });

    expect(api.submitDeepIngestSource).toHaveBeenCalledWith(payload);
    expect(api.getDeepIngestState).toHaveBeenCalledOnce();
    expect(result.view).toBe(next);
  });

  it("builds proposals for an analyzed source and refetches", async () => {
    const next = state();
    const api = {
      buildDeepIngestProposals: vi.fn().mockResolvedValue({ created: 3 }),
      getDeepIngestState: vi.fn().mockResolvedValue(next),
    };

    const result = await buildProposalsAndRefresh({
      api,
      source: { id: "source-1", targetShape: "auto" },
    });

    expect(api.buildDeepIngestProposals).toHaveBeenCalledWith({
      sourceId: "source-1",
      targetShape: "auto",
    });
    expect(api.getDeepIngestState).toHaveBeenCalledOnce();
    expect(result.view).toBe(next);
  });

  it("removes a failed source and refetches", async () => {
    const next = state({ sources: [] });
    const api = {
      removeDeepIngestSource: vi.fn().mockResolvedValue({ id: "source-failed" }),
      getDeepIngestState: vi.fn().mockResolvedValue(next),
    };

    const result = await removeSourceAndRefresh({
      api,
      source: { id: "source-failed" },
    });

    expect(api.removeDeepIngestSource).toHaveBeenCalledWith({ sourceId: "source-failed" });
    expect(api.getDeepIngestState).toHaveBeenCalledOnce();
    expect(result.view).toBe(next);
  });

  it("rescans a failed source and refetches", async () => {
    const next = state();
    const api = {
      retryDeepIngestSource: vi.fn().mockResolvedValue({ id: "source-failed" }),
      getDeepIngestState: vi.fn().mockResolvedValue(next),
    };

    const result = await retrySourceAndRefresh({
      api,
      source: { id: "source-failed" },
    });

    expect(api.retryDeepIngestSource).toHaveBeenCalledWith({ sourceId: "source-failed" });
    expect(api.getDeepIngestState).toHaveBeenCalledOnce();
    expect(result.view).toBe(next);
  });

  it.each([
    ["save_edits", undefined],
    ["confirm", undefined],
    ["defer", "Review later"],
    ["reject", "Not relevant to my work"],
  ])("persists a %s decision with current version and refetches", async (decision, reason) => {
    const row = proposal();
    const next = state();
    const api = {
      decideDeepIngestProposal: vi.fn().mockResolvedValue({ ok: true }),
      getDeepIngestState: vi.fn().mockResolvedValue(next),
    };

    const result = await decideProposalAndRefresh({
      api,
      proposal: row,
      decision,
      reason,
      edits: { title: "Reviewed title", summary: "Reviewed summary", supportingQuote: "Quote" },
    });

    expect(api.decideDeepIngestProposal).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      expectedVersion: 3,
      decision,
      ...(reason ? { reason } : {}),
      ...(["save_edits", "confirm"].includes(decision)
        ? {
            edits: {
              items: [
                expect.objectContaining({
                  title: "Reviewed title",
                  summary: "Reviewed summary",
                  supportingQuote: "Quote",
                  result: "Reduced reconciliation time by 31%.",
                }),
              ],
            },
          }
        : {}),
    });
    expect(api.getDeepIngestState).toHaveBeenCalledOnce();
    expect(result.view).toBe(next);
  });
});
