import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

function section(heading) {
  const start = agents.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `AGENTS.md must have a '## ${heading}' heading`);
  const next = agents.indexOf("\n## ", start + 1);
  return agents.slice(start, next === -1 ? undefined : next);
}

test("company discovery routes through the discover-companies skill", () => {
  const body = section("Runtime Routing for Company Discovery");
  assert.match(body, /discover-companies/);
});

test("AGENTS.md does not claim careerrat companies owns proposal batches", () => {
  const body = section("Runtime Routing for Company Discovery");
  assert.doesNotMatch(body, /proposal batches/i);
  assert.doesNotMatch(body, /company proposal path/i);
  assert.match(body, /Company discovery runs through the `discover-companies` skill/);
  assert.match(body, /`careerrat companies` is only the tracked-company source-config helper/);
  assert.match(body, /does not create or decide candidate\s+lists/);
});

test("AGENTS.md matches the discover-companies skill and the CLI on writes", () => {
  const body = section("Runtime Routing for Company Discovery");
  assert.doesNotMatch(body, /confirm-first/i);
  assert.match(body, /adds validated high-confidence boards right away/);
  assert.match(body, /`--remove "<name>" --write`/);
  assert.match(body, /only preview\s+without `--write`/);
});
