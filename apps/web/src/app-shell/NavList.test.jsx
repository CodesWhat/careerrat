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
  it("renders the canonical product nav with the Inbox badge", () => {
    const html = renderNav();

    for (const label of [
      "Home",
      "Settings",
      "Onboarding",
      "Inbox",
      "Jobs",
      "Calendar",
      "Network",
      "Library",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("nav-item__badge");
    expect(html).toContain(">7<");
  });

  it("does not advertise the legacy tracker route as normal product navigation", () => {
    const html = renderNav();

    expect(html).not.toContain("Classic");
    expect(html).not.toContain('href="/tracker"');
  });
});
