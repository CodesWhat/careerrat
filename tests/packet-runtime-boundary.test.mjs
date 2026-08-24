// tests/packet-runtime-boundary.test.mjs
// Static guard: packet generation and answer drafting remain local APIs while
// the retained full skill runtime stays an explicit, separate route.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("ordinary packet generation and answer drafting stay on local packet APIs", () => {
  const source = readFileSync("src/cli/packet-route.mjs", "utf8");
  assert.match(source, /addRoute\("POST", "\/api\/packet\/generate"/);
  assert.match(source, /\bgenerateApplicationPacket\b/);
  assert.match(source, /addRoute\("POST", "\/api\/packet\/answers"/);
  assert.match(source, /\bdraftPacketAnswers\b/);
  assert.doesNotMatch(source, /\/api\/skill\/run/);
  assert.doesNotMatch(source, /\brunSkillStream\b/);
});

test("retained POST /api/skill/run remains mounted outside the ordinary packet path", () => {
  const source = readFileSync("src/cli/skill-run-route.mjs", "utf8");
  assert.match(source, /addRoute\("POST", "\/api\/skill\/run"/);
  assert.match(source, /\brunSkillStream\b/);
});
