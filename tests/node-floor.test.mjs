import assert from "node:assert/strict";
import test from "node:test";
import { checkNodeVersion } from "../src/core/runtime/node-floor.mjs";

test("24.22.0 is refused with upgrade text", () => {
  const r = checkNodeVersion("24.22.0");
  assert.equal(r.ok, false);
  assert.match(r.message, /Upgrade to Node\.js 24\.22\.1 or newer/);
});

test("24.22.1 and later 24.x pass", () => {
  assert.equal(checkNodeVersion("24.22.1").ok, true);
  assert.equal(checkNodeVersion("v24.30.0").ok, true);
});

test("25.x is refused as end of life", () => {
  for (const v of ["25.0.0", "25.9.9"]) {
    const r = checkNodeVersion(v);
    assert.equal(r.ok, false);
    assert.match(r.message, /end of life/);
  }
});

test("26.12.0 is refused, 26.12.1 passes", () => {
  const r = checkNodeVersion("26.12.0");
  assert.equal(r.ok, false);
  assert.match(r.message, /26\.12\.1/);
  assert.equal(checkNodeVersion("26.12.1").ok, true);
  assert.equal(checkNodeVersion("27.0.0").ok, true);
});

test("old and unreadable versions are refused", () => {
  assert.equal(checkNodeVersion("22.23.4").ok, false);
  assert.equal(checkNodeVersion("nonsense").ok, false);
});

test("the guard leaves Electron's bundled Node alone", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `Object.defineProperty(process.versions,"node",{value:"24.22.0"});Object.defineProperty(process.versions,"electron",{value:"40.0.0"});const {requirePatchedNode}=await import(${JSON.stringify(new URL("../src/core/runtime/node-floor.mjs", import.meta.url).href)});requirePatchedNode();console.log("ran");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.match(result.stdout, /ran/, result.stderr);
});
