// playwright-ops.mjs — Layer-3 Playwright implementation of the provider-neutral
// ops contract (openTab/snapshot/fillField/selectOption/toggleField/clickButton/
// upload/screenshot) pinned by apply-driver.mjs, mirroring orca-ops.mjs's shape
// so createApplyDriver runs unmodified over a bundled-Playwright persistent
// profile instead of the Orca supervised browser.
//
// `playwright` is a devDependency, not guaranteed to be installed wherever this
// module is required — the import stays lazy (dynamic `import("playwright")`
// inside the launch path, only reached on the first openTab call) so requiring
// this module never throws when playwright isn't present.
//
// pageText also carries a synthesized "- role "name" [ref=eN]" tree section for
// upload controls, grouped under their nearest document-type label (e.g.
// "Resume/CV*"). apply-driver.mjs's uploadTargetsFromSnapshot()/parsedSnapshotNodes()
// parse that exact grammar (see the regex in parsedSnapshotNodes) to associate an
// Attach/Upload control with its resume/cover-letter group — that parser is
// Orca-shaped and out of scope here, so this module produces text it already
// understands instead of leaving upload targets undetectable under this provider.

const CONTROL_SELECTOR = "input, textarea, select, button, [role='button']";
const MAX_PAGE_TEXT = 20_000;
// Bounds every Playwright action selectOption() takes (native-select attempt,
// then each step of the combobox fallback) so a control that can't actually
// be driven fails in a few seconds, not Playwright's implicit 30s
// actionability wait. Real ATS forms almost never use a native <select> —
// Greenhouse/Ashby/Lever all route dropdowns through custom [role=combobox]
// widgets — so hitting this timeout on the native attempt is the common case,
// not the exception, and the combobox fallback below is what actually drives
// the control.
const SELECT_OPTION_TIMEOUT_MS = 5_000;
// Per-character delay while driving a type-to-populate combobox (Ashby
// shape) with real keystrokes. Measured directly against a live Ashby form:
// typing the whole target value in one burst (pressSequentially's default,
// effectively no delay) does not reliably trigger its debounced live-search,
// where pacing keystrokes ~60ms apart does — this mirrors that working
// sequence instead of guessing at a smaller number.
const TYPEAHEAD_KEY_DELAY_MS = 60;
// Bounds the FIRST wait for a type-to-populate widget's async/debounced
// option list to render at all, after typing. Deliberately shorter than
// SELECT_OPTION_TIMEOUT_MS: this wait is only reachable after the
// click-to-open fallback already burned its own full timeout finding
// nothing, and the two are additive — see the failure-path budget note on
// selectOption() below.
const TYPEAHEAD_OPTIONS_TIMEOUT_MS = 3_000;
// Bounded pause before a single retry of the match-click-verify cycle
// against a type-to-populate widget. Real Ashby-shaped widgets have been
// observed rendering an interim option list (present in the DOM, but not yet
// wired to commit a selection) that a later async response replaces with the
// real, click-handling list — a click that lands during that gap resolves
// with no error and no real selection. This pause gives the real list a
// bounded chance to arrive before selectOption() gives up.
const TYPEAHEAD_SETTLE_DELAY_MS = 700;
// Bounds how many supervised tabs stay open at once in a long-lived process
// (e.g. a dev server fielding many applies in a day) — beyond this, the
// least-recently-used tab is closed to free real browser resources.
const MAX_OPEN_PAGES = 8;

async function defaultLaunch({ profileDir, headless, channel }) {
  const { chromium } = await import("playwright");
  return chromium.launchPersistentContext(profileDir, {
    headless,
    ...(channel ? { channel } : {}),
    viewport: { width: 1440, height: 1100 },
  });
}

