import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { brandElectronDevApp, buildInfoPlistBrandCommands } from "../apps/desktop/dev-branding.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function readText(relPath) {
  return readFile(join(root, relPath), "utf8");
}

test("desktop icon is generated from the tracked rat emoji artwork", async () => {
  const generator = await readText("apps/desktop/scripts/make-icon.mjs");
  const artwork = await readFile(join(root, "apps/desktop/assets/rat-emoji.png"));

  assert.match(generator, /assets["'], ["']rat-emoji\.png/);
  assert.equal(artwork.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(artwork.readUInt32BE(16), artwork.readUInt32BE(20));
  assert.ok(artwork.readUInt32BE(16) >= 1024);
  assert.equal(artwork[25], 6, "rat emoji artwork must retain an alpha channel");
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
