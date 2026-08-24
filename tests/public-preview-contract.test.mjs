import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the chat-first product has no retired static-preview build path", () => {
  assert.equal(existsSync(new URL("../scripts/build-demo.mjs", import.meta.url)), false);
  assert.equal(existsSync(new URL("../scripts/deploy-demo.mjs", import.meta.url)), false);
  assert.equal(existsSync(new URL("../scripts/dns-demo-record.sh", import.meta.url)), false);
  assert.equal(existsSync(new URL("../scripts/rebase-demo-dates.mjs", import.meta.url)), false);
  assert.equal(Object.hasOwn(packageJson.scripts, "build:demo"), false);
  assert.equal(Object.hasOwn(packageJson.scripts, "deploy:demo"), false);
});

test("no source script can re-enable the removed static-preview environment", () => {
  const packageSource = JSON.stringify(packageJson);
  assert.doesNotMatch(packageSource, /VITE_STATIC_PREVIEW|design-v3/);
});
