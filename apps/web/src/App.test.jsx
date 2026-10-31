import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: state.pathname }),
  Routes: ({ children }) => {
    const routes = Array.isArray(children) ? children : [children];
    return (
      routes.find((route) => route.props.path === state.pathname) ||
      routes.find((route) => route.props.path === "*")
    ).props.element;
  },
  Route: () => null,
}));
vi.mock("./chat-first/dashboard-context.jsx", () => ({
  DashboardProvider: ({ children }) => <div data-testid="dashboard-provider">{children}</div>,
}));
vi.mock("./dashboard/DashboardApp.jsx", () => ({
  DashboardApp: () => <main className="cli-dashboard">Today, in focus.</main>,
}));
vi.mock("./LegacyWorkspace.jsx", () => ({ App: () => "legacy-workspace" }));
vi.mock("./chat-first/ProfileSettingsController.jsx", () => ({
  ProfileSettingsController: () => "profile-settings",
}));

import { App } from "./App.jsx";

describe("CLI dashboard entry", () => {
  it("opens the dashboard without waiting for onboarding or AI setup", () => {
    state.pathname = "/";
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("cli-dashboard");
    expect(html).toContain("Today, in focus.");
    expect(html).not.toContain("legacy-workspace");
  });
  it("keeps profile settings reachable", () => {
    state.pathname = "/settings";
    expect(renderToStaticMarkup(<App />)).toContain("profile-settings");
  });
  it("keeps the old workspace behind its explicit transition route", () => {
    state.pathname = "/conversation";
    expect(renderToStaticMarkup(<App />)).toContain("legacy-workspace");
  });
});
