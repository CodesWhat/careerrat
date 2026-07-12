// tests/ai-config.test.mjs
// node:test suite for the no-code model-swap seam (src/core/ai/ai-config.mjs).
//
// Hermetic: every test builds its own temp repoRoot with (or without) a
// config/ai.json, so no test depends on this real repo's own (gitignored,
// user-local) config/ai.json.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_MODEL,
  DEFAULT_SMALL_FAST_MODEL,
  loadAiConfigFile,
  normalizeAiConfig,
  resolveModelConfig,
} from "../src/core/ai/ai-config.mjs";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "rolester-ai-config-"));
}

function writeAiConfig(repoRoot, contents) {
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileSync(join(repoRoot, "config", "ai.json"), contents, "utf8");
}

// ---------------------------------------------------------------------------
// normalizeAiConfig — pure
// ---------------------------------------------------------------------------

test("normalizeAiConfig: null/undefined input -> valid, all-null data", () => {
  const result = normalizeAiConfig(null);
  assert.equal(result.valid, true);
  assert.deepEqual(result.data, { model: null, smallFastModel: null });
});

test("normalizeAiConfig: a well-formed object round-trips both fields", () => {
  const result = normalizeAiConfig({
    model: "claude-sonnet-5",
    smallFastModel: "claude-haiku-4-5",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.data, {
    model: "claude-sonnet-5",
    smallFastModel: "claude-haiku-4-5",
  });
});

test("normalizeAiConfig: a gateway slug is accepted as-is (not native-id-shaped)", () => {
  const result = normalizeAiConfig({ model: "anthropic/claude-sonnet-4.6" });
  assert.equal(result.valid, true);
  assert.equal(result.data.model, "anthropic/claude-sonnet-4.6");
});

test("normalizeAiConfig: the _comment documentation key never trips validation", () => {
  const result = normalizeAiConfig({ _comment: "explains the file", model: "claude-sonnet-5" });
  assert.equal(result.valid, true);
  assert.equal(result.data.model, "claude-sonnet-5");
});

test("normalizeAiConfig: an unexpected property fails validation but still returns safe null data", () => {
  const result = normalizeAiConfig({ nonsense: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(result.data, { model: null, smallFastModel: null });
});

test("normalizeAiConfig: a non-object input (array/string) is invalid, still returns safe null data", () => {
  const result = normalizeAiConfig(["not", "an", "object"]);
  assert.equal(result.valid, false);
  assert.deepEqual(result.data, { model: null, smallFastModel: null });
});

// ---------------------------------------------------------------------------
// loadAiConfigFile — fs touchpoint, tolerant reads
// ---------------------------------------------------------------------------

test("loadAiConfigFile: missing config/ai.json -> nulls, not an error", () => {
  const repoRoot = tempRepo();
  try {
    assert.deepEqual(loadAiConfigFile({ root: repoRoot }), {
      model: null,
      smallFastModel: null,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("loadAiConfigFile: reads a well-formed config/ai.json", () => {
  const repoRoot = tempRepo();
  try {
    writeAiConfig(repoRoot, JSON.stringify({ model: "claude-sonnet-5" }));
    assert.deepEqual(loadAiConfigFile({ root: repoRoot }), {
      model: "claude-sonnet-5",
      smallFastModel: null,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("loadAiConfigFile: malformed JSON is silently ignored, falls back to nulls", () => {
  const repoRoot = tempRepo();
  try {
    writeAiConfig(repoRoot, "{not valid json");
    assert.deepEqual(loadAiConfigFile({ root: repoRoot }), {
      model: null,
      smallFastModel: null,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("loadAiConfigFile: a schema-invalid shape (unexpected property) is silently ignored", () => {
  const repoRoot = tempRepo();
  try {
    writeAiConfig(repoRoot, JSON.stringify({ modle: "typo'd key" }));
    assert.deepEqual(loadAiConfigFile({ root: repoRoot }), {
      model: null,
      smallFastModel: null,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveModelConfig — the one precedence rule: env > config file > unset
// ---------------------------------------------------------------------------

test("resolveModelConfig: no env, no config file -> falls back to the shipped defaults", () => {
  const repoRoot = tempRepo();
  try {
    assert.deepEqual(resolveModelConfig({ root: repoRoot, env: {} }), {
      model: DEFAULT_MODEL,
      smallFastModel: DEFAULT_SMALL_FAST_MODEL,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveModelConfig: config file used when env is absent", () => {
  const repoRoot = tempRepo();
  try {
    writeAiConfig(
      repoRoot,
      JSON.stringify({ model: "claude-sonnet-5", smallFastModel: "claude-haiku-4-5" })
    );
    assert.deepEqual(resolveModelConfig({ root: repoRoot, env: {} }), {
      model: "claude-sonnet-5",
      smallFastModel: "claude-haiku-4-5",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveModelConfig: an explicit env var wins over config/ai.json", () => {
  const repoRoot = tempRepo();
  try {
    writeAiConfig(
      repoRoot,
      JSON.stringify({ model: "claude-sonnet-5", smallFastModel: "claude-haiku-4-5" })
    );
    const resolved = resolveModelConfig({
      root: repoRoot,
      env: { ANTHROPIC_MODEL: "anthropic/claude-opus-4-8" },
    });
    assert.equal(resolved.model, "anthropic/claude-opus-4-8"); // env wins, not the file's claude-sonnet-5
    assert.equal(resolved.smallFastModel, "claude-haiku-4-5"); // unset in env -> falls back to the file
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveModelConfig: a malformed config/ai.json never breaks resolution — falls back to the shipped default", () => {
  const repoRoot = tempRepo();
  try {
    writeAiConfig(repoRoot, "{not valid json");
    assert.deepEqual(
      resolveModelConfig({ root: repoRoot, env: { ANTHROPIC_MODEL: "claude-sonnet-5" } }),
      { model: "claude-sonnet-5", smallFastModel: DEFAULT_SMALL_FAST_MODEL }
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
