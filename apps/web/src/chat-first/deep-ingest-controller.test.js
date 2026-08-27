import { describe, expect, it, vi } from "vitest";
import {
  buildDeepIngestProposalItem,
  buildDeepIngestReview,
  buildProposalsAndRefresh,
  captureSourceAndRefresh,
  clearDeepIngestOperation,
  createDeepIngestOperationController,
  decideProposalAndRefresh,
  readDeepIngestOperation,
  removeSourceAndRefresh,
  resolveDeepIngestTextDecision,
  retrySourceAndRefresh,
  uploadDeepIngestFilesAndRefresh,
} from "./deep-ingest-controller.js";

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}

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
  it("resumes an exact saved source scan after reload", async () => {
    const storage = memoryStorage();
    const firstApi = {
      submitDeepIngestSource: vi.fn().mockResolvedValue({
        data: {
          operation: { id: "app-operation-deep-1", status: "running" },
          subject: { sourceId: "source-exact", sourceVersion: 4, targetShape: "evidence" },
        },
      }),
    };
    const first = createDeepIngestOperationController({ api: firstApi, storage, pollMs: 0 });

    const started = await first.startCapture({ kind: "paste", value: "Durable career notes" });

    expect(started.operation.id).toBe("app-operation-deep-1");
    expect(readDeepIngestOperation(storage)).toMatchObject({
      operationId: "app-operation-deep-1",
      sourceId: "source-exact",
      sourceVersion: 4,
      targetShape: "evidence",
    });

    const exactState = state({
      sources: [
        {
          id: "source-exact",
          version: 4,
          targetShape: "evidence",
          sourceKind: "paste",
          status: "proposal_ready",
        },
      ],
      proposals: [],
      reviewQueue: [],
    });
    const reloadApi = {
      getAppOperation: vi.fn().mockResolvedValue({
        id: "app-operation-deep-1",
        status: "completed",
        resultRef: {
          type: "deep-ingest-source",
          id: "source-exact",
          version: 4,
          status: "proposal_ready",
          proposalId: null,
        },
      }),
      getDeepIngestState: vi.fn().mockResolvedValue(exactState),
    };
    const reloaded = createDeepIngestOperationController({ api: reloadApi, storage, pollMs: 0 });

    const completed = await reloaded.resume();

    expect(reloadApi.getAppOperation).toHaveBeenCalledWith("app-operation-deep-1");
    expect(completed.exact).toEqual({ source: exactState.sources[0], proposals: [] });
    expect(readDeepIngestOperation(storage)).toBeNull();
  });

  it("finishes in the background without changing the active route or draft", async () => {
    const storage = memoryStorage({
      "careerrat:draft:ingest-input%3Apaste": "Keep this unfinished note",
      "careerrat:foreground": "?thread=today&browse=search",
    });
    const onOperation = vi.fn();
    const api = {
      getAppOperation: vi.fn().mockResolvedValue({
        id: "app-operation-deep-2",
        status: "completed",
        resultRef: {
          type: "deep-ingest-proposal-set",
          id: "deep-set-exact",
          sourceId: "source-1",
          sourceVersion: 1,
          targetShape: "auto",
          proposalIds: ["proposal-1"],
        },
      }),
      getDeepIngestState: vi.fn().mockResolvedValue(state()),
    };
    const controller = createDeepIngestOperationController({
      api,
      storage,
      pollMs: 0,
      onOperation,
    });
    storage.setItem(
      "careerrat:operation:deep-ingest",
      JSON.stringify({
        operationId: "app-operation-deep-2",
        sourceId: "source-1",
        sourceVersion: 1,
        targetShape: "auto",
      })
    );

    await controller.resume();

    expect(storage.getItem("careerrat:draft:ingest-input%3Apaste")).toBe(
      "Keep this unfinished note"
    );
    expect(storage.getItem("careerrat:foreground")).toBe("?thread=today&browse=search");
    expect(onOperation).toHaveBeenLastCalledWith(null);
  });

  it("starts a linked retry for an interrupted run and follows only the retry", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "careerrat:operation:deep-ingest",
      JSON.stringify({ operationId: "app-operation-deep-failed", sourceId: "source-1" })
    );
    const api = {
      retryAppOperation: vi.fn().mockResolvedValue({
        operation: {
          id: "app-operation-deep-retry",
          status: "running",
          retryOf: "app-operation-deep-failed",
          attempt: 2,
        },
      }),
      getAppOperation: vi.fn().mockResolvedValue({
        id: "app-operation-deep-retry",
        status: "completed",
        retryOf: "app-operation-deep-failed",
        resultRef: {
          type: "deep-ingest-source",
          id: "source-1",
          version: 1,
          status: "proposal_ready",
          proposalId: null,
        },
      }),
      getDeepIngestState: vi.fn().mockResolvedValue(state()),
    };
    const controller = createDeepIngestOperationController({ api, storage, pollMs: 0 });

    const completed = await controller.retry();

    expect(api.retryAppOperation).toHaveBeenCalledWith("app-operation-deep-failed");
    expect(api.getAppOperation).toHaveBeenCalledWith("app-operation-deep-retry");
    expect(completed.operation.retryOf).toBe("app-operation-deep-failed");
  });

  it("coalesces a double click into one source start", async () => {
    let release;
    const response = new Promise((resolve) => {
      release = resolve;
    });
    const api = { submitDeepIngestSource: vi.fn(() => response) };
    const controller = createDeepIngestOperationController({ api, storage: memoryStorage() });

    const first = controller.startCapture({ kind: "paste", value: "One exact source" });
    const second = controller.startCapture({ kind: "paste", value: "One exact source" });
    release({
      data: {
        operation: { id: "app-operation-deep-click", status: "running" },
        subject: { sourceId: "source-click", sourceVersion: 1, targetShape: "auto" },
      },
    });

    await expect(first).resolves.toEqual(await second);
    expect(api.submitDeepIngestSource).toHaveBeenCalledOnce();
  });

  it("starts an upload through the same durable source lifecycle", async () => {
    const file = { name: "career-notes.pdf" };
    const api = {
      uploadDeepIngestFile: vi.fn().mockResolvedValue({
        operation: { id: "app-operation-deep-upload", status: "running" },
        subject: { sourceId: "source-upload", sourceVersion: 1, targetShape: "auto" },
      }),
    };
    const storage = memoryStorage();
    const controller = createDeepIngestOperationController({ api, storage });

    const started = await controller.startUpload({ file, targetShape: "auto" });

    expect(api.uploadDeepIngestFile).toHaveBeenCalledWith(file, { targetShape: "auto" });
    expect(started.operation.id).toBe("app-operation-deep-upload");
    expect(readDeepIngestOperation(storage)).toMatchObject({
      operationId: "app-operation-deep-upload",
      sourceId: "source-upload",
    });
  });

  it("waits for an uploaded source's exact durable result before refreshing", async () => {
    const file = { name: "career-notes.pdf", size: 1200, lastModified: 4 };
    const exactState = state({
      sources: [
        {
          id: "source-upload",
          version: 1,
          targetShape: "auto",
          sourceKind: "file",
          status: "proposal_ready",
        },
      ],
      proposals: [],
      reviewQueue: [],
    });
    const api = {
      uploadDeepIngestFile: vi.fn().mockResolvedValue({
        operation: { id: "app-operation-deep-upload", status: "running" },
        subject: { sourceId: "source-upload", sourceVersion: 1, targetShape: "auto" },
      }),
      getAppOperation: vi.fn().mockResolvedValue({
        id: "app-operation-deep-upload",
        status: "completed",
        resultRef: {
          type: "deep-ingest-source",
          id: "source-upload",
          version: 1,
          status: "proposal_ready",
          proposalId: null,
        },
      }),
      getDeepIngestState: vi.fn().mockResolvedValue(exactState),
    };

    const result = await uploadDeepIngestFilesAndRefresh({
      api,
      files: [file],
      controller: createDeepIngestOperationController({ api, storage: memoryStorage(), pollMs: 0 }),
    });

    expect(result.view).toBe(exactState);
    expect(result.completed[0].exact.source.id).toBe("source-upload");
  });

  it("loads only the proposal set named by the completed result reference", async () => {
    const exact = proposal({ id: "proposal-exact" });
    const unrelated = proposal({
      id: "proposal-latest",
      sourceId: "source-latest",
      proposalSetId: "deep-set-latest",
    });
    const api = {
      getAppOperation: vi.fn().mockResolvedValue({
        id: "app-operation-deep-proposals",
        status: "completed",
        resultRef: {
          type: "deep-ingest-proposal-set",
          id: "deep-set-exact",
          sourceId: "source-1",
          sourceVersion: 1,
          targetShape: "auto",
          proposalIds: ["proposal-exact"],
        },
      }),
      getDeepIngestState: vi.fn().mockResolvedValue(
        state({
          proposals: [{ ...exact, proposalSetId: "deep-set-exact" }, unrelated],
          reviewQueue: [exact, unrelated],
        })
      ),
    };
    const controller = createDeepIngestOperationController({ api, pollMs: 0 });

    const completed = await controller.follow("app-operation-deep-proposals");

    expect(completed.exact.proposals.map((row) => row.id)).toEqual(["proposal-exact"]);
  });

  it("turns stale and interrupted operation failures into clear recovery copy", async () => {
    const missing = createDeepIngestOperationController({
      api: {
        getAppOperation: vi.fn().mockRejectedValue({
          status: 404,
          body: { code: "NOT_FOUND" },
        }),
      },
      pollMs: 0,
    });
    await expect(missing.follow("app-operation-deep-missing")).rejects.toThrow(
      "can't find that saved Deep Ingest run"
    );

    const interrupted = createDeepIngestOperationController({
      api: {
        getAppOperation: vi.fn().mockResolvedValue({
          id: "app-operation-deep-stopped",
          status: "failed",
          error: { code: "APP_OPERATION_SERVER_STOPPED", retryable: true },
        }),
      },
      pollMs: 0,
    });
    await expect(interrupted.follow("app-operation-deep-stopped")).rejects.toThrow(
      "app closed before Deep Ingest finished"
    );
  });

  it("does not clear a newer saved operation when an older follow finishes", () => {
    const storage = memoryStorage();
    storage.setItem(
      "careerrat:operation:deep-ingest",
      JSON.stringify({ operationId: "app-operation-deep-new" })
    );
    expect(clearDeepIngestOperation(storage, "app-operation-deep-old")).toBe(false);
    expect(readDeepIngestOperation(storage)?.operationId).toBe("app-operation-deep-new");
  });

  it("leaves another workflow's foreground operation to its owning controller", async () => {
    const storage = memoryStorage();
    const api = {
      getAppOperation: vi.fn().mockResolvedValue({
        id: "app-operation-workspace",
        kind: "workspace.message",
        status: "completed",
        resultRef: { type: "workspace-message", id: "message-1" },
      }),
      getDeepIngestState: vi.fn(),
    };
    const controller = createDeepIngestOperationController({ api, storage, pollMs: 0 });

    await expect(controller.follow("app-operation-workspace")).resolves.toBeNull();
    expect(api.getDeepIngestState).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("clears the matching location run after success even when storage is unavailable", async () => {
    const onOperation = vi.fn();
    const api = {
      getAppOperation: vi.fn().mockResolvedValue({
        id: "app-operation-deep-no-storage",
        kind: "deep-ingest-source-scan",
        status: "completed",
        resultRef: {
          type: "deep-ingest-source",
          id: "source-1",
          version: 1,
          status: "proposal_ready",
          proposalId: null,
        },
      }),
      getDeepIngestState: vi.fn().mockResolvedValue(state()),
    };
    const controller = createDeepIngestOperationController({
      api,
      storage: null,
      pollMs: 0,
      onOperation,
    });

    await controller.follow("app-operation-deep-no-storage");

    expect(onOperation).toHaveBeenLastCalledWith(null);
  });

  it("does not let an older completion overwrite a newer Deep Ingest run", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "careerrat:operation:deep-ingest",
      JSON.stringify({ operationId: "app-operation-deep-new", sourceId: "source-new" })
    );
    const onOperation = vi.fn();
    const api = {
      getAppOperation: vi.fn().mockResolvedValue({
        id: "app-operation-deep-old",
        kind: "deep-ingest-source-scan",
        status: "completed",
        resultRef: {
          type: "deep-ingest-source",
          id: "source-1",
          version: 1,
          status: "proposal_ready",
          proposalId: null,
        },
      }),
      getDeepIngestState: vi.fn().mockResolvedValue(state()),
    };
    const controller = createDeepIngestOperationController({
      api,
      storage,
      pollMs: 0,
      onOperation,
    });

    await controller.follow("app-operation-deep-old");

    expect(readDeepIngestOperation(storage)).toMatchObject({
      operationId: "app-operation-deep-new",
      sourceId: "source-new",
    });
    expect(onOperation).not.toHaveBeenCalledWith(null);
  });

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
