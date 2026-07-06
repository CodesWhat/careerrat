import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function readText(relPath) {
  return readFile(join(root, relPath), "utf8");
}

test("desktop dist builds the SPA before staging the packaged runtime", async () => {
  const pkg = JSON.parse(await readText("apps/desktop/package.json"));
  const dist = pkg.scripts?.dist || "";

  const buildAt = dist.search(
    /(?:app:build|--workspace\s+apps\/web\s+run\s+build|run\s+build\s+--workspace\s+apps\/web)/
  );
  const stageAt = dist.indexOf("stage");

  assert.ok(buildAt >= 0, "desktop dist must build apps/web before packaging");
  assert.ok(stageAt >= 0, "desktop dist must stage the runtime before electron-builder");
  assert.ok(buildAt < stageAt, "apps/web build must run before staging copies apps/web/dist");
});

test("desktop staging validates web dist and mirrors agent skills for Claude-style discovery", async () => {
  const stageScript = await readText("apps/desktop/scripts/stage.mjs");

  assert.match(
    stageScript,
    /apps\/web\/dist\/index\.html/,
    "stage must fail fast when the SPA dist is missing"
  );
  assert.match(stageScript, /\.agents\/skills/, "stage must copy the canonical agent skills");
  assert.match(
    stageScript,
    /\.claude\/skills/,
    "stage must mirror skills to .claude/skills for Claude-compatible lookup"
  );
});

test("electron-builder embeds the full staged runtime, including hidden skill dirs and SDK node_modules", async () => {
  const config = await readText("apps/desktop/electron-builder.yml");

  assert.match(
    config,
    /from:\s+staging\/rolester[\s\S]*filter:/,
    "main staged runtime must use explicit filters"
  );
  for (const pattern of ["**/*", ".agents/**", ".claude/**", "apps/web/dist/**"]) {
    assert.match(
      config,
      new RegExp(`-\\s+["']?${escapeRegExp(pattern)}["']?`),
      `${pattern} must be included in extraResources`
    );
  }
  assert.match(
    config,
    /from:\s+staging\/rolester\/node_modules[\s\S]*to:\s+rolester\/node_modules/,
    "node_modules must be copied as its own FileSet because electron-builder filters root node_modules directories"
  );
});

test("electron-builder macOS pilot config requires signing, entitlements, and notarization", async () => {
  const [config, pkgText] = await Promise.all([
    readText("apps/desktop/electron-builder.yml"),
    readText("apps/desktop/package.json"),
  ]);
  const macBlock = yamlTopLevelBlock(config, "mac");

  assert.match(macBlock, /\bhardenedRuntime:\s+true\b/, "mac builds must use hardened runtime");
  assert.match(
    macBlock,
    /\bforceCodeSigning:\s+true\b/,
    "pilot packaging must fail unsigned builds"
  );
  assert.match(
    macBlock,
    /\bentitlements:\s+build\/entitlements\.mac\.plist\b/,
    "mac builds must use the app hardened-runtime entitlements file"
  );
  assert.match(
    macBlock,
    /\bentitlementsInherit:\s+build\/entitlements\.mac\.inherit\.plist\b/,
    "mac builds must use the inherited hardened-runtime entitlements file"
  );
  assert.doesNotMatch(
    macBlock,
    /\bnotarize:\s+false\b/,
    "pilot packaging must not disable notarization"
  );
  assert.match(macBlock, /\bnotarize:\s+true\b/, "pilot packaging must enable notarization");

  const pkg = JSON.parse(pkgText);
  const dist = pkg.scripts?.dist || "";
  const stageAt = dist.indexOf("stage");
  const builderAt = dist.indexOf("electron-builder");
  assert.ok(stageAt >= 0, "desktop dist must stage before packaging");
  assert.ok(builderAt > stageAt, "electron-builder must run after staging completes");

  const credentialSurfaces = { "electron-builder.yml": config, "package.json": pkgText };
  for (const [label, text] of Object.entries(credentialSurfaces)) {
    assert.doesNotMatch(
      text,
      /\b(?:APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|APPLE_API_KEY|APPLE_API_KEY_ID|APPLE_API_ISSUER|APPLE_KEYCHAIN|APPLE_KEYCHAIN_PROFILE)\s*[:=]\s*["']?[^"'\s]+/,
      `${label} must not store Apple credential values`
    );
    assert.doesNotMatch(
      text,
      /\b[A-Z0-9]{10}\b/,
      `${label} must not store an Apple Team ID literal`
    );
    assert.doesNotMatch(
      text,
      /[A-Z0-9._%+-]+@(?:icloud|me|mac|apple|gmail|outlook|hotmail|yahoo)\.[A-Z]{2,}/i,
      `${label} must not store an Apple ID email literal`
    );
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yamlTopLevelBlock(source, key) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  assert.notEqual(start, -1, `${key}: block must exist`);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z0-9_-]+:/.test(lines[i])) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
}
