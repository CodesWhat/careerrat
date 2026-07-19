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

function renderCard(setup, props = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SetupReadinessCard setup={setup} {...props} />
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

  it("renders compact readiness rows and missing hints when setup is incomplete", () => {
    const markup = renderCard(INCOMPLETE_SETUP);

    expect(markup).toContain("Setup readiness");
    expect(markup).toContain("Searching now");
    expect(markup).toContain("Search");
    expect(markup).toContain("Gate");
    expect(markup).toContain("Apply");
    expect(markup).toContain("Deep ingest");
    expect(markup).toContain("compensation floor");
    expect(markup).toContain("work authorization");
    expect(markup).toContain("evidence claims");
    expect(markup).toContain("deeper evidence bank");
    expect(markup).toContain("/onboarding");
  });

  it("routes deep ingest to its workbench and every other readiness row to onboarding", () => {
    const markup = renderCard(INCOMPLETE_SETUP);
    const rowLinks = markup
      .match(/<a\b[^>]*>[\s\S]*?<\/a>/g)
      .filter((link) => link.includes("chip--readiness"));
    const hrefFor = (label) => rowLinks.find((link) => link.includes(`>${label}</span>`));

    expect(hrefFor("Deep ingest")).toContain('href="/deep-ingest"');
    for (const label of ["Search", "Gate", "Apply"]) {
      expect(hrefFor(label)).toContain('href="/onboarding"');
    }
  });

  it("shows first-search status as checklist context rather than a nag", () => {
    const markup = renderCard(INCOMPLETE_SETUP, {
      firstSearchRun: {
        status: "running",
        summary: { sourcesAttempted: 2, rolesFound: 0 },
      },
    });

    expect(markup).toContain("First search");
    expect(markup).toContain("Running");
    expect(markup).toContain("Searching deterministic public sources...");
    expect(markup).not.toContain("Search jobs now");
    expect(markup).not.toContain("nag");
  });
});
