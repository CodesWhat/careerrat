import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("../scripts/capture-board-snapshot.mjs", import.meta.url);

test("capture-board-snapshot defaults to the active CareerRat home's private profile root", () => {
  for (const dataRoot of ["/private/candidate-a", "/private/candidate-b"]) {
    const result = spawnSync(process.execPath, [SCRIPT.pathname, "--help"], {
      encoding: "utf8",
      env: { ...process.env, CAREERRAT_HOME: dataRoot },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(join(dataRoot, "board-profiles")));
  }
});
