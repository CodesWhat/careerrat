import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const cssPath = new URL("../apps/web/src/styles/app.css", import.meta.url);

function cssText() {
  return readFileSync(cssPath, "utf8");
}

function cssRule(selector) {
  return cssRuleIn(cssText(), selector);
}

function cssRuleIn(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected to find CSS rule for ${selector}`);
  return match[1];
}

// cssRule() finds the first substring match, so a bare class selector that
// is also a suffix of an earlier, more-specific compound selector (e.g.
// ".onboarding-targeting__summary-signals .onboarding-targeting__signal-pill-remove")
// can shadow the base rule it's meant to look up. baseCssRule() anchors the
// match to the start of a line so it only finds the selector's own
// (unscoped) rule.
function baseCssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cssText().match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected to find a base (unscoped) CSS rule for ${selector}`);
  return match[1];
}

function mediaBlockContaining(query, selector) {
  const css = cssText();
  const marker = `@media (${query})`;
  let searchFrom = 0;

  while (searchFrom < css.length) {
    const start = css.indexOf(marker, searchFrom);
    if (start === -1) break;

    const open = css.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < css.length; index += 1) {
      const char = css[index];
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        const block = css.slice(open + 1, index);
        if (block.includes(selector)) return block;
        searchFrom = index + 1;
        break;
      }
    }
  }

  assert.fail(`Expected to find ${marker} containing ${selector}`);
}

