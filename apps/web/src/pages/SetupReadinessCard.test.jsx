import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  DeepIngestDock,
  DeepIngestPriorityNudge,
  deepIngestNeeded,
} from "./SetupReadinessCard.jsx";

function renderWithRouter(node) {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("deepIngestNeeded", () => {
  it("is false when setup is unavailable", () => {
    expect(deepIngestNeeded(null)).toBe(false);
  });

  it("is false when deep ingest is complete", () => {
    expect(deepIngestNeeded({ readiness: { deep_ingest_complete: true } })).toBe(false);
  });

  it("is true when deep ingest is not complete", () => {
    expect(deepIngestNeeded({ readiness: { deep_ingest_complete: false } })).toBe(true);
  });
});

describe("DeepIngestDock", () => {
  it("renders the docked nudge row with a title, CTA, and dismiss control", () => {
    const markup = renderWithRouter(<DeepIngestDock onDismiss={() => {}} />);

    expect(markup).toContain('class="ask-bar__nudge"');
    expect(markup).toContain("Go deeper");
    expect(markup).toMatch(/<a[^>]*href="\/deep-ingest"[^>]*>Start deep ingest<\/a>/);
    expect(markup).toMatch(/<button[^>]*aria-label="Dismiss"[^>]*>/);
  });
});

describe("DeepIngestPriorityNudge", () => {
  it("renders a link to deep ingest", () => {
    const markup = renderWithRouter(<DeepIngestPriorityNudge />);

    expect(markup).toMatch(/<a[^>]*href="\/deep-ingest"[^>]*>/);
  });
});
