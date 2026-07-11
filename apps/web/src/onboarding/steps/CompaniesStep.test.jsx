import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  createCompanyProposals: vi.fn(),
  getCompanyProposals: vi.fn(),
  decideCompanyProposal: vi.fn(),
  saveCandidateFile: vi.fn(),
  searchLogos: vi.fn(async () => ({ ok: true, results: [] })),
  logoImageUrl: vi.fn((input) => {
    const source = input && typeof input === "object" ? input : { domain: input };
    const parts = [];
    if (source.domain) parts.push(`domain=${encodeURIComponent(source.domain)}`);
    if (source.name) parts.push(`name=${encodeURIComponent(source.name)}`);
    return `/api/logos/img?${parts.join("&")}`;
  }),
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

import { resolveCompanySuggestions } from "../companyCatalog.js";
import * as CompaniesStepModule from "./CompaniesStep.jsx";
import {
  CompaniesStep,
  companySeedErrorMessage,
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

const SUPPORTED_PROPOSAL = {
  proposalId: "proposal-supported",
  company: { name: "Acme AI", domain: "acme.example" },
  why: "Strong applied AI fit.",
  roleSeen: "Applied AI Engineer",
  jobBoardUrl: "https://jobs.lever.co/acme",
  atsProvider: "lever",
  confidenceTier: "high-confidence",
  proposedAction: "approve-supported-ats",
  version: 3,
};

const REVIEW_PROPOSAL = {
  proposalId: "proposal-review",
  company: { name: "Review Co", domain: "review.example" },
  why: "Needs review before approval.",
  roleSeen: "AI Architect",
  jobBoardUrl: "https://jobs.ashbyhq.com/review",
  atsProvider: "ashby",
  confidenceTier: "borderline",
  proposedAction: "review",
  version: 4,
};

const ACTION_BATCH = {
  batchId: "batch-actions",
  status: "pending",
  counts: { proposals: 2, rejected: 0 },
  proposals: [SUPPORTED_PROPOSAL, REVIEW_PROPOSAL],
  rejected: [],
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

describe("CompaniesStep logo UX", () => {
  it("resolves common companies locally before logo search returns", () => {
    expect(resolveCompanySuggestions({ query: "sweet" })[0]).toMatchObject({
      name: "Sweetgreen",
      domain: "sweetgreen.com",
      source: "catalog",
    });
    expect(resolveCompanySuggestions({ query: "sweet green" })[0]).toMatchObject({
      name: "Sweetgreen",
      domain: "sweetgreen.com",
    });
  });

  it("merges logo search results without duplicating selected companies", () => {
    expect(
      resolveCompanySuggestions({
        query: "sweet",
        selectedCompanies: [{ name: "Sweetgreen", domain: "sweetgreen.com" }],
        logoResults: [
          { name: "Sweetgreen", domain: "sweetgreen.com" },
          { name: "Sweet Labs", domain: "sweetlabs.example" },
        ],
      })
    ).toEqual([{ name: "Sweet Labs", domain: "sweetlabs.example", source: "logo-search" }]);
  });

  it("does not ask for logo.dev image credentials during onboarding", () => {
    const html = renderCompaniesStep();

    expect(html).not.toContain("logo.dev credentials");
    expect(html).not.toContain("Image token");
    expect(html).not.toContain("Search key");
    expect(html).not.toContain("No logo.dev search key configured");
  });

  it("describes unavailable AI company picks without asking for an AI key", () => {
    expect(companySeedErrorMessage({ status: 501 })).toBe(
      "AI company picks are unavailable right now. Add companies manually for now."
    );
    expect(companySeedErrorMessage({ body: { code: "NO_AI_ROUTE" } })).toBe(
      "AI company picks are unavailable right now. Add companies manually for now."
    );
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

describe("runCompanyProposalDecision", () => {
  it("sends the proposal decision contract and refreshes pending proposals after success", async () => {
    const decision = { action: "reject", status: "rejected" };
    const decidedProposal = {
      ...SUPPORTED_PROPOSAL,
      version: 4,
      decision,
    };
    const decisionResponse = {
      ok: true,
      data: {
        decision,
        proposal: decidedProposal,
      },
      meta: { version: 7 },
    };
    const pending = {
      ok: true,
      data: { batch: { batchId: "batch-actions", proposals: [decidedProposal], rejected: [] } },
      meta: { found: true, status: "pending" },
    };
    const calls = [];

    await expect(
      CompaniesStepModule.runCompanyProposalDecision({
        batchId: "batch-actions",
        proposal: SUPPORTED_PROPOSAL,
        action: "reject",
        decideProposal: async (payload) => {
          calls.push(["decide", payload]);
          return decisionResponse;
        },
        readProposals: async (payload) => {
          calls.push(["read", payload]);
          return pending;
        },
      })
    ).resolves.toEqual({
      result: decisionResponse,
      pending,
      decision,
      proposal: decidedProposal,
      refreshedProposal: null,
      rejected: null,
      conflict: false,
    });

    expect(calls).toEqual([
      [
        "decide",
        {
          batchId: "batch-actions",
          proposalId: "proposal-supported",
          action: "reject",
          expectedVersion: 3,
        },
      ],
      ["read", { status: "pending" }],
    ]);
  });

  it("preserves refresh and rejected metadata returned by the decision route", async () => {
    const refreshedProposal = { ...SUPPORTED_PROPOSAL, version: 4 };
    const rejected = {
      proposalId: "proposal-rejected",
      company: { name: "Rejected Co" },
      confidenceTier: "rejected",
      rejectReasons: ["no-current-role-signal"],
      version: 4,
    };
    const pending = {
      ok: true,
      data: { batch: { batchId: "batch-actions", proposals: [], rejected: [rejected] } },
      meta: { found: true, status: "pending" },
    };

    await expect(
      CompaniesStepModule.runCompanyProposalDecision({
        batchId: "batch-actions",
        proposal: SUPPORTED_PROPOSAL,
        action: "refresh",
        decideProposal: async () => ({
          ok: true,
          data: {
            decision: { action: "refresh", status: "refreshed" },
            refreshedProposal,
            rejected: null,
          },
        }),
        readProposals: async () => pending,
      })
    ).resolves.toMatchObject({
      decision: { action: "refresh", status: "refreshed" },
      refreshedProposal,
      rejected: null,
      pending,
    });

    await expect(
      CompaniesStepModule.runCompanyProposalDecision({
        batchId: "batch-actions",
        proposal: SUPPORTED_PROPOSAL,
        action: "refresh",
        decideProposal: async () => ({
          ok: true,
          data: {
            decision: { action: "refresh", status: "rejected" },
            refreshedProposal: null,
            rejected,
          },
        }),
        readProposals: async () => pending,
      })
    ).resolves.toMatchObject({
      decision: { action: "refresh", status: "rejected" },
      refreshedProposal: null,
      rejected,
      pending,
    });
  });

  it("treats stale-version conflicts as a local refresh-needed state without starting chat", async () => {
    const pending = {
      ok: true,
      data: { batch: ACTION_BATCH },
      meta: { found: true, status: "pending" },
    };
    const calls = [];
    const conflict = {
      status: 409,
      body: { code: "CONFLICT", error: { message: "proposal changed; refresh required" } },
    };

    await expect(
      CompaniesStepModule.runCompanyProposalDecision({
        batchId: "batch-actions",
        proposal: SUPPORTED_PROPOSAL,
        action: "approve-supported-ats",
        decideProposal: async (payload) => {
          calls.push(["decide", payload]);
          throw conflict;
        },
        readProposals: async (payload) => {
          calls.push(["read", payload]);
          return pending;
        },
      })
    ).resolves.toMatchObject({
      conflict: true,
      pending,
      message: "Proposal changed. Review the refreshed proposal before deciding.",
    });

    expect(calls).toEqual([
      [
        "decide",
        {
          batchId: "batch-actions",
          proposalId: "proposal-supported",
          action: "approve-supported-ats",
          expectedVersion: 3,
        },
      ],
      ["read", { status: "pending" }],
    ]);
    expect(chatMock.renders).toEqual([]);
  });
});

describe("CompaniesStep", () => {
  it("renders inside the same two-panel onboarding card as the surrounding steps", () => {
    const html = renderCompaniesStep();

    expect(html).toContain("onboarding-shell");
    expect(html).toContain("onboarding-shell--targeting");
    expect(html).toContain("onboarding-step-stack onboarding-step-stack--targeting");
    expect(html).toContain("onboarding-step-label");
    expect(html).toContain(">Step 4<");
    expect(html).toContain("onboarding-step-card onboarding-targeting onboarding-companies");
    expect(html).toContain("onboarding-step-card__media onboarding-targeting__media");
    expect(html).toContain("onboarding-targeting__content onboarding-companies__content");
    expect(html).toContain("onboarding-shell__actions");
  });

  it("does not render proposal admin controls, chat handoffs, or logo.dev setup UI", () => {
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

    expect(html).not.toContain("Company proposals");
    expect(html).not.toContain("Load pending proposals");
    expect(html).not.toContain("Find boards from shortlist");
    expect(html).not.toContain("Ask Roland");
    expect(html).not.toContain("CHAT:discover-companies");
    expect(html).not.toContain("logo.dev");
    expect(chatMock.renders).toEqual([]);
  });

  it("shows AI proposal companies as editable scan targets without decision buttons", () => {
    const html = renderCompaniesStep({ initialProposalBatch: ACTION_BATCH });

    expect(html).toContain("Acme AI");
    expect(html).toContain("Review Co");
    expect(html).toContain("onboarding-companies__company-list");
    for (const action of ["approve-supported-ats", "reject", "suppress", "escalate", "refresh"]) {
      expect(html).not.toContain(`data-action="${action}"`);
    }
    expect(html).not.toContain("CHAT:discover-companies");
  });

  it("renders selected companies as compact removable pills", () => {
    const html = renderCompaniesStep({ initialProposalBatch: ACTION_BATCH });

    expect(html).toContain("onboarding-companies__company-pill");
    expect(html).not.toContain("onboarding-companies__company-card");
    expect(html).toContain('aria-label="Remove Acme AI"');
    expect(html).toContain('aria-label="Remove Saved Co"');
  });

  it("keeps the action card free of explanatory company-board copy", () => {
    const html = renderCompaniesStep({ initialProposalBatch: ACTION_BATCH });

    expect(html).not.toContain("Company boards to scan");
    expect(html).not.toContain("AI mixes your resume signals");
    expect(html).not.toContain("these make sure selected company boards are checked directly");
    expect(html).toContain("Selected company scan targets");
    expect(html).toContain('class="field onboarding-custom-entry onboarding-companies__add-field"');
    expect(html).toContain("Add a company");
  });
});
