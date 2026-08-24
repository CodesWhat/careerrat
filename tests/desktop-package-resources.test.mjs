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
  const dist = pkg.scripts?.["dist:local"] || "";

  const buildAt = dist.search(
    /(?:app:build|--workspace\s+apps\/web\s+run\s+build|run\s+build\s+--workspace\s+apps\/web)/
  );
  const stageAt = dist.indexOf("stage");

  assert.ok(buildAt >= 0, "desktop dist must build apps/web before packaging");
  assert.ok(stageAt >= 0, "desktop dist must stage the runtime before electron-builder");
  assert.ok(buildAt < stageAt, "apps/web build must run before staging copies apps/web/dist");
});

test("desktop staging validates web dist and ships one canonical skill tree", async () => {
  const [stageScript, builder] = await Promise.all([
    readText("apps/desktop/scripts/stage.mjs"),
    readText("apps/desktop/electron-builder.yml"),
  ]);

  assert.match(
    stageScript,
    /apps\/web\/dist\/index\.html/,
    "stage must fail fast when the SPA dist is missing"
  );
  assert.match(stageScript, /\.agents\/skills/, "stage must copy the canonical agent skills");
  assert.doesNotMatch(stageScript, /\.claude\/skills/, "stage must not duplicate the skill tree");
  assert.doesNotMatch(builder, /\.claude\/\*\*/, "the packaged app must not ship a dead mirror");
});

