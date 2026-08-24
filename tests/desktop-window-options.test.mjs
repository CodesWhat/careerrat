import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserWindowOptions } from "../apps/desktop/window-options.mjs";

test("the chat-first desktop workspace opens at its designed size and can go full screen", () => {
  const options = buildBrowserWindowOptions({ platform: "linux", dark: false });

  assert.equal(options.width, 1280);
  assert.equal(options.height, 860);
  assert.equal(options.minWidth, 1100);
  assert.equal(options.maxWidth, undefined);
  assert.equal(options.minHeight, 680);
  assert.equal(options.maxHeight, undefined);
  assert.equal(options.resizable, true);
  assert.equal(options.maximizable, true);
  assert.equal(options.fullscreenable, true);
});

test("the resizable macOS window keeps native inset controls", () => {
  const options = buildBrowserWindowOptions({ platform: "darwin", dark: false });

  assert.equal(options.titleBarStyle, "hiddenInset");
  assert.deepEqual(options.trafficLightPosition, { x: 18, y: 18 });
  assert.equal(options.resizable, true);
});

test("the desktop chrome always matches the fixed chat-first canvas", () => {
  assert.equal(
    buildBrowserWindowOptions({ platform: "darwin", dark: true }).backgroundColor,
    "#edf5fb"
  );
});
