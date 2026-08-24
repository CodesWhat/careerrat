import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const foundation = readFileSync(
  new URL("../apps/web/src/chat-first/app-foundation.css", import.meta.url),
  "utf8"
);
const workspace = readFileSync(
  new URL("../apps/web/src/chat-first/chat-first.css", import.meta.url),
  "utf8"
);
const browser = readFileSync(
  new URL("../apps/web/src/chat-first/workspace-browser.css", import.meta.url),
  "utf8"
);

function cssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected to find CSS rule for ${selector}`);
  return match[1];
}

describe("chat-first foundation styles", () => {
  it("keeps the fixed workspace base and controller alert", () => {
    assert.match(cssRule(foundation, "body"), /margin:\s*0/);
    assert.match(cssRule(foundation, "body"), /background:\s*#edf5fb/);
    assert.match(cssRule(foundation, "body"), /font-family:\s*"Figtree"/);
    assert.match(cssRule(workspace, ".chat-first-workspace"), /height:\s*100dvh/);
    assert.match(cssRule(workspace, ".chat-first-controller-alert"), /position:\s*absolute/);
  });

  it("ships no alternate theme selector", () => {
    assert.doesNotMatch(`${foundation}\n${workspace}`, /\[data-theme=/);
  });

  it("retains the shared button and reduced-motion behavior", () => {
    assert.match(cssRule(browser, ".cf-button"), /display:\s*inline-flex/);
    assert.match(cssRule(foundation, ".icon-btn"), /width:\s*32px/);
    assert.match(cssRule(browser, ".cf-search__spinner"), /animation:\s*cf-browser-spin/);
    assert.match(browser, /@media \(prefers-reduced-motion: reduce\)/);
  });

  it("keeps the artifact viewer bounded and Electron-safe", () => {
    const overlay = cssRule(foundation, ".packet-viewer-overlay");
    const viewer = cssRule(foundation, ".packet-viewer");

    assert.match(overlay, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(overlay, /padding:\s*clamp/);
    assert.match(viewer, /width:\s*100%/);
    assert.match(viewer, /height:\s*100%/);
    assert.match(viewer, /-webkit-app-region:\s*no-drag/);
    assert.doesNotMatch(viewer, /100vw|100vh/);
  });
});
