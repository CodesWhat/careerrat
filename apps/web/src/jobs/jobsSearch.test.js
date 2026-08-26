import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api.js";
import {
  classifyDurableSearchRun,
  jobSearchCapabilities,
  runAiWebSearchLane,
  runCoordinatedJobSearch,
  runJobsPageSearch,
} from "./jobsSearch.js";

const FAILED_SEARCH_FALLBACK =
  "Search failed. Add an RSS source or supported public ATS company, then retry.";

function manualSearchSpies() {
  return {
    refetch: vi.fn(),
    setSearchError: vi.fn(),
    setSearchRun: vi.fn(),
  };
}

describe("classifyDurableSearchRun", () => {
  it("classifies completed configured-source errors as a partial failed lane", () => {
    const run = {
      status: "completed",
      summary: {
        new: 2,
        errors: [{ company: "Acme", error: "careers page timed out" }],
      },
    };

    expect(classifyDurableSearchRun("deterministic", { run })).toEqual({
      status: "failed",
      partial: true,
      error: "1 configured source couldn't be searched.",
      failedPromptIds: [],
      run,
    });
  });

  it("recovers exact failed prompt ids from a durable AI failure", () => {
    const run = {
      status: "failed",
      error: {
        message: "second query timed out",
        failedPromptIds: ["p2"],
      },
    };

    expect(classifyDurableSearchRun("aiWeb", { run })).toEqual({
      status: "failed",
      partial: false,
      error: "second query timed out",
      failedPromptIds: ["p2"],
      run,
    });
  });

  it("classifies a durable AI disconnect as a cancelled skipped lane", () => {
    const run = {
      status: "failed",
      error: { code: "AI_WEB_SEARCH_ABORTED", message: "AI web search was cancelled." },
    };

    expect(classifyDurableSearchRun("aiWeb", { run })).toEqual({
      status: "skipped",
      reason: "cancelled",
      partial: false,
      error: null,
      failedPromptIds: [],
      run,
    });
  });
});

describe("runJobsPageSearch", () => {
  it("accepts a terminal successful start response", async () => {
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

  it("passes the coordinated search execution id to the manual-search start", async () => {
    const state = manualSearchSpies();
    const run = { id: "run-correlated", status: "completed", summary: { new: 0 } };
    const startSearchRun = vi.fn(async () => ({ ok: true, run }));

    await runJobsPageSearch({
      ...state,
      startSearchRun,
      searchExecutionId: "search-execution-shared",
    });

    expect(startSearchRun).toHaveBeenCalledWith({
      purpose: "manual-search",
      searchExecutionId: "search-execution-shared",
    });
  });

  it("marks a completed deterministic run with source errors as partial without dropping results", async () => {
    const state = manualSearchSpies();
    const run = {
      id: "run-partial",
      status: "completed",
      summary: {
        new: 2,
        errors: [{ company: "Acme", error: "careers page timed out" }],
      },
    };

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run, requestId: "request-partial" })),
    });

    expect(result).toMatchObject({
      ok: true,
      partial: true,
      error: "1 configured source couldn't be searched.",
      run,
      requestId: "request-partial",
    });
    expect(state.setSearchRun).toHaveBeenLastCalledWith(run);
    expect(state.setSearchError).toHaveBeenLastCalledWith(
      "1 configured source couldn't be searched."
    );
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
      [{ purpose: "manual-search", id: "run-poll" }],
      [{ purpose: "manual-search", id: "run-poll" }],
    ]);
    expect(state.setSearchRun.mock.calls).toEqual([[startingRun], [terminalRun]]);
    expect(state.refetch).toHaveBeenCalledOnce();
  });

  it("keeps rows from a completed poll while reporting its source errors", async () => {
    const state = manualSearchSpies();
    const startingRun = { id: "run-poll-partial", status: "running" };
    const terminalRun = {
      id: "run-poll-partial",
      status: "completed",
      summary: {
        new: 2,
        errorCount: 2,
        errors: [
          { company: "Acme", error: "timed out" },
          { company: "Globex", error: "unavailable" },
        ],
      },
    };

    const result = await runJobsPageSearch({
      ...state,
      startSearchRun: vi.fn(async () => ({ run: startingRun })),
      getSourcingRun: vi.fn(async () => ({ run: terminalRun })),
      pollIntervalMs: 0,
    });

    expect(result).toEqual({
      ok: true,
      partial: true,
      error: "2 configured sources couldn't be searched.",
      run: terminalRun,
    });
    expect(state.setSearchError).toHaveBeenLastCalledWith(
      "2 configured sources couldn't be searched."
    );
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
      "Search is still running in the background. Reload the page later to see results."
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
        inputFingerprint: "inputs-current",
        savedInputFingerprint: "inputs-current",
      },
    })),
    generateSearchPrompts: vi.fn(),
    saveSearchPrompts: vi.fn(),
  };
}

