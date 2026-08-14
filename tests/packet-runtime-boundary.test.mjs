// tests/packet-runtime-boundary.test.mjs
// RED static guard for Phase 10: ordinary packet/answer UI actions must use
// local packet APIs by default while the retained full skill runtime remains
// available as an explicit route outside the packet path.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ANSWER_PAGE_HTML } from "../src/core/ai/answer-page.mjs";
import { PACKET_PAGE_HTML } from "../src/core/onboarding/packet-page.mjs";
import { extractInlineScript } from "./html-test-helpers.mjs";

function inlineScript(html) {
  const script = extractInlineScript(html);
  assert.ok(script, "expected an inline script");
  return script;
}

test("ordinary packet page generation calls the local packet API, not the retained skill runtime", () => {
  const script = inlineScript(PACKET_PAGE_HTML);
  assert.match(script, /\/api\/packet\/generate/);
  assert.doesNotMatch(script, /\/api\/skill\/run/);
  assert.doesNotMatch(script, /\btailor-application\b|\bevaluate-job\b/);
  assert.doesNotMatch(script, /\brunSkill\s*\(/);
});

test("ordinary answer page drafting calls the local answers API, not answer-question through runtime", () => {
  const script = inlineScript(ANSWER_PAGE_HTML);
  assert.match(script, /\/api\/packet\/answers/);
  assert.doesNotMatch(script, /\/api\/skill\/run/);
  assert.doesNotMatch(script, /\banswer-question\b/);
  assert.doesNotMatch(script, /\brunSkill\s*\(/);
});

test("retained POST /api/skill/run remains mounted outside the ordinary packet path", () => {
  const source = readFileSync("src/cli/skill-run-route.mjs", "utf8");
  assert.match(source, /addRoute\("POST", "\/api\/skill\/run"/);
  assert.match(source, /\brunSkillStream\b/);
});
