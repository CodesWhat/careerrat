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

    for (const label of ["Dashboard", "Dashboard V2", "Jobs", "Calendar", "Network", "Library"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("Home");
    expect(html).not.toContain("Settings");
    expect(html).not.toContain("Onboarding");
    expect(html).not.toContain("Inbox");
    expect(html).not.toContain("nav-item__badge");
  });

  it("keeps Calendar immediately to the right of Dashboard", () => {
    const html = renderNav();

    expect(html.indexOf("Dashboard")).toBeLessThan(html.indexOf("Calendar"));
    expect(html.indexOf("Calendar")).toBeLessThan(html.indexOf("Dashboard V2"));
  });

  it("does not advertise the legacy tracker route as normal product navigation", () => {
    const html = renderNav();

    expect(html).not.toContain("Classic");
    expect(html).not.toContain('href="/tracker"');
  });
});