describe("onboarding shell styles", () => {
  it("integrates the header without a separator line", () => {
    assert.doesNotMatch(cssRule(".onboarding-shell__header"), /border-bottom\s*:/);
  });

  it("reserves side gutters so desktop arrow buttons sit outside the card", () => {
    assert.match(
      cssRule(".onboarding-shell"),
      /--onboarding-card-width:\s*min\(960px,\s*calc\(100vw - 176px\)\)/
    );
    assert.match(cssRule(".onboarding-step-card"), /width:\s*var\(--onboarding-card-width\)/);
    assert.match(cssRule(".onboarding-shell__actions"), /width:\s*calc\(100% \+ 128px\)/);
  });

  it("moves arrows below and shows only the active progress pill on narrow screens", () => {
    const narrow = mediaBlockContaining("max-width: 760px", ".onboarding-shell__actions");

    assert.match(cssRuleIn(narrow, ".onboarding-shell__actions"), /position:\s*static/);
    assert.match(cssRuleIn(narrow, ".onboarding-shell__actions"), /transform:\s*none/);
    assert.match(cssRuleIn(narrow, ".onboarding-progress__case"), /display:\s*none/);
    assert.match(cssRuleIn(narrow, ".onboarding-progress__case--active"), /display:\s*inline-flex/);
  });

  it("keeps the progress rail transparent so only the step pills carry fill", () => {
    const progress = cssRule(".onboarding-progress");

    assert.doesNotMatch(progress, /background\s*:/);
    assert.doesNotMatch(progress, /border\s*:/);
    assert.doesNotMatch(progress, /box-shadow\s*:/);
    assert.doesNotMatch(progress, /backdrop-filter\s*:/);
    assert.match(cssRule(".onboarding-progress__case--filled"), /background:\s*#dff3c8/);
  });

  it("renders company logos on a tight neutral avatar tile", () => {
    const avatar = cssRule(".avatar");
    const avatarImage = cssRule(".avatar img");

    assert.match(avatar, /box-sizing:\s*border-box/);
    assert.match(avatar, /padding:\s*1px/);
    assert.match(avatar, /background:\s*var\(--paper-surface\)/);
    assert.match(avatar, /color:\s*var\(--ink\)/);
    assert.match(avatarImage, /width:\s*112%/);
    assert.match(avatarImage, /height:\s*112%/);
    assert.match(avatarImage, /object-fit:\s*contain/);
  });

  it("uses a grey unavailable style for disabled onboarding arrows", () => {
    const disabled = cssRule(".onboarding-nav-button:disabled");

    assert.match(disabled, /background:\s*rgba\(107,\s*96,\s*88,\s*0\.14\)/);
    assert.match(disabled, /color:\s*rgba\(35,\s*31,\s*28,\s*0\.38\)/);
    assert.match(disabled, /border-color:\s*rgba\(107,\s*96,\s*88,\s*0\.18\)/);
    assert.match(disabled, /box-shadow:\s*none/);
  });

  it("starts wizard cards closer to the top while keeping welcome centered", () => {
    const main = cssRule(".onboarding-shell__main");
    const welcome = cssRule(".onboarding-shell--welcome .onboarding-shell__main");

    assert.match(main, /place-items:\s*start center/);
    assert.match(main, /padding:\s*clamp\(18px,\s*3\.2vh,\s*36px\) 24px 18px/);
    assert.match(welcome, /place-items:\s*center/);
    assert.match(welcome, /padding:\s*clamp\(32px,\s*6vh,\s*68px\) 24px 18px/);
  });

  it("uses larger title-side body copy in onboarding cards", () => {
    assert.match(
      cssText(),
      /\.onboarding-targeting__media-copy p,\s*\.onboarding-step-card__content \.onboarding-targeting__media-copy p\s*\{[^}]*font-size:\s*16px/s
    );
  });

  it("centers account fine print with an attached lightweight asterisk marker", () => {
    const finePrint = cssRule(".onboarding-account__fine-print");
    const marker = cssRule(".onboarding-account__fine-print-marker");
    const finePrintText = cssRule(
      ".onboarding-account__fine-print span:not(.onboarding-account__fine-print-marker)"
    );

    assert.match(finePrint, /display:\s*inline-flex/);
    assert.match(finePrint, /align-items:\s*flex-start/);
    assert.match(finePrint, /align-self:\s*center/);
    assert.match(finePrint, /gap:\s*6px/);
    assert.match(finePrint, /margin:\s*6px auto 0/);
    assert.doesNotMatch(finePrint, /padding-top/);
    assert.match(finePrint, /font-weight:\s*400/);
    assert.match(finePrint, /text-align:\s*left/);
    assert.match(marker, /display:\s*inline-block/);
    assert.doesNotMatch(marker, /position:\s*absolute/);
    assert.match(finePrintText, /display:\s*inline/);
  });

  it("centers the signed-in account stack and lets the Clerk avatar fill its tile", () => {
    const panel = cssRule(".onboarding-account__panel--signed-in");
    const main = cssRule(".onboarding-account__signed-in-main");
    const label = cssRule(".onboarding-account__signed-in-label");
    const avatar = cssRule(".onboarding-account__avatar");
    const confirmation = cssRule(".onboarding-key__confirmation.onboarding-account__confirmation");

    assert.match(panel, /align-items:\s*center/);
    assert.match(panel, /justify-content:\s*center/);
    assert.match(panel, /gap:\s*16px/);
    assert.match(main, /flex:\s*0 0 auto/);
    assert.match(main, /gap:\s*14px/);
    assert.match(label, /align-self:\s*center/);
    assert.match(avatar, /width:\s*128px/);
    assert.match(avatar, /padding:\s*12px/);
    assert.match(confirmation, /align-self:\s*center/);
  });

  it("keeps the welcome headline spans from wrapping into extra visual lines", () => {
    const headline = cssRule(".onboarding-hero__copy h1");
    const line = cssRule(".onboarding-hero__line");

    assert.match(headline, /font-size:\s*clamp\(48px,\s*5\.7vw,\s*74px\)/);
    assert.match(line, /white-space:\s*nowrap/);
  });

  it("has deliberate dark-mode onboarding surfaces instead of translucent cream", () => {
    assert.match(
      cssRule('[data-theme="dark"] .onboarding-shell__header'),
      /background:\s*var\(--header-bar-bg\)/
    );
    assert.match(
      cssRule('[data-theme="dark"] .onboarding-step-card'),
      /background:\s*rgba\(35,\s*31,\s*24,\s*0\.96\)/
    );
    assert.match(
      cssRule('[data-theme="dark"] .onboarding-targeting__media'),
      /linear-gradient\(180deg,\s*rgba\(20,\s*22,\s*24,\s*0\.98\),\s*rgba\(0,\s*0,\s*0,\s*0\.98\)\)/
    );
    assert.match(
      cssRule('[data-theme="dark"] .onboarding-targeting__tag-box--good'),
      /background:\s*rgba\(78,\s*135,\s*45,\s*0\.26\)/
    );
    assert.match(
      cssRule('[data-theme="dark"] .onboarding-targeting__tag-box--bad'),
      /background:\s*rgba\(232,\s*85,\s*61,\s*0\.18\)/
    );
  });

  it("tones resume upload controls for dark mode instead of carrying light pills forward", () => {
    const dropzone = cssRule('[data-theme="dark"] .onboarding-resume__dropzone');
    const formats = cssRule('[data-theme="dark"] .onboarding-resume__formats span');
    const exampleFile = cssRule('[data-theme="dark"] .onboarding-resume__file--example');
    const pasteToggle = cssRule('[data-theme="dark"] .onboarding-resume__paste-toggle');

    assert.match(dropzone, /background:\s*rgba\(255,\s*250,\s*242,\s*0\.035\)/);
    assert.match(dropzone, /border-color:\s*rgba\(239,\s*233,\s*221,\s*0\.16\)/);
    assert.match(formats, /background:\s*rgba\(239,\s*233,\s*221,\s*0\.08\)/);
    assert.match(formats, /color:\s*rgba\(239,\s*233,\s*221,\s*0\.72\)/);
    assert.match(exampleFile, /opacity:\s*1/);
    assert.match(exampleFile, /background:\s*rgba\(255,\s*250,\s*242,\s*0\.07\)/);
    assert.match(pasteToggle, /background:\s*rgba\(255,\s*250,\s*242,\s*0\.035\)/);
  });

  it("keeps dark-mode onboarding panels neutral while preserving green pills", () => {
    const signalPanel = cssRule('[data-theme="dark"] .onboarding-targeting__signal-panel');
    const companyPill = cssRule('[data-theme="dark"] .onboarding-companies__company-pill');
    const selectedPreset = cssRule('[data-theme="dark"] .onboarding-guardrails__preset--selected');

    assert.match(signalPanel, /background:\s*rgba\(255,\s*250,\s*242,\s*0\.06\)/);
    assert.doesNotMatch(signalPanel, /rgba\(78,\s*135,\s*45/);
    assert.match(companyPill, /background:\s*rgba\(78,\s*135,\s*45,\s*0\.28\)/);
    assert.match(selectedPreset, /background:\s*rgba\(78,\s*135,\s*45,\s*0\.28\)/);
  });

  it("uses neutral company pills in light mode so the company list is not a green wall", () => {
    const companyPill = cssRule(".onboarding-companies__company-pill");

    assert.match(companyPill, /border:\s*1px solid rgba\(105,\s*88,\s*78,\s*0\.16\)/);
    assert.match(companyPill, /background:\s*rgba\(var\(--rgb-surface\),\s*0\.72\)/);
    assert.doesNotMatch(companyPill, /rgba\(220,\s*242,\s*199/);
  });

  it("keeps quick facts links off an extra panel background", () => {
    const quickFactsPanel = cssRule(".onboarding-quick-facts__panel");
    const darkQuickFactsPanel = cssRule('[data-theme="dark"] .onboarding-quick-facts__panel');

    assert.match(quickFactsPanel, /padding:\s*0/);
    assert.match(quickFactsPanel, /border:\s*0/);
    assert.match(quickFactsPanel, /background:\s*transparent/);
    assert.match(darkQuickFactsPanel, /border:\s*0/);
    assert.match(darkQuickFactsPanel, /background:\s*transparent/);
  });

  it("uses compact icon-led rows for quick facts profile links", () => {
    const row = cssRule(".onboarding-quick-facts__link-row");
    const icon = cssRule(".onboarding-quick-facts__link-icon");
    const field = cssRule(".onboarding-quick-facts__link-field");

    assert.match(row, /display:\s*grid/);
    assert.match(row, /grid-template-columns:\s*36px minmax\(0,\s*1fr\)/);
    assert.match(row, /align-items:\s*end/);
    assert.match(icon, /width:\s*36px/);
    assert.match(icon, /height:\s*36px/);
    assert.match(icon, /border-radius:\s*999px/);
    assert.match(icon, /background:\s*rgba\(var\(--rgb-surface\),\s*0\.78\)/);
    assert.match(field, /min-width:\s*0/);
  });

  it("keeps company board controls off an extra panel background", () => {
    const companiesPanel = cssRule(".onboarding-companies__panel");
    const darkCompaniesPanel = cssRule('[data-theme="dark"] .onboarding-companies__panel');

    assert.match(companiesPanel, /padding:\s*0/);
    assert.match(companiesPanel, /border:\s*0/);
    assert.match(companiesPanel, /background:\s*transparent/);
    assert.match(darkCompaniesPanel, /border:\s*0/);
    assert.match(darkCompaniesPanel, /background:\s*transparent/);
  });

  it("anchors the add-company field at the bottom with helper text right-aligned", () => {
    const companiesPanel = cssRule(".onboarding-companies__panel");
    const companyList = cssRule(".onboarding-companies__company-list");
    // The typeahead popover-positioning fix (aa1f6bd3) renamed the anchored
    // wrapper from .onboarding-companies__add-field to
    // .onboarding-companies__combobox (also adding position: relative so the
    // suggestions popover can sit above the input) — the inner
    // .onboarding-companies__add-field element remains for the hint styling.
    const combobox = cssRule(".onboarding-companies__combobox");
    const addFieldHint = cssRule(".onboarding-companies__add-field .field__hint");

    assert.match(companiesPanel, /min-height:\s*100%/);
    assert.match(companyList, /flex:\s*1 1 auto/);
    assert.match(companyList, /max-height:\s*none/);
    assert.match(combobox, /margin-top:\s*auto/);
    assert.match(addFieldHint, /align-self:\s*flex-end/);
    assert.match(addFieldHint, /text-align:\s*right/);
  });

  it("uses one custom-entry treatment for company and guardrail add fields", () => {
    const customEntry = cssRule(".onboarding-custom-entry");
    const customEntryInput = cssRule(".onboarding-custom-entry .text-input");

    assert.match(customEntry, /gap:\s*8px/);
    assert.match(customEntry, /width:\s*100%/);
    assert.match(customEntryInput, /width:\s*100%/);
    assert.match(customEntryInput, /box-sizing:\s*border-box/);
  });

  it("uses smaller title-side support copy for guardrails guidance", () => {
    const sideNote = cssRule(".onboarding-targeting__media-copy .onboarding-guardrails__side-note");

    assert.match(sideNote, /font-size:\s*13px/);
    assert.match(sideNote, /line-height:\s*1\.42/);
  });

  it("centers the guardrails info icon inside its circular button", () => {
    const infoButton = cssRule(".onboarding-guardrails__info-button");
    const infoIcon = cssRule(".onboarding-guardrails__info-icon");

    assert.match(infoButton, /padding:\s*0/);
    assert.match(infoButton, /line-height:\s*0/);
    assert.match(infoIcon, /display:\s*block/);
  });

  it("keeps the guardrails info tooltip above the onboarding card", () => {
    const panel = cssRule(".onboarding-guardrails__panel");
    const header = cssRule(".onboarding-guardrails__preset-header");
    const info = cssRule(".onboarding-guardrails__info");
    const tooltip = cssRule(".onboarding-guardrails__tooltip");

    assert.match(panel, /position:\s*relative/);
    assert.match(panel, /z-index:\s*20/);
    assert.match(header, /z-index:\s*21/);
    assert.match(info, /z-index:\s*22/);
    assert.match(tooltip, /z-index:\s*1000/);
  });

  it("centers and tones the Clerk modal portal", () => {
    const modalBackdrop = cssRule(".cl-modalBackdrop");
    const modalContent = cssRule(".cl-modalContent");

    assert.match(modalBackdrop, /background:\s*rgba\(0,\s*0,\s*0,\s*0\.74\)/);
    assert.match(modalContent, /display:\s*grid/);
    assert.match(modalContent, /place-items:\s*center/);
    assert.match(modalContent, /place-content:\s*center/);
    assert.match(modalContent, /padding:\s*24px/);
  });

  it("frames role lanes as one card with a bottom-right add action", () => {
    const roleCard = cssRule(".onboarding-targeting__summary-card--role");
    const roleMain = cssRule(".onboarding-targeting__summary-main");
    const laneActions = cssRule(".onboarding-targeting__lane-actions");
    const addButton = cssRule(".onboarding-targeting__add-lane");

    assert.match(roleCard, /position:\s*relative/);
    assert.match(roleCard, /border:\s*1px solid var\(--paper-edge\)/);
    assert.match(roleCard, /box-shadow:\s*0 18px 34px rgba\(var\(--rgb-line\), 0\.08\)/);
    assert.match(roleMain, /display:\s*grid/);
    assert.match(laneActions, /justify-content:\s*flex-end/);
    assert.match(addButton, /border-radius:\s*999px/);
  });

  it("stacks role summary fit sections and renders signals as pills", () => {
    const signalGrid = cssRule(".onboarding-targeting__signal-grid");
    const signalRow = cssRule(".onboarding-targeting__summary-signal-row");
    const pillList = cssRule(".onboarding-targeting__summary-pill-list");
    const signalPill = cssRule(".onboarding-targeting__signal-pill");
    const signalPillRemove = baseCssRule(".onboarding-targeting__signal-pill-remove");

    assert.match(signalGrid, /display:\s*flex/);
    assert.match(signalGrid, /flex-direction:\s*column/);
    assert.match(signalRow, /display:\s*grid/);
    assert.match(signalRow, /grid-template-columns:\s*22px minmax\(0,\s*1fr\)/);
    assert.match(pillList, /flex-wrap:\s*wrap/);
    assert.match(signalPill, /border-radius:\s*999px/);
    assert.match(signalPillRemove, /border:\s*0/);
  });

  it("uses a compact title-suggestion tool instead of a full-width role ideas button", () => {
    const heading = cssRule(".onboarding-targeting__field-heading");
    const tool = cssRule(".onboarding-targeting__field-tool");
    const tooltip = cssRule(".onboarding-targeting__tool-tip");
    const tooltipHover = cssRule(
      ".onboarding-targeting__tool-wrap:hover .onboarding-targeting__tool-tip"
    );

    assert.match(heading, /display:\s*flex/);
    assert.match(heading, /justify-content:\s*space-between/);
    assert.match(tool, /width:\s*36px/);
    assert.match(tool, /height:\s*36px/);
    assert.match(tool, /border-radius:\s*999px/);
    assert.match(tooltip, /position:\s*absolute/);
    assert.match(tooltip, /opacity:\s*0/);
    assert.match(tooltip, /z-index:\s*1000/);
    assert.match(tooltipHover, /opacity:\s*1/);
  });

  it("uses an opaque blue corner priority pill so card lines cannot show through", () => {
    const cornerPill = cssRule(".onboarding-targeting__priority-pill--corner");
    const darkCornerPill = cssRule(
      '[data-theme="dark"] .onboarding-targeting__priority-pill--corner'
    );

    assert.match(cornerPill, /background:\s*var\(--sky\)/);
    assert.match(cornerPill, /border-color:\s*var\(--sky\)/);
    assert.match(darkCornerPill, /background:\s*var\(--sky\)/);
    assert.match(darkCornerPill, /border-color:\s*var\(--sky\)/);
    assert.doesNotMatch(cornerPill, /background:\s*rgba/);
  });

  it("lays out resume upload as dropzone, file list, then paste action", () => {
    const actionSide = cssRule(".onboarding-resume__action-side");
    const filesPanel = cssRule(".onboarding-resume__files-panel");
    const pasteSection = cssRule(".onboarding-resume__paste-section");

    // Column flex, not a fixed-row grid: a grid with a content-independent
    // 1fr row let the files list overflow its track into the paste button's
    // track once a file (or the Review & edit section) grew the content —
    // see .onboarding-resume__action-side's own comment in app.css. Flex
    // flow lets each child push the next one down naturally at any file
    // count instead.
    assert.match(actionSide, /display:\s*flex/);
    assert.match(actionSide, /flex-direction:\s*column/);
    assert.match(filesPanel, /min-height:\s*96px/);
    assert.match(filesPanel, /overflow:\s*auto/);
    assert.match(pasteSection, /flex-shrink:\s*0/);
  });

  it("keeps resume text entry inside the upload row instead of expanding the footer action", () => {
    const textEntry = cssRule(".onboarding-resume__text-entry");
    const textArea = cssRule(".onboarding-resume__text-entry .textarea");
    const pasteSection = cssRule(".onboarding-resume__paste-section");

    assert.match(textEntry, /min-height:\s*176px/);
    assert.match(textEntry, /display:\s*grid/);
    assert.match(textArea, /min-height:\s*116px/);
    assert.doesNotMatch(pasteSection, /grid-template-rows/);
  });

  it("makes resume file rows previewable and removable", () => {
    const fileRow = cssRule(".onboarding-resume__file");
    const preview = cssRule(".onboarding-resume__file-preview");
    const remove = cssRule(".onboarding-resume__file-remove");

    assert.match(fileRow, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    assert.match(preview, /grid-template-columns:\s*44px minmax\(0,\s*1fr\)/);
    assert.match(preview, /cursor:\s*pointer/);
    assert.match(remove, /width:\s*28px/);
    assert.match(remove, /border-radius:\s*999px/);
  });

  it("opens resume previews in a document viewer overlay, not inside the file list", () => {
    const actionSide = cssRule(".onboarding-resume__action-side");
    const viewer = cssRule(".onboarding-resume__document-viewer");
    const stage = cssRule(".onboarding-resume__document-stage");
    const object = cssRule(".onboarding-resume__document-object");

    assert.match(actionSide, /position:\s*relative/);
    assert.match(viewer, /position:\s*fixed/);
    assert.match(viewer, /inset:\s*clamp\(12px,\s*2vw,\s*24px\)/);
    assert.match(viewer, /z-index:\s*90/);
    assert.match(stage, /place-items:\s*stretch/);
    assert.match(object, /height:\s*100%/);
  });

  it("top-aligns wizard action panels after the welcome step, except the compact account card", () => {
    // KeyStep's action-side holds a short sign-up/sign-in card (see
    // KeyStep.jsx), not a scrollable list like Targeting/Companies — 0af26faa
    // deliberately centered it instead of top-aligning it, matching a small
    // card's proportions rather than leaving a large empty gap beneath it.
    assert.match(cssRule(".onboarding-key__action-side"), /justify-content:\s*center/);
    assert.match(cssRule(".onboarding-targeting__content"), /justify-content:\s*flex-start/);
    assert.match(
      cssRule(".onboarding-targeting__content--signals"),
      /justify-content:\s*flex-start/
    );
    assert.match(cssRule(".onboarding-companies__content"), /justify-content:\s*flex-start/);
  });
});
