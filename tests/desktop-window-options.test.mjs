import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserWindowOptions } from "../apps/desktop/window-options.mjs";

test("the chat-first desktop workspace opens at one fixed supported size", () => {
  const options = buildBrowserWindowOptions({ platform: "linux", dark: false });

  assert.equal(options.width, 1280);
  assert.equal(options.height, 860);
  assert.equal(options.minWidth, 1280);
  assert.equal(options.maxWidth, 1280);
  assert.equal(options.minHeight, 860);
  assert.equal(options.maxHeight, 860);
  assert.equal(options.resizable, false);
  assert.equal(options.maximizable, false);
  assert.equal(options.fullscreenable, false);
});

test("the fixed macOS window keeps native inset controls", () => {
  const options = buildBrowserWindowOptions({ platform: "darwin", dark: false });

  assert.equal(options.titleBarStyle, "hiddenInset");
  assert.deepEqual(options.trafficLightPosition, { x: 18, y: 18 });
  assert.equal(options.resizable, false);
});

test("the desktop chrome always matches the fixed chat-first canvas", () => {
  assert.equal(
    buildBrowserWindowOptions({ platform: "darwin", dark: true }).backgroundColor,
    "#edf5fb"
  );
});
