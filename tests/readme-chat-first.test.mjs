import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("README leads with the shipped chat-first Mac app", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(
    readme,
    /A Mac app that turns the AI CLI you already have into a personal recruiter\./
  );
  assert.match(readme, /Download the latest `\.dmg`/);
  assert.match(readme, /signed and notarized Apple Silicon app/);
  assert.match(readme, /It never presses the final Submit button\./);
  assert.match(readme, /SQLite/);
  assert.match(readme, /Deep ingest/);
  assert.match(readme, /mock interviews/);
  assert.doesNotMatch(readme, /assets\/screenshots|assets\/logo\.png/);
  assert.doesNotMatch(readme, /never phones home|one persistent conversation/i);
});

test("README states runtime, update, and Windows boundaries without overclaiming", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /Claude Code 2\.1\.241\+[\s\S]*full in-app task tools and research/);
  assert.match(readme, /Codex\s+0\.149\.1\+[\s\S]*in-app chat and drafting/);
  assert.match(readme, /Claude Code and Codex\s+both work in the[\s\S]*terminal workspace flow/);
  assert.match(readme, /never downloads or installs the update/);
  assert.match(readme, /Automatic checks can be disabled in[\s\S]*Settings/);
  assert.match(readme, /SignPath Foundation/);
  assert.match(readme, /public Windows installer will[\s\S]*only after/);
});

test("README lists every shipped skill exactly once", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const skillsRoot = new URL("../.agents/skills/", import.meta.url);
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.equal(skillIds.length, 28);
  for (const skillId of skillIds) {
    const occurrences = readme.split(`\`${skillId}\``).length - 1;
    assert.equal(occurrences, 1, `${skillId} should appear exactly once`);
  }

  const headings = [
    "Setup and intake",
    "Find and research",
    "Evaluate and apply",
    "Pipeline and communication",
    "Interview, strategy, and support",
  ];
  for (const heading of headings) {
    assert.match(readme, new RegExp(`<summary><strong>${heading}</strong></summary>`));
  }
});
