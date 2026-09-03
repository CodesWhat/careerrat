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
  const flattened = readme.replace(/\s+/g, " ");

  assert.match(flattened, /Claude Code/);
  assert.match(flattened, /OpenAI Codex/);
  assert.match(flattened, /works with/i);
  assert.match(flattened, /keeps using the one you picked/i);
  assert.match(flattened, /passes a quick check/i);
  assert.doesNotMatch(readme, /Hermes Agent|Gemini CLI|OpenCode|GitHub Copilot/);
  assert.match(readme, /never falls back to another tool or switches on its own/);
  assert.match(flattened, /You do not need it before you open the app/);
  assert.match(flattened, /install Claude Code from inside the app on first run/);
  assert.doesNotMatch(flattened, /already installed before anything in the app works/i);
  assert.doesNotMatch(readme, /equal, complete CareerRat engines/i);
  assert.match(readme, /downloads the signed and notarized\s+app update/i);
  assert.match(readme, /Restart and install/);
  assert.match(readme, /Windows self-update stays off/i);
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
