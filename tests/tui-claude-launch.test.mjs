import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeLaunchArgs } from "../src/core/tui/claude-launch.mjs";

const excludes = (root, home) => JSON.parse(claudeLaunchArgs(root, home)[1]).claudeMdExcludes;

test("Claude skips instruction files from folders above the install", () => {
  const list = excludes("/opt/homebrew/lib/node_modules/careerrat", "/Users/someone");
  assert.ok(list.includes("/opt/homebrew/CLAUDE.md"));
  assert.ok(list.includes("/opt/homebrew/.claude/rules/**"));
  assert.ok(list.includes("/CLAUDE.md"));
});

test("Claude keeps the install's own instructions and the user's rules", () => {
  const list = excludes("/Users/someone/code/careerrat", "/Users/someone");
  assert.ok(!list.includes("/Users/someone/code/careerrat/CLAUDE.md"));
  assert.ok(list.includes("/Users/someone/CLAUDE.md"));
  assert.ok(!list.includes("/Users/someone/.claude/rules/**"));
  assert.ok(!list.includes("/Users/someone/.claude/CLAUDE.md"));
});
