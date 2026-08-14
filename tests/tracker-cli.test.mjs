import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("tracker --json writes one parseable JSON document", () => {
  const home = mkdtempSync(join(tmpdir(), "careerrat-tracker-json-"));
  mkdirSync(join(home, "workspace"), { recursive: true });
  writeFileSync(
    join(home, "workspace", "tracker.json"),
    `${JSON.stringify({ meta: {}, applications: [], sourced: [], communications: [], sources: [] })}\n`
  );

  const stdout = execFileSync(process.execPath, [join(ROOT, "src/cli/tracker.mjs"), "--json"], {
    cwd: ROOT,
    env: { ...process.env, CAREERRAT_HOME: home },
    encoding: "utf8",
  });

  const result = JSON.parse(stdout);
  assert.equal(result.summary.counts.applications, 0);
  assert.equal(result.snapshot.ok, true);
});
