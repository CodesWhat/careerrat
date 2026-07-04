import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const dashboardMock = vi.hoisted(() => ({
  snapshot: {
    data: null,
    loading: false,
    error: null,
    noDatabase: false,
  },
}));

vi.mock("../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => dashboardMock.snapshot,
}));

import { filterLibraryCards, LibraryPage } from "./LibraryPage.jsx";

function makeLibrary(overrides = {}) {
  return {
    metrics: { claims: 24, stories: 35, gaps: 0 },
    index: [
      { label: "Evidence bank", value: "24" },
      { label: "Story bank", value: "35" },
      { label: "Writing voice", value: "Ready" },
      { label: "Claim gaps", value: "0" },
    ],
    filters: [
      { label: "Applied AI", count: 24 },
      { label: "Platform", count: 14 },
    ],
    cards: Array.from({ length: 60 }, (_, index) => ({
      kind: index % 3 === 0 ? "evidence" : "story",
      label: index % 3 === 0 ? "Evidence bank" : "Story bank",
      title: `Reusable proof ${index + 1}`,
      summary: `Migration outcome ${index + 1}`,
      note: `Use proof ${index + 1} with the confirmed evidence boundary.`,
      tags: [
        { label: index % 2 === 0 ? "Applied AI" : "Platform", tone: "teal" },
        { label: "Metrics-backed", tone: "gold" },
      ],
    })),
    readiness: { proof: 24, stories: 35, voice: 1 },
    gaps: [
      {
        tone: "teal",
        title: "No urgent gaps",
        body: "Evidence, stories, and writing guidance are ready for normal reuse.",
      },
    ],
    storyLanes: [
      { tone: "teal", body: "Applied AI: incident automation" },
      { tone: "sky", body: "Platform: migration leadership" },
    ],
    ...overrides,
  };
}

function renderPage(library) {
  dashboardMock.snapshot = {
    data: { library },
    loading: false,
    error: null,
    noDatabase: false,
  };
  return renderToStaticMarkup(<LibraryPage />);
}

describe("LibraryPage", () => {
  it("renders the full uncapped library bank", () => {
    const html = renderPage(makeLibrary());

    expect((html.match(/data-library-card=/g) || []).length).toBe(60);
    expect(html).toContain("Reusable proof 1");
    expect(html).toContain("Reusable proof 60");
  });

  it("narrows cards by type, family, lane, and text query", () => {
    const cards = [
      {
        kind: "story",
        title: "Incident automation",
        summary: "Built an applied AI workflow for escalations.",
        note: "Best for agentic systems interviews.",
        tags: [{ label: "Applied AI" }, { label: "Agentic Systems" }],
      },
      {
        kind: "story",
        title: "Platform migration",
        summary: "Moved the service estate safely.",
        note: "Best for platform leadership.",
        tags: [{ label: "Platform" }],
      },
      {
        kind: "evidence",
        title: "Applied AI claim",
        summary: "Evidence claim.",
        note: "Use the verified wording.",
        tags: [{ label: "Applied AI" }],
      },
    ];

    const filtered = filterLibraryCards(cards, {
      type: "story",
      family: "Applied AI",
      lane: "Agentic Systems: reusable story",
      query: "escalations",
    });

    expect(filtered).toEqual([cards[0]]);
  });

  it("renders an honest setup empty state", () => {
    const html = renderPage(
      makeLibrary({
        metrics: { claims: 0, stories: 0, gaps: 0 },
        index: [],
        filters: [],
        cards: [],
        readiness: { proof: 0, stories: 0, voice: 0 },
        gaps: [],
        storyLanes: [],
      })
    );

    expect(html).toContain("No reusable material yet");
    expect(html).toContain("ingest-profile");
    expect(html).toContain("capture evidence");
    expect((html.match(/data-library-card=/g) || []).length).toBe(0);
  });
});
