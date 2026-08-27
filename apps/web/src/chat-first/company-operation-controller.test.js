import { describe, expect, it, vi } from "vitest";

import {
  clearCompanyDiscoveryOperation,
  companyProposalArtifact,
  followCompanyDiscoveryOperation,
  readCompanyDiscoveryOperationId,
  rememberCompanyDiscoveryOperation,
  retryCompanyDiscoveryOperation,
} from "./company-operation-controller.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}

describe("company discovery foreground lifecycle", () => {
  it("persists only the durable operation id across a reload", () => {
    const storage = memoryStorage();
    rememberCompanyDiscoveryOperation(storage, { id: "app-operation-company-1" });
    expect(readCompanyDiscoveryOperationId(storage)).toBe("app-operation-company-1");
    clearCompanyDiscoveryOperation(storage, "another-operation");
    expect(readCompanyDiscoveryOperationId(storage)).toBe("app-operation-company-1");
    clearCompanyDiscoveryOperation(storage, "app-operation-company-1");
    expect(readCompanyDiscoveryOperationId(storage)).toBeNull();
  });

  it("follows the exact operation and opens only its durable result batch", async () => {
    const api = {
      getAppOperation: vi
        .fn()
        .mockResolvedValueOnce({ id: "op-1", status: "running" })
        .mockResolvedValueOnce({
          id: "op-1",
          status: "completed",
          resultRef: { type: "company-proposal-batch", id: "cpb-exact" },
        }),
      getCompanyProposalBatch: vi.fn().mockResolvedValue({
        batchId: "cpb-exact",
        proposals: [{ proposalId: "proposal-1" }],
      }),
    };
    const progress = [];
    const completed = await followCompanyDiscoveryOperation({
      api,
      id: "op-1",
      pollMs: 0,
      onProgress: (operation) => progress.push(operation.status),
    });

    expect(progress).toEqual(["running", "completed"]);
    expect(api.getCompanyProposalBatch).toHaveBeenCalledWith("cpb-exact");
    expect(completed.batch.batchId).toBe("cpb-exact");
    expect(companyProposalArtifact(completed.batch)).toMatchObject({
      kind: "company_proposals",
      batchId: "cpb-exact",
    });
  });

  it("rejects a mismatched result reference instead of opening the latest batch", async () => {
    const api = {
      getAppOperation: vi.fn().mockResolvedValue({
        id: "op-1",
        status: "completed",
        resultRef: { type: "some-other-result", id: "cpb-wrong" },
      }),
      getCompanyProposalBatch: vi.fn(),
    };

    await expect(followCompanyDiscoveryOperation({ api, id: "op-1", pollMs: 0 })).rejects.toThrow(
      "didn't finish with a company review batch"
    );
    expect(api.getCompanyProposalBatch).not.toHaveBeenCalled();
  });

  it("starts a linked retry and follows the retry operation, not the failed parent", async () => {
    const api = {
      retryAppOperation: vi.fn().mockResolvedValue({
        operation: { id: "op-2", status: "running", retryOf: "op-1", attempt: 2 },
      }),
    };
    const storage = memoryStorage();
    const retried = await retryCompanyDiscoveryOperation({ api, id: "op-1", storage });
    expect(retried.id).toBe("op-2");
    expect(retried.retryOf).toBe("op-1");
    expect(readCompanyDiscoveryOperationId(storage)).toBe("op-2");
  });
});
