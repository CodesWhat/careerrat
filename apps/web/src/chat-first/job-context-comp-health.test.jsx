import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { jobCompRange } from "./ChatFirstApp.jsx";
import { JobContextPanel } from "./conversation-surfaces.jsx";

function markup(node) {
  return renderToStaticMarkup(node);
}

function baseJob(overrides = {}) {
  return {
    company: "Hightouch",
    role: "Software Engineer",
    stage: "Ready",
    fit: 88,
    ...overrides,
  };
}

describe("JobContextPanel comp range bar", () => {
  it("renders a bar with low/high labels, mid pin, and target marker for a posted band", () => {
    const html = markup(
      JobContextPanel({
        job: baseJob({
          compRange: {
            state: "posted",
            hasMarket: true,
            marketLo: 120,
            marketP50: 140,
            marketHi: 160,
            floorK: 110,
            askK: 150,
            currency: "USD",
          },
        }),
      })
    );
    expect(html).toContain("COMPENSATION");
    expect(html).toContain("$120K");
    expect(html).toContain("$160K");
    expect(html).toContain("Posted by the company");
    expect(html).toContain("chat-first-comp-bar__track");
    expect(html).toContain("chat-first-comp-bar__mid");
    expect(html).toContain("chat-first-comp-bar__target");
  });

  it("shows a single figure, not an empty bar, when a posted band collapses to one number", () => {
    const html = markup(
      JobContextPanel({
        job: baseJob({
          compRange: {
            state: "posted",
            hasMarket: true,
            marketLo: 150,
            marketP50: 150,
            marketHi: 150,
            floorK: null,
            askK: 150,
            currency: "USD",
          },
        }),
      })
    );
    expect(html).toContain("$150K");
    expect(html).not.toContain("chat-first-comp-bar__track");
  });

  it("renders a bar for a built (estimated) band", () => {
    const html = markup(
      JobContextPanel({
        job: baseJob({
          compRange: {
            state: "built",
            hasMarket: true,
            marketLo: 100,
            marketP50: 115,
            marketHi: 130,
            floorK: null,
            askK: null,
            currency: "USD",
          },
        }),
      })
    );
    expect(html).toContain("$100K");
    expect(html).toContain("$130K");
    expect(html).toContain("Estimated");
    expect(html).toContain("chat-first-comp-bar__track");
    expect(html).toContain("chat-first-comp-bar__mid");
    // No candidate target in this fixture, so no target marker.
    expect(html).not.toContain("chat-first-comp-bar__target");
  });

  it("shows a plain target line and caption in the needs-info state, with no bar", () => {
    const html = markup(
      JobContextPanel({
        job: baseJob({
          compRange: {
            state: "needs-info",
            hasMarket: false,
            marketLo: null,
            marketP50: null,
            marketHi: null,
            floorK: 100,
            askK: 130,
            currency: "USD",
          },
        }),
      })
    );
    expect(html).toContain("No market data yet");
    expect(html).toContain("Your target $130K");
    expect(html).not.toContain("chat-first-comp-bar__track");
  });

  it("shows a floor line, not a target line, when only the floor is set", () => {
    const html = markup(
      JobContextPanel({
        job: baseJob({
          compRange: {
            state: "needs-info",
            hasMarket: false,
            marketLo: null,
            marketP50: null,
            marketHi: null,
            floorK: 100,
            askK: null,
            currency: "USD",
          },
        }),
      })
    );
    expect(html).toContain("No market data yet");
    expect(html).toContain("Your floor $100K");
    expect(html).not.toContain("Your target");
  });

  it("renders nothing when there is no comp data at all", () => {
    const html = markup(JobContextPanel({ job: baseJob({ compRange: null }) }));
    expect(html).not.toContain("COMPENSATION");
    expect(html).not.toContain("chat-first-comp-bar");
  });
});

describe("JobContextPanel company-health pill", () => {
  it("renders a healthy pill with its provenance line", () => {
    const html = markup(
      JobContextPanel({
        job: baseJob({
          companyHealth: {
            rating: "healthy",
            ratingLabel: "Healthy",
            provenanceLabel: "Built from data",
          },
        }),
      })
    );
    expect(html).toContain("chat-first-context-card__health-pill--healthy");
    expect(html).toContain("Healthy");
    expect(html).toContain("Built from data");
  });

  it("renders a watch pill with its provenance line", () => {
    const html = markup(
      JobContextPanel({
        job: baseJob({
          companyHealth: {
            rating: "watch",
            ratingLabel: "Watch",
            provenanceLabel: "Needs more info",
          },
        }),
      })
    );
    expect(html).toContain("chat-first-context-card__health-pill--watch");
    expect(html).toContain("Watch");
    expect(html).toContain("Needs more info");
  });

  it("renders a risky pill with its provenance line", () => {
    const html = markup(
      JobContextPanel({
        job: baseJob({
          companyHealth: {
            rating: "risky",
            ratingLabel: "Risky for backend engineering",
            provenanceLabel: "Stale",
          },
        }),
      })
    );
    expect(html).toContain("chat-first-context-card__health-pill--risky");
    expect(html).toContain("Risky for backend engineering");
    expect(html).toContain("Stale");
  });

  it("renders nothing when there is no rating", () => {
    const html = markup(JobContextPanel({ job: baseJob({ companyHealth: null }) }));
    expect(html).not.toContain("chat-first-context-card__health-pill");
  });
});

describe("jobCompRange normalization", () => {
  it("treats an unset floor/ask as null, not a fabricated $0K", () => {
    const view = jobCompRange({
      compHasMarket: false,
      floor: null,
      ask: null,
      marketLo: null,
      marketP50: null,
      marketHi: null,
      compState: "needs-info",
      currency: "USD",
    });
    expect(view).toBeNull();
  });

  it("keeps a real floor of 0 distinct from an unset floor", () => {
    const view = jobCompRange({
      compHasMarket: false,
      floor: 0,
      ask: null,
      marketLo: null,
      marketP50: null,
      marketHi: null,
      compState: "needs-info",
      currency: "USD",
    });
    expect(view).not.toBeNull();
    expect(view.floorK).toBe(0);
    expect(view.askK).toBeNull();
  });

  it("does not put a false target marker at 0% when only a market band is set", () => {
    const view = jobCompRange({
      compHasMarket: true,
      floor: null,
      ask: null,
      marketLo: 100,
      marketP50: 120,
      marketHi: 140,
      compState: "posted",
      currency: "USD",
    });
    expect(view.askK).toBeNull();
    expect(view.floorK).toBeNull();
  });
});
