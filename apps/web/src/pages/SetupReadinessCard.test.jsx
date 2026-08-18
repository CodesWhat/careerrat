import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
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

// useDeepIngestNudge's dismissal is a module-level store, not per-instance
// useState — AskBar.jsx and DashboardPage.jsx each call the hook from their
// own component instance, and DashboardPage's priority-panel fallback only
// renders once `dismissed` is true (see DashboardPage.jsx's
// `showDeepIngestNudge={deepIngest.needed && deepIngest.dismissed}`). A
// per-instance state would leave that fallback hidden until a remount even
// though the dock in AskBar was already dismissed. vi.resetModules() plus a
// dynamic import keeps this test's module cache isolated from every other
// test in the file (same pattern as DashboardContext.test.jsx's
// loadDashboardContext helper).
describe("useDeepIngestNudge — shared dismissal", () => {
  it("dismissing through one consumer flips dismissed for another consumer in the same mount", async () => {
    vi.resetModules();
    const { useDeepIngestNudge } = await import("./SetupReadinessCard.jsx");

    const captured = {};
    function ConsumerA({ setup }) {
      captured.a = useDeepIngestNudge(setup);
      return null;
    }
    function ConsumerB({ setup }) {
      captured.b = useDeepIngestNudge(setup);
      return null;
    }

    const setup = { readiness: { deep_ingest_complete: false } };
    const tree = (
      <>
        <ConsumerA setup={setup} />
        <ConsumerB setup={setup} />
      </>
    );

    renderToStaticMarkup(tree);
    expect(captured.a.needed).toBe(true);
    expect(captured.a.dismissed).toBe(false);
    expect(captured.b.dismissed).toBe(false);

    captured.a.dismiss();

    renderToStaticMarkup(tree);
    expect(captured.a.dismissed).toBe(true);
    expect(captured.b.dismissed).toBe(true);
  });
});
