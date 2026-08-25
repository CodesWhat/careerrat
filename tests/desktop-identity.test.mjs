import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function loadIdentity() {
  return import("../apps/desktop/desktop-identity.mjs").catch(() => ({}));
}

function topLevelBlock(source, key) {
  const lines = source.split("\n");
  const start = lines.indexOf(`${key}:`);
  assert.notEqual(start, -1, `${key}: block must exist`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z0-9_-]+:/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("desktop runtime owns one CareerRat application identity", async () => {
  const identity = await loadIdentity();
  assert.equal(identity.CAREERRAT_APP_NAME, "CareerRat");
  assert.equal(identity.CAREERRAT_APP_ID, "com.codeswhat.careerrat");
  assert.equal(typeof identity.configureCareerRatAppIdentity, "function");

  const calls = [];
  identity.configureCareerRatAppIdentity({
    app: {
      setName: (value) => calls.push(["name", value]),
      setAboutPanelOptions: (value) => calls.push(["about", value]),
      setAppUserModelId: (value) => calls.push(["windows-id", value]),
    },
    platform: "win32",
  });

  assert.deepEqual(calls, [
    ["name", "CareerRat"],
    ["about", { applicationName: "CareerRat" }],
    ["windows-id", "com.codeswhat.careerrat"],
  ]);
});

test("non-Windows runtime does not register a Windows application identity", async () => {
  const { configureCareerRatAppIdentity } = await loadIdentity();
  const calls = [];

  configureCareerRatAppIdentity({
    app: {
      setName: (value) => calls.push(["name", value]),
      setAboutPanelOptions: (value) => calls.push(["about", value]),
      setAppUserModelId: (value) => calls.push(["windows-id", value]),
    },
    platform: "darwin",
  });

  assert.deepEqual(calls, [
    ["name", "CareerRat"],
    ["about", { applicationName: "CareerRat" }],
  ]);
});

test("desktop package and platform installers explicitly ship as CareerRat", async () => {
  const [pkg, builder] = await Promise.all([
    text("apps/desktop/package.json").then(JSON.parse),
    text("apps/desktop/electron-builder.yml"),
  ]);

  assert.equal(pkg.productName, "CareerRat");
  assert.match(builder, /^appId:\s+com\.codeswhat\.careerrat$/m);
  assert.match(builder, /^productName:\s+CareerRat$/m);
  assert.match(topLevelBlock(builder, "mac"), /^\s+executableName:\s+CareerRat$/m);
  assert.match(topLevelBlock(builder, "win"), /^\s+executableName:\s+CareerRat$/m);
  assert.match(topLevelBlock(builder, "nsis"), /^\s+shortcutName:\s+CareerRat$/m);
});

test("menu, window, and startup all consume the shared CareerRat identity", async () => {
  const [main, menu, windowOptions, devBranding] = await Promise.all([
    text("apps/desktop/main.mjs"),
    text("apps/desktop/menu-template.mjs"),
    text("apps/desktop/window-options.mjs"),
    text("apps/desktop/dev-branding.mjs"),
  ]);

  assert.match(main, /configureCareerRatAppIdentity\(\{ app, platform: process\.platform \}\)/);
  assert.match(menu, /CAREERRAT_APP_NAME/);
  assert.match(windowOptions, /CAREERRAT_APP_NAME/);
  assert.match(devBranding, /CAREERRAT_APP_NAME/);
});
