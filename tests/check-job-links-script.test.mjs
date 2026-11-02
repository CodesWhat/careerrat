import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

test("check:jobs fails and says so when no link could be checked at all", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "careerrat-links-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "links.txt");
  // A host that can never resolve, so every check ends "uncertain" for real.
  writeFileSync(file, "https://no-such-host.invalid/job/1\nhttps://no-such-host.invalid/job/2\n");
  const result = spawnSync(process.execPath, ["scripts/check-job-links.mjs", "--file", file], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CAREERRAT_HOME: folder, CAREERRAT_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Checked 2 link\(s\): 0 gave an answer, 2 could not be checked\./);
  assert.match(result.stderr, /None of the 2 link\(s\) could be checked/);
});
