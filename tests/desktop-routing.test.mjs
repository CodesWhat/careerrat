import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseDesktopRoute, normalizeDesktopRoute } from "../apps/desktop/desktop-routing.mjs";

describe("desktop route selection", () => {
  it("opens app-first Home for existing candidate setup", () => {
    assert.equal(chooseDesktopRoute({ hasCandidateSetup: true }), "/app");
  });

  it("opens the SPA onboarding wizard for first-run workspaces", () => {
    assert.equal(chooseDesktopRoute({ hasCandidateSetup: false }), "/app/onboarding");
  });

  it("can force onboarding for source-dev design launches", () => {
    assert.equal(
      chooseDesktopRoute({ hasCandidateSetup: true, forceOnboarding: true }),
      "/app/onboarding"
    );
  });

  it("normalizes dev route overrides into app routes", () => {
    assert.equal(normalizeDesktopRoute("dashboard-v2"), "/app/dashboard-v2");
    assert.equal(normalizeDesktopRoute("/dashboard-v2"), "/app/dashboard-v2");
    assert.equal(normalizeDesktopRoute("/app/dashboard-v2"), "/app/dashboard-v2");
  });

  it("lets explicit dev route overrides win over forced onboarding", () => {
    assert.equal(
      chooseDesktopRoute({
        hasCandidateSetup: true,
        forceOnboarding: true,
        routeOverride: "dashboard-v2",
      }),
      "/app/dashboard-v2"
    );
  });
});
