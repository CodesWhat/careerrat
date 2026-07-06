import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const PILOT_DOCS = Object.freeze([
  "apps/desktop/README.md",
  "docs/RELEASE.md",
  "docs/ARCHITECTURE.md",
]);

const STALE_DESKTOP_README_PATTERNS = Object.freeze([
  /Notarization \(deferred\)/i,
  /mac\.notarize:\s*false/i,
  /flip `mac\.notarize` back to `true`/i,
  /notarization is off/i,
  /unidentified developer/i,
  /primary POC deliverable/i,
  /native window over the same local server `rolester tracker-dev` already\s+serves in a browser/i,
]);

test("desktop docs release guard is scoped to pilot-facing docs", () => {
  assert.deepEqual(PILOT_DOCS, [
    "apps/desktop/README.md",
    "docs/RELEASE.md",
    "docs/ARCHITECTURE.md",
  ]);
});

test("desktop README does not describe notarization as deferred or development-only", async () => {
  const readme = await readText("apps/desktop/README.md");

  for (const pattern of STALE_DESKTOP_README_PATTERNS) {
    assert.doesNotMatch(readme, pattern);
  }
});

test("desktop README teaches the app-first signed and notarized pilot path", async () => {
  const readme = await readText("apps/desktop/README.md");

  assertIncludes(readme, "apps/desktop/README.md", [
    /Electron desktop/i,
    /\/app\b/,
    /\/app\/onboarding\b/,
    /signed and notarized macOS DMG/i,
    /ROLESTER_HOME/i,
    /internal\/ai\.env/i,
    /auto-update readiness/i,
  ]);

  assert.doesNotMatch(readme, /automatic updates? (are )?(enabled|available|installed)/i);
});

test("release checklist requires signed notarized desktop pilot evidence", async () => {
  const release = await readText("docs/RELEASE.md");

  assertIncludes(release, "docs/RELEASE.md", [
    /signed and notarized macOS DMG/i,
    /xcrun stapler validate/i,
    /spctl --assess/i,
    /fresh workspace/i,
    /existing workspace/i,
    /without the source checkout/i,
    /no Apple credentials/i,
  ]);

  assert.doesNotMatch(release, /notarization (is )?(deferred|off|optional)/i);
});

test("architecture docs name app-safe defaults and explicit tool-heavy retained runtime", async () => {
  const architecture = await readText("docs/ARCHITECTURE.md");

  assertIncludes(architecture, "docs/ARCHITECTURE.md", [
    /app-safe default/i,
    /Read, Glob, Grep, WebFetch, and Skill/i,
    /tool-heavy retained runtime/i,
    /Write, Edit, and Bash/i,
    /compatibility\/debug\/export/i,
    /not normal product UX/i,
  ]);

  assert.doesNotMatch(architecture, /generated tracker\/static .* normal product/i);
});

async function readText(relPath) {
  return readFile(join(root, relPath), "utf8");
}

function assertIncludes(text, relPath, patterns) {
  for (const pattern of patterns) {
    assert.match(text, pattern, `${relPath} should match ${pattern}`);
  }
}
