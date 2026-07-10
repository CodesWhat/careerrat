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

    for (const label of [
      "Dashboard",
      "Calendar",
      "Jobs",
      "Jobs V2",
      "Jobs V3",
      "Network",
      "Network V2",
      "Network V3",
      "Library",
      "Library V2",
      "Library V3",
    ]) {
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
    expect(html).not.toContain("nav-item__badge");
  });

  it("keeps V2 and V3 pages grouped with each non-dashboard product area", () => {
    const html = renderNav();

    expect(html.indexOf("Dashboard")).toBeLessThan(html.indexOf("Calendar"));
    expect(html.indexOf("Calendar")).toBeLessThan(html.indexOf("Jobs"));
    expect(html.indexOf("Jobs")).toBeLessThan(html.indexOf("Jobs V2"));
    expect(html.indexOf("Jobs V2")).toBeLessThan(html.indexOf("Jobs V3"));
    expect(html.indexOf("Jobs V3")).toBeLessThan(html.indexOf("Network"));
    expect(html.indexOf("Network")).toBeLessThan(html.indexOf("Network V2"));
    expect(html.indexOf("Network V2")).toBeLessThan(html.indexOf("Network V3"));
    expect(html.indexOf("Network V3")).toBeLessThan(html.indexOf("Library"));
    expect(html.indexOf("Library")).toBeLessThan(html.indexOf("Library V2"));
    expect(html.indexOf("Library V2")).toBeLessThan(html.indexOf("Library V3"));
  });

  it("does not advertise the legacy tracker route as normal product navigation", () => {
    const html = renderNav();

    expect(html).not.toContain("Classic");
    expect(html).not.toContain('href="/tracker"');
  });
});
