import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoachingPlanCard } from "./CoachingPlanCard.jsx";

function evidenceGap(overrides = {}) {
  return {
    id: "no-direct-kubernetes-production-experience",
    gapText: "No direct Kubernetes production experience on record",
    suggestion: {
      kind: "evidence-claim",
      draftClaim: {
        claim: "Ran production platform tooling used daily by 3 engineering teams.",
        evidence: "Source: resume (Experience — Northwind Digital).",
      },
      rationale: "Grounds platform-delivery scope without claiming Kubernetes itself.",
    },
    status: "open",
    ...overrides,
  };
}

function planWith(overrides = {}) {
  return {
    basedOn: {
      gate: "review",
      fitScore: 68,
      fitBucket: "med",
      evaluatedAt: "2026-08-19T00:00:00.000Z",
    },
    gaps: [evidenceGap()],
    ...overrides,
  };
}

function renderCard(props = {}) {
  return renderToStaticMarkup(
    <CoachingPlanCard plan={null} onAddToEvidence={() => {}} onSkip={() => {}} {...props} />
  );
}

describe("CoachingPlanCard", () => {
  it("renders nothing when there is no plan yet", () => {
    expect(renderCard({ plan: null })).toBe("");
  });

  it("renders nothing when the plan has no gaps", () => {
    expect(renderCard({ plan: { gaps: [] } })).toBe("");
  });

  it("renders the gap text verbatim, the AI-drafted framing line, and the grounded evidence-claim draft", () => {
    const html = renderCard({ plan: { gaps: [evidenceGap()] } });
    expect(html).toContain("No direct Kubernetes production experience on record");
    expect(html).toContain(
      "Drafted from what you have told CareerRat. Check it reads true before adding."
    );
    expect(html).toContain("Ran production platform tooling used daily by 3 engineering teams.");
    expect(html).toContain("Source: resume (Experience — Northwind Digital).");
    expect(html).toContain("Grounds platform-delivery scope without claiming Kubernetes itself.");
  });

  it("renders an honest no-close-path gap without a draft claim", () => {
    const html = renderCard({
      plan: {
        gaps: [
          evidenceGap({
            id: "no-fintech-domain-experience",
            gapText: "No fintech domain experience on record",
            suggestion: {
              kind: "no-close-path",
              draftClaim: null,
              rationale: "Nothing on record honestly closes this gap.",
            },
          }),
        ],
      },
    });
    expect(html).toContain("No honest way to close this one yet.");
    expect(html).toContain("Nothing on record honestly closes this gap.");
  });

  it("renders Add to evidence and Skip for an open gap with a draft claim", () => {
    const html = renderCard({ plan: { gaps: [evidenceGap()] } });
    expect(html).toContain("Add to evidence");
    expect(html).toContain("Skip");
  });

  it("omits Add to evidence for an open no-close-path gap, but still offers Skip", () => {
    const html = renderCard({
      plan: {
        gaps: [
          evidenceGap({
            suggestion: { kind: "no-close-path", draftClaim: null, rationale: "No path yet." },
          }),
        ],
      },
    });
    expect(html).not.toContain("Add to evidence");
    expect(html).toContain("Skip");
  });

  it("disables both actions and shows a saving label while the gap is busy", () => {
    const html = renderCard({
      plan: { gaps: [evidenceGap()] },
      busyGapId: "no-direct-kubernetes-production-experience",
    });
    expect(html).toContain("Saving…");
    expect(html).toContain("disabled");
  });

  it("renders a status badge instead of actions once a gap is closed or dismissed", () => {
    const closedHtml = renderCard({ plan: { gaps: [evidenceGap({ status: "closed" })] } });
    expect(closedHtml).toContain("Added to evidence");
    expect(closedHtml).not.toContain("Add to evidence<");
    expect(closedHtml).not.toContain(">Skip<");

    const dismissedHtml = renderCard({ plan: { gaps: [evidenceGap({ status: "dismissed" })] } });
    expect(dismissedHtml).toContain("Skipped");
  });

  it("stays visible but disables Add/Skip and shows a stale notice once a new evaluation has landed", () => {
    const html = renderCard({
      plan: planWith(),
      evaluation: { evaluatedAt: "2026-08-21T00:00:00.000Z" },
    });
    expect(html).toContain(
      "This plan was built for an earlier evaluation. Coach again to refresh it."
    );
    expect(html).toContain("Add to evidence");
    expect(html).toContain("Skip");
    expect(html).toContain("disabled");
  });

  it("renders no stale notice and leaves actions enabled when the plan matches the current evaluation", () => {
    const html = renderCard({
      plan: planWith(),
      evaluation: { evaluatedAt: "2026-08-19T00:00:00.000Z" },
    });
    expect(html).not.toContain("earlier evaluation");
    expect(html).not.toContain("disabled");
  });
});
