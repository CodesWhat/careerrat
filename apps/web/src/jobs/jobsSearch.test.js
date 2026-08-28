import { describe, expect, it, vi } from "vitest";
import {
  classifyDurableSearchRun,
  followSearchExecution,
  runUnifiedJobSearch,
  searchExecutionPresentation,
} from "./jobsSearch.js";

function searchExecution({
  id = "search-execution-1",
  status = "running",
  partial = false,
  deterministic = "running",
  aiWeb = "queued",
} = {}) {
  return {
    id,
    kind: "manual-search",
    status,
    partial,
    lanes: {
      deterministic: {
        status: deterministic,
        runId: "manual-1",
        summary: deterministic === "completed" ? { new: 2, scanned: 8 } : null,
        error: deterministic === "failed" ? "One saved site timed out." : null,
      },
      aiWeb: {
        status: aiWeb,
        runId: aiWeb === "queued" ? null : "ai-1",
        summary: aiWeb === "completed" ? { new: 1 } : null,
        error: aiWeb === "failed" ? "AI search timed out." : null,
      },
    },
  };
}

describe("durable unified search execution", () => {
  it("shows configured sources running while the server-owned AI lane is still queued", () => {
    expect(searchExecutionPresentation(searchExecution())).toMatchObject({
      status: "running",
      detail: "Searching your saved job sites",
      searchExecutionId: "search-execution-1",
      lanes: {
        deterministic: { label: "Configured sources", status: "running" },
        aiWeb: { label: "AI web search", status: "queued" },
      },
    });
  });

  it("adopts the server execution id and follows only that exact execution", async () => {
    const adopted = searchExecution({ id: "search-adopted" });
    const aiRunning = searchExecution({
      id: "search-adopted",
      deterministic: "completed",
      aiWeb: "running",
    });
    const completed = searchExecution({
      id: "search-adopted",
      status: "completed",
      deterministic: "completed",
      aiWeb: "completed",
    });
    const startSearchRun = vi.fn(async () => ({
      ok: true,
      searchExecutionId: "search-adopted",
      execution: adopted,
    }));
    const getSearchExecution = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, execution: aiRunning })
      .mockResolvedValueOnce({ ok: true, execution: completed });
    const states = [];
    const refetch = vi.fn();

    const result = await runUnifiedJobSearch({
      startSearchRun,
      getSearchExecution,
      searchExecutionId: "search-requested",
      setSearchState: (state) => states.push(state),
      refetch,
      pollIntervalMs: 0,
    });

    expect(startSearchRun).toHaveBeenCalledWith({
      purpose: "manual-search",
      searchExecutionId: "search-requested",
    });
    expect(getSearchExecution.mock.calls).toEqual([
      [{ searchExecutionId: "search-adopted" }],
      [{ searchExecutionId: "search-adopted" }],
    ]);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lanes: expect.objectContaining({
            deterministic: expect.objectContaining({ status: "running" }),
            aiWeb: expect.objectContaining({ status: "queued" }),
          }),
        }),
        expect.objectContaining({
          lanes: expect.objectContaining({
            deterministic: expect.objectContaining({ status: "succeeded" }),
            aiWeb: expect.objectContaining({ status: "running" }),
          }),
        }),
      ])
    );
    expect(result).toMatchObject({
      ok: true,
      partial: false,
      searchExecutionId: "search-adopted",
      execution: completed,
    });
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful sibling visible when the durable execution finishes partially", () => {
    const state = searchExecutionPresentation(
      searchExecution({
        status: "completed",
        partial: true,
        deterministic: "completed",
        aiWeb: "failed",
      })
    );

    expect(state).toMatchObject({
      status: "complete",
      partial: true,
      lanes: {
        deterministic: { status: "succeeded" },
        aiWeb: { status: "failed", error: "AI search timed out." },
      },
    });
    expect(state.summary).toContain("AI search needs another try");
  });

  it("never publishes a mismatched execution returned during an exact-id race", async () => {
    const stale = searchExecution({
      id: "search-stale",
      status: "failed",
      deterministic: "failed",
      aiWeb: "failed",
    });
    const completed = searchExecution({
      id: "search-current",
      status: "completed",
      deterministic: "completed",
      aiWeb: "completed",
    });
    const states = [];
    const getSearchExecution = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, execution: stale })
      .mockResolvedValueOnce({ ok: true, execution: completed });

    const result = await followSearchExecution({
      getSearchExecution,
      searchExecutionId: "search-current",
      initialExecution: searchExecution({ id: "search-current" }),
      setSearchState: (state) => states.push(state),
      pollIntervalMs: 0,
    });

    expect(result).toMatchObject({ ok: true, execution: completed });
    expect(states.some((state) => state.searchExecutionId === "search-stale")).toBe(false);
    expect(getSearchExecution).toHaveBeenNthCalledWith(1, {
      searchExecutionId: "search-current",
    });
  });
});

describe("legacy durable search classification", () => {
  it("preserves configured-source partial failures during first-search migration", () => {
    const run = {
      status: "completed",
      summary: { errors: [{ company: "Acme", error: "timed out" }] },
    };
    expect(classifyDurableSearchRun("deterministic", { run })).toMatchObject({
      status: "failed",
      partial: true,
      error: "1 configured source couldn't be searched.",
    });
  });
});
