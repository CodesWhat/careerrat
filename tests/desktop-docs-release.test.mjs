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
  /native window over the same local server `careerrat tracker-dev` already\s+serves in a browser/i,
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
    /same shell/i,
    /signed and notarized macOS DMG/i,
    /CAREERRAT_HOME/i,
    /internal\/ai\.env/i,
    /electron-updater 6\.8\.9/i,
    /Restart and\s+install/i,
    /latest-mac\.yml/i,
  ]);

  assert.match(readme, /Windows self-update stays\s+disabled/i);
  assert.doesNotMatch(readme, /equal, complete CareerRat engines/i);
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

test("release docs require one verified macOS install and update bundle before publication", async () => {
  const release = await readText("docs/RELEASE.md");

  assertIncludes(release, "docs/RELEASE.md", [
    /DMG[\s\S]{0,160}exact-version updater ZIP[\s\S]{0,160}`latest-mac\.yml`/i,
    /SHA-512[\s\S]{0,120}size[\s\S]{0,160}`latest-mac\.yml`/i,
    /all three[\s\S]{0,160}before[^\n]*publish/i,
    /Restart and\s+install/i,
    /shut(?:s|ting)? down[\s\S]{0,160}services[\s\S]{0,160}install/i,
    /ordinary quit[\s\S]{0,120}(?:does not|never) install/i,
    /Windows self-update[\s\S]{0,120}disabled[\s\S]{0,240}SignPath/i,
  ]);
});

test("release docs keep paid native-runtime certification off the release blocker", async () => {
  const release = await readText("docs/RELEASE.md");

  assertIncludes(release, "docs/RELEASE.md", [
    /separate product-certification[\s\S]{0,120}not a tag or packaged-release prerequisite/i,
    /Open-web result mix[\s\S]{0,120}external state/i,
    /native runtime adapters[\s\S]{0,240}scheduled\s+certification cadence/i,
    /protected unit, integration, browser, and build\s+matrix/i,
  ]);
});

test("architecture docs describe the exact packaged runtime boundaries", async () => {
  const architecture = await readText("docs/ARCHITECTURE.md");

  assertIncludes(architecture, "docs/ARCHITECTURE.md", [
    /POST `?\/api\/skill\/run` exposes only `intake-extract` and `resume-extract`/i,
    /one canonical uploaded file plus its isolated skill/i,
    /generic chat surface exposes only[\s\S]*`company-health`/i,
    /Claude Code 2\.1\.241\s+or newer/i,
    /guarded CareerRat public\s+web MCP/i,
    /OpenAI Codex 0\.149\.1 or newer[\s\S]{0,100}complete CareerRat product/i,
    /allowlisted process\s+environment/i,
    /app never silently switches engines/i,
    /only HTML product surface/i,
  ]);

  assert.doesNotMatch(architecture, /generated tracker\/static .* normal product/i);
  assert.doesNotMatch(architecture, /Hermes Agent|Gemini CLI|OpenCode|GitHub Copilot/i);
});

test("architecture docs describe the native updater trust and lifecycle boundaries", async () => {
  const architecture = await readText("docs/ARCHITECTURE.md");

  assertIncludes(architecture, "docs/ARCHITECTURE.md", [
    /electron-updater 6\.8\.9/i,
    /main process[\s\S]{0,180}isolated preload[\s\S]{0,180}IPC/i,
    /renderer[\s\S]{0,160}(?:does not|never)[\s\S]{0,120}(?:fetch|GitHub)/i,
    /signed\s+updater ZIP[\s\S]{0,160}`latest-mac\.yml`/i,
    /SHA-512[\s\S]{0,120}size/i,
    /Restart and\s+install[\s\S]{0,220}service shutdown/i,
    /Windows self-update[\s\S]{0,120}disabled/i,
  ]);
});

test("public privacy copy describes anonymous update checks and checksum metadata", async () => {
  const [privacy, readme] = await Promise.all([
    readText("apps/docs/content/docs/advanced/privacy.mdx"),
    readText("README.md"),
  ]);

  for (const [relPath, text] of [
    ["apps/docs/content/docs/advanced/privacy.mdx", privacy],
    ["README.md", readme],
  ]) {
    assertIncludes(text, relPath, [
      /no\s+unique installation\s+or device\s+identifier/i,
      /latest-mac\.yml[\s\S]{0,160}(?:SHA-512|checksum) metadata/i,
      /signed and notarized/i,
    ]);
    assert.doesNotMatch(text, /signed (?:release )?feed/i);
  }
});

async function readText(relPath) {
  return readFile(join(root, relPath), "utf8");
}

function assertIncludes(text, relPath, patterns) {
  for (const pattern of patterns) {
    assert.match(text, pattern, `${relPath} should match ${pattern}`);
  }
}
