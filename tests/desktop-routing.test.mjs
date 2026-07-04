import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseDesktopRoute } from "../apps/desktop/desktop-routing.mjs";

describe("desktop route selection", () => {
  it("opens app-first Home for existing candidate setup", () => {
    assert.equal(chooseDesktopRoute({ hasCandidateSetup: true }), "/app");
  });

  it("opens the SPA onboarding wizard for first-run workspaces", () => {
    assert.equal(chooseDesktopRoute({ hasCandidateSetup: false }), "/app/onboarding");
  });
});
