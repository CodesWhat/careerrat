import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { brandElectronDevApp, buildInfoPlistBrandCommands } from "../apps/desktop/dev-branding.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function readText(relPath) {
  return readFile(join(root, relPath), "utf8");
}

test("desktop icon is generated from the selected text-only brand mark", async () => {
  const generator = await readText("apps/desktop/scripts/make-icon.mjs");

  assert.match(generator, /figtree-latin-800-normal\.woff2/);
  assert.match(generator, />Career<\/text>/);
  assert.match(generator, />Rat\.<\/text>/);
  assert.match(generator, /SKY = "#8fd0f8"/);
  assert.doesNotMatch(generator, /rat-emoji|emoji artwork/i);
});

test("desktop icon text fills and centers the sky tile", async () => {
  const { data, info } = await sharp(join(root, "apps/desktop/build/icon.png"))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = {
    minX: info.width,
    minY: info.height,
    maxX: -1,
    maxY: -1,
  };

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const isInk =
        data[offset + 3] > 128 &&
        data[offset] < 80 &&
        data[offset + 1] < 80 &&
        data[offset + 2] < 80;
      if (!isInk) continue;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }

  const width = bounds.maxX - bounds.minX + 1;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  assert.ok(width >= 740, `ink width ${width}px should fill most of the 824px tile`);
  assert.ok(Math.abs(centerX - 512) <= 3, `ink center x=${centerX}px should center on 512px`);
  assert.ok(Math.abs(centerY - 512) <= 12, `ink center y=${centerY}px should center on 512px`);
});

test("desktop dev launch brands the local Electron.app as CareerRat before starting", async () => {
  const pkg = JSON.parse(await readText("apps/desktop/package.json"));
  const dev = pkg.scripts?.dev || "";

  assert.match(dev, /node scripts\/brand-dev-app\.mjs\s*&&\s*electron \./);
});

test("desktop smoke launch repairs dev branding before starting Electron", async () => {
  const pkg = JSON.parse(await readText("apps/desktop/package.json"));
  const smoke = pkg.scripts?.smoke || "";

  assert.match(smoke, /node scripts\/brand-dev-app\.mjs\s*&&\s*electron \. --smoke/);
});

test("desktop dev branding changes plist identity and executable name for the Dock label", () => {
  const commands = buildInfoPlistBrandCommands();

  assert.deepEqual(commands, [
    ["Set", "CFBundleName", "CareerRat"],
    ["Set", "CFBundleDisplayName", "CareerRat"],
    ["Set", "CFBundleExecutable", "CareerRat"],
    ["Set", "CFBundleIdentifier", "com.codeswhat.careerrat.dev"],
    ["Set", "CFBundleIconFile", "electron.icns"],
  ]);
});

test("desktop dev branding launches a CareerRat executable copy", () => {
  const calls = [];
  const result = brandElectronDevApp({
    platform: "darwin",
    desktopDir: join(root, "apps/desktop"),
    exists: (target) =>
      target.endsWith("Contents/Info.plist") ||
      target.endsWith("Contents/MacOS/Electron") ||
      target.endsWith("build/icon.icns"),
    copy: (from, to) => calls.push(["copy", from, to]),
    chmod: (target, mode) => calls.push(["chmod", target, mode]),
    write: (target, value) => calls.push(["write", target, value]),
    run: (cmd, args) => {
      calls.push(["run", cmd, args]);
      return { status: 0 };
    },
  });

  assert.equal(result.branded, true);
  assert.ok(
    calls.some(
      ([kind, from, to]) =>
        kind === "copy" &&
        from.endsWith("Electron.app/Contents/MacOS/Electron") &&
        to.endsWith("Electron.app/Contents/MacOS/CareerRat")
    )
  );
  assert.ok(
    calls.some(
      ([kind, target, mode]) =>
        kind === "chmod" &&
        target.endsWith("Electron.app/Contents/MacOS/CareerRat") &&
        mode === 0o755
    )
  );
  assert.ok(
    calls.some(
      ([kind, target, value]) =>
        kind === "write" &&
        target.endsWith("node_modules/electron/path.txt") &&
        value === "Electron.app/Contents/MacOS/CareerRat"
    )
  );
});
