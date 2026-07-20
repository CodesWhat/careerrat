import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainSource = readFileSync(new URL("../apps/web/src/main.jsx", import.meta.url), "utf8");
const buildSource = readFileSync(new URL("../scripts/build-demo.mjs", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../apps/web/src/styles/app.css", import.meta.url), "utf8");

test("the fictional static preview is explicitly public and contains no client-side password gate", () => {
  const shippedSources = `${mainSource}\n${buildSource}\n${appCss}`;
  assert.doesNotMatch(
    shippedSources,
    /PasswordGate|PREVIEW_PASSWORD|preview-unlocked|Enter password|Wrong password/i
  );
  assert.match(buildSource, /public V3 (?:design|product) preview/i);
  assert.match(buildSource, /fictional data/i);
});

test("the demo root is built from the supported React preview, not retired tracker HTML", () => {
  assert.doesNotMatch(buildSource, /tracker\.html|dashboard-data\.js/);
  assert.doesNotMatch(buildSource, /allow-tailwind-cdn/);
  assert.match(buildSource, /VITE_BASE_PATH:\s*"\/"/);
  assert.match(buildSource, /VITE_ROUTER_BASENAME:\s*"\/"/);
  assert.match(buildSource, /VITE_STATIC_PREVIEW:\s*"true"/);
});