test("desktop staging bundles Playwright and its matching Chromium inside the signed runtime", async () => {
  const [stageScript, main, packageText] = await Promise.all([
    readText("apps/desktop/scripts/stage.mjs"),
    readText("apps/desktop/main.mjs"),
    readText("apps/desktop/runtime-dependencies/package.json"),
  ]);
  const pkg = JSON.parse(packageText);
  const version = pkg.dependencies?.playwright;

  assert.match(version || "", /^\d+\.\d+\.\d+$/, "the desktop runtime must pin Playwright");
  assert.match(
    stageScript,
    /runtime-dependencies/,
    "staging must install from the isolated runtime manifest and lock"
  );
  assert.match(
    stageScript,
    /playwright\/cli\.js/,
    "staging must run the installed Playwright CLI from its isolated runtime"
  );
  assert.match(stageScript, /["']install["'][\s\S]*["']chromium["'][\s\S]*["']--no-shell["']/);
  assert.match(
    stageScript,
    /\.local-browsers["']?,\s*["']\.links["']/,
    "staging must remove Playwright's build-machine path registry"
  );
  assert.match(
    stageScript,
    /PLAYWRIGHT_BROWSERS_PATH:\s*["']0["']/,
    "Chromium must live under staged node_modules so electron-builder copies it"
  );

  const browserPathAt = main.indexOf('process.env.PLAYWRIGHT_BROWSERS_PATH = "0"');
  const packagedMarkerAt = main.indexOf('process.env.CAREERRAT_PACKAGED_DESKTOP = "1"');
  const firstEngineImportAt = main.indexOf('loadEngineModule("src/cli/tracker-dev.mjs")');
  assert.ok(browserPathAt >= 0, "packaged startup must select the bundled browser location");
  assert.ok(packagedMarkerAt >= 0, "packaged startup must identify its bundled browser runtime");
  assert.ok(
    firstEngineImportAt > browserPathAt,
    "the bundled browser location must be selected before staged engine modules load"
  );
  assert.ok(
    firstEngineImportAt > packagedMarkerAt,
    "the packaged marker must be set before staged session resolution loads"
  );
  assert.match(
    main,
    /loadSmokeEngineModule\(\s*"src\/core\/apply\/playwright-ops\.mjs"\s*\)/,
    "every smoke must load the staged Playwright adapter"
  );
  assert.match(
    main,
    /verifySmokeBrowserAutomation/,
    "packaged smoke must launch the bundled Chromium, not only check files"
  );

  const builder = await readText("apps/desktop/electron-builder.yml");
  assert.match(
    builder,
    /!playwright-core\/\.local-browsers\/\.links\/\*\*/,
    "packaging must defensively exclude Playwright's build-machine path registry"
  );
});

test("desktop smoke builds and stages its exact Playwright runtime before Electron starts", async () => {
  const pkg = JSON.parse(await readText("apps/desktop/package.json"));
  const smoke = pkg.scripts?.smoke || "";
  const buildAt = smoke.indexOf("app:build");
  const stageAt = smoke.indexOf("run stage");
  const electronAt = smoke.indexOf("electron . --smoke");

  assert.ok(buildAt >= 0, "desktop smoke must build the SPA required by staging");
  assert.ok(stageAt > buildAt, "desktop smoke must stage after building the SPA");
  assert.ok(electronAt > stageAt, "desktop smoke must launch only after staging is complete");
});

test("desktop staging retains the documentation required by cold-start doctor", async () => {
  const [stageScript, doctor, packageText] = await Promise.all([
    readText("apps/desktop/scripts/stage.mjs"),
    readText("src/cli/doctor.mjs"),
    readText("package.json"),
  ]);
  const pkg = JSON.parse(packageText);

  for (const path of ["docs/DATA_CONTRACT.md", "docs/ROADMAP.md"]) {
    assert.match(
      doctor,
      new RegExp(escapeRegExp(path)),
      `${path} must remain a doctor prerequisite`
    );
    assert.ok(pkg.files.includes(path), `${path} must remain in the npm package allowlist`);
  }
  assert.doesNotMatch(
    stageScript,
    /EXCLUDE_PREFIXES\s*=\s*\[[^\]]*["']docs\//s,
    "desktop staging must not remove doctor prerequisites from the packaged runtime"
  );
});

test("desktop staging includes the demo workspace required by data init --demo", async () => {
  const [stageScript, dataCli, demoSeed] = await Promise.all([
    readText("apps/desktop/scripts/stage.mjs"),
    readText("src/cli/data.mjs"),
    readText("src/core/db/demo-seed.mjs"),
  ]);

  assert.match(dataCli, /--demo/, "the packaged data CLI exposes demo initialization");
  assert.match(
    demoSeed,
    /examples\/demo-workspace/,
    "demo initialization reads the bundled fictional workspace"
  );
  assert.match(
    stageScript,
    /examples\/demo-workspace/,
    "desktop staging must include the fixture consumed by data init --demo"
  );
});

test("electron-builder embeds every desktop main-process module imported by main", async () => {
  const config = await readText("apps/desktop/electron-builder.yml");

  for (const file of [
    "main.mjs",
    "desktop-runtime.mjs",
    "desktop-routing.mjs",
    "desktop-smoke.mjs",
  ]) {
    assert.match(
      config,
      new RegExp(`-\\s+${escapeRegExp(file)}\\b`),
      `${file} must be included in the app bundle files list`
    );
  }
});

test("ISSUE-028: desktop boots Electron's private PDF renderer before the staged engine", async () => {
  const main = await readText("apps/desktop/main.mjs");
  const rendererStartAt = main.indexOf("await startDesktopPdfRenderer");
  const engineStartAt = main.indexOf("const { createDevServer } =");

  assert.ok(rendererStartAt >= 0, "desktop must start its Electron-backed PDF renderer");
  assert.ok(engineStartAt > rendererStartAt, "PDF renderer must be ready before API routes start");
  assert.match(main, /CAREERRAT_DESKTOP_PDF_RENDER_URL\s*=\s*pdfRenderer\.url/);
  assert.match(main, /CAREERRAT_DESKTOP_PDF_RENDER_TOKEN\s*=\s*pdfRenderer\.token/);
  assert.match(
    main,
    /verifySmokePdfExport/,
    "packaged smoke must prove a real PDF export, not only an app-window load"
  );
  assert.ok(
    main.indexOf("await loadAndVerifySmokeWindow") < main.indexOf("await verifySmokePdfExport"),
    "smoke must mount the app window before the temporary PDF window can trigger window-all-closed"
  );
});

test("electron-builder embeds the full staged runtime, including its canonical skills and locked node_modules", async () => {
  const config = await readText("apps/desktop/electron-builder.yml");

  assert.match(
    config,
    /from:\s+staging\/careerrat[\s\S]*filter:/,
    "main staged runtime must use explicit filters"
  );
  for (const pattern of ["**/*", ".agents/**", "apps/web/dist/**"]) {
    assert.match(
      config,
      new RegExp(`-\\s+["']?${escapeRegExp(pattern)}["']?`),
      `${pattern} must be included in extraResources`
    );
  }
  assert.match(
    config,
    /from:\s+staging\/careerrat\/node_modules[\s\S]*to:\s+careerrat\/node_modules/,
    "node_modules must be copied as its own FileSet because electron-builder filters root node_modules directories"
  );
  assert.match(
    config,
    /-\s+["']?playwright-core\/\.local-browsers\/\*\*["']?/,
    "the node_modules FileSet must explicitly include Playwright's hidden hermetic browser directory"
  );
});

test("electron-builder macOS pilot config requires signing, entitlements, and notarization", async () => {
  const [config, pkgText, appEntitlements, inheritedEntitlements] = await Promise.all([
    readText("apps/desktop/electron-builder.yml"),
    readText("apps/desktop/package.json"),
    readText("apps/desktop/build/entitlements.mac.plist"),
    readText("apps/desktop/build/entitlements.mac.inherit.plist"),
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
  const localDist = pkg.scripts?.["dist:local"] || "";
  const macPackage = pkg.scripts?.["package:mac"] || "";
  const releaseDist = pkg.scripts?.dist || "";
  const releaseDmg = pkg.scripts?.["release:dmg"] || "";
  const stageAt = localDist.indexOf("stage");
  const builderAt = localDist.indexOf("package:mac");
  assert.ok(stageAt >= 0, "desktop local dist must stage before packaging");
  assert.ok(builderAt > stageAt, "electron-builder must run after staging completes");
  assert.match(macPackage, /electron-builder --mac dmg/);
  assert.match(
    releaseDist,
    /dist:local[\s\S]*release:dmg[\s\S]*verify:release[\s\S]*verify:packaged/,
    "desktop release dist must verify and launch the signed package after DMG notarization"
  );
  assert.match(releaseDmg, /release-dmg\.mjs/, "desktop release must own a DMG notarization step");

  for (const [label, text] of Object.entries({
    "entitlements.mac.plist": appEntitlements,
    "entitlements.mac.inherit.plist": inheritedEntitlements,
  })) {
    assert.match(
      text,
      /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/,
      `${label} must allow JIT for hardened Electron runtime`
    );
    assert.doesNotMatch(
      text,
      /com\.apple\.security\.(?:device|personal-information)\./,
      `${label} must not request device or personal-information entitlements`
    );
  }

  const credentialSurfaces = {
    "electron-builder.yml": config,
    "package.json": pkgText,
    "entitlements.mac.plist": appEntitlements,
    "entitlements.mac.inherit.plist": inheritedEntitlements,
  };
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
