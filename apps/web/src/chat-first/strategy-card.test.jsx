import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildChatFirstView } from "./chat-first-model.js";
import { TodayConversation } from "./conversation-surfaces.jsx";

function markup(node) {
  return renderToStaticMarkup(node);
}

const strategyFixture = {
  metrics: {
    topSource: { label: "LinkedIn", rate: "32%", value: "LinkedIn" },
    bestLane: { label: "Platform Engineering", rate: "40%", value: "Platform Engineering" },
    staleCount: { label: "Quiet", value: 3, rate: "3 quiet" },
  },
  sources: [{ label: "LinkedIn", rate: "32%", total: 12, advanced: 4 }],
  roles: [{ label: "Platform Engineering", rate: "40%", total: 5, advanced: 2 }],
  stale: [{ id: "app-1" }, { id: "app-2" }, { id: "app-3" }],
  fitBands: [],
  stageAges: [],
  cadence: [],
  learning: {},
  recommendation: { title: "Double down on LinkedIn", summary: "", ctaLabel: "", ctaAction: "" },
};

describe("buildChatFirstView strategy pass-through", () => {
  it("carries dashboard.strategy through unchanged", () => {
    const view = buildChatFirstView({ strategy: strategyFixture }, {});
    expect(view.strategy).toBe(strategyFixture);
  });

  it("carries a null strategy through when the dashboard has none", () => {
    const view = buildChatFirstView({}, {});
    expect(view.strategy).toBeNull();
  });
});

describe("TodayConversation strategy card", () => {
  it("renders Paul's read on your search with each insight line", () => {
    const html = markup(<TodayConversation agentName="Paul" strategy={strategyFixture} />);

    expect(html).toContain("Paul’s read on your search");
    expect(html).toContain(
      "LinkedIn is your top source, with a 32% response rate across 12 tracked roles."
    );
    expect(html).toContain(
      "Platform Engineering is your strongest role lane, with a 40% response rate across 5 tracked roles."
    );
    expect(html).toContain("3 applications have gone quiet and could use a nudge.");
  });

  it("renders no card when the insight list is empty", () => {
    const emptyStrategy = {
      metrics: {
        topSource: { label: "No source yet", rate: "0%", value: "No source yet" },
        bestLane: { label: "No lane yet", rate: "0%", value: "No lane yet" },
        staleCount: { label: "Quiet", value: 0, rate: "Clear" },
      },
      sources: [],
      roles: [],
      stale: [],
    };
    const html = markup(<TodayConversation agentName="Paul" strategy={emptyStrategy} />);

    expect(html).not.toContain("Paul’s read on your search");
    expect(html).not.toContain("chat-first-strategy-card");
  });

  it("renders no card when strategy is absent", () => {
    const html = markup(<TodayConversation agentName="Paul" strategy={null} />);

    expect(html).not.toContain("Paul’s read on your search");
    expect(html).not.toContain("chat-first-strategy-card");
  });

  it("contains no em dash character in the rendered copy", () => {
    const html = markup(<TodayConversation agentName="Paul" strategy={strategyFixture} />);

    expect(html).not.toContain("—");
  });
});
