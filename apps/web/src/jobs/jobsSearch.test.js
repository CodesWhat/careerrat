import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api.js";
import { runAiWebSearchLane, runJobsPageSearch } from "./jobsSearch.js";

const FAILED_SEARCH_FALLBACK =
  "Search failed. Add an RSS source or supported public ATS company, then retry.";

function manualSearchSpies() {
  return {
    refetch: vi.fn(),
    setSearchError: vi.fn(),
    setSearchRun: vi.fn(),
  };
}

describe("runJobsPageSearch", () => {
  it("keeps the legacy path for a terminal successful start response", async () => {
    const state = manualSearchSpies();
    const run = { id: "run-complete", status: "completed", summary: { new: 4 } };
    const startResult = { run, requestId: "request-1" };
    const startSearchRun = vi.fn(async () => startResult);
    const getSourcingRun = vi.fn();

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun,
      getSourcingRun,
    });

    expect(result).toBe(startResult);
    expect(startSearchRun).toHaveBeenCalledWith({ purpose: "manual-search" });
    expect(state.setSearchRun).toHaveBeenLastCalledWith(run);
    expect(getSourcingRun).not.toHaveBeenCalled();
    expect(state.refetch).toHaveBeenCalledOnce();
  });

  it("returns a failed start response without polling or refetching", async () => {
    const state = manualSearchSpies();
    const run = { id: "run-failed-at-start", status: "failed", error: { message: "RSS broke" } };
    const getSourcingRun = vi.fn();

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run })),
      getSourcingRun,
    });

    expect(result).toEqual({ ok: false, error: "RSS broke", run });
    expect(state.setSearchRun).toHaveBeenLastCalledWith(run);
    expect(state.setSearchError).toHaveBeenLastCalledWith("RSS broke");
    expect(getSourcingRun).not.toHaveBeenCalled();
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it("uses the failed-search fallback when a failed start has no error message", async () => {
    const state = manualSearchSpies();
    const run = { id: "run-failed-without-message", status: "failed" };

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run })),
    });

    expect(result).toEqual({ ok: false, error: FAILED_SEARCH_FALLBACK, run });
    expect(state.setSearchError).toHaveBeenLastCalledWith(FAILED_SEARCH_FALLBACK);
  });

  it("polls a running start through completion and refetches once", async () => {
    const state = manualSearchSpies();
    const startingRun = { id: "run-poll", status: "running" };
    const terminalRun = {
      id: "run-poll",
      status: "completed",
      summary: { scanned: 10, new: 3 },
    };
    const getSourcingRun = vi
      .fn()
      .mockResolvedValueOnce({ run: startingRun })
      .mockResolvedValueOnce({ run: terminalRun });

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run: startingRun })),
      getSourcingRun,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({ ok: true, run: terminalRun });
    expect(getSourcingRun.mock.calls).toEqual([
      [{ purpose: "manual-search" }],
      [{ purpose: "manual-search" }],
    ]);
    expect(state.setSearchRun.mock.calls).toEqual([[startingRun], [terminalRun]]);
    expect(state.refetch).toHaveBeenCalledOnce();
  });

  it("surfaces a failed polled run without refetching", async () => {
    const state = manualSearchSpies();
    const startingRun = { id: "run-poll-failed", status: "running" };
    const failedRun = { id: "run-poll-failed", status: "failed" };

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run: startingRun })),
      getSourcingRun: vi.fn(async () => ({ run: failedRun })),
      pollIntervalMs: 0,
    });

    expect(result).toEqual({ ok: false, error: FAILED_SEARCH_FALLBACK, run: failedRun });
    expect(state.setSearchRun).toHaveBeenLastCalledWith(failedRun);
    expect(state.setSearchError).toHaveBeenLastCalledWith(FAILED_SEARCH_FALLBACK);
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it("stops after three consecutive missing poll results", async () => {
    const state = manualSearchSpies();
    const startingRun = { id: "run-missing", status: "running" };
    const finalPollError = new Error("run lookup unavailable");
    const getSourcingRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary lookup failure"))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(finalPollError);

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run: startingRun })),
      getSourcingRun,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({ ok: false, error: finalPollError });
    expect(getSourcingRun).toHaveBeenCalledTimes(3);
    expect(state.setSearchRun).toHaveBeenLastCalledWith(null);
    expect(state.setSearchError).toHaveBeenLastCalledWith(
      "Couldn't read search status. Reload the page to see results."
    );
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it("resets poll misses when a later poll returns a run", async () => {
    const state = manualSearchSpies();
    const startingRun = { id: "run-recovers", status: "running" };
    const terminalRun = { id: "run-recovers", status: "completed", summary: { new: 1 } };
    const getSourcingRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("miss one"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ run: terminalRun });

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run: startingRun })),
      getSourcingRun,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({ ok: true, run: terminalRun });
    expect(getSourcingRun).toHaveBeenCalledTimes(3);
    expect(state.setSearchRun).toHaveBeenLastCalledWith(terminalRun);
    expect(state.setSearchError).toHaveBeenCalledOnce();
    expect(state.refetch).toHaveBeenCalledOnce();
  });

  it("times out while the detached search remains running", async () => {
    const state = manualSearchSpies();
    const startingRun = { id: "run-timeout", status: "running" };
    const getSourcingRun = vi.fn(async () => ({ run: startingRun }));

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run: startingRun })),
      getSourcingRun,
      pollIntervalMs: 0,
      pollTimeoutMs: 0,
    });

    expect(result).toEqual({ ok: false, timedOut: true });
    expect(state.setSearchRun).toHaveBeenLastCalledWith(null);
    expect(state.setSearchError).toHaveBeenLastCalledWith(
      "Search is still running in the background — reload the page later to see results."
    );
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it("routes a thrown start-request failure through resolveErrorCopy, never the raw server string", async () => {
    const state = manualSearchSpies();
    // 422 deliberately isn't one of resolveErrorCopy's mapped statuses (401/
    // 403/404/5xx all have their own rule-provided message) — this exercises
    // the true generic bucket, where describeJobsPageSearchError's own
    // fallback (not resolveErrorCopy's GENERIC_ERROR_MESSAGE) applies.
    const startSearchRun = vi.fn(async () => {
      throw new ApiError(422, { error: "column workspace.jobs_new does not exist" });
    });

    const result = await runJobsPageSearch({ ...state, startSearchRun });

    const friendly = "Search could not start. Review Search setup, then try again.";
    expect(result).toEqual({ ok: false, error: friendly });
    expect(state.setSearchError).toHaveBeenLastCalledWith(friendly);
    expect(state.setSearchError).not.toHaveBeenCalledWith(
      expect.stringContaining("workspace.jobs_new")
    );
  });

  it("aborts during polling without making later state updates", async () => {
    const state = manualSearchSpies();
    const controller = new AbortController();
    const startingRun = { id: "run-aborted", status: "running" };

    const searchPromise = runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run: startingRun })),
      getSourcingRun: vi.fn(async () => ({ run: startingRun })),
      signal: controller.signal,
      pollIntervalMs: 10,
    });
    await vi.waitFor(() => expect(state.setSearchRun).toHaveBeenCalledWith(startingRun));
    const callsAtAbort = {
      error: state.setSearchError.mock.calls.length,
      run: state.setSearchRun.mock.calls.length,
    };
    controller.abort();

    await expect(searchPromise).resolves.toEqual({ ok: false, aborted: true });
    expect(state.setSearchError).toHaveBeenCalledTimes(callsAtAbort.error);
    expect(state.setSearchRun).toHaveBeenCalledTimes(callsAtAbort.run);
    expect(state.refetch).not.toHaveBeenCalled();
  });
});