describe("runAiWebSearchLane", () => {
  it("regenerates invisible prompts when candidate search inputs changed", async () => {
    const state = stateSpies();
    const getSearchPrompts = vi.fn(async () => ({
      data: {
        prompts: [{ id: "prompt-1", text: "old prompt" }],
        inputFingerprint: "inputs-new",
        savedInputFingerprint: "inputs-old",
      },
    }));
    const generateSearchPrompts = vi.fn(async () => ({
      data: { prompts: [{ text: "new prompt" }] },
    }));
    const saveSearchPrompts = vi.fn(async () => ({
      data: { prompts: [{ id: "prompt-2", text: "new prompt" }] },
    }));
    const runAiWebSearchStream = vi.fn(async ({ onEvent }) => {
      onEvent({ type: "done", data: { searched: 1, found: 1, new: 1, duplicates: 0, errors: [] } });
    });

    const result = await runAiWebSearchLane({
      ...state,
      getSearchPrompts,
      generateSearchPrompts,
      saveSearchPrompts,
      runAiWebSearchStream,
    });

    expect(result.ok).toBe(true);
    expect(generateSearchPrompts).toHaveBeenCalledOnce();
    expect(saveSearchPrompts).toHaveBeenCalledWith([{ text: "new prompt" }]);
    expect(runAiWebSearchStream).toHaveBeenCalledOnce();
  });

  it("drops stale retry prompt ids when targeting changes regenerate the prompt set", async () => {
    const state = stateSpies();
    const runAiWebSearchStream = vi.fn(async ({ onEvent }) => {
      onEvent({ type: "done", data: { searched: 2, found: 0, new: 0, duplicates: 0, errors: [] } });
    });

    await runAiWebSearchLane({
      ...state,
      promptIds: ["old-prompt-2"],
      getSearchPrompts: vi.fn(async () => ({
        data: {
          prompts: [{ id: "old-prompt-1", text: "old search" }],
          inputFingerprint: "targeting-new",
          savedInputFingerprint: "targeting-old",
        },
      })),
      generateSearchPrompts: vi.fn(async () => ({
        data: { prompts: [{ text: "fresh search one" }, { text: "fresh search two" }] },
      })),
      saveSearchPrompts: vi.fn(async () => ({
        data: {
          prompts: [
            { id: "fresh-prompt-1", text: "fresh search one" },
            { id: "fresh-prompt-2", text: "fresh search two" },
          ],
        },
      })),
      runAiWebSearchStream,
    });

    expect(runAiWebSearchStream).toHaveBeenCalledOnce();
    expect(runAiWebSearchStream.mock.calls[0][0]).not.toHaveProperty("promptIds");
  });

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

  it("passes the coordinated search execution id into the AI stream request", async () => {
    const state = stateSpies();
    const run = vi.fn(async ({ onEvent }) => {
      onEvent({ type: "done", data: { searched: 1, found: 0, new: 0, duplicates: 0, errors: [] } });
    });

    await runAiWebSearchLane({
      ...state,
      ...freshPromptsStub(),
      searchExecutionId: "search-execution-shared",
      runAiWebSearchStream: run,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ searchExecutionId: "search-execution-shared" })
    );
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

    expect(result).toEqual({
      ok: false,
      error: "query timed out",
      failedPromptIds: ["p1"],
      data: done,
    });
    expect(state.setCounts).toHaveBeenLastCalledWith(done);
    expect(state.setStatus).toHaveBeenLastCalledWith("error");
    expect(state.setError).toHaveBeenLastCalledWith("query timed out");
  });

  it("keeps successful AI prompt results while returning exact failed prompt ids", async () => {
    const state = stateSpies();
    const refetch = vi.fn();
    const done = {
      searched: 2,
      found: 2,
      new: 1,
      duplicates: 1,
      errors: ["second query timed out"],
      failedPromptIds: ["p2"],
      queryResults: [
        { promptId: "p1", status: "completed" },
        { promptId: "p2", status: "failed", error: "second query timed out" },
      ],
    };

    const result = await runAiWebSearchLane({
      ...state,
      ...freshPromptsStub(),
      refetch,
      runAiWebSearchStream: async ({ onEvent }) => onEvent({ type: "done", data: done }),
    });

    expect(result).toEqual({
      ok: true,
      partial: true,
      error: "second query timed out",
      failedPromptIds: ["p2"],
      data: done,
    });
    expect(state.setCounts).toHaveBeenLastCalledWith(done);
    expect(state.setStatus).toHaveBeenLastCalledWith("results");
    expect(state.setError).toHaveBeenLastCalledWith("second query timed out");
    expect(refetch).toHaveBeenCalledOnce();
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

describe("runCoordinatedJobSearch", () => {
  const capabilities = {
    deterministic: { configured: true, executable: true },
    aiWeb: { configured: true, executable: true, consented: true },
  };

  it("starts every executable lane from one action and refetches once after both finish", async () => {
    const setSearchState = vi.fn();
    const refetch = vi.fn();
    let finishDeterministic;
    let finishAiWeb;
    const runDeterministic = vi.fn(
      () => new Promise((resolve) => (finishDeterministic = () => resolve({ ok: true })))
    );
    const runAiWeb = vi.fn(
      () => new Promise((resolve) => (finishAiWeb = () => resolve({ ok: true })))
    );

    const search = runCoordinatedJobSearch({
      capabilities,
      runDeterministic,
      runAiWeb,
      refetch,
      setSearchState,
    });

    await vi.waitFor(() => {
      expect(runDeterministic).toHaveBeenCalledOnce();
      expect(runAiWeb).toHaveBeenCalledOnce();
    });
    expect(setSearchState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "running",
        lanes: {
          deterministic: expect.objectContaining({
            configured: true,
            executable: true,
            status: "running",
          }),
          aiWeb: expect.objectContaining({
            configured: true,
            executable: true,
            status: "running",
          }),
        },
      })
    );
    finishAiWeb();
    finishDeterministic();

    await expect(search).resolves.toMatchObject({ ok: true, partial: false });
    expect(refetch).toHaveBeenCalledOnce();
    expect(setSearchState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "complete",
        lanes: {
          deterministic: expect.objectContaining({ status: "succeeded" }),
          aiWeb: expect.objectContaining({ status: "succeeded" }),
        },
      })
    );
  });

  it("keeps successful results while clearly summarizing JD capture gaps", async () => {
    const states = [];
    const result = await runCoordinatedJobSearch({
      capabilities,
      setSearchState: (state) => states.push(state),
      runDeterministic: async () => ({ ok: true, run: { summary: { new: 2 } } }),
      runAiWeb: async () => ({
        ok: true,
        data: { new: 1, unreadable: 2, partial: 1, errors: ["2 descriptions could not be read"] },
      }),
    });

    expect(result).toMatchObject({ ok: true, partial: false });
    expect(states.at(-1).summary).toBe(
      "2 search lanes finished · 3 new · 2 couldn't be added · 1 has a partial description"
    );
  });

  it("counts one exact posting once when both parallel lanes report it as new", async () => {
    const states = [];
    const result = await runCoordinatedJobSearch({
      capabilities,
      setSearchState: (state) => states.push(state),
      runDeterministic: async () => ({
        ok: true,
        run: {
          summary: {
            new: 1,
            offers: [
              {
                company: "Acme & Co",
                title: "Platform Engineer",
                url: "https://jobs.example.test/acme/platform",
              },
            ],
          },
        },
      }),
      runAiWeb: async () => ({
        ok: true,
        data: {
          new: 1,
          offers: [
            {
              company: "Acme and Co",
              role: "Platform Engineer",
              url: "https://jobs.example.test/acme/platform",
            },
          ],
        },
      }),
    });

    expect(result).toMatchObject({ ok: true, partial: false });
    expect(states.at(-1).summary).toBe("2 search lanes finished · 1 new");
  });

  it("counts distinct same-title requisitions from parallel lanes separately", async () => {
    const states = [];
    await runCoordinatedJobSearch({
      capabilities,
      setSearchState: (state) => states.push(state),
      runDeterministic: async () => ({
        ok: true,
        run: {
          summary: {
            new: 1,
            offers: [
              {
                company: "Acme",
                title: "Platform Engineer",
                url: "https://jobs.lever.co/acme/platform-a",
                reqId: "lever:platform-a",
                location: "Remote, US",
              },
            ],
          },
        },
      }),
      runAiWeb: async () => ({
        ok: true,
        data: {
          new: 1,
          offers: [
            {
              company: "Acme",
              role: "Platform Engineer",
              url: "https://jobs.lever.co/acme/platform-b",
              reqId: "lever:platform-b",
              location: "Remote, US",
            },
          ],
        },
      }),
    });

    expect(states.at(-1).summary).toBe("2 search lanes finished · 2 new");
  });

  it("counts NYC and US-remote versions of the same title separately", async () => {
    const states = [];
    await runCoordinatedJobSearch({
      capabilities,
      setSearchState: (state) => states.push(state),
      runDeterministic: async () => ({
        ok: true,
        run: {
          summary: {
            new: 1,
            offers: [
              {
                company: "Acme",
                title: "Platform Engineer",
                url: "https://jobs.example.test/acme/platform-remote",
                location: "Remote, US",
              },
            ],
          },
        },
      }),
      runAiWeb: async () => ({
        ok: true,
        data: {
          new: 1,
          offers: [
            {
              company: "Acme",
              role: "Platform Engineer",
              url: "https://jobs.example.test/acme/platform-nyc",
              location: "New York, NY",
            },
          ],
        },
      }),
    });

    expect(states.at(-1).summary).toBe("2 search lanes finished · 2 new");
  });

  it("skips unavailable or unconsented lanes without invoking them", async () => {
    const runDeterministic = vi.fn();
    const runAiWeb = vi.fn();
    const refetch = vi.fn();
    const states = [];

    const result = await runCoordinatedJobSearch({
      capabilities: {
        deterministic: { configured: true, executable: false },
        aiWeb: { configured: true, executable: true, consented: false },
      },
      runDeterministic,
      runAiWeb,
      refetch,
      setSearchState: (state) => states.push(state),
    });

    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(runDeterministic).not.toHaveBeenCalled();
    expect(runAiWeb).not.toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({
      status: "error",
      reason: "no-configured-lane",
      lanes: {
        deterministic: { configured: true, executable: false, status: "skipped" },
        aiWeb: {
          configured: true,
          executable: true,
          consented: false,
          status: "skipped",
        },
      },
    });
  });

  it("keeps a successful lane when its sibling fails", async () => {
    const setSearchState = vi.fn();
    const refetch = vi.fn();

    const result = await runCoordinatedJobSearch({
      capabilities,
      runDeterministic: vi.fn(async () => ({ ok: true, run: { summary: { new: 3 } } })),
      runAiWeb: vi.fn(async () => ({ ok: false, error: "AI search timed out" })),
      refetch,
      setSearchState,
    });

    expect(result).toMatchObject({ ok: true, partial: true });
    expect(result.retry).toEqual({ aiWeb: true });
    expect(refetch).toHaveBeenCalledOnce();
    expect(setSearchState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "complete",
        summary: expect.stringContaining("1 lane needs retry"),
        lanes: {
          deterministic: expect.objectContaining({ status: "succeeded" }),
          aiWeb: expect.objectContaining({ status: "failed", error: "AI search timed out" }),
        },
      })
    );
  });

  it("marks a partly failed AI lane while preserving its successful results and retry ids", async () => {
    const states = [];
    const result = await runCoordinatedJobSearch({
      capabilities,
      runDeterministic: vi.fn(async () => ({ ok: true, run: { summary: { new: 2 } } })),
      runAiWeb: vi.fn(async () => ({
        ok: true,
        partial: true,
        error: "second query timed out",
        failedPromptIds: ["p2"],
        data: { new: 1 },
      })),
      setSearchState: (state) => states.push(state),
    });

    expect(result).toMatchObject({
      ok: true,
      partial: true,
      failedPromptIds: ["p2"],
      retry: { aiPromptIds: ["p2"] },
    });
    expect(states.at(-1)).toMatchObject({
      status: "complete",
      summary: "2 search lanes finished · 1 lane needs retry · 3 new",
      lanes: {
        deterministic: { status: "succeeded" },
        aiWeb: {
          status: "failed",
          partial: true,
          error: "second query timed out",
          failedPromptIds: ["p2"],
          result: { data: { new: 1 } },
        },
      },
    });
  });

  it("marks a completed deterministic lane with summary errors as partial", async () => {
    const states = [];
    const result = await runCoordinatedJobSearch({
      capabilities,
      runDeterministic: vi.fn(async () => ({
        ok: true,
        run: {
          status: "completed",
          summary: {
            new: 2,
            errorCount: 1,
            errors: [{ company: "Acme", error: "careers page timed out" }],
          },
        },
      })),
      runAiWeb: vi.fn(async () => ({ ok: true, data: { new: 1 } })),
      setSearchState: (state) => states.push(state),
    });

    expect(result).toMatchObject({
      ok: true,
      partial: true,
      retry: { deterministic: true },
    });
    expect(states.at(-1)).toMatchObject({
      status: "complete",
      summary: "2 search lanes finished · 1 lane needs retry · 3 new",
      lanes: {
        deterministic: {
          status: "failed",
          partial: true,
          error: "1 configured source couldn't be searched.",
        },
        aiWeb: { status: "succeeded" },
      },
    });
  });

  it("retries exact failed AI prompts without rerunning a successful deterministic lane", async () => {
    const runDeterministic = vi.fn(async () => ({ ok: true }));
    const runAiWeb = vi.fn(async () => ({ ok: true, data: { new: 1 } }));

    const result = await runCoordinatedJobSearch({
      capabilities,
      retry: { aiPromptIds: ["p2"] },
      runDeterministic,
      runAiWeb,
    });

    expect(runDeterministic).not.toHaveBeenCalled();
    expect(runAiWeb).toHaveBeenCalledWith(expect.objectContaining({ retryPromptIds: ["p2"] }));
    expect(result).toMatchObject({
      ok: true,
      partial: false,
      lanes: {
        deterministic: { status: "succeeded", reason: "already-succeeded" },
        aiWeb: { status: "succeeded" },
      },
    });
  });

  it("reruns deterministic search too when both lanes need retry", async () => {
    const runDeterministic = vi.fn(async () => ({ ok: true }));
    const runAiWeb = vi.fn(async () => ({ ok: true }));

    await runCoordinatedJobSearch({
      capabilities,
      retry: { deterministic: true, aiPromptIds: ["p2"] },
      runDeterministic,
      runAiWeb,
    });

    expect(runDeterministic).toHaveBeenCalledOnce();
    expect(runAiWeb).toHaveBeenCalledWith(expect.objectContaining({ retryPromptIds: ["p2"] }));
  });

  it("shares cancellation with both lanes and does not refetch after abort", async () => {
    const controller = new AbortController();
    const refetch = vi.fn();
    const setSearchState = vi.fn();
    const runLane = vi.fn(async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return { ok: false, aborted: true };
    });

    const result = await runCoordinatedJobSearch({
      capabilities,
      runDeterministic: runLane,
      runAiWeb: runLane,
      refetch,
      setSearchState,
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, aborted: true });
    expect(refetch).not.toHaveBeenCalled();
    expect(setSearchState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "idle",
        reason: "cancelled",
        lanes: {
          deterministic: expect.objectContaining({ status: "skipped" }),
          aiWeb: expect.objectContaining({ status: "skipped" }),
        },
      })
    );
  });
});

describe("jobSearchCapabilities", () => {
  it("distinguishes configured sources from executable deterministic work", () => {
    expect(
      jobSearchCapabilities({
        sourceStatus: {
          searches: { enabled: 2 },
          enabledTrackedCompanies: 0,
          deterministicSources: { attempted: 0 },
        },
        ai: { configured: true, executable: true, consented: true },
      })
    ).toEqual({
      deterministic: { configured: true, executable: false, consented: true },
      aiWeb: { configured: true, executable: true, consented: true },
    });
  });

  it("fails closed when source or AI capability state is unavailable", () => {
    expect(jobSearchCapabilities()).toEqual({
      deterministic: { configured: false, executable: false, consented: true },
      aiWeb: { configured: false, executable: false, consented: false },
    });
  });
});
