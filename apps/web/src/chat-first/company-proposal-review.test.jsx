import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const ARTIFACT = {
  kind: "company_proposals",
  title: "Company discovery: 2 to review",
  batchId: "batch-growth",
  version: 9,
  counts: { proposals: 3, rejected: 0, seeds: 3 },
  proposals: [
    {
      proposalId: "proposal-acme",
      company: { name: "Acme AI", domain: "acme.example" },
      roleSeen: "Staff Applied AI Engineer",
      why: "Matches the candidate's applied AI focus.",
      jobBoardUrl: "https://boards.greenhouse.io/acme",
      atsProvider: "greenhouse",
      classification: "supported_ats",
      proposedAction: "review",
      version: 3,
    },
    {
      proposalId: "proposal-tyrell",
      company: { name: "Tyrell Systems", domain: "tyrell.example" },
      roleSeen: "Principal Platform Engineer",
      why: "Strong platform ownership match.",
      jobBoardUrl: "https://jobs.ashbyhq.com/tyrell",
      atsProvider: "ashby",
      classification: "supported_ats",
      proposedAction: "approve-supported-ats",
      version: 5,
    },
    {
      proposalId: "proposal-decided",
      company: { name: "Already Reviewed" },
      roleSeen: "Staff Engineer",
      why: "This proposal is no longer pending.",
      jobBoardUrl: "https://jobs.lever.co/reviewed",
      atsProvider: "lever",
      classification: "supported_ats",
      proposedAction: "approve-supported-ats",
      version: 2,
      decision: { action: "reject", status: "rejected" },
    },
  ],
};

async function reviewContract() {
  return import("./company-proposal-review.jsx").catch((error) => {
    if (/cannot find|failed to load|does not exist/i.test(String(error?.message))) return {};
    throw error;
  });
}

function visit(node, callback) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => {
      visit(child, callback);
    });
    return;
  }
  if (typeof node.type === "function") {
    visit(node.type(node.props), callback);
    return;
  }
  callback(node);
  visit(node.props?.children, callback);
}

