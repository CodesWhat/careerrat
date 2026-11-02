import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/check-job-links.mjs", import.meta.url));

test("check:jobs prints a summary and exits non-zero when no link could be checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-links-"));
  try {
    const file = join(dir, "links.txt");
    // Loopback is refused by the public-fetch guard before any network call.
    writeFileSync(file, "http://127.0.0.1/job/1\nhttp://127.0.0.1/job/2\n");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
    );
    const result = spawnSync(process.execPath, [SCRIPT, "--file", file], {
      encoding: "utf8",
      env: { ...env, CAREERRAT_NO_UPDATE_CHECK: "1" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /0 of 2 links could be checked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
