import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { loadAIPreferences, writeAIPreferences } from "../src/core/ai/ai-preferences.mjs";

const roots = new Set();

function root() {
  const value = mkdtempSync(join(tmpdir(), "careerrat-ai-preferences-"));
  roots.add(value);
  return value;
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.clear();
});

test("AI preferences default independently from candidate modes", () => {
  const repoRoot = root();

  assert.deepEqual(loadAIPreferences({ repoRoot, env: {} }), {
    quality: "automatic",
    reasoning: "automatic",
    source: "default",
    updatedAt: null,
  });
  assert.equal(existsSync(join(repoRoot, "candidate", "modes.yml")), false);
});

test("AI preferences write atomically into the private app-local directory", () => {
  const repoRoot = root();
  const home = join(repoRoot, "person-home");
  const env = { CAREERRAT_HOME: home };
  const now = () => new Date("2026-08-27T15:30:00.000Z");

  const saved = writeAIPreferences({
    repoRoot,
    env,
    quality: "best",
    reasoning: "high",
    now,
  });

  assert.deepEqual(saved, {
    quality: "best",
    reasoning: "high",
    source: "saved",
    updatedAt: "2026-08-27T15:30:00.000Z",
  });
  assert.deepEqual(loadAIPreferences({ repoRoot, env }), saved);

  const directory = join(home, "internal");
  const path = join(directory, "ai-preferences.json");
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    version: 1,
    quality: "best",
    reasoning: "high",
    updatedAt: "2026-08-27T15:30:00.000Z",
  });
  assert.deepEqual(readdirSync(directory), ["ai-preferences.json"]);
});

test("AI preferences reject invalid product choices with people-shaped errors", () => {
  const repoRoot = root();

  assert.throws(
    () =>
      writeAIPreferences({
        repoRoot,
        env: {},
        quality: "opus",
        reasoning: "high",
      }),
    {
      code: "AI_PREFERENCES_INVALID",
      message: "Paul quality must be Automatic, Faster, Balanced, or Best.",
    }
  );
  assert.throws(
    () =>
      writeAIPreferences({
        repoRoot,
        env: {},
        quality: "automatic",
        reasoning: "xhigh",
      }),
    {
      code: "AI_PREFERENCES_INVALID",
      message: "Thinking depth must be Automatic, Low, Medium, or High.",
    }
  );
});

test("AI preferences recover to safe defaults when the local file is unreadable", () => {
  const repoRoot = root();
  const home = join(repoRoot, "person-home");
  const env = { CAREERRAT_HOME: home };
  writeAIPreferences({
    repoRoot,
    env,
    quality: "balanced",
    reasoning: "medium",
  });

  const path = join(home, "internal", "ai-preferences.json");
  const invalid = readFileSync(path, "utf8").replace('"quality": "balanced"', '"quality": "raw"');
  writeFileSync(path, invalid, "utf8");

  assert.deepEqual(loadAIPreferences({ repoRoot, env }), {
    quality: "automatic",
    reasoning: "automatic",
    source: "default",
    updatedAt: null,
  });
});
