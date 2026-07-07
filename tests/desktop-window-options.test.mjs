import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBrowserWindowOptions } from "../apps/desktop/window-options.mjs";

describe("desktop window chrome", () => {
  it("integrates the macOS title bar into the app content", () => {
    assert.deepEqual(buildBrowserWindowOptions({ platform: "darwin" }), {
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 700,
      title: "Rolester",
      backgroundColor: "#fffaf2",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
    });
  });

  it("keeps standard window chrome on non-mac platforms", () => {
    assert.deepEqual(buildBrowserWindowOptions({ platform: "linux" }), {
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 700,
      title: "Rolester",
      backgroundColor: "#fffaf2",
    });
  });
});