// Runs against the live matched elements (already in DOM/selector order, same
// order `container.nth(index)` addresses). Self-contained — every helper is
// nested inside this function on purpose, not hoisted to module scope: Playwright's
// evaluateAll serializes only this function's own source to run in the browser, so
// a reference to a sibling module-level helper would be undefined there.
export function collectControls(elements) {
  // Node.compareDocumentPosition's FOLLOWING bit (standard value, hardcoded so
  // this doesn't depend on a global `Node` reference — it only ever needs
  // `document`/`window`/`CSS`, matching what evaluateAll actually injects).
  // Declared INSIDE collectControls, not at module scope: the comment above is
  // load-bearing and a module-scope const is subject to it exactly like a
  // module-scope helper is. It previously sat outside and threw
  // "DOCUMENT_POSITION_FOLLOWING is not defined" in the browser on every real
  // page with a button, which is nearly every ATS form. The stubbed tests could
  // not catch it because nothing is serialized there.
  const DOCUMENT_POSITION_FOLLOWING = 0x04;

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function accessibleName(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel?.trim()) return ariaLabel.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.innerText?.trim()) return label.innerText.trim();
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel?.innerText?.trim()) return wrappingLabel.innerText.trim();
    const placeholder = el.getAttribute("placeholder");
    if (placeholder?.trim()) return placeholder.trim();
    const title = el.getAttribute("title");
    if (title?.trim()) return title.trim();
    const isButtonish = el.tagName === "BUTTON" || el.getAttribute("role") === "button";
    if (isButtonish && el.innerText?.trim()) return el.innerText.trim();
    // input[type=submit|button|reset] has no content of its own — its
    // displayed (and accessible) text is the value attribute, not the name
    // attribute a form submits under (often something like "commit").
    if (el.tagName === "INPUT") {
      const inputType = (el.getAttribute("type") || "text").toLowerCase();
      if (["submit", "button", "reset"].includes(inputType)) {
        const value = el.getAttribute("value");
        if (value?.trim()) return value.trim();
      }
    }
    return el.getAttribute("name") || "";
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return "combobox";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      // A file input's real interaction surface is a "choose file" trigger,
      // same click-driven affordance as a button.
      if (["button", "submit", "reset", "file"].includes(type)) return "button";
      return "textbox";
    }
    return tag;
  }

  // Nearest ancestor caption for a control — fieldset legend, an
  // aria-label/aria-labelledby on a container, or the CLOSEST PRECEDING
  // heading/label sibling within that container. This is how a resume/
  // cover-letter "group" is recognized: the upload trigger itself rarely says
  // "resume", its enclosing section does (e.g. a "Resume/CV*" legend above an
  // "Attach" button). Position matters: a flat ATS shape like
  // <label>Resume/CV</label><button>Attach</button><label>Cover Letter</label>
  // <button>Attach</button> as plain siblings under one container has TWO
  // candidate labels at the same level — picking the first one found (instead
  // of the nearest one that precedes the control) would mis-tag the second
  // button's group as "Resume/CV" too.
  function nearestGroupLabel(el, { nativeChoice = false } = {}) {
    let node = el.parentElement;
    let depth = 0;
    while (node && depth < 6) {
      if (node.tagName === "FIELDSET") {
        const legend = node.querySelector(":scope > legend");
        if (legend?.innerText?.trim()) return legend.innerText.trim();
      }
      if (!nativeChoice || node.tagName !== "FORM") {
        const ariaLabel = node.getAttribute("aria-label");
        if (ariaLabel?.trim()) return ariaLabel.trim();
        const labelledBy = node.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.innerText || "")
            .join(" ")
            .trim();
          if (text) return text;
        }
      }
      const candidates = node.querySelectorAll(
        `:scope > legend, :scope > label, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > [role='heading']${nativeChoice ? ", :scope > p" : ""}`
      );
      let nearest = null;
      for (const candidate of candidates) {
        if (nativeChoice && candidate.querySelector("input[type='radio']")) {
          continue;
        }
        // querySelectorAll returns matches in document order, so the last
        // candidate that still precedes `el` is the nearest preceding one.
        if (
          isVisible(candidate) &&
          candidate.compareDocumentPosition(el) & DOCUMENT_POSITION_FOLLOWING
        ) {
          nearest = candidate;
        }
      }
      if (nearest?.innerText?.trim()) return nearest.innerText.trim();
      if (nativeChoice && node.tagName === "FORM") break;
      node = node.parentElement;
      depth += 1;
    }
    return null;
  }

  const choiceGroupIds = new Map();
  let choiceGroupCounter = 0;
  function choiceGroupId(el, semanticRoot) {
    const name = String(el.getAttribute("name") || "").trim();
    const scope = name ? el.form || el.getRootNode() : semanticRoot;
    if (!scope) return null;
    const scopeKey = name ? `name:${name}` : "semantic-root";
    let scopedIds = choiceGroupIds.get(scope);
    if (!scopedIds) {
      scopedIds = new Map();
      choiceGroupIds.set(scope, scopedIds);
    }
    if (!scopedIds.has(scopeKey)) {
      choiceGroupCounter += 1;
      scopedIds.set(scopeKey, `radio-group-${choiceGroupCounter}`);
    }
    return scopedIds.get(scopeKey);
  }

  const controls = [];
  elements.forEach((el, index) => {
    const isFileInput =
      el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file";
    // Every other control must be visible to count; ATS upload inputs are
    // routinely hidden behind a styled label/button, so they're enumerated
    // regardless — that hidden input is often the only reliable upload target.
    if (!isFileInput && !isVisible(el)) return;
    const role = roleOf(el);
    const isNativeRadio =
      role === "radio" &&
      el.tagName === "INPUT" &&
      (el.getAttribute("type") || "").toLowerCase() === "radio";
    const choiceRoot = isNativeRadio
      ? el.closest("fieldset") || el.closest("[role='radiogroup']")
      : null;
    const choiceGroup = isNativeRadio ? choiceGroupId(el, choiceRoot) : null;
    controls.push({
      index,
      role,
      name: accessibleName(el),
      required: el.required === true || el.getAttribute("aria-required") === "true",
      fileInput: isFileInput,
      groupLabel:
        role === "button"
          ? nearestGroupLabel(el)
          : isNativeRadio
            ? nearestGroupLabel(el, { nativeChoice: true })
            : null,
      choiceGroup,
      checked: isNativeRadio && el.checked === true,
    });
  });
  return controls;
}

