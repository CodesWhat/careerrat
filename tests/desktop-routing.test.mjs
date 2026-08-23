import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseDesktopRoute, normalizeDesktopRoute } from "../apps/desktop/desktop-routing.mjs";

describe("desktop route selection", () => {
  it("opens the chat-first workspace for every candidate state", () => {
    assert.equal(chooseDesktopRoute(), "/app");
  });

  it("normalizes explicit chat-first route overrides", () => {
    assert.equal(normalizeDesktopRoute("settings"), "/app/settings");
    assert.equal(normalizeDesktopRoute("/settings"), "/app/settings");
    assert.equal(normalizeDesktopRoute("/app/settings"), "/app/settings");
  });

  it("lets explicit dev route overrides win over the workspace default", () => {
    assert.equal(
      chooseDesktopRoute({
        routeOverride: "settings",
      }),
      "/app/settings"
    );
  });
});
