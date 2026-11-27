import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-tui-cli-"));
  mkdirSync(join(home, "workspace"));
  writeFileSync(
    join(home, "workspace/tracker.json"),
    JSON.stringify({
      applications: [
        { id: "northstar", company: "Northstar", role: "Staff Engineer", status: "interview" },
        { id: "atlas", company: "Atlas", role: "Platform Engineer", status: "applied" },
      ],
    })
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    CAREERRAT_HOME: home,
    HOME: home,
    PATH: process.env.PATH,
    CAREERRAT_NO_UPDATE_CHECK: "1",
  };
}

test("tui JSON reads saved jobs without a terminal, agent or browser server", (t) => {
  const env = fixture(t);
  const result = JSON.parse(
    execFileSync(process.execPath, [join(root, "bin/careerrat.mjs"), "tui", "--json"], {
      env,
      encoding: "utf8",
    })
  );
  assert.equal(result.jobs.length, 2);
  assert.equal(result.mode, "legacy");
});
