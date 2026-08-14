import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const cssPath = new URL("../apps/web/src/styles/app.css", import.meta.url);
const tokensPath = new URL("../apps/web/src/styles/tokens.css", import.meta.url);

function cssText() {
  return readFileSync(cssPath, "utf8");
}

function tokensText() {
  return readFileSync(tokensPath, "utf8");
}

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cssText().match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected to find CSS rule for ${selector}`);
  return match[1];
}

describe("app shell styles", () => {
  it("uses a top product header instead of a left sidebar layout", () => {
    const shell = cssRule(".app-shell");
    const header = cssRule(".app-shell__header");
    const brand = cssRule(".app-shell__brand");
    const brandLockup = cssRule(".app-shell__brand-lockup");
    const primary = cssRule(".app-shell__primary");
    const content = cssRule(".app-shell__content");
    const navList = cssRule(".nav-list");

    assert.match(shell, /display:\s*grid/);
    assert.match(shell, /grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    assert.match(header, /display:\s*grid/);
    assert.match(header, /grid-template-columns:\s*auto 1fr auto/);
    assert.match(primary, /justify-content:\s*center/);
    assert.doesNotMatch(brandLockup, /border-right/);
    assert.match(brand, /font-family:\s*"Archivo"/);
    assert.match(brand, /font-size:\s*22px/);
    assert.match(brand, /letter-spacing:\s*-0\.02em/);
    assert.match(cssRule(".app-shell__brand-dot"), /color:\s*var\(--accent\)/);
    assert.match(navList, /flex-direction:\s*row/);
    assert.match(content, /max-width:\s*1440px/);
    assert.match(content, /margin:\s*0 auto/);
    assert.doesNotMatch(cssText(), /\.app-shell__nav\s*\{/);
  });

  it("keeps header whitespace draggable while excluding actual controls", () => {
    const productHeader = cssRule(".app-shell__header");
    const productPrimary = cssRule(".app-shell__primary");
    const productRight = cssRule(".app-shell__right");
    const onboardingHeader = cssRule(".onboarding-shell__header");
    const onboardingRight = cssRule(".onboarding-shell__right");
    const css = cssText();

    assert.match(productHeader, /-webkit-app-region:\s*drag/);
    assert.match(productPrimary, /-webkit-app-region:\s*drag/);
    assert.match(productRight, /-webkit-app-region:\s*drag/);
    assert.match(onboardingHeader, /-webkit-app-region:\s*drag/);
    assert.match(onboardingRight, /-webkit-app-region:\s*drag/);
    assert.match(
      css,
      /\.app-shell__header\s+:is\(a,\s*button,\s*input,\s*select,\s*textarea,\s*\[role="button"\]\)\s*\{[^}]*-webkit-app-region:\s*no-drag/
    );
    assert.match(
      css,
      /\.onboarding-shell__header\s+:is\(a,\s*button,\s*input,\s*select,\s*textarea,\s*\[role="button"\]\)\s*\{[^}]*-webkit-app-region:\s*no-drag/
    );
  });

  it("keeps chat-first onboarding clear of the macOS window controls", () => {
    const header = cssRule(".onboarding-app__header");
    const css = cssText();

    assert.match(header, /padding:\s*0 32px 0 max\(92px,\s*32px\)/);
    assert.match(header, /-webkit-app-region:\s*drag/);
    assert.match(
      css,
      /\.onboarding-app__header\s+:is\(a,\s*button,\s*input,\s*select,\s*textarea,\s*\[role="button"\]\)\s*\{[^}]*-webkit-app-region:\s*no-drag/
    );
  });

  it("W3: docks the ask bar bottom-center instead of the old bottom-right capture launcher", () => {
    const askBar = cssRule(".ask-bar");
    const shell = cssRule(".ask-bar__shell");

    assert.match(askBar, /position:\s*fixed/);
    assert.match(askBar, /left:\s*50%/);
    assert.match(askBar, /bottom:\s*clamp/);
    assert.match(shell, /border-radius:\s*10px/);
    assert.match(shell, /border:\s*1px solid var\(--input-border\)/);
    assert.doesNotMatch(cssText(), /\.capture-assistant\b/);
  });

  it("uses dark-mode header tokens instead of light header literals, flat (no shadow)", () => {
    const header = cssRule(".app-shell__header");
    const utility = cssRule(".app-shell__utility");
    const darkHeader = cssRule('[data-theme="dark"] .app-shell__header');
    const darkControls = cssRule('[data-theme="dark"] .app-shell__utility');

    assert.match(header, /background:\s*var\(--header-bar-bg\)/);
    assert.match(utility, /background:\s*var\(--header-pill-bg\)/);
    assert.match(darkHeader, /box-shadow:\s*none/);
    assert.match(darkControls, /background:\s*var\(--header-pill-bg\)/);
    assert.match(darkControls, /border-color:\s*var\(--header-pill-border\)/);
    assert.doesNotMatch(header, /background:\s*rgba\(255,\s*250,\s*242/);
  });

  it("keeps dark header tokens true near-black instead of slate gray", () => {
    const tokens = tokensText();
    const darkTheme = tokens.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";

    // The CareerRat design system routes --header-bar-bg/--header-pill-bg
    // through --surface/--card rather than literal header-only colors, so
    // the true-black regression guard now lives on --canvas itself.
    assert.match(darkTheme, /--canvas:\s*#131316/);
    assert.match(darkTheme, /--header-bar-bg:\s*var\(--surface\)/);
    assert.match(darkTheme, /--header-pill-bg:\s*var\(--card\)/);
    assert.doesNotMatch(darkTheme, /--canvas:\s*#(2|3|4|5|6)/);
  });

  it("keeps onboarding chrome aligned with the product header", () => {
    const header = cssRule(".onboarding-shell__header");
    const brand = cssRule(".onboarding-shell__brand");
    const right = cssRule(".onboarding-shell__right");
    const theme = cssRule(".onboarding-shell__theme");

    assert.match(header, /height:\s*72px/);
    assert.match(header, /display:\s*grid/);
    assert.match(header, /grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/);
    assert.match(header, /background:\s*var\(--header-bar-bg\)/);
    assert.match(brand, /font-family:\s*"Archivo"/);
    assert.match(brand, /font-size:\s*clamp\(30px,\s*3vw,\s*42px\)/);
    assert.match(right, /justify-content:\s*flex-end/);
    assert.match(theme, /background:\s*var\(--header-pill-bg\)/);
  });

  it("uses a straight cobalt underline for the active product nav item", () => {
    const base = cssRule(".nav-item");
    const active = cssRule(".nav-item--active");

    // Reserved transparent border on every item so labels never shift when
    // the active underline appears; the old wavy ::after mask is gone.
    assert.match(base, /border-bottom:\s*2px solid transparent/);
    assert.match(active, /border-bottom-color:\s*var\(--accent\)/);
    assert.doesNotMatch(cssText(), /\.nav-item--active::after\s*\{/);
  });

  it("makes header utility buttons compact rounded squares", () => {
    const utility = cssRule(".app-shell__utility");
    const scopedUtility = cssRule(".app-shell__right .app-shell__utility");

    assert.match(utility, /width:\s*34px/);
    assert.match(utility, /height:\s*34px/);
    assert.match(utility, /border-radius:\s*8px/);
    assert.match(scopedUtility, /flex:\s*0 0 34px/);
    assert.match(scopedUtility, /min-width:\s*34px/);
    assert.match(scopedUtility, /max-width:\s*34px/);
    assert.match(scopedUtility, /min-height:\s*34px/);
    assert.match(scopedUtility, /max-height:\s*34px/);
    assert.match(scopedUtility, /aspect-ratio:\s*1 \/ 1/);
    assert.match(scopedUtility, /padding:\s*0/);
    assert.match(scopedUtility, /border-radius:\s*8px/);
    assert.doesNotMatch(scopedUtility, /border-radius:\s*999px/);
  });

  it("keeps every primary navigation item visible in the mobile two-row header", () => {
    const css = cssText();

    assert.match(
      css,
      /@media \(max-width: 760px\)[\s\S]*?\.app-shell__header\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*88px;/
    );
    assert.match(
      css,
      /@media \(max-width: 760px\)[\s\S]*?\.app-shell__primary\s*\{[^}]*-webkit-mask-image:\s*none;[^}]*mask-image:\s*none;/
    );
    assert.match(
      css,
      /@media \(max-width: 760px\)[\s\S]*?\.nav-list\s*\{[^}]*min-width:\s*0;[^}]*justify-content:\s*space-between;/
    );
  });

  it("keeps the job artifact viewer inside the capped app canvas", () => {
    const overlay = cssRule(".packet-viewer-overlay");
    const viewer = cssRule(".packet-viewer");

    assert.match(overlay, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(overlay, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    assert.match(overlay, /box-sizing:\s*border-box/);
    assert.match(overlay, /padding:\s*clamp/);
    assert.match(viewer, /box-sizing:\s*border-box/);
    assert.match(viewer, /width:\s*100%/);
    assert.match(viewer, /height:\s*100%/);
    assert.match(viewer, /min-height:\s*0/);
    assert.doesNotMatch(viewer, /100vw|100vh/);
  });

  it("gives the Jobs board a dashboard product frame instead of scaffold styling", () => {
    const page = cssRule(".jobs-page");
    const hero = cssRule(".jobs-page__hero");
    const title = cssRule(".jobs-page__title");
    const board = cssRule(".jobs-page__board-card");
    const row = cssRule(".jobs-page .job-row");

    assert.match(page, /gap:\s*28px/);
    assert.match(hero, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    assert.match(title, /font-family:\s*"Archivo"/);
    assert.match(board, /background:\s*var\(--paper-surface\)/);
    assert.match(row, /display:\s*grid/);
    assert.match(row, /grid-template-columns:\s*42px minmax\(240px,\s*1fr\) auto/);
  });
});
