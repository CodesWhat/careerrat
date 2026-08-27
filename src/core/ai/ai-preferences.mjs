import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { userPath } from "../paths/workspace.mjs";

const AI_PREFERENCES_RELPATH = ".internal/ai-preferences.json";
const QUALITY_VALUES = new Set(["automatic", "faster", "balanced", "best"]);
const REASONING_VALUES = new Set(["automatic", "low", "medium", "high"]);
const DEFAULT_PREFERENCES = Object.freeze({
  quality: "automatic",
  reasoning: "automatic",
  source: "default",
  updatedAt: null,
});

function preferenceError(message) {
  const error = new Error(message);
  error.code = "AI_PREFERENCES_INVALID";
  return error;
}

function normalizeQuality(value) {
  const quality = String(value || "")
    .trim()
    .toLowerCase();
  if (!QUALITY_VALUES.has(quality)) {
    throw preferenceError("Paul quality must be Automatic, Faster, Balanced, or Best.");
  }
  return quality;
}

function normalizeReasoning(value) {
  const reasoning = String(value || "")
    .trim()
    .toLowerCase();
  if (!REASONING_VALUES.has(reasoning)) {
    throw preferenceError("Thinking depth must be Automatic, Low, Medium, or High.");
  }
  return reasoning;
}

function persistedPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    return null;
  }
  try {
    const updatedAt = String(value.updatedAt || "").trim();
    if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) return null;
    return {
      quality: normalizeQuality(value.quality),
      reasoning: normalizeReasoning(value.reasoning),
      source: "saved",
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function loadAIPreferences({ repoRoot, env = process.env } = {}) {
  const path = userPath({ repoRoot, env }, AI_PREFERENCES_RELPATH);
  if (!existsSync(path)) return { ...DEFAULT_PREFERENCES };
  try {
    return (
      persistedPreferences(JSON.parse(readFileSync(path, "utf8"))) || {
        ...DEFAULT_PREFERENCES,
      }
    );
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writeAIPreferences({
  repoRoot,
  env = process.env,
  quality,
  reasoning,
  now = () => new Date(),
} = {}) {
  const cleanQuality = normalizeQuality(quality);
  const cleanReasoning = normalizeReasoning(reasoning);
  const updatedAt = now().toISOString();
  const path = userPath({ repoRoot, env }, AI_PREFERENCES_RELPATH);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        { version: 1, quality: cleanQuality, reasoning: cleanReasoning, updatedAt },
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  return {
    quality: cleanQuality,
    reasoning: cleanReasoning,
    source: "saved",
    updatedAt,
  };
}
