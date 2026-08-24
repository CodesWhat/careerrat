import { describe, expect, it, vi } from "vitest";
import {
  buildDeepIngestProposalItem,
  buildDeepIngestReview,
  buildProposalsAndRefresh,
  captureSourceAndRefresh,
  decideProposalAndRefresh,
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
