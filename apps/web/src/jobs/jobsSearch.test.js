import { describe, expect, it, vi } from "vitest";
import { runAiWebSearchLane } from "./jobsSearch.js";

function stateSpies() {
  return {
    setStatus: vi.fn(),
    setActivity: vi.fn(),
    setCounts: vi.fn(),
    setError: vi.fn(),
  };
}

describe("runAiWebSearchLane", () => {
  it("moves running to results, records activity/counts, and refetches", async () => {
    const state = stateSpies();
    const refetch = vi.fn();
    const done = { searched: 2, found: 3, new: 2, duplicates: 1, errors: [] };
    const result = await runAiWebSearchLane({
      ...state,
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

  it("surfaces in-band errors as error state without refetching", async () => {
    const state = stateSpies();
    const refetch = vi.fn();
    const result = await runAiWebSearchLane({
      ...state,
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

  it("treats abort as a clean return to idle", async () => {
    const state = stateSpies();
    const result = await runAiWebSearchLane({
      ...state,
      runAiWebSearchStream: async () => {
        throw new DOMException("cancelled", "AbortError");
      },
    });

    expect(result).toEqual({ ok: false, aborted: true });
    expect(state.setStatus.mock.calls).toEqual([["running"], ["idle"]]);
    expect(state.setError).toHaveBeenCalledOnce();
  });
});
