import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("./useNeedsYouCount.js", () => ({
  useNeedsYouCount: () => 7,
}));

import { NavList } from "./NavList.jsx";

function renderNav() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NavList />
    </MemoryRouter>
  );
}

describe("NavList", () => {
  it("renders the canonical product top nav", () => {
    const html = renderNav();

    for (const label of ["Dashboard", "Calendar", "Jobs", "Network", "Library"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("Home");
    expect(html).not.toContain("Settings");
    expect(html).not.toContain("Onboarding");
    expect(html).not.toContain("Inbox");
    expect(html).not.toContain("Dashboard V2");
    expect(html).not.toContain("Dashboard V3");
    expect(html).not.toContain("Calendar V2");
    expect(html).not.toContain("Calendar V3");
    expect(html).not.toContain("Calendar Next");
    expect(html).not.toContain("Jobs V2");
    expect(html).not.toContain("Jobs V3");
    expect(html).not.toContain("Jobs Next");
    expect(html).not.toContain("Network V2");
    expect(html).not.toContain("Network V3");
    expect(html).not.toContain("Network Next");
    expect(html).not.toContain("Library V2");
    expect(html).not.toContain("Library V3");
    expect(html).not.toContain("Library Next");
    expect(html).not.toContain("nav-item__badge");
  });

  it("orders the canonical product areas Dashboard → Calendar → Jobs → Network → Library", () => {
    const html = renderNav();

    expect(html.indexOf("Dashboard")).toBeLessThan(html.indexOf("Calendar"));
    expect(html.indexOf("Calendar")).toBeLessThan(html.indexOf("Jobs"));
    expect(html.indexOf("Jobs")).toBeLessThan(html.indexOf("Network"));
    expect(html.indexOf("Network")).toBeLessThan(html.indexOf("Library"));
  });

  it("does not advertise the legacy tracker route as normal product navigation", () => {
    const html = renderNav();

    expect(html).not.toContain("Classic");
    expect(html).not.toContain('href="/tracker"');
  });
});
