import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const skill = readFileSync(
  new URL("../.agents/skills/apply-job/SKILL.md", import.meta.url),
  "utf8"
);

test("apply-job tells the legacy no-DB write to stamp appliedAt", () => {
  const line = skill
    .split("\n")
    .find((text) => text.includes("edit the matched (or newly created) row"));
  assert.ok(line, "legacy submission write step exists");
  assert.match(line, /set `appliedAt` to the current ISO datetime/);
});
