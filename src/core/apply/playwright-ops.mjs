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
// Bounds how many supervised tabs stay open at once in a long-lived process
// (e.g. a dev server fielding many applies in a day) — beyond this, the
// least-recently-used tab is closed to free real browser resources.
const MAX_OPEN_PAGES = 8;
// Node.compareDocumentPosition's FOLLOWING bit (standard value, hardcoded so
// collectControls doesn't depend on a global `Node` reference — it only ever
// needs `document`/`window`/`CSS`, matching what evaluateAll actually injects).
const DOCUMENT_POSITION_FOLLOWING = 0x04;

async function defaultLaunch({ profileDir, headless }) {
  const { chromium } = await import("playwright");
  return chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1440, height: 1100 },
  });
}

// Runs against the live matched elements (already in DOM/selector order, same
// order `container.nth(index)` addresses). Self-contained — every helper is
// nested inside this function on purpose, not hoisted to module scope: Playwright's
// evaluateAll serializes only this function's own source to run in the browser, so
// a reference to a sibling module-level helper would be undefined there.
export function collectControls(elements) {
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
  function nearestGroupLabel(el) {
    let node = el.parentElement;
    let depth = 0;
    while (node && depth < 6) {
      if (node.tagName === "FIELDSET") {
        const legend = node.querySelector(":scope > legend");
        if (legend?.innerText?.trim()) return legend.innerText.trim();
      }
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
      const candidates = node.querySelectorAll(
        ":scope > legend, :scope > label, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > [role='heading']"
      );
      let nearest = null;
      for (const candidate of candidates) {
        // querySelectorAll returns matches in document order, so the last
        // candidate that still precedes `el` is the nearest preceding one.
        if (candidate.compareDocumentPosition(el) & DOCUMENT_POSITION_FOLLOWING) {
          nearest = candidate;
        }
      }
      if (nearest?.innerText?.trim()) return nearest.innerText.trim();
      node = node.parentElement;
      depth += 1;
    }
    return null;
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
    controls.push({
      index,
      role,
      name: accessibleName(el),
      required: el.required === true || el.getAttribute("aria-required") === "true",
      fileInput: isFileInput,
      groupLabel: role === "button" ? nearestGroupLabel(el) : null,
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

// createPlaywrightOps — bundled-Playwright implementation of the provider-neutral
// ops contract. The browser context launches lazily on the first openTab call so
// constructing ops (e.g. inside createPlaywrightApplyExecutor) never touches
// Playwright itself.
export function createPlaywrightOps({
  launchImpl = defaultLaunch,
  profileDir,
  headless = false,
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
      contextPromise = launchImpl({ profileDir, headless }).catch((error) => {
        contextPromise = null;
        throw error;
      });
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
    throw new Error(`Unknown or stale ref "${ref}" — snapshot the page again before acting.`);
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
        });
        refs[ref] = { role: control.role, name: control.name, required: Boolean(control.required) };
      }
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

    async selectOption({ pageId, ref, value }) {
      const { locator } = resolveRef(pageId, ref);
      const stringValue = String(value);
      try {
        await locator.selectOption({ label: stringValue });
      } catch {
        await locator.selectOption(stringValue);
      }
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
