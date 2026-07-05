import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  createCompanyProposals: vi.fn(),
  getCompanyProposals: vi.fn(),
  decideCompanyProposal: vi.fn(),
  saveCandidateFile: vi.fn(),
  searchLogos: vi.fn(async () => ({ ok: true, results: [] })),
  logoImageUrl: vi.fn((domain) => `/api/logos/img?domain=${encodeURIComponent(domain)}`),
}));

const chatMock = vi.hoisted(() => ({
  renders: [],
}));

vi.mock("../../lib/api.js", () => apiMocks);

vi.mock("../ChatPanel.jsx", () => ({
  ChatPanel: ({ skill }) => {
    chatMock.renders.push(skill);
    return <div data-testid="chat-marker">CHAT:{skill}</div>;
  },
}));

import {
  CompaniesStep,
  proposalSeedsFromCompanies,
  runCompanyProposalCreate,
  runCompanyProposalRead,
} from "./CompaniesStep.jsx";

const BASE_STATE = {
  data: {
    targeting: {
      tracked_companies: ["Saved Co"],
    },
  },
};

const LOCAL_CAPABILITIES = {
  aiAvailable: false,
  aiRoute: "none",
  companyProposals: true,
  manualCompanySeeds: true,
  discoveryChatHandoffs: false,
  fullSkillRun: false,
  skills: [],
  chatSkills: [],
};

function renderCompaniesStep(props = {}) {
  return renderToStaticMarkup(
    <CompaniesStep
      state={BASE_STATE}
      draftSeeds={{}}
      runtimeCapabilities={LOCAL_CAPABILITIES}
      aiEnabled={false}
      reload={async () => {}}
      goNext={() => {}}
      goBack={() => {}}
      showToast={() => {}}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  chatMock.renders = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proposalSeedsFromCompanies", () => {
  it("maps company name/domain pairs into manual proposal seeds", () => {
    expect(
      proposalSeedsFromCompanies([
        { name: " Acme AI ", domain: "acme.example" },
        { name: "No Domain Co", domain: "" },
        { name: "   ", domain: "blank.example" },
        null,
      ])
    ).toEqual([{ name: "Acme AI", domain_hint: "acme.example" }, { name: "No Domain Co" }]);
  });
});

describe("company proposal API wrappers", () => {
  it("use Phase 3 discovery routes instead of the retained skill runtime route", async () => {
    const actualApi = await vi.importActual("../../lib/api.js");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await actualApi.createCompanyProposals({ manualSeeds: [{ name: "Acme AI" }] });
    await actualApi.getCompanyProposals({ status: "pending" });
    await actualApi.decideCompanyProposal({
      batchId: "cpb_1",
      proposalId: "cpp_1",
      action: "reject",
      expectedVersion: 1,
    });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/discovery/company-proposals",
      "/api/discovery/company-proposals?status=pending",
      "/api/discovery/company-proposal-decisions",
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => options?.method || "GET")).toEqual([
      "POST",
      "GET",
      "POST",
    ]);
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain("/api/skill/run");
  });
});

describe("runCompanyProposalRead", () => {
  it("loads the latest pending proposal batch", async () => {
    const response = { ok: true, data: { batch: null }, meta: { found: false, status: "pending" } };
    apiMocks.getCompanyProposals.mockResolvedValue(response);

    await expect(runCompanyProposalRead()).resolves.toBe(response);

    expect(apiMocks.getCompanyProposals).toHaveBeenCalledWith({ status: "pending" });
    expect(apiMocks.createCompanyProposals).not.toHaveBeenCalled();
  });
});

describe("runCompanyProposalCreate", () => {
  it("creates manual-seed proposals and refreshes pending proposals", async () => {
    const manualSeeds = [{ name: "Acme AI", domain_hint: "acme.example" }];
    const created = { ok: true, data: { batchId: "cpb_new" } };
    const pending = {
      ok: true,
      data: { batch: { batchId: "cpb_new", proposals: [], rejected: [] } },
      meta: { found: true, status: "pending" },
    };
    const calls = [];
    apiMocks.createCompanyProposals.mockImplementation(async (payload) => {
      calls.push(["create", payload]);
      return created;
    });
    apiMocks.getCompanyProposals.mockImplementation(async (payload) => {
      calls.push(["read", payload]);
      return pending;
    });

    await expect(runCompanyProposalCreate({ manualSeeds })).resolves.toEqual({
      created,
      pending,
    });

    expect(calls).toEqual([
      ["create", { manualSeeds }],
      ["read", { status: "pending" }],
    ]);
  });

  it("propagates local proposal route failures without starting chat", async () => {
    apiMocks.createCompanyProposals.mockRejectedValue(new Error("local proposal route failed"));

    await expect(runCompanyProposalCreate({ manualSeeds: [{ name: "Acme AI" }] })).rejects.toThrow(
      "local proposal route failed"
    );

    expect(apiMocks.getCompanyProposals).not.toHaveBeenCalled();
    expect(chatMock.renders).toEqual([]);
  });
});

describe("CompaniesStep", () => {
  it("renders the local proposal control before the explicit secondary chat handoff", () => {
    const html = renderCompaniesStep({
      runtimeCapabilities: {
        ...LOCAL_CAPABILITIES,
        aiAvailable: true,
        aiRoute: "byok",
        discoveryChatHandoffs: true,
        chatSkills: ["discover-companies"],
      },
      aiEnabled: true,
    });

    const localIndex = html.indexOf("Company proposals");
    const chatIndex = html.indexOf("CHAT:discover-companies");

    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(chatIndex).toBeGreaterThan(localIndex);
    expect(html).toContain(">Find boards from shortlist<");
    expect(chatMock.renders).toEqual(["discover-companies"]);
  });

  it("keeps local proposal controls visible when chat and AI are unavailable", () => {
    const html = renderCompaniesStep();

    expect(html).toContain("Company proposals");
    expect(html).toContain(">Find boards from shortlist<");
    expect(html).not.toContain("CHAT:discover-companies");
    expect(chatMock.renders).toEqual([]);
  });
});