function formatTreeLine({ indent, role, label, ref, required }) {
  // Backstop: collection time (see the normalizeWhitespace call in snapshot())
  // already collapses newlines/runs of whitespace in every label, but this
  // stays defensive so a raw multi-line label can never split a tree line
  // across physical lines and break the parser's one-line-per-node grammar.
  const safeLabel = String(label || "")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const flags = required ? `[required, ref=${ref}]` : `[ref=${ref}]`;
  return `${" ".repeat(indent)}- ${role} "${safeLabel}" ${flags}`;
}

// Labels come from innerText (accessibleName, nearestGroupLabel, legends/
// headings) and can contain embedded newlines or runs of whitespace. Collapse
// to single spaces and trim so (1) formatTreeLine never emits a label that
// spans multiple physical lines, which would break the indent-stack parser in
// apply-driver.mjs's parsedSnapshotNodes (a continuation line has no ref=
// token), and (2) buildUploadTreeLines's group-by-label keying doesn't split
// one logical group into two because of whitespace differences alone.
function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

// Builds the Orca-shaped tree lines uploadTargetsFromSnapshot()/parsedSnapshotNodes()
// parse: only button-role controls matter (file inputs are mapped to role
// "button" by roleOf above), grouped contiguously under one synthetic "group"
// header per distinct group label so the parser's indent-stack nesting resolves
// correctly — a group's children must appear back-to-back right after its
// header line, so ungrouped/unrelated controls are emitted after all groups
// instead of interleaved in raw DOM order.
function buildUploadTreeLines(controlsWithRef) {
  const buttonish = controlsWithRef.filter(({ control }) => control.role === "button");
  const groupOrder = [];
  const groups = new Map();
  const ungrouped = [];
  for (const entry of buttonish) {
    const label = entry.control.groupLabel;
    if (!label) {
      ungrouped.push(entry);
      continue;
    }
    if (!groups.has(label)) {
      groups.set(label, []);
      groupOrder.push(label);
    }
    groups.get(label).push(entry);
  }

  const lines = [];
  let groupCounter = 0;
  for (const label of groupOrder) {
    groupCounter += 1;
    lines.push(formatTreeLine({ indent: 0, role: "group", label, ref: `g${groupCounter}` }));
    for (const { control, ref } of groups.get(label)) {
      lines.push(
        formatTreeLine({
          indent: 2,
          role: control.role,
          label: control.name,
          ref,
          required: control.required,
        })
      );
    }
  }
  for (const { control, ref } of ungrouped) {
    lines.push(
      formatTreeLine({
        indent: 0,
        role: control.role,
        label: control.name,
        ref,
        required: control.required,
      })
    );
  }
  return lines;
}

function foldNativeRadioGroups(controlsWithRef, refs) {
  const groups = new Map();
  for (const entry of controlsWithRef) {
    const { control } = entry;
    if (control.role !== "radio" || !control.choiceGroup) continue;
    const key = control.choiceGroup;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    if (entries.some(({ control }) => !control.groupLabel)) continue;
    const labels = new Set(entries.map(({ control }) => control.groupLabel));
    if (labels.size !== 1) continue;
    const [{ control: firstControl, ref: firstRef }] = entries;
    refs[firstRef] = {
      role: "radio-group",
      name: firstControl.groupLabel,
      required: entries.some(({ control }) => control.required),
      options: entries.map(({ control, ref }) => ({ label: control.name, ref })),
      stateKnown: true,
      value: entries.find(({ control }) => control.checked)?.control.name || "",
    };
    for (const { ref } of entries.slice(1)) refs[ref].field = false;
  }
}

