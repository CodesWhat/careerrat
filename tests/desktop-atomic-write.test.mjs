import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { writeFileAtomic } from "../apps/desktop/atomic-write.mjs";

let dir = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function tempRoot() {
  dir = mkdtempSync(join(tmpdir(), "careerrat-atomic-write-"));
  return dir;
}

function tmpLeftovers(root) {
  return readdirSync(root).filter((name) => name.includes(".tmp"));
}

describe("writeFileAtomic", () => {
  it("writes the target file with the given contents", () => {
    const root = tempRoot();
    const target = join(root, "state.json");

    writeFileAtomic(target, '{"enabled":true}\n');

    assert.equal(readFileSync(target, "utf8"), '{"enabled":true}\n');
  });

  it("creates the target directory if it doesn't exist yet", () => {
    const root = tempRoot();
    const target = join(root, "nested", "state.json");

    writeFileAtomic(target, "{}\n");

    assert.equal(readFileSync(target, "utf8"), "{}\n");
  });

  it("leaves no temp file behind after a successful write", () => {
    const root = tempRoot();
    writeFileAtomic(join(root, "state.json"), "{}\n");

    assert.deepEqual(tmpLeftovers(root), []);
  });

  it("replaces prior contents through one rename rather than truncating in place", () => {
    const root = tempRoot();
    const target = join(root, "state.json");

    writeFileAtomic(target, '{"n":1}\n');
    writeFileAtomic(target, '{"n":2}\n');

    assert.equal(readFileSync(target, "utf8"), '{"n":2}\n');
  });

  it("cleans up the temp file and rethrows when the rename step fails", () => {
    const root = tempRoot();
    // A directory sitting at the target path forces renameSync to fail
    // after the temp file write already succeeded, exercising the same
    // failure point a mid-rename crash would hit.
    const target = join(root, "state.json");
    mkdirSync(target);

    assert.throws(() => writeFileAtomic(target, '{"enabled":false}\n'));
    assert.deepEqual(tmpLeftovers(root), []);
  });

  it("a crash between the temp write and the rename leaves the prior persisted value intact", () => {
    // Simulates the crash window writeFileAtomic exists to close: a temp
    // file lands on disk but the process dies before renameSync runs. The
    // real target must still hold whatever was last fully persisted, e.g.
    // an explicit "enabled": false, never a truncated file. A plain
    // writeFileSync(target, ...) truncates the target up front, so the same
    // crash would leave loadUpdateState() reading a corrupt/empty file and
    // falling back to DEFAULT_UPDATE_STATE, whose `enabled` is true.
    const root = tempRoot();
    const target = join(root, "state.json");
    writeFileAtomic(target, '{"enabled":false}\n');

    writeFileSync(`${target}.${process.pid}.tmp`, '{"enabled":true}\n'); // the crash: no rename follows

    assert.equal(readFileSync(target, "utf8"), '{"enabled":false}\n');
  });
});
