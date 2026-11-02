import assert from "node:assert/strict";
import { test } from "node:test";
import { ptyStatus } from "../src/core/tui/pty-status.mjs";

test("the real native terminal helper loads in this checkout", () => {
  assert.equal(ptyStatus().ok, true);
});

test("a helper that failed to build is reported with its reason", () => {
  const status = ptyStatus({
    load: () => {
      throw new Error("Cannot find module pty.node");
    },
  });
  assert.deepEqual(status, { ok: false, error: "Cannot find module pty.node" });
});