describe("company proposal review", () => {
  it("resolves exact visible company names to the same stable batch ids", async () => {
    const { companyProposalTextSelection } = await reviewContract();

    expect(companyProposalTextSelection(ARTIFACT, "Track Acme AI and Tyrell Systems")).toEqual([
      "proposal-acme",
      "proposal-tyrell",
    ]);
    expect(companyProposalTextSelection(ARTIFACT, "Track tyrell.example")).toEqual([
      "proposal-tyrell",
    ]);
    expect(companyProposalTextSelection(ARTIFACT, "Track Acme")).toBeNull();
    expect(companyProposalTextSelection(ARTIFACT, "Track Already Reviewed")).toBeNull();
    expect(companyProposalTextSelection(ARTIFACT, "Why is Acme AI relevant?")).toBeNull();
    expect(companyProposalTextSelection(ARTIFACT, "Reject Acme AI")).toEqual(["proposal-tyrell"]);
    expect(
      companyProposalTextSelection(
        {
          ...ARTIFACT,
          proposals: [
            ARTIFACT.proposals[0],
            {
              ...ARTIFACT.proposals[1],
              proposalId: "proposal-acme-labs",
              company: { name: "Acme AI Labs" },
            },
          ],
        },
        "Track Acme AI Labs"
      )
    ).toBeNull();
  });

  it("recognizes a main-thread company proposals artifact without performing a write", async () => {
    const { companyProposalReviewForArtifact } = await reviewContract();

    expect(companyProposalReviewForArtifact).toBeTypeOf("function");
    expect(companyProposalReviewForArtifact(ARTIFACT)).toMatchObject({
      kind: "company_proposals",
      title: "Company discovery: 2 to review",
      batchId: "batch-growth",
      version: 9,
      proposals: ARTIFACT.proposals.slice(0, 2),
    });
    expect(companyProposalReviewForArtifact({ kind: "resume" })).toBeNull();
  });

  it("builds canonical Track and Skip intents from the selected proposal version", async () => {
    const { companyProposalDecisionIntent } = await reviewContract();
    const proposal = ARTIFACT.proposals[0];

    expect(companyProposalDecisionIntent).toBeTypeOf("function");
    expect(companyProposalDecisionIntent(ARTIFACT, proposal, "track")).toEqual({
      type: "company.proposal-decide",
      entity: { type: "company-proposal", id: "proposal-acme" },
      input: {
        batchId: "batch-growth",
        action: "approve-supported-ats",
        expectedVersion: 3,
      },
    });
    expect(companyProposalDecisionIntent(ARTIFACT, proposal, "skip")).toEqual({
      type: "company.proposal-decide",
      entity: { type: "company-proposal", id: "proposal-acme" },
      input: { batchId: "batch-growth", action: "reject", expectedVersion: 3 },
    });
    expect(
      companyProposalDecisionIntent(ARTIFACT, { ...proposal, proposedAction: "review" }, "track")
    ).toEqual({
      type: "company.proposal-decide",
      entity: { type: "company-proposal", id: "proposal-acme" },
      input: {
        batchId: "batch-growth",
        action: "approve-supported-ats",
        expectedVersion: 3,
      },
    });
  });

  it("reads the refreshed review artifact returned by a canonical decision", async () => {
    const { companyProposalReviewFromResult } = await reviewContract();
    const refreshed = {
      ...ARTIFACT,
      title: "Company discovery: 1 to review",
      proposals: [ARTIFACT.proposals[1]],
    };

    expect(companyProposalReviewFromResult).toBeTypeOf("function");
    expect(
      companyProposalReviewFromResult({
        data: {
          messages: [
            {
              artifacts: [{ kind: "search_run", status: "running" }, refreshed],
            },
          ],
        },
      })
    ).toMatchObject({
      title: "Company discovery: 1 to review",
      proposals: [ARTIFACT.proposals[1]],
    });
    expect(
      companyProposalReviewFromResult({
        messages: [
          {
            artifacts: [
              {
                ...ARTIFACT,
                title: "Company discovery: review complete",
                proposals: [],
              },
            ],
          },
        ],
      })
    ).toMatchObject({ title: "Company discovery: review complete", proposals: [] });
  });

  it("renders pending company evidence and stays read-only until Track or Skip is clicked", async () => {
    const { CompanyProposalReview, CompanyProposalReviewContent } = await reviewContract();
    const onIntent = vi.fn();
    const onClose = vi.fn();

    expect(CompanyProposalReview).toBeTypeOf("function");
    const element = CompanyProposalReview({ artifact: ARTIFACT, onIntent, onClose });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Acme AI");
    expect(html).toContain("Staff Applied AI Engineer");
    expect(html).toContain("Matches the candidate&#x27;s applied AI focus.");
    expect(html).toContain("greenhouse");
    expect(html).toContain("https://boards.greenhouse.io/acme");
    expect(html).toContain("Tyrell Systems");
    expect(html).not.toContain("Already Reviewed");
    expect(html).toContain("Which companies should CareerRat track?");
    expect(html).toContain("1 reviewed · 2 remaining");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/>Save choices</g)).toHaveLength(1);
    expect(html).not.toContain(">Track<");
    expect(html).not.toContain(">Skip<");
    expect(html).toContain(">Back<");
    expect(onIntent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const buttons = [];
    visit(CompanyProposalReviewContent({ artifact: ARTIFACT, onIntent, onClose }), (node) => {
      if (node.type === "button") buttons.push(node);
    });
    const save = buttons.find((button) => button.props.children === "Save choices");
    const back = buttons.find((button) => button.props.children === "Back");
    expect(save).toBeDefined();
    expect(back).toBeDefined();

    back.props.onClick();
    expect(onIntent).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("builds and submits a batch with the captured proposal versions", async () => {
    const { companyProposalBatchIntents, submitCompanyProposalBatch } = await reviewContract();
    const selected = ["proposal-acme"];
    const intents = companyProposalBatchIntents(ARTIFACT, selected);
    expect(intents).toEqual([
      {
        type: "company.proposal-decide",
        entity: { type: "company-proposal", id: "proposal-acme" },
        input: {
          batchId: "batch-growth",
          action: "approve-supported-ats",
          expectedVersion: 3,
        },
      },
      {
        type: "company.proposal-decide",
        entity: { type: "company-proposal", id: "proposal-tyrell" },
        input: { batchId: "batch-growth", action: "reject", expectedVersion: 5 },
      },
    ]);
    expect(companyProposalBatchIntents(ARTIFACT, ["proposal-stale"])).toBeNull();

    const onIntent = vi.fn();
    await submitCompanyProposalBatch({ artifact: ARTIFACT, selectedOptionIds: selected, onIntent });
    expect(onIntent.mock.calls).toEqual(intents.map((intent) => [intent]));

    const failingIntent = vi.fn().mockResolvedValueOnce(false);
    expect(
      await submitCompanyProposalBatch({
        artifact: ARTIFACT,
        selectedOptionIds: selected,
        onIntent: failingIntent,
      })
    ).toBe(false);
    expect(failingIntent).toHaveBeenCalledOnce();
  });

  it("keeps the batch controls disabled while decisions are in flight", async () => {
    const { CompanyProposalReviewContent } = await reviewContract();
    const buttons = [];
    visit(
      CompanyProposalReviewContent({
        artifact: ARTIFACT,
        busy: true,
        onIntent: vi.fn(),
        onClose: vi.fn(),
      }),
      (node) => {
        if (node.type === "button") buttons.push(node);
      }
    );

    expect(buttons.find((button) => button.props.children === "Back").props.disabled).toBe(true);
    expect(buttons.find((button) => button.props.children === "Save choices").props.disabled).toBe(
      true
    );
  });

  it("uses the same focus trap, Escape close, focus target, and modal semantics as source review", async () => {
    const { CompanyProposalReview, handleCompanyProposalReviewKeyDown } = await reviewContract();
    const onClose = vi.fn();
    const escapeEvent = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    handleCompanyProposalReviewKeyDown({ event: escapeEvent, onClose });
    expect(onClose).toHaveBeenCalledOnce();
    expect(escapeEvent.preventDefault).toHaveBeenCalledOnce();

    const html = renderToStaticMarkup(
      <CompanyProposalReview artifact={ARTIFACT} onIntent={vi.fn()} onClose={vi.fn()} />
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('tabindex="-1"');
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    expect(css).toMatch(
      /\.company-proposal-review__card:has\(input:checked\)\s*\{[^}]*background:\s*var\(--tint-cool-2\)/s
    );
    expect(css).toMatch(/\.packet-viewer-overlay\s*\{[^}]*overscroll-behavior:\s*contain/s);
  });
});
