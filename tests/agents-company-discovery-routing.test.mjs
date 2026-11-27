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
  assert.match(body, /careerrat companies/);
  assert.match(body, /list|add|remove/i);
});