function stateSpies() {
  return {
    setStatus: vi.fn(),
    setActivity: vi.fn(),
    setCounts: vi.fn(),
    setError: vi.fn(),
  };
}

// Already-fresh stored prompts — every runAiWebSearchLane test below is
// exercising the STREAM, not the invisible prep step in front of it (see
// jobsSearch.js's ensureFreshSearchPrompts/promptsAreStale), so prep must
// resolve ok on the first read without ever calling generate/save.
function freshPromptsStub() {
  return {
    getSearchPrompts: vi.fn(async () => ({
      data: {
        prompts: [{ id: "prompt-1", text: "existing prompt", updatedAt: "2026-07-01T00:00:00Z" }],
      },
    })),
    generateSearchPrompts: vi.fn(),
    saveSearchPrompts: vi.fn(),
    getTargetingUpdatedAt: vi.fn(async () => null),
  };
}

describe("runAiWebSearchLane", () => {
  it("moves running to results, records activity/counts, and refetches", async () => {
    const state = stateSpies();
    const refetch = vi.fn();
    const done = { searched: 2, found: 3, new: 2, duplicates: 1, errors: [] };
    const result = await runAiWebSearchLane({
      ...state,
      ...freshPromptsStub(),
      refetch,
      runAiWebSearchStream: async ({ onEvent }) => {
        onEvent({ type: "activity", message: "Searching Acme…" });
        onEvent({ type: "done", data: done });
      },
    });

    expect(result).toEqual({ ok: true, data: done });
    expect(state.setStatus.mock.calls).toEqual([["running"], ["results"]]);
    expect(state.setActivity).toHaveBeenLastCalledWith("Searching Acme…");
    expect(state.setCounts).toHaveBeenLastCalledWith(done);
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("passes only failed saved prompt ids to a retry run", async () => {
    const state = stateSpies();
    const run = vi.fn(async ({ onEvent }) => {
      onEvent({ type: "done", data: { searched: 1, found: 0, new: 0, duplicates: 0, errors: [] } });
    });

    await runAiWebSearchLane({
      ...state,
      ...freshPromptsStub(),
      promptIds: ["p2"],
      runAiWebSearchStream: run,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ promptIds: ["p2"] }));
  });

  it("surfaces in-band errors as error state without refetching", async () => {
    const state = stateSpies();
    const refetch = vi.fn();
    const result = await runAiWebSearchLane({
      ...state,
      ...freshPromptsStub(),
      refetch,
      runAiWebSearchStream: async ({ onEvent }) => {
        onEvent({ type: "error", message: "provider failed" });
      },
    });

    expect(result).toEqual({ ok: false, error: "provider failed" });
    expect(state.setStatus).toHaveBeenLastCalledWith("error");
    expect(state.setError).toHaveBeenLastCalledWith("provider failed");
    expect(refetch).not.toHaveBeenCalled();
  });

  it("turns an all-query failed done frame into retriable error state", async () => {
    const state = stateSpies();
    const done = {
      searched: 1,
      found: 0,
      new: 0,
      duplicates: 0,
      errors: ["query timed out"],
      failedPromptIds: ["p1"],
      queryResults: [{ promptId: "p1", status: "failed", error: "query timed out" }],
    };
    const result = await runAiWebSearchLane({
      ...state,
      ...freshPromptsStub(),
      runAiWebSearchStream: async ({ onEvent }) => onEvent({ type: "done", data: done }),
    });

    expect(result).toEqual({ ok: false, error: "query timed out", data: done });
    expect(state.setCounts).toHaveBeenLastCalledWith(done);
    expect(state.setStatus).toHaveBeenLastCalledWith("error");
    expect(state.setError).toHaveBeenLastCalledWith("query timed out");
  });

  it("routes a thrown stream failure through resolveErrorCopy, never the raw server string", async () => {
    const state = stateSpies();
    // 422 deliberately isn't one of resolveErrorCopy's mapped statuses — see
    // the matching runJobsPageSearch test above for why.
    const result = await runAiWebSearchLane({
      ...state,
      ...freshPromptsStub(),
      runAiWebSearchStream: async () => {
        throw new ApiError(422, { error: "SEARCH_PROMPTS_NO_TARGETING" });
      },
    });

    const friendly = "AI web search could not start. Review saved prompts, then try again.";
    expect(result).toEqual({ ok: false, error: friendly });
    expect(state.setError).toHaveBeenLastCalledWith(friendly);
    expect(state.setError).not.toHaveBeenCalledWith(
      expect.stringContaining("SEARCH_PROMPTS_NO_TARGETING")
    );
  });

  it("treats abort as a clean return to idle", async () => {
    const state = stateSpies();
    const result = await runAiWebSearchLane({
      ...state,
      ...freshPromptsStub(),
      runAiWebSearchStream: async () => {
        throw new DOMException("cancelled", "AbortError");
      },
    });

    expect(result).toEqual({ ok: false, aborted: true });
    expect(state.setStatus.mock.calls).toEqual([["running"], ["idle"]]);
    expect(state.setError).toHaveBeenCalledOnce();
  });
});