// Case/whitespace-insensitive comparison key for matching a target value
// against a rendered [role=option]'s text. This runs in Node against strings
// already pulled out of the page (Locator.allTextContents()), not inside an
// evaluate() callback, so it's fine as an ordinary module-level helper.
function normalizeOptionText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Index of the best match for `targetValue` among `optionTexts`, or -1 if
// none matches at all. An exact match (after normalizing case/whitespace)
// always wins over a substring match, even when a substring match comes
// first in the list — e.g. selecting "United States" must not land on
// "United States Minor Outlying Islands" just because that option happens to
// render before the exact one.
function findOptionMatch(optionTexts, targetValue) {
  const target = normalizeOptionText(targetValue);
  // An empty target must never fall through to substring matching — every
  // option's text "includes" the empty string, so that would silently click
  // the first option in the list instead of handing an unset field back to
  // the human.
  if (!target) return -1;
  const exactIndex = optionTexts.findIndex((text) => normalizeOptionText(text) === target);
  if (exactIndex !== -1) return exactIndex;
  return optionTexts.findIndex((text) => normalizeOptionText(text).includes(target));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Clicks the [role=option] node whose text exactly matches `optionText`, via
// a FRESH locator query at click time rather than a cached index — this is
// the fix for a real, measured false positive: an async/virtualized option
// list (Ashby) can replace its DOM nodes between the moment optionTexts is
// read and the moment the match is clicked, and a stale `nth(index)` click
// silently lands on whatever now occupies that position instead of failing.
// `.filter({hasText})` with an anchored, escaped regex requires a WHOLE-TEXT
// match (not "contains") so a short exact option ("Canada") never matches a
// longer one that merely contains it ("Canadian Overseas Territory") purely
// because both satisfy a substring filter; `.first()` tolerates a genuine
// duplicate label (two options rendering the identical text) by clicking
// whichever occurrence currently exists.
async function clickOptionByExactText(optionsLocator, optionText, timeoutMs) {
  const exact = new RegExp(`^\\s*${escapeRegExp(String(optionText).trim())}\\s*$`);
  await optionsLocator.filter({ hasText: exact }).first().click({ timeout: timeoutMs });
}

// Reads back whatever a combobox-shaped control currently displays as its
// own selection state — an <input>/<textarea>'s `value`, or a
// contentEditable element's text. selectOption() trusts nothing but this to
// decide a combobox selection actually took: the P0 this guards against was
// a real Ashby control where a click resolved with no error and left the
// field's own value genuinely blank.
async function readComboboxDisplayValue(locator) {
  return locator
    .evaluate((el) => ("value" in el ? String(el.value ?? "") : String(el.textContent ?? "")))
    .catch(() => "");
}

function comboboxSelectionConfirmed(displayValue, expectedText) {
  const expected = normalizeOptionText(expectedText);
  if (!expected) return false;
  return normalizeOptionText(displayValue).includes(expected);
}

// Shared match-click-verify cycle for both combobox fallback strategies
// (click-to-open and type-to-populate). Never reports success on "the click
// didn't throw" alone — after clicking, it reads the control's own display
// value back and only returns true once that value actually reflects the
// option just clicked. `settleDelayMs`, when set, is paused BEFORE EVERY
// attempt, including the first: an option list can exist in the DOM before
// it's actually wired to commit a selection (measured against a real Ashby
// form — see TYPEAHEAD_SETTLE_DELAY_MS), so reading/clicking the instant a
// node becomes visible is exactly what produces a false positive, not a
// missing retry. Retries (bounded by `attempts`) are the backstop for
// settling that takes longer than one pause. Returns false, never throws,
// when no attempt confirms — the caller decides what that means for its
// strategy.
//
// `requireDisplayChange` exists because comboboxSelectionConfirmed() alone is
// the wrong check for a type-to-populate control: the code itself already
// typed `stringValue` into the box before any option list existed, so the
// display value contains the target text whether or not the click actually
// landed on an option. That's not evidence of selection — it's evidence of
// the code's own prior input, and it's the exact trap that produced a false
// negative in an earlier verification pass (which used typed text and the
// accessibility snapshot as proof and concluded a working fix hadn't worked).
// With this on, confirmation instead requires the pre-click display value to
// have genuinely changed, or the option list to have closed — either one is
// real evidence the click committed a selection.
async function matchClickAndConfirm({
  locator,
  optionsLocator,
  stringValue,
  attempts,
  settleDelayMs,
  requireDisplayChange = false,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (settleDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
    }
    const optionTexts = await optionsLocator.allTextContents();
    const matchIndex = findOptionMatch(optionTexts, stringValue);
    if (matchIndex === -1) continue;
    const matchedText = optionTexts[matchIndex];
    const displayValueBeforeClick = requireDisplayChange
      ? await readComboboxDisplayValue(locator)
      : null;
    try {
      await clickOptionByExactText(optionsLocator, matchedText, SELECT_OPTION_TIMEOUT_MS);
    } catch {
      continue;
    }
    const displayValue = await readComboboxDisplayValue(locator);
    if (requireDisplayChange) {
      const optionListClosed = (await optionsLocator.count()) === 0;
      if (displayValue !== displayValueBeforeClick || optionListClosed) return true;
      continue;
    }
    if (comboboxSelectionConfirmed(displayValue, matchedText)) return true;
  }
  return false;
}

// The product requirement for a dropdown selectOption() genuinely cannot
// drive: never a silent skip, never a guessed value — a visible handoff to
// the human, in plain language, naming the field. apply-driver.mjs's
// fillStep() already catches every field-op error and surfaces
// `error.message` as that field's unresolved reason (see the `unresolved.push`
// call around its `await action(ops, pageId)`), so this message IS what the
// candidate sees.
function comboboxHandoffError(name) {
  const trimmed = String(name || "").trim();
  const subject = trimmed ? `The "${trimmed}" dropdown` : "This dropdown";
  return new Error(
    `${subject} couldn't be set automatically. Please switch to the open browser window and choose the correct option yourself.`
  );
}

// createPlaywrightOps — bundled-Playwright implementation of the provider-neutral
// ops contract. The browser context launches lazily on the first openTab call so
// constructing ops (e.g. inside createPlaywrightApplyExecutor) never touches
// Playwright itself.
export function createPlaywrightOps({
  launchImpl = defaultLaunch,
  profileDir,
  headless = false,
  channel,
} = {}) {
  let contextPromise = null;
  const pages = new Map(); // pageId -> Page, Map iteration order = LRU order (oldest first)
  const latestRefs = new Map(); // pageId -> Map(ref -> {locator, fileInput}), replaced on every snapshot()
  const evictedPageIds = new Set();
  let pageCounter = 0;

  async function getContext() {
    if (!contextPromise) {
      // On rejection, clear the cached promise before rethrowing so the NEXT
      // openTab retries the launch instead of replaying a stale failure (a
      // transient profile lock or crash would otherwise permanently disable
      // this provider until process restart).
      contextPromise = launchImpl({ profileDir, headless, ...(channel ? { channel } : {}) }).catch(
        (error) => {
          contextPromise = null;
          throw error;
        }
      );
    }
    return contextPromise;
  }

  async function evictLeastRecentlyUsed() {
    while (pages.size > MAX_OPEN_PAGES) {
      const oldestPageId = pages.keys().next().value;
      const oldestPage = pages.get(oldestPageId);
      pages.delete(oldestPageId);
      latestRefs.delete(oldestPageId);
      evictedPageIds.add(oldestPageId);
      try {
        await oldestPage.close();
      } catch {
        // best-effort — the tab may already be closed or crashed
      }
    }
  }

  function page(pageId) {
    const found = pages.get(pageId);
    if (found) {
      // Bump recency: delete + re-set moves this entry to the end of the
      // Map's iteration order, so eviction always picks the actual
      // least-recently-used tab, not just the earliest-opened one.
      pages.delete(pageId);
      pages.set(pageId, found);
      return found;
    }
    if (evictedPageIds.has(pageId)) {
      throw new Error(
        "This application's browser tab was closed to free resources. Ask CareerRat to apply again to reopen it."
      );
    }
    throw new Error(`Unknown browser page id "${pageId}".`);
  }

  // Refs are only ever valid against the snapshot that produced them — the
  // driver always re-snapshots immediately before acting, so a ref missing
  // here means it's unknown or stale relative to the latest snapshot (or its
  // page was evicted — same plain-language error as any other op there).
  function resolveRef(pageId, ref) {
    const entry = latestRefs.get(pageId)?.get(ref);
    if (entry) return entry;
    if (evictedPageIds.has(pageId)) {
      throw new Error(
        "This application's browser tab was closed to free resources. Ask CareerRat to apply again to reopen it."
      );
    }
    throw new Error(`Unknown or stale ref "${ref}". Snapshot the page again before acting.`);
  }

  return {
    async openTab({ url }) {
      const context = await getContext();
      const target = await context.newPage();
      try {
        await target.goto(url, { waitUntil: "domcontentloaded" });
      } catch (error) {
        // A failed goto must not leak the new page. It was never added to
        // `pages`, so evictLeastRecentlyUsed can never find it to close it,
        // and repeated navigation failures would grow real browser tabs
        // without bound.
        await target.close().catch(() => {});
        throw error;
      }
      pageCounter += 1;
      const pageId = `page-${pageCounter}`;
      pages.set(pageId, target);
      await evictLeastRecentlyUsed();
      return { pageId };
    },

    async focusTab({ pageId }) {
      await page(pageId).bringToFront();
    },

    async navigate({ pageId, url }) {
      const target = page(pageId);
      await target.goto(url, { waitUntil: "domcontentloaded" });
      return { pageId, url: target.url() };
    },

    async back({ pageId }) {
      const target = page(pageId);
      await target.goBack({ waitUntil: "domcontentloaded" });
      return { pageId, url: target.url() };
    },

    async pageContent({ pageId, maxText = MAX_PAGE_TEXT }) {
      const target = page(pageId);
      const bounded = Math.min(Math.max(Number(maxText) || MAX_PAGE_TEXT, 1), 100_000);
      const body = target.locator("body");
      return {
        url: target.url(),
        title: await target.title().catch(() => ""),
        text: String((await body.innerText().catch(() => "")) || "").slice(0, bounded),
      };
    },

    async extractText({ pageId, selectors, maxText = MAX_PAGE_TEXT }) {
      const target = page(pageId);
      const candidates = (Array.isArray(selectors) ? selectors : [selectors])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .slice(0, 12);
      const bounded = Math.min(Math.max(Number(maxText) || MAX_PAGE_TEXT, 1), 100_000);
      return target.evaluate(
        ({ candidates: values, bounded: limit }) => {
          for (const selector of values) {
            const matches = Array.from(document.querySelectorAll(selector));
            if (!matches.length) continue;
            return {
              selector,
              text: matches
                .map((node) => String(node.innerText || node.textContent || "").trim())
                .filter(Boolean)
                .join("\n\n")
                .slice(0, limit),
            };
          }
          return { selector: null, text: "" };
        },
        { candidates, bounded }
      );
    },

    async extractRows({ pageId, rowSelectors, fields, maxRows = 100 }) {
      const target = page(pageId);
      const selectors = (Array.isArray(rowSelectors) ? rowSelectors : [rowSelectors])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .slice(0, 12);
      const fieldSpecs = Object.fromEntries(
        Object.entries(fields && typeof fields === "object" ? fields : {}).slice(0, 24)
      );
      const boundedRows = Math.min(Math.max(Number(maxRows) || 100, 1), 250);
      return target.evaluate(
        ({ selectors: candidates, fieldSpecs: specs, boundedRows: limit }) => {
          function first(root, values) {
            for (const selector of Array.isArray(values) ? values : [values]) {
              if (!selector) continue;
              const found = selector === ":scope" ? root : root.querySelector(selector);
              if (found) return found;
            }
            return null;
          }
          let rowSelector = null;
          let rows = [];
          for (const selector of candidates) {
            const matches = Array.from(document.querySelectorAll(selector));
            if (matches.length) {
              rowSelector = selector;
              rows = matches.slice(0, limit);
              break;
            }
          }
          return {
            rowSelector,
            rows: rows.map((row, index) => {
              const output = { index };
              for (const [name, specValue] of Object.entries(specs)) {
                const spec = specValue && typeof specValue === "object" ? specValue : {};
                const node = first(row, spec.selectors || ":scope");
                if (!node) {
                  output[name] = "";
                } else if (spec.kind === "href") {
                  output[name] = node.href || node.getAttribute("href") || "";
                } else if (spec.kind === "attr") {
                  output[name] = node.getAttribute(String(spec.attribute || "")) || "";
                } else {
                  output[name] = String(node.innerText || node.textContent || "").trim();
                }
              }
              return output;
            }),
          };
        },
        { selectors, fieldSpecs, boundedRows }
      );
    },

    async clickRow({ pageId, rowSelector, index }) {
      const target = page(pageId);
      await target.locator(String(rowSelector)).nth(Number(index)).click();
      await target.waitForLoadState("domcontentloaded").catch(() => {});
      return { pageId, url: target.url() };
    },

    async scroll({ pageId, amount = 900 }) {
      const target = page(pageId);
      const delta = Math.min(Math.max(Number(amount) || 900, -5_000), 5_000);
      await target.evaluate((value) => window.scrollBy(0, value), delta);
      return { pageId, url: target.url() };
    },

    async snapshot({ pageId }) {
      const target = page(pageId);
      const container = target.locator(CONTROL_SELECTOR);
      const rawControls = await container.evaluateAll(collectControls);
      // Normalize here, at the collection choke point. collectControls itself
      // runs inside the browser via evaluateAll, so it can't share this helper.
      // Normalizing before refs/tree lines are built means the driver-side
      // ref name and the tree line's label are always the same string.
      const controls = rawControls.map((control) => ({
        ...control,
        name: normalizeWhitespace(control.name),
        groupLabel: control.groupLabel == null ? null : normalizeWhitespace(control.groupLabel),
      }));

      const refs = {};
      const refMap = new Map();
      const controlsWithRef = controls.map((control, position) => ({
        control,
        ref: `e${position + 1}`,
      }));
      for (const { control, ref } of controlsWithRef) {
        refMap.set(ref, {
          locator: container.nth(control.index),
          fileInput: Boolean(control.fileInput),
          // Carried through so selectOption()'s combobox-handoff error can
          // name the field the same way the rest of the snapshot does.
          name: control.name,
        });
        refs[ref] = { role: control.role, name: control.name, required: Boolean(control.required) };
      }
      foldNativeRadioGroups(controlsWithRef, refs);
      latestRefs.set(pageId, refMap);

      let bodyText = "";
      try {
        bodyText = String((await target.locator("body").innerText()) || "").slice(0, MAX_PAGE_TEXT);
      } catch {
        bodyText = "";
      }

      const treeLines = buildUploadTreeLines(controlsWithRef);
      const pageText = treeLines.length ? `${bodyText}\n${treeLines.join("\n")}` : bodyText;

      return { origin: target.url(), pageText, refs };
    },

    async fillField({ pageId, ref, value }) {
      await resolveRef(pageId, ref).locator.fill(String(value));
    },

    // Three shapes of dropdown, tried in order. None of them is trusted on
    // "no exception was thrown" alone — a real Ashby form produced exactly
    // that false positive (a click resolved cleanly while the field stayed
    // genuinely blank), so every path below confirms the control's own
    // display value actually changed before reporting success.
    //  1. A native <select> — the original, still-correct path for a form
    //     like Lever's that genuinely has one. Bounded to a few seconds so a
    //     control that ISN'T a <select> fails fast instead of riding
    //     Playwright's 30s default actionability wait (the exact hang
    //     observed against a real Lever combobox). Playwright's own
    //     selectOption() throws when nothing matches, but its return value
    //     (the option values it actually selected) is checked too, so an
    //     edge case where it resolves without throwing yet selects nothing
    //     still falls through instead of being reported as success.
    //  2. A click-to-open combobox widget (react-select and friends: a
    //     clickable control that opens a [role=option] list right away) —
    //     click to open it, then match/click/confirm.
    //  3. A type-to-populate combobox (Ashby: a plain text input that
    //     renders NO [role=option] nodes until something is actually typed
    //     into it, and populates them asynchronously/debounced after that)
    //     — real keystrokes (not fill(), and paced, not a single burst),
    //     then match/click/confirm with one bounded retry for an async list
    //     that hasn't finished settling yet.
    // If no path can resolve AND CONFIRM a match, this throws a
    // plain-language error naming the field instead of silently skipping it,
    // guessing a value, or reporting a click that didn't actually select
    // anything — apply-driver.mjs's fillStep() already surfaces that message
    // as the field's unresolved reason, which is the visible human handoff.
    //
    // Failure-path budget (every real ATS control that can't be driven at
    // all): native attempts fail near-instantly for a non-<select> control,
    // the click-to-open wait burns up to SELECT_OPTION_TIMEOUT_MS (5s), and
    // the type-to-populate wait+retries burns up to roughly
    // TYPEAHEAD_OPTIONS_TIMEOUT_MS + 2 * TYPEAHEAD_SETTLE_DELAY_MS (~4.4s) —
    // additive, but comfortably under the product's 15s ceiling (measured
    // worst case under 10s against a live Chromium fixture, see
    // tests/playwright-live-dropdowns.test.mjs).
    async selectOption({ pageId, ref, value }) {
      const target = page(pageId);
      const { locator, name } = resolveRef(pageId, ref);
      const stringValue = String(value);

      for (const arg of [{ label: stringValue }, stringValue]) {
        try {
          const selected = await locator.selectOption(arg, { timeout: SELECT_OPTION_TIMEOUT_MS });
          if (selected.length > 0) return;
        } catch {
          // Not a native <select> (or this particular match form didn't
          // hit) — try the next form, then fall through to the combobox
          // path below.
        }
      }

      const optionsLocator = target.locator("[role='option']:visible");

      try {
        await locator.click({ timeout: SELECT_OPTION_TIMEOUT_MS });
        // react-select shape: the option list renders right away off the
        // click above. A type-to-populate shape (Ashby) times out here
        // instead — caught rather than left to abort the whole strategy, so
        // control falls through to the typing attempt below instead of
        // giving up on a list that was never going to open from a click
        // alone.
        await optionsLocator
          .first()
          .waitFor({ state: "visible", timeout: SELECT_OPTION_TIMEOUT_MS })
          .catch(() => {});

        const confirmed = await matchClickAndConfirm({
          locator,
          optionsLocator,
          stringValue,
          attempts: 1,
          settleDelayMs: 0,
        });
        if (confirmed) return;
      } catch {
        // fall through to the typing strategy below
      }

      try {
        const isTypeable = await locator
          .evaluate(
            (el) => el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable
          )
          .catch(() => false);
        if (isTypeable) {
          // Real keystrokes, paced, not fill() — a type-to-populate
          // combobox (Ashby-shaped) listens for input/keydown as the user
          // types to populate its option list at all; fill() sets the value
          // and dispatches a single synthetic input event, and typing the
          // whole value in one burst doesn't reliably trigger its debounced
          // live-search either. TYPEAHEAD_KEY_DELAY_MS mirrors the paced
          // sequence measured to actually work against a live Ashby form.
          await locator.pressSequentially(stringValue, {
            timeout: SELECT_OPTION_TIMEOUT_MS,
            delay: TYPEAHEAD_KEY_DELAY_MS,
          });
          await optionsLocator
            .first()
            .waitFor({ state: "visible", timeout: TYPEAHEAD_OPTIONS_TIMEOUT_MS })
            .catch(() => {});

          const confirmed = await matchClickAndConfirm({
            locator,
            optionsLocator,
            stringValue,
            attempts: 2,
            settleDelayMs: TYPEAHEAD_SETTLE_DELAY_MS,
            // This strategy already typed stringValue into the control
            // above, so its display value trivially "contains" the target
            // text before any option is ever clicked — confirming on that
            // would pass whether or not the click actually selected
            // anything. Require real evidence instead: the display value
            // changing, or the option list closing.
            requireDisplayChange: true,
          });
          if (confirmed) return;
        }
      } catch {
        // fall through to the handoff error below
      }

      throw comboboxHandoffError(name);
    },

    async toggleField({ pageId, ref, checked }) {
      await resolveRef(pageId, ref).locator.setChecked(Boolean(checked));
    },

    async clickButton({ pageId, ref }) {
      await resolveRef(pageId, ref).locator.click();
    },

    // Two shapes of upload target: a real (often visually hidden) <input
    // type=file> can take files directly; a styled trigger button has no file
    // input of its own to target, so the file chooser it opens on click has to
    // be awaited and fed instead. The wait is bounded — if no chooser opens,
    // this rejects and the driver's own catch already turns that into an
    // unresolved field instead of hanging on the implicit 30s default.
    async upload({ pageId, ref, files }) {
      const target = page(pageId);
      const { locator, fileInput } = resolveRef(pageId, ref);
      if (fileInput) {
        await locator.setInputFiles(files);
        return;
      }
      const [chooser] = await Promise.all([
        target.waitForEvent("filechooser", { timeout: 10_000 }),
        locator.click(),
      ]);
      await chooser.setFiles(files);
    },

    async screenshot({ pageId }) {
      const buffer = await page(pageId).screenshot({ type: "png" });
      return { data: Buffer.from(buffer).toString("base64"), format: "png" };
    },

    async close() {
      pages.clear();
      latestRefs.clear();
      evictedPageIds.clear();
      if (!contextPromise) return;
      const context = await contextPromise;
      contextPromise = null;
      await context.close();
    },
  };
}
