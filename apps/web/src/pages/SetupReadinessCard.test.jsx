import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SetupReadinessCard } from "./SetupReadinessCard.jsx";

const COMPLETE_SETUP = {
  readiness: {
    search_ready: true,
    gate_ready: true,
    apply_ready: true,
    deep_ingest_complete: true,
  },
  missing: {
    search_ready: [],
    gate_ready: [],
    apply_ready: [],
    deep_ingest_complete: [],
  },
};

const INCOMPLETE_SETUP = {
  readiness: {
    search_ready: true,
    gate_ready: false,
    apply_ready: false,
    deep_ingest_complete: false,
  },
  missing: {
    search_ready: [],
    gate_ready: ["compensation floor", "work authorization"],
    apply_ready: ["evidence claims"],
    deep_ingest_complete: ["deeper evidence bank", "target-company shortlist"],
  },
};

function renderCard(setup) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SetupReadinessCard setup={setup} />
    </MemoryRouter>
  );
}

describe("SetupReadinessCard", () => {
  it("hides when setup is unavailable", () => {
    expect(renderCard(null)).toBe("");
  });

  it("hides when every readiness flag is complete", () => {
    expect(renderCard(COMPLETE_SETUP)).toBe("");
  });

  it("renders the setup banner with actionable todos when setup is incomplete", () => {
    const markup = renderCard(INCOMPLETE_SETUP);

    expect(markup).toContain('class="setup-banner"');
    expect(markup).toContain("🪪");
    expect(markup).toContain("Finish setup — 4 quick things left");
    expect(markup).toContain("Searching now");
    expect(markup).toContain("Set compensation floor");
    expect(markup).toContain("Add work authorization");
    expect(markup).toContain("Add evidence claims");
    expect(markup).toContain("Finish deep ingest");
    expect(markup).not.toContain("deeper evidence bank");
    expect(markup).not.toContain("target-company shortlist");
  });

  it("deep-links todos to the step that resolves them", () => {
    const markup = renderCard(INCOMPLETE_SETUP);
    const todoLinks = markup.match(/<a\b[^>]*class="setup-banner__todo"[^>]*>[^<]*<\/a>/g) || [];
    const linkFor = (label) => todoLinks.find((link) => link.endsWith(`>${label}</a>`));

    expect(linkFor("Add work authorization")).toContain('href="/onboarding?step=prefs"');
    expect(linkFor("Finish deep ingest")).toContain('href="/deep-ingest"');
  });

  it("deduplicates the same todo across readiness groups", () => {
    const markup = renderCard({
      readiness: {
        search_ready: true,
        gate_ready: false,
        apply_ready: false,
        deep_ingest_complete: true,
      },
      missing: {
        search_ready: [],
        gate_ready: ["work authorization"],
        apply_ready: ["work authorization"],
        deep_ingest_complete: [],
      },
    });

    expect(markup.match(/Add work authorization/g) || []).toHaveLength(1);
  });

  it("uses singular grammar when exactly one todo remains", () => {
    const markup = renderCard({
      readiness: {
        search_ready: true,
        gate_ready: false,
        apply_ready: true,
        deep_ingest_complete: true,
      },
      missing: {
        search_ready: [],
        gate_ready: ["work authorization"],
        apply_ready: [],
        deep_ingest_complete: [],
      },
    });

    expect(markup).toContain("Finish setup — 1 quick thing left");
    expect(markup).not.toContain("1 quick things left");
  });

  it("prompts the user to finish setup before searching when search is not ready", () => {
    const markup = renderCard({
      readiness: {
        search_ready: false,
        gate_ready: true,
        apply_ready: true,
        deep_ingest_complete: true,
      },
      missing: {
        search_ready: ["role titles"],
        gate_ready: [],
        apply_ready: [],
        deep_ingest_complete: [],
      },
    });

    expect(markup).toContain("Finish these to start searching.");
    expect(markup).not.toContain("Searching now. Gate and apply unlock as these fill in.");
  });
});
