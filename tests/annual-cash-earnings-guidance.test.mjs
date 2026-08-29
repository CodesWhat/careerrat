import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("candidate workflows explain annual cash earnings consistently", () => {
  for (const name of ["ingest-profile", "search-jobs", "evaluate-job", "apply-job"]) {
    const body = read(`.agents/skills/${name}/SKILL.md`);
    assert.match(body, /minimum_annual_earnings/);
    assert.match(body, /tips/i);
    assert.match(body, /commission/i);
    assert.match(body, /cash bonus/i);
    assert.match(body, /equity/i);
    assert.match(body, /benefits/i);
  }
});

test("public compensation docs distinguish guaranteed base from annual cash earnings", () => {
  const readme = read("README.md");
  const foundations = read("docs/foundations-spec.md");

  for (const body of [readme, foundations]) {
    assert.match(body, /guaranteed (?:base|pay)/i);
    assert.match(body, /annual cash earnings/i);
    assert.match(body, /tips/i);
    assert.match(body, /commission/i);
    assert.match(body, /equity/i);
    assert.match(body, /benefits/i);
  }
});
