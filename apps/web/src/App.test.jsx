// apps/web/src/App.test.jsx — the canonical /app route table. Lane B retired
// /inbox as a destination (universal intake now lives in the docked AskBar —
// see app-shell/AskBar.jsx); this asserts that retirement at the routing
// level rather than relying on InboxPage.jsx simply not existing anymore.
//
// Every page component is mocked to a cheap marker string so this stays a
// routing test, not a full-tree render of AppShell/DashboardProvider/AskBar.
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("./app-shell/AppShell.jsx", () => ({
  AppShell: ({ children }) => <div data-testid="shell">{children}</div>,
}));
vi.mock("./app-shell/DashboardContext.jsx", () => ({
  DashboardProvider: ({ children }) => <div data-testid="dashboard-provider">{children}</div>,
}));
vi.mock("./calendar/CalendarPage.jsx", () => ({ CalendarPage: () => "calendar-page" }));
vi.mock("./deep-ingest/DeepIngestPage.jsx", () => ({ DeepIngestPage: () => "deep-ingest-page" }));
vi.mock("./jobs/JobsPage.jsx", () => ({ JobsPage: () => "jobs-page" }));
vi.mock("./library/LibraryPage.jsx", () => ({ LibraryPage: () => "library-page" }));
vi.mock("./network/NetworkPage.jsx", () => ({ NetworkPage: () => "network-page" }));
vi.mock("./onboarding/OnboardingPage.jsx", () => ({ OnboardingPage: () => "onboarding-page" }));
vi.mock("./pages/ComingSoonPage.jsx", () => ({
  ComingSoonPage: ({ title }) => `not-found:${title}`,
}));
vi.mock("./pages/DashboardPage.jsx", () => ({ DashboardPage: () => "dashboard-page" }));
vi.mock("./settings/SettingsPage.jsx", () => ({ SettingsPage: () => "settings-page" }));

import { App } from "./App.jsx";

function renderAt(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe("App — canonical route table", () => {
  it("falls through /inbox to the catch-all 'Not found' page", () => {
    const html = renderAt("/inbox");
    expect(html).toContain("not-found:Not found");
    expect(html).not.toContain("inbox-page");
  });

  it("still routes every surviving product page", () => {
    expect(renderAt("/")).toContain("dashboard-page");
    expect(renderAt("/jobs")).toContain("jobs-page");
    expect(renderAt("/calendar")).toContain("calendar-page");
    expect(renderAt("/network")).toContain("network-page");
    expect(renderAt("/library")).toContain("library-page");
    expect(renderAt("/settings")).toContain("settings-page");
    expect(renderAt("/deep-ingest")).toContain("deep-ingest-page");
  });

  it("routes /onboarding outside AppShell, through its own DashboardProvider", () => {
    const html = renderAt("/onboarding");
    expect(html).toContain("onboarding-page");
    expect(html).not.toContain('data-testid="shell"');
  });
});
