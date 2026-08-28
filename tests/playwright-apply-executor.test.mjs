import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createApplyDriver, uploadTargetsFromSnapshot } from "../src/core/apply/apply-driver.mjs";
import { createConfiguredApplyExecutor } from "../src/core/apply/apply-executor-factory.mjs";
import { createPlaywrightApplyExecutor } from "../src/core/apply/playwright-executor.mjs";
import { collectControls, createPlaywrightOps } from "../src/core/apply/playwright-ops.mjs";
import { buildMinimalPdf } from "./fixtures/pdf.mjs";

const GREENHOUSE_URL = "https://job-boards.greenhouse.io/example/jobs/123";

// A fake context/page/locator triple that implements only the surface
// playwright-ops.mjs actually calls: context.newPage(), page.goto/url/screenshot,
// page.locator(selector) for the control-collection selector and "body", the
// collection locator's evaluateAll(fn) + nth(index), page.waitForEvent
// ("filechooser"), and the per-element fill/selectOption/setChecked/click/
// setInputFiles actions. `evaluateAll` is stubbed to hand back canned
// {index, role, name, required, fileInput, groupLabel, choiceGroup, checked} metadata directly
// (matching what a real browser-side collectControls() pass would produce)
// rather than executing the passed function against real DOM nodes, since
// that extraction logic needs a real page and is out of scope for this
// no-live-browser suite. A click on a non-file-input control resolves any
// pending waitForEvent("filechooser") listener with a fake chooser, mirroring
// how a real styled "Attach" button opens the native file picker on click.
function createFakeBrowser({ controls, bodyText = "", onAction } = {}) {
  const actions = [];
  let pageOpens = 0;
  let currentUrl = "";
  const filechooserResolvers = [];

  function elementLocator(index) {
    return {
      async fill(value) {
        const action = { op: "fill", index, value };
        actions.push(action);
        onAction?.(action);
      },
      async selectOption(arg) {
        const action = { op: "selectOption", index, arg };
        actions.push(action);
        onAction?.(action);
        // A real Locator.selectOption() returns the option values it
        // actually selected — selectOption() now checks that array is
        // non-empty before trusting a native <select> attempt succeeded, so
        // this fake has to return one too instead of resolving `undefined`.
        return [String(arg?.label ?? arg)];
      },
      async setChecked(checked) {
        const action = { op: "setChecked", index, checked };
        actions.push(action);
        onAction?.(action);
      },
      async click() {
        const action = { op: "click", index };
        actions.push(action);
        onAction?.(action);
        if (controls[index]?.role === "radio") {
          for (const control of controls) {
            if (control.choiceGroup === controls[index].choiceGroup) control.checked = false;
          }
          controls[index].checked = true;
        }
        const resolvers = filechooserResolvers.splice(0);
        for (const resolve of resolvers) {
          resolve({
            async setFiles(files) {
              actions.push({ op: "chooserSetFiles", index, files });
            },
          });
        }
      },
      async setInputFiles(files) {
        const action = { op: "setInputFiles", index, files };
        actions.push(action);
        onAction?.(action);
      },
    };
  }

  const page = {
    async goto(url) {
      currentUrl = url;
    },
    url() {
      return currentUrl;
    },
    locator(selector) {
      if (selector === "body") {
        return {
          async innerText() {
            return bodyText;
          },
        };
      }
      return {
        async evaluateAll() {
          return controls.map((control, index) => ({
            index,
            role: control.role,
            name: control.name,
            required: Boolean(control.required),
            fileInput: Boolean(control.fileInput),
            groupLabel: control.groupLabel ?? null,
            choiceGroup: control.choiceGroup ?? null,
            checked: Boolean(control.checked),
            ...(control.advanceSafe === true ? { advanceSafe: true } : {}),
          }));
        },
        nth: elementLocator,
      };
    },
    waitForEvent(eventName) {
      if (eventName !== "filechooser") throw new Error(`unexpected waitForEvent: ${eventName}`);
      return new Promise((resolve) => {
        filechooserResolvers.push(resolve);
      });
    },
    async screenshot() {
      return Buffer.from("fake-png-bytes");
    },
    async bringToFront() {
      actions.push({ op: "bringToFront" });
    },
  };

  const context = {
    async newPage() {
      pageOpens += 1;
      return page;
    },
    async close() {},
  };

  return {
    actions,
    pageOpens: () => pageOpens,
    launchImpl: async () => context,
  };
}

const FORM_CONTROLS = [
  { role: "textbox", name: "First Name", required: true },
  { role: "textbox", name: "Phone Number", required: false },
  { role: "combobox", name: "Work authorization", required: false },
  { role: "button", name: "Submit application", required: false },
];

const NATIVE_RADIO_CONTROLS = [
  {
    role: "radio",
    name: "Yes",
    required: true,
    groupLabel: "Will you now or in the future require sponsorship?",
    choiceGroup: "fieldset-1",
    checked: false,
  },
  {
    role: "radio",
    name: "No",
    required: true,
    groupLabel: "Will you now or in the future require sponsorship?",
    choiceGroup: "fieldset-1",
    checked: false,
  },
  { role: "button", name: "Submit application", required: false },
];

// A resume group whose upload trigger IS a (visually hidden) file input, and a
// cover-letter group whose upload trigger is a plain styled button — the two
// real-world shapes ATS forms use for document uploads.
const UPLOAD_CONTROLS = [
  { role: "textbox", name: "First Name", required: true },
  {
    role: "button",
    name: "Attach",
    groupLabel: "Resume/CV*",
    fileInput: true,
    required: true,
  },
  {
    role: "button",
    name: "Attach",
    groupLabel: "Cover Letter",
  },
  { role: "button", name: "Submit application" },
];

// ---------------------------------------------------------------------------
// A minimal DOM stub for unit-testing collectControls (and, through it,
// nearestGroupLabel/accessibleName/roleOf, which are nested closures inside
// collectControls and not separately callable — see the comment on
// collectControls for why they have to stay nested) directly, with no jsdom
// dependency. collectControls only ever touches getBoundingClientRect,
// getAttribute, tagName, id, innerText, required, parentElement, closest,
// querySelector/querySelectorAll (a fixed, small selector vocabulary: tag
// selectors, `[attr="value"]`, `:scope > X` direct-child combinators, comma
// groups), and compareDocumentPosition, plus document.getElementById/
// querySelector and window.getComputedStyle/CSS.escape — this stub implements
// exactly that surface over a plain object graph, nothing more.
// ---------------------------------------------------------------------------

function parseSimpleSelector(token) {
  const match = token.trim().match(/^([a-zA-Z0-9-]*)(?:\[([\w-]+)(?:=("[^"]*"|'[^']*'))?\])?$/);
  if (!match) throw new Error(`DOM stub cannot parse selector token: ${token}`);
  const [, tag, attr, rawValue] = match;
  return { tag: tag || null, attr: attr || null, value: rawValue ? rawValue.slice(1, -1) : null };
}

function parseSelectorGroup(selector) {
  return selector.split(",").map((clause) => {
    const trimmed = clause.trim();
    const directChild = trimmed.startsWith(":scope > ");
    const rest = directChild ? trimmed.slice(":scope > ".length) : trimmed;
    return { directChild, ...parseSimpleSelector(rest) };
  });
}

function elementMatches(el, { tag, attr, value }) {
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (attr) {
    const actual = el.getAttribute(attr);
    if (actual == null) return false;
    if (value != null && actual !== value) return false;
  }
  return true;
}

function descendantsOf(root) {
  const result = [];
  const walk = (node) => {
    for (const child of node.children) {
      result.push(child);
      walk(child);
    }
  };
  walk(root);
  return result;
}

class StubElement {
  constructor(tagName, attrs = {}, { text = "", required = false, hidden = false } = {}) {
    this.tagName = tagName.toUpperCase();
    this._attrs = new Map(Object.entries(attrs));
    this.children = [];
    this.parentElement = null;
    this.innerText = text;
    this.required = required;
    this.hidden = hidden;
    this._order = null;
  }

  get id() {
    return this._attrs.get("id") || "";
  }

  get form() {
    let node = this.parentElement;
    while (node) {
      if (node.tagName === "FORM") return node;
      node = node.parentElement;
    }
    return null;
  }

  getRootNode() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node;
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  getBoundingClientRect() {
    return this.hidden ? { width: 0, height: 0 } : { width: 10, height: 10 };
  }

  closest(tag) {
    let node = this;
    while (node) {
      if (node.tagName?.toLowerCase() === tag.toLowerCase()) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Real DOCUMENT_POSITION_FOLLOWING is 0x04, PRECEDING is 0x02 — only the
  // FOLLOWING bit matters to nearestGroupLabel, so this stub only needs to
  // get that bit right.
  compareDocumentPosition(other) {
    return other._order > this._order ? 0x04 : 0x02;
  }

  querySelectorAll(selector) {
    const clauses = parseSelectorGroup(selector);
    const matches = new Set();
    for (const clause of clauses) {
      const pool = clause.directChild ? this.children : descendantsOf(this);
      for (const el of pool) {
        if (elementMatches(el, clause)) matches.add(el);
      }
    }
    return [...matches].sort((a, b) => a._order - b._order);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

// Assigns a document-order index to every node (DFS preorder, matching real
// DOM tree order) so compareDocumentPosition/querySelectorAll ordering work.
function createDomStub(root) {
  let orderCounter = 0;
  const walk = (node) => {
    node._order = orderCounter++;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return {
    document: {
      getElementById: (id) => descendantsOf(root).find((el) => el.id === id) || null,
      querySelector: (selector) => root.querySelectorAll(selector)[0] || null,
    },
    window: {
      getComputedStyle: (el) =>
        el.hidden
          ? { visibility: "visible", display: "none" }
          : { visibility: "visible", display: "block" },
    },
    CSS: { escape: (value) => value },
  };
}

// collectControls reads document/window/CSS as browser globals (correct for
// real evaluateAll execution) — set them for the duration of a synchronous
// call and restore whatever was there before.
function withDomGlobals(stub, fn) {
  const prev = { document: globalThis.document, window: globalThis.window, CSS: globalThis.CSS };
  globalThis.document = stub.document;
  globalThis.window = stub.window;
  globalThis.CSS = stub.CSS;
  try {
    return fn();
  } finally {
    globalThis.document = prev.document;
    globalThis.window = prev.window;
    globalThis.CSS = prev.CSS;
  }
}

test("collectControls: fieldset legend names the group (P2 coverage)", () => {
  const legend = new StubElement("legend", {}, { text: "Resume/CV*" });
  const attach = new StubElement("button", {}, { text: "Attach" });
  const fieldset = new StubElement("fieldset").append(legend, attach);
  const root = new StubElement("div", { id: "root" }).append(fieldset);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([attach]));

  assert.equal(controls.length, 1);
  assert.equal(controls[0].role, "button");
  assert.equal(controls[0].name, "Attach");
  assert.equal(controls[0].groupLabel, "Resume/CV*");
});

test("collectControls: unwrapped native radios use form owner plus name identity without crossing identical names in another form", () => {
  const questionA = new StubElement("p", { id: "question-a" }, { text: "Need sponsorship?" });
  const yesA = new StubElement("input", { type: "radio", name: "eligibility" }, { required: true });
  const noA = new StubElement("input", { type: "radio", name: "eligibility" }, { required: true });
  const choicesA = new StubElement("div", { "aria-labelledby": "question-a" }).append(
    new StubElement("label", {}, { text: "Yes" }).append(yesA),
    new StubElement("label", {}, { text: "No" }).append(noA)
  );
  const formA = new StubElement("form").append(questionA, choicesA);

  const questionB = new StubElement("p", { id: "question-b" }, { text: "Authorized to work?" });
  const yesB = new StubElement("input", { type: "radio", name: "eligibility" }, { required: true });
  const noB = new StubElement("input", { type: "radio", name: "eligibility" }, { required: true });
  const choicesB = new StubElement("div").append(
    new StubElement("label", {}, { text: "Yes" }).append(yesB),
    new StubElement("label", {}, { text: "No" }).append(noB)
  );
  const formB = new StubElement("form").append(questionB, choicesB);
  const root = new StubElement("div", { id: "root" }).append(formA, formB);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([yesA, noA, yesB, noB]));

  assert.ok(controls[0].choiceGroup);
  assert.equal(controls[0].choiceGroup, controls[1].choiceGroup);
  assert.equal(controls[2].choiceGroup, controls[3].choiceGroup);
  assert.notEqual(controls[0].choiceGroup, controls[2].choiceGroup);
  assert.deepEqual(
    controls.map(({ groupLabel }) => groupLabel),
    ["Need sponsorship?", "Need sponsorship?", "Authorized to work?", "Authorized to work?"]
  );
});

test("collectControls: an aria-label on the container names the group (P2 coverage)", () => {
  const attach = new StubElement("button", {}, { text: "Attach" });
  const section = new StubElement("div", { "aria-label": "Cover Letter" }).append(attach);
  const root = new StubElement("div", { id: "root" }).append(section);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([attach]));

  assert.equal(controls[0].groupLabel, "Cover Letter");
});

test("collectControls: flat sibling labels resolve to the NEAREST PRECEDING one per control, not the first in the container (P1-2 regression)", () => {
  // <div><label>Resume/CV</label><button>Attach</button><label>Cover Letter</label><button>Attach</button></div>
  // Pre-fix, nearestGroupLabel's querySelector(":scope > label, ...") returned
  // the first matching label in the whole container for BOTH buttons, so the
  // cover-letter button was mis-tagged "Resume/CV" too, and
  // uploadTargetsFromSnapshot's usedKinds dedup silently dropped it.
  const resumeLabel = new StubElement("label", {}, { text: "Resume/CV" });
  const resumeButton = new StubElement("button", {}, { text: "Attach" });
  const coverLabel = new StubElement("label", {}, { text: "Cover Letter" });
  const coverButton = new StubElement("button", {}, { text: "Attach" });
  const container = new StubElement("div").append(
    resumeLabel,
    resumeButton,
    coverLabel,
    coverButton
  );
  const root = new StubElement("div", { id: "root" }).append(container);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([resumeButton, coverButton]));

  assert.equal(controls[0].groupLabel, "Resume/CV");
  assert.equal(controls[1].groupLabel, "Cover Letter");
  assert.notEqual(controls[0].groupLabel, controls[1].groupLabel);
});

test("collectControls: input[type=submit] names itself from the value attribute, not the name attribute (P2 coverage)", () => {
  const submitInput = new StubElement("input", {
    type: "submit",
    value: "Submit application",
    name: "commit",
  });
  const root = new StubElement("div", { id: "root" }).append(submitInput);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([submitInput]));

  assert.equal(controls[0].name, "Submit application");
});

test("collectControls marks Next safe only when its own form has structured remaining progress", () => {
  const progress = new StubElement("div", {
    role: "progressbar",
    "aria-label": "Application progress",
    "aria-valuenow": "1",
    "aria-valuemax": "3",
  });
  const next = new StubElement("button", { type: "button" }, { text: "Next" });
  const form = new StubElement("form").append(progress, next);
  const unrelatedProgress = new StubElement("div", {
    role: "progressbar",
    "aria-valuenow": "1",
    "aria-valuemax": "8",
  });
  const unrelatedNext = new StubElement("button", {}, { text: "Next" });
  const unrelatedForm = new StubElement("form").append(unrelatedNext);
  const root = new StubElement("div", { id: "root" }).append(
    form,
    unrelatedProgress,
    unrelatedForm
  );
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([next, unrelatedNext]));

  assert.equal(controls[0].advanceSafe, true);
  assert.equal(controls[1].advanceSafe, undefined);
});

test("collectControls does not treat upload progress as proof that Next is non-final", () => {
  const uploadProgress = new StubElement("div", {
    role: "progressbar",
    "aria-label": "Resume upload progress",
    "aria-valuenow": "75",
    "aria-valuemax": "100",
  });
  const next = new StubElement("button", { type: "button" }, { text: "Next" });
  const root = new StubElement("form").append(uploadProgress, next);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([next]));

  assert.equal(controls[0].advanceSafe, undefined);
});

test("collectControls never marks a submit-backed Next control safe", () => {
  const progress = new StubElement("div", {
    role: "progressbar",
    "aria-label": "Application progress",
    "aria-valuenow": "1",
    "aria-valuemax": "3",
  });
  const next = new StubElement("button", { type: "submit" }, { text: "Next" });
  const root = new StubElement("form").append(progress, next);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([next]));

  assert.equal(controls[0].advanceSafe, undefined);
});

test("collectControls binds wizard proof only to the exact non-submit advance control", () => {
  const progress = new StubElement("div", {
    role: "progressbar",
    "aria-label": "Application progress",
    "aria-valuenow": "1",
    "aria-valuemax": "3",
  });
  const leave = new StubElement("button", { type: "submit" }, { text: "Continue browsing jobs" });
  const next = new StubElement("button", { type: "button" }, { text: "Next" });
  const root = new StubElement("form").append(progress, leave, next);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([leave, next]));

  assert.equal(controls[0].advanceSafe, undefined);
  assert.equal(controls[1].advanceSafe, true);
});

test("collectControls does not mark a final structured step safe", () => {
  const progress = new StubElement("div", {
    role: "progressbar",
    "aria-valuenow": "3",
    "aria-valuemax": "3",
  });
  const next = new StubElement("button", {}, { text: "Next" });
  const root = new StubElement("form").append(progress, next);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([next]));

  assert.equal(controls[0].advanceSafe, undefined);
});

test("collectControls: a hidden file input is enumerated, a hidden text input is not (P2 coverage)", () => {
  const hiddenFileInput = new StubElement(
    "input",
    { type: "file", "aria-label": "Attach" },
    { hidden: true }
  );
  const hiddenTextInput = new StubElement("input", { type: "text" }, { hidden: true });
  const root = new StubElement("div", { id: "root" }).append(hiddenFileInput, hiddenTextInput);
  const stub = createDomStub(root);

  const controls = withDomGlobals(stub, () => collectControls([hiddenFileInput, hiddenTextInput]));

  assert.equal(controls.length, 1, "only the file input survives the visibility filter");
  assert.equal(controls[0].fileInput, true);
  assert.equal(controls[0].role, "button");
  assert.equal(controls[0].name, "Attach");
});

// ---------------------------------------------------------------------------
// (d) import safety: the module is importable without ever touching Playwright
// itself, because the launch is lazy — reached only inside openTab.
// ---------------------------------------------------------------------------

test("playwright-ops is importable without throwing (launch stays lazy)", async () => {
  const module = await import("../src/core/apply/playwright-ops.mjs");
  assert.equal(typeof module.createPlaywrightOps, "function");
  // Constructing ops also doesn't launch anything until openTab is called.
  assert.doesNotThrow(() => module.createPlaywrightOps({ profileDir: "/tmp/unused-profile" }));
});

test("playwright-ops forwards an explicit Chromium channel to the lazy launcher", async () => {
  const launches = [];
  const ops = createPlaywrightOps({
    profileDir: "/tmp/profile",
    headless: true,
    channel: "chromium",
    launchImpl: async (options) => {
      launches.push(options);
      return {
        async newPage() {
          return minimalFakePage("about:blank");
        },
        async close() {},
      };
    },
  });

  await ops.openTab({ url: "about:blank" });
  await ops.close();

  assert.deepEqual(launches, [{ profileDir: "/tmp/profile", headless: true, channel: "chromium" }]);
});

test("Playwright aborts a redirected private navigation before the request is sent", async () => {
  let routeHandler = null;
  let privateRequestSent = false;
  const context = {
    async route(pattern, handler) {
      assert.equal(pattern, "**/*");
      routeHandler = handler;
    },
    async newPage() {
      return {
        async goto() {
          assert.equal(typeof routeHandler, "function");
          await routeHandler({
            request: () => ({
              url: () => "https://jobs.example.test/search",
              isNavigationRequest: () => true,
              frame: () => ({ parentFrame: () => null }),
            }),
            continue: async () => {},
            abort: async () => assert.fail("the public hop must not be aborted"),
          });
          let blocked = false;
          await routeHandler({
            request: () => ({
              url: () => "http://127.0.0.1:7777/admin",
              isNavigationRequest: () => true,
              frame: () => ({ parentFrame: () => null }),
            }),
            continue: async () => {
              privateRequestSent = true;
            },
            abort: async () => {
              blocked = true;
            },
          });
          if (blocked)
            throw new Error("Navigation blocked by CareerRat's public-network boundary.");
        },
        async close() {},
      };
    },
  };
  const ops = createPlaywrightOps({
    launchImpl: async () => context,
    profileDir: "/tmp/profile",
    resolvePublicTargetImpl: async (rawUrl) =>
      String(rawUrl).includes("127.0.0.1")
        ? { ok: false, reason: "private or local host is not fetchable" }
        : { ok: true, url: new URL(rawUrl).toString() },
  });

  await assert.rejects(
    () => ops.openTab({ url: "https://jobs.example.test/search" }),
    /public-network boundary/i
  );
  assert.equal(privateRequestSent, false);
});

// ---------------------------------------------------------------------------
// P1-1: a transient launch failure (profile lock, momentary crash) must not
// permanently disable the provider — getContext() has to clear the cached
// promise on rejection so the next openTab retries the launch.
// ---------------------------------------------------------------------------

function minimalFakePage(url) {
  return {
    async goto() {},
    url: () => url,
    locator(selector) {
      if (selector === "body") return { innerText: async () => "" };
      return { evaluateAll: async () => [], nth: () => ({}) };
    },
    async screenshot() {
      return Buffer.from("");
    },
    async close() {},
  };
}

test("a transient launch failure doesn't permanently disable the provider (P1-1 regression)", async () => {
  let attempt = 0;
  const launchImpl = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("profile lock held by another process");
    return {
      async newPage() {
        return minimalFakePage("https://example.test/");
      },
      async close() {},
    };
  };
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  await assert.rejects(() => ops.openTab({ url: "https://example.test" }), /profile lock held/);
  const { pageId } = await ops.openTab({ url: "https://example.test" });

  assert.equal(typeof pageId, "string");
  assert.equal(
    attempt,
    2,
    "the second openTab retried the launch instead of reusing the rejected promise"
  );
});

// ---------------------------------------------------------------------------
// A failed goto must not leak the new page. Before the fix, a rejected
// target.goto() left the page open and never added to `pages`, so it could
// never be found (and closed) by evictLeastRecentlyUsed — repeated navigation
// failures would grow real browser tabs without bound.
// ---------------------------------------------------------------------------

test("openTab closes an untracked page when goto fails, and a later openTab still works (regression)", async () => {
  let newPageCalls = 0;
  const closedIndexes = [];
  const context = {
    async newPage() {
      newPageCalls += 1;
      const index = newPageCalls;
      const fakePage = minimalFakePage(`https://example.test/page-${index}`);
      if (index === 1) {
        fakePage.goto = async () => {
          throw new Error("net::ERR_NAME_NOT_RESOLVED");
        };
      }
      fakePage.close = async () => {
        closedIndexes.push(index);
      };
      return fakePage;
    },
    async close() {},
  };
  const ops = createPlaywrightOps({ launchImpl: async () => context, profileDir: "/tmp/profile" });

  await assert.rejects(
    () => ops.openTab({ url: "https://example.test/bad" }),
    /ERR_NAME_NOT_RESOLVED/
  );
  assert.deepEqual(closedIndexes, [1], "the page from the failed goto was closed");

  const { pageId } = await ops.openTab({ url: "https://example.test/good" });
  assert.equal(pageId, "page-1", "the failed attempt left no gap in the tracked set's bookkeeping");

  const snapshot = await ops.snapshot({ pageId });
  assert.equal(snapshot.origin, "https://example.test/page-2");
});

// ---------------------------------------------------------------------------
// (b) ops contract
// ---------------------------------------------------------------------------

test("snapshot normalizes role/name/required and assigns stable-for-this-snapshot refs", async () => {
  const { launchImpl } = createFakeBrowser({ controls: FORM_CONTROLS });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  const snapshot = await ops.snapshot({ pageId });

  assert.equal(snapshot.origin, GREENHOUSE_URL);
  assert.deepEqual(snapshot.refs, {
    e1: { role: "textbox", name: "First Name", required: true },
    e2: { role: "textbox", name: "Phone Number", required: false },
    e3: { role: "combobox", name: "Work authorization", required: false },
    e4: { role: "button", name: "Submit application", required: false },
  });
});

test("snapshot folds a native required radio fieldset into one labeled group with option refs and live state", async () => {
  const { launchImpl } = createFakeBrowser({ controls: NATIVE_RADIO_CONTROLS });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  let snapshot = await ops.snapshot({ pageId });

  assert.deepEqual(snapshot.refs, {
    e1: {
      role: "radio-group",
      name: "Will you now or in the future require sponsorship?",
      required: true,
      options: [
        { label: "Yes", ref: "e1" },
        { label: "No", ref: "e2" },
      ],
      stateKnown: true,
      value: "",
    },
    e2: { role: "radio", name: "No", required: true, field: false },
    e3: { role: "button", name: "Submit application", required: false },
  });

  await ops.clickButton({ pageId, ref: "e2" });
  snapshot = await ops.snapshot({ pageId });
  assert.equal(snapshot.refs.e1.value, "No");
});

test("snapshot refuses to merge one native identity across conflicting visible question scopes", async () => {
  const controls = [
    {
      role: "radio",
      name: "Yes",
      required: true,
      groupLabel: "Need sponsorship?",
      choiceGroup: "same-form-and-name",
    },
    {
      role: "radio",
      name: "No",
      required: true,
      groupLabel: "Need sponsorship?",
      choiceGroup: "same-form-and-name",
    },
    {
      role: "radio",
      name: "Yes",
      required: true,
      groupLabel: "Authorized to work?",
      choiceGroup: "same-form-and-name",
    },
    {
      role: "radio",
      name: "No",
      required: true,
      groupLabel: "Authorized to work?",
      choiceGroup: "same-form-and-name",
    },
  ];
  const { launchImpl } = createFakeBrowser({ controls });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  const snapshot = await ops.snapshot({ pageId });

  assert.equal(
    Object.values(snapshot.refs).some(({ role }) => role === "radio-group"),
    false
  );
  assert.deepEqual(
    Object.values(snapshot.refs).map(({ name }) => name),
    ["Yes", "No", "Yes", "No"]
  );
});

test("snapshot refuses to fold only the labeled subset of one native radio identity", async () => {
  const controls = [
    {
      role: "radio",
      name: "Yes",
      required: true,
      groupLabel: "Need sponsorship?",
      choiceGroup: "partially-labeled-group",
    },
    {
      role: "radio",
      name: "No",
      required: true,
      groupLabel: "Need sponsorship?",
      choiceGroup: "partially-labeled-group",
    },
    {
      role: "radio",
      name: "Maybe",
      required: true,
      groupLabel: null,
      choiceGroup: "partially-labeled-group",
    },
  ];
  const { launchImpl } = createFakeBrowser({ controls });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  const snapshot = await ops.snapshot({ pageId });

  assert.equal(
    Object.values(snapshot.refs).some(({ role }) => role === "radio-group"),
    false
  );
});

test("fillField and clickButton resolve refs from the latest snapshot", async () => {
  const { launchImpl, actions } = createFakeBrowser({ controls: FORM_CONTROLS });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  await ops.fillField({ pageId, ref: "e1", value: "Morgan" });
  await ops.selectOption({ pageId, ref: "e3", value: "Yes" });
  await ops.clickButton({ pageId, ref: "e4" });

  assert.deepEqual(actions, [
    { op: "fill", index: 0, value: "Morgan" },
    { op: "selectOption", index: 2, arg: { label: "Yes" } },
    { op: "click", index: 3 },
  ]);
});

test("Playwright select stops before another strategy after an in-flight cancellation", async () => {
  const controller = new AbortController();
  const cancellation = new Error("application preparation cancelled");
  const { launchImpl, actions } = createFakeBrowser({
    controls: FORM_CONTROLS,
    onAction(action) {
      if (action.op === "selectOption") controller.abort(cancellation);
    },
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });
  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });

  await assert.rejects(
    () =>
      ops.selectOption({
        pageId,
        ref: "e3",
        value: "Yes",
        optionAliases: ["Authorized"],
        signal: controller.signal,
      }),
    (error) => error === cancellation
  );
  assert.deepEqual(
    actions.filter((action) => action.op === "selectOption"),
    [{ op: "selectOption", index: 2, arg: { label: "Yes" } }]
  );
});

test("playwright-ops focuses the retained page without creating a second tab", async () => {
  const { launchImpl, actions, pageOpens } = createFakeBrowser({ controls: FORM_CONTROLS });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.focusTab({ pageId });

  assert.equal(pageOpens(), 1);
  assert.deepEqual(actions, [{ op: "bringToFront" }]);
});

test("an unknown or stale ref fails with a clear error", async () => {
  const { launchImpl } = createFakeBrowser({ controls: FORM_CONTROLS });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });

  await assert.rejects(
    () => ops.fillField({ pageId, ref: "e99", value: "x" }),
    /Unknown or stale ref "e99"/
  );
});

test("screenshot returns base64 png data", async () => {
  const { launchImpl } = createFakeBrowser({ controls: FORM_CONTROLS });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  const shot = await ops.screenshot({ pageId });

  assert.equal(shot.format, "png");
  assert.equal(Buffer.from(shot.data, "base64").toString(), "fake-png-bytes");
});

// ---------------------------------------------------------------------------
// selectOption(): custom [role=combobox] fallback (P0 — real ATS forms almost
// never use a native <select>; Greenhouse, Ashby, and Lever all route
// dropdowns through custom react-select-shaped widgets instead, which the
// original selectOption() couldn't drive at all — see PLAYWRIGHT-OPS.md-style
// evidence in the fix commit).
//
// createFakeBrowser above always resolves selectOption() successfully (it
// only records the call), which is right for pinning the still-working
// native-<select> contract but can't exercise the fallback. This fake models
// the extra Locator surface selectOption() now calls beyond that: a
// combobox-index control whose own selectOption() rejects exactly the way a
// real non-<select> element does ("Element is not a <select> element"), a
// click() that opens a live option list, an evaluate()/pressSequentially()
// pair for the optional type-to-filter step, an evaluate() that reflects the
// control's own post-selection display value (selectOption() now confirms a
// click actually selected something before reporting success — see
// comboboxValue below), and a page-level locator("[role='option']:visible")
// with first()/waitFor()/allTextContents()/filter({hasText}).first().click()
// reflecting that same filterable list — the same shape a real react-select
// combobox exposes.
// ---------------------------------------------------------------------------

function createFakeComboboxBrowser({
  controls,
  comboboxIndex,
  options,
  // false models an Ashby-shaped input: clicking it renders no options at
  // all (a type-to-populate control only ever populates its list from
  // typing), so selectOption() falls through past the click-to-open
  // strategy into the typing strategy below. true (the default) models the
  // react-select shape the existing tests below exercise, where the option
  // list opens right off the click.
  openOnClick = true,
  // false models the real P0 this fake exists to guard against: a click on
  // an option resolves with no error, yet the control's own display value
  // never actually changes. Only meaningful once the typing strategy is
  // reached (openOnClick: false) — see the requireDisplayChange regression
  // test below.
  applySelectionOnClick = true,
} = {}) {
  const actions = [];
  let currentUrl = "";
  let open = false;
  let filterText = "";
  // The combobox control's own "display value" — selectOption() now reads
  // this back (via evaluate()) after every click to CONFIRM a selection
  // actually took, instead of trusting a click that merely didn't throw.
  // Only ever set by a successful option click below, exactly mirroring the
  // real bug this fake pins the fix for: a click on a real Ashby control
  // resolved cleanly while its value stayed genuinely blank.
  let comboboxValue = "";

  function visibleOptions() {
    if (!open) return [];
    const query = filterText.trim().toLowerCase();
    return options.filter((option) => option.toLowerCase().includes(query));
  }

  function elementLocator(index) {
    if (index !== comboboxIndex) {
      // Every other control these tests touch is treated as a real native
      // <select> — selectOption() against it just has to succeed, the same
      // contract createFakeBrowser's fake already pins above.
      return {
        async selectOption(arg) {
          actions.push({ op: "selectOption", index, arg });
          return [String(arg?.label ?? arg)];
        },
      };
    }
    return {
      async selectOption() {
        // A real Playwright Locator.selectOption() against a non-<select>
        // element rejects immediately with exactly this message — reproduced
        // here so selectOption()'s outer try/catch takes the same fallback
        // branch it would against a live combobox.
        throw new Error("Element is not a <select> element");
      },
      async click() {
        if (!openOnClick) return; // Ashby-shaped: a click alone opens nothing
        actions.push({ op: "comboboxOpen", index });
        open = true;
        filterText = "";
      },
      async evaluate(fn) {
        return fn({ tagName: "INPUT", isContentEditable: false, value: comboboxValue });
      },
      async pressSequentially(value) {
        actions.push({ op: "comboboxFilter", index, value });
        filterText = value;
        // A real <input> reflects keystrokes in its own .value as they're
        // typed — this is exactly the value matchClickAndConfirm's
        // requireDisplayChange option must NOT accept as evidence of a
        // completed selection, since it's set before any option is clicked.
        comboboxValue = value;
        open = true; // the list appears as a side effect of typing, not a click
      },
      async fill(value) {
        assert.equal(value, "");
        actions.push({ op: "comboboxClear", index });
        filterText = "";
        comboboxValue = "";
      },
    };
  }

  function selectOptionByLabel(label) {
    actions.push({ op: "comboboxSelect", index: comboboxIndex, label });
    if (applySelectionOnClick) {
      comboboxValue = label;
      open = false;
    }
    // else: reproduces the real Ashby P0 this fake guards against — the
    // click resolves with no error, yet the control's own display value and
    // open option list never actually change.
  }

  function fakeOptionsLocator() {
    return {
      first() {
        return {
          async waitFor() {
            if (visibleOptions().length === 0) throw new Error("no visible [role='option']");
          },
        };
      },
      async allTextContents() {
        return visibleOptions();
      },
      // matchClickAndConfirm's requireDisplayChange path reads this after a
      // click to check whether the option list closed.
      async count() {
        return visibleOptions().length;
      },
      // Mirrors real Locator.filter({hasText}).first().click() — the exact
      // surface selectOption()'s clickOptionByExactText() now drives instead
      // of a cached nth(index), so this has to model it for the combobox
      // fallback tests below to exercise the real code path.
      filter({ hasText }) {
        return {
          first() {
            return {
              async click() {
                const matches = visibleOptions().filter((text) =>
                  hasText instanceof RegExp ? hasText.test(text) : text.includes(hasText)
                );
                if (matches.length === 0) throw new Error("no option matched filter({hasText})");
                selectOptionByLabel(matches[0]);
              },
            };
          },
        };
      },
    };
  }

  const page = {
    async goto(url) {
      currentUrl = url;
    },
    url() {
      return currentUrl;
    },
    locator(selector) {
      if (selector === "body")
        return {
          async innerText() {
            return "";
          },
        };
      if (selector === "[role='option']:visible") return fakeOptionsLocator();
      return {
        async evaluateAll() {
          return controls.map((control, index) => ({
            index,
            role: control.role,
            name: control.name,
            required: Boolean(control.required),
            fileInput: Boolean(control.fileInput),
            groupLabel: control.groupLabel ?? null,
          }));
        },
        nth: elementLocator,
      };
    },
    async screenshot() {
      return Buffer.from("fake-png-bytes");
    },
  };

  const context = {
    async newPage() {
      return page;
    },
    async close() {},
  };

  return { actions, launchImpl: async () => context };
}

const COMBOBOX_FORM_CONTROLS = [
  { role: "textbox", name: "First Name", required: true },
  { role: "combobox", name: "Country", required: true },
  { role: "button", name: "Submit application", required: false },
];

// Deliberately ordered so the substring match ("United States Minor Outlying
// Islands" contains "united states") would be the FIRST match found by a
// naive first-hit search, even though the target value has an exact match
// later in the list.
const COUNTRY_OPTIONS = [
  "United States Minor Outlying Islands",
  "United States",
  "Canada",
  "United Kingdom",
];

test("selectOption falls back to a custom combobox when the ref isn't a native <select>", async () => {
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: COUNTRY_OPTIONS,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  await ops.selectOption({ pageId, ref: "e2", value: "Canada" });

  assert.deepEqual(actions, [
    { op: "comboboxOpen", index: 1 },
    { op: "comboboxSelect", index: 1, label: "Canada" },
  ]);
});

test("selectOption uses a configured alias without provider-specific engine logic", async () => {
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: ["LinkedIn", "Other"],
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  await ops.selectOption({
    pageId,
    ref: "e2",
    value: "Community event",
    optionAliases: ["Other"],
  });

  assert.deepEqual(actions, [
    { op: "comboboxOpen", index: 1 },
    { op: "comboboxSelect", index: 1, label: "Other" },
  ]);
});

test("selectOption retries a typed combobox with a configured alias", async () => {
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: ["LinkedIn", "Other"],
    openOnClick: false,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  await ops.selectOption({
    pageId,
    ref: "e2",
    value: "Community event",
    optionAliases: ["Other"],
  });

  assert.deepEqual(actions, [
    { op: "comboboxFilter", index: 1, value: "Community event" },
    { op: "comboboxClear", index: 1 },
    { op: "comboboxFilter", index: 1, value: "Other" },
    { op: "comboboxSelect", index: 1, label: "Other" },
  ]);
});

test("selectDeclineOption chooses the one narrowly recognized option", async () => {
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: ["Woman", "Prefer not to answer"],
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  const result = await ops.selectDeclineOption({
    pageId,
    ref: "e2",
    label: "Gender",
  });

  assert.equal(result.selectedValue, "Prefer not to answer");
  assert.deepEqual(actions, [
    { op: "comboboxOpen", index: 1 },
    { op: "comboboxSelect", index: 1, label: "Prefer not to answer" },
  ]);
});

test("selectDeclineOption refuses ambiguous decline options", async () => {
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: ["Prefer not to answer", "Decline to self-identify"],
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  await assert.rejects(
    () => ops.selectDeclineOption({ pageId, ref: "e2", label: "Gender" }),
    /did not offer one unambiguous decline option/
  );
  assert.equal(
    actions.some(({ op }) => op === "comboboxSelect"),
    false
  );
});

test("selectOption prefers an exact option match over a substring match (P1 regression)", async () => {
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: COUNTRY_OPTIONS,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  await ops.selectOption({ pageId, ref: "e2", value: "United States" });

  const selected = actions.find((entry) => entry.op === "comboboxSelect");
  assert.equal(
    selected.label,
    "United States",
    "the exact match wins even though the substring match sorts first in the option list"
  );
});

test("selectOption matches case-insensitively and tolerates surrounding whitespace", async () => {
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: COUNTRY_OPTIONS,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  await ops.selectOption({ pageId, ref: "e2", value: "  canada  " });

  const selected = actions.find((entry) => entry.op === "comboboxSelect");
  assert.equal(selected.label, "Canada");
});

test("selectOption on a genuine native <select> ref never touches the combobox fallback (no regression)", async () => {
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: COUNTRY_OPTIONS,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  // ref e1 ("First Name") resolves to control index 0 — the fake's
  // "always a native <select>" branch — proving the native path still runs
  // untouched when it's not the combobox-shaped control under test.
  await ops.selectOption({ pageId, ref: "e1", value: "whatever" });

  assert.deepEqual(actions, [{ op: "selectOption", index: 0, arg: { label: "whatever" } }]);
});

test("selectOption throws a plain-language human-handoff error naming the field when no option matches (P0)", async () => {
  const { launchImpl } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: COUNTRY_OPTIONS,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });

  await assert.rejects(
    () => ops.selectOption({ pageId, ref: "e2", value: "Atlantis" }),
    (error) => {
      assert.match(error.message, /"Country" dropdown/);
      assert.match(error.message, /couldn't be set automatically/);
      assert.match(error.message, /switch to the open browser window/);
      assert.match(error.message, /choose the correct option yourself/);
      return true;
    }
  );
});

test("findOptionMatch: an empty target value never falls through to substring matching (P2 regression)", async () => {
  // Every option's normalized text "includes" the empty string, so without
  // the early return in findOptionMatch() an unset/blank value would
  // substring-match the FIRST option in the list and get clicked — the
  // field silently ends up with an arbitrary value instead of a clean
  // handoff to the human. openOnClick: false plus the empty value also
  // means the click-to-open strategy never opens a list and the typing
  // strategy never has anything to type, so this only passes if the -1
  // short-circuit fires before either match kind runs.
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: COUNTRY_OPTIONS,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });

  await assert.rejects(
    () => ops.selectOption({ pageId, ref: "e2", value: "" }),
    /couldn't be set automatically/
  );
  assert.ok(
    !actions.some((entry) => entry.op === "comboboxSelect"),
    "an empty value must never result in an option actually being clicked"
  );
});

test("selectOption's typeahead strategy (Ashby shape) confirms a real selection via typed keystrokes", async () => {
  // openOnClick: false forces the click-to-open strategy to find no list at
  // all, falling through into the typing strategy — the only path that
  // exercises requireDisplayChange. applySelectionOnClick stays at its
  // default (true): the option click genuinely commits, so confirmation
  // must still succeed once real evidence (the display value changing)
  // exists, not just when a click resolves.
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: COUNTRY_OPTIONS,
    openOnClick: false,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });
  await ops.selectOption({ pageId, ref: "e2", value: "United States" });

  assert.ok(
    actions.some((entry) => entry.op === "comboboxFilter"),
    "the typing strategy must have actually been reached"
  );
  const selected = actions.find((entry) => entry.op === "comboboxSelect");
  assert.equal(selected.label, "United States");
});

test("selectOption's typeahead strategy does NOT confirm on the text it typed itself — a click that resolves without ever changing the control's value must be rejected (P0 regression guard)", async () => {
  // This is the exact false-positive an earlier verification pass fell
  // into on this feature: the code had already typed "United States" into
  // the box, so the control's display value contains the target text
  // whether or not the option click actually committed anything. Before
  // requireDisplayChange, comboboxSelectionConfirmed(displayValue,
  // matchedText) would pass on that alone. applySelectionOnClick: false
  // reproduces the real Ashby bug this guards against — the click resolves
  // with no error, yet the control's own value and open option list never
  // change — so confirmation must fail and the field must hand off to the
  // human instead of silently reporting success.
  const { launchImpl, actions } = createFakeComboboxBrowser({
    controls: COMBOBOX_FORM_CONTROLS,
    comboboxIndex: 1,
    options: COUNTRY_OPTIONS,
    openOnClick: false,
    applySelectionOnClick: false,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  await ops.snapshot({ pageId });

  await assert.rejects(
    () => ops.selectOption({ pageId, ref: "e2", value: "United States" }),
    (error) => {
      assert.match(error.message, /"Country" dropdown/);
      assert.match(error.message, /couldn't be set automatically/);
      return true;
    }
  );
  assert.ok(
    actions.some((entry) => entry.op === "comboboxFilter"),
    "the typing strategy must have actually typed the target text in — that's the trap being guarded against"
  );
});

// ---------------------------------------------------------------------------
// upload group-tree synthesis: pageText carries an Orca-shaped tree section so
// apply-driver.mjs's real uploadTargetsFromSnapshot()/parsedSnapshotNodes()
// (unmodified, imported directly here) can resolve upload targets — this is
// the regression pin for the "uploads silently never run" gap.
// ---------------------------------------------------------------------------

test("uploadTargetsFromSnapshot resolves both a file-input and a button upload target from the synthesized tree", async () => {
  const { launchImpl } = createFakeBrowser({ controls: UPLOAD_CONTROLS });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  const snapshot = await ops.snapshot({ pageId });

  const targets = uploadTargetsFromSnapshot(snapshot);
  assert.deepEqual(
    targets.map(({ kind, label, required }) => ({ kind, label, required })),
    [
      { kind: "resume", label: "Resume/CV*", required: true },
      { kind: "coverLetter", label: "Cover Letter", required: false },
    ]
  );
  // The resume target resolves to the hidden file input (control index 1),
  // the cover-letter target to the styled button (control index 2).
  assert.equal(targets[0].ref, "e2");
  assert.equal(targets[1].ref, "e3");
});

test("upload() sets files directly on a file-input ref and drives the filechooser for a button ref", async () => {
  const { launchImpl, actions } = createFakeBrowser({ controls: UPLOAD_CONTROLS });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  const snapshot = await ops.snapshot({ pageId });
  const targets = uploadTargetsFromSnapshot(snapshot);

  await ops.upload({ pageId, ref: targets[0].ref, files: "/tmp/resume.pdf" });
  await ops.upload({ pageId, ref: targets[1].ref, files: "/tmp/cover.pdf" });

  assert.deepEqual(actions, [
    { op: "setInputFiles", index: 1, files: "/tmp/resume.pdf" },
    { op: "click", index: 2 },
    { op: "chooserSetFiles", index: 2, files: "/tmp/cover.pdf" },
  ]);
});

// ---------------------------------------------------------------------------
// Labels come from innerText and can contain embedded newlines or runs of
// whitespace. Before the fix, formatTreeLine only escaped double quotes, so a
// multi-line label split a tree line across two physical lines, neither of
// which carries a ref= token, breaking apply-driver.mjs's line-by-line
// indent-stack parser. Group labels differing only by whitespace also split
// into separate groups because buildUploadTreeLines keyed on the raw label.
// ---------------------------------------------------------------------------

const UPLOAD_CONTROLS_WITH_NEWLINE_LABEL = [
  { role: "textbox", name: "First Name", required: true },
  {
    role: "button",
    name: "Attach",
    groupLabel: "Resume/CV*\n(PDF only)",
    fileInput: true,
    required: true,
  },
  { role: "button", name: "Submit application" },
];

test("a control label with an embedded newline still produces a parseable upload tree (regression)", async () => {
  const { launchImpl } = createFakeBrowser({ controls: UPLOAD_CONTROLS_WITH_NEWLINE_LABEL });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  const snapshot = await ops.snapshot({ pageId });

  const treeLines = snapshot.pageText.split("\n").filter((line) => line.trim().startsWith("- "));
  assert.ok(treeLines.length > 0, "the synthesized tree section is present");
  for (const line of treeLines) {
    assert.match(line, /ref=[\w-]+/, `tree line missing a ref= token: ${JSON.stringify(line)}`);
  }

  const targets = uploadTargetsFromSnapshot(snapshot);
  const resumeTarget = targets.find((target) => target.kind === "resume");
  assert.ok(resumeTarget, "uploadTargetsFromSnapshot still finds the resume target");
  assert.equal(resumeTarget.label, "Resume/CV* (PDF only)");
});

const UPLOAD_CONTROLS_DUPLICATE_GROUP_WHITESPACE = [
  { role: "button", name: "Attach", groupLabel: "Documents \n", fileInput: true },
  { role: "button", name: "Attach More", groupLabel: " Documents", fileInput: true },
];

test("group labels identical after whitespace normalization collapse into one group (regression)", async () => {
  const { launchImpl } = createFakeBrowser({
    controls: UPLOAD_CONTROLS_DUPLICATE_GROUP_WHITESPACE,
  });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const { pageId } = await ops.openTab({ url: GREENHOUSE_URL });
  const snapshot = await ops.snapshot({ pageId });

  const groupHeaderLines = snapshot.pageText
    .split("\n")
    .filter((line) => /^- group "/.test(line.trim()));
  assert.equal(groupHeaderLines.length, 1, "both controls collapse into a single group header");
});

// ---------------------------------------------------------------------------
// P1-3: unbounded tab growth — every applicationId used to open a page that
// was never closed. Pages are now capped (LRU, ~8); opening past the cap
// closes the least-recently-used tab, and a later op against it fails with a
// clear, plain-language error instead of a generic "unknown page id".
// ---------------------------------------------------------------------------

test("LRU eviction: opening past the cap closes the oldest tab and a later op against it fails clearly (P1-3 regression)", async () => {
  const closedPageNumbers = [];
  let pageCounter = 0;
  const context = {
    async newPage() {
      pageCounter += 1;
      const pageNumber = pageCounter;
      const fakePage = minimalFakePage(`https://example.test/page-${pageNumber}`);
      return {
        ...fakePage,
        async close() {
          closedPageNumbers.push(pageNumber);
        },
      };
    },
    async close() {},
  };
  const ops = createPlaywrightOps({ launchImpl: async () => context, profileDir: "/tmp/profile" });

  const opened = [];
  for (let i = 0; i < 9; i += 1) {
    opened.push((await ops.openTab({ url: "https://example.test" })).pageId);
  }

  assert.deepEqual(
    closedPageNumbers,
    [1],
    "the 9th open evicts the 1st (oldest, least-recently-used) tab"
  );

  await assert.rejects(
    () => ops.snapshot({ pageId: opened[0] }),
    /This application's browser tab was closed to free resources\. Ask CareerRat to apply again to reopen it\./
  );

  // The most recently opened tab is unaffected.
  const snapshot = await ops.snapshot({ pageId: opened[8] });
  assert.equal(snapshot.origin, "https://example.test/page-9");
});

test("LRU eviction: an active tab that keeps getting snapshotted is not evicted just because it's old", async () => {
  let pageCounter = 0;
  const context = {
    async newPage() {
      pageCounter += 1;
      return minimalFakePage(`https://example.test/page-${pageCounter}`);
    },
    async close() {},
  };
  const ops = createPlaywrightOps({ launchImpl: async () => context, profileDir: "/tmp/profile" });

  const { pageId: keptAlive } = await ops.openTab({ url: "https://example.test" });
  for (let i = 0; i < 8; i += 1) {
    await ops.snapshot({ pageId: keptAlive }); // bumps recency on the first-opened tab
    await ops.openTab({ url: "https://example.test" });
  }

  // 9 tabs were opened total; the cap is 8. Without recency bumping the
  // first-opened tab would be the eviction target, but it's been the most
  // recently used one all along.
  const snapshot = await ops.snapshot({ pageId: keptAlive });
  assert.equal(snapshot.origin, "https://example.test/page-1");
});

// ---------------------------------------------------------------------------
// (c) end-to-end through createApplyDriver: proves the driver runs unmodified
// over playwright-ops.
// ---------------------------------------------------------------------------

test("createApplyDriver reaches awaiting-submit with fields filled over playwright-ops", async () => {
  const { launchImpl, actions } = createFakeBrowser({ controls: FORM_CONTROLS });
  const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

  const execute = createApplyDriver({
    ops,
    providerLabel: "playwright",
    repoRoot: "/repo",
    env: {},
    mayRunImpl: () => ({ allowed: true }),
    candidateConfigGetImpl: () => ({
      profile: { candidate: { full_name: "Morgan Hale" } },
      honesty: {},
      "form-defaults": { work_authorization: "Yes" },
    }),
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl: async ({ questions }) => ({
      questions,
      excluded: [],
      demographicSectionPresent: false,
    }),
    saveScreenshotImpl: () => "workspace/captures/fake-confirmation.png",
  });

  const result = await execute({
    applicationId: "app-1",
    application: { id: "app-1" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.available, true);
  assert.equal(result.verified, false);
  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.provider, "playwright");
  assert.equal(
    result.session.filledCount,
    2,
    "First Name + Work authorization; Phone Number has no source"
  );
  assert.deepEqual(
    actions.filter((entry) => entry.op !== "click"),
    [
      { op: "fill", index: 0, value: "Morgan" },
      { op: "selectOption", index: 2, arg: { label: "Yes" } },
    ]
  );
});

test("createApplyDriver uploads the resume through playwright-ops when a target resolves", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-playwright-upload-"));
  try {
    mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
    writeFileSync(
      join(repoRoot, "workspace", "tailored", "resume.pdf"),
      buildMinimalPdf(["Resume"]).bytes
    );

    const { launchImpl, actions } = createFakeBrowser({ controls: UPLOAD_CONTROLS });
    const ops = createPlaywrightOps({ launchImpl, profileDir: "/tmp/profile" });

    const execute = createApplyDriver({
      ops,
      providerLabel: "playwright",
      repoRoot,
      env: {},
      mayRunImpl: () => ({ allowed: true }),
      // First Name is required in UPLOAD_CONTROLS; the multi-step loop now
      // blocks on any unresolved required field (same NEEDS YOU discipline
      // Easy Apply already applied) rather than reaching awaiting-submit with
      // a silently blank required field, so a resolvable full_name is needed
      // here to isolate this test's actual subject (the upload path) from
      // that unrelated required-field gate.
      candidateConfigGetImpl: () => ({
        profile: { candidate: { full_name: "Alex Doe" } },
        honesty: {},
        "form-defaults": {},
      }),
      loadAnswerMapImpl: async () => new Map(),
      captureQuestionsImpl: async ({ questions }) => ({
        questions,
        excluded: [],
        demographicSectionPresent: false,
      }),
      saveScreenshotImpl: () => "workspace/captures/fake-confirmation.png",
    });

    const result = await execute({
      applicationId: "app-upload",
      application: {
        id: "app-upload",
        artifacts: { resumePdf: "workspace/tailored/resume.pdf" },
      },
      postingUrl: GREENHOUSE_URL,
      questionCapture: { state: "captured" },
    });

    assert.equal(result.state, "awaiting-submit");
    assert.equal(result.session.uploadedCount, 1, "only the resume has a matching artifact");
    assert.deepEqual(
      actions.filter((entry) => entry.op === "setInputFiles"),
      [
        {
          op: "setInputFiles",
          index: 1,
          files: join(repoRoot, "workspace", "tailored", "resume.pdf"),
        },
      ]
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (a) factory dispatch
// ---------------------------------------------------------------------------

test("configured executor dispatches to the playwright executor for provider playwright", async () => {
  const { launchImpl, pageOpens } = createFakeBrowser({ controls: FORM_CONTROLS });
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    loadAutomationImpl: () => ({ data: { session: { provider: "playwright" } } }),
    launchImpl,
    mayRunImpl: () => ({ allowed: true }),
    candidateConfigGetImpl: () => ({ profile: {}, honesty: {}, "form-defaults": {} }),
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl: async ({ questions }) => ({
      questions,
      excluded: [],
      demographicSectionPresent: false,
    }),
  });

  assert.equal(typeof execute, "function");
  const result = await execute({
    applicationId: "app-1",
    application: { id: "app-1" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.session.provider, "playwright");
  assert.ok(pageOpens() > 0, "the playwright executor actually opened a fake browser tab");
});

test("configured Playwright executor preserves cancellation instead of reporting unavailable", async () => {
  const { launchImpl, pageOpens } = createFakeBrowser({ controls: FORM_CONTROLS });
  const controller = new AbortController();
  const cancellation = new Error("application preparation cancelled");
  controller.abort(cancellation);
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    loadAutomationImpl: () => ({ data: { session: { provider: "playwright" } } }),
    launchImpl,
    mayRunImpl: () => ({ allowed: true }),
    candidateConfigGetImpl: () => ({ profile: {}, honesty: {}, "form-defaults": {} }),
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl: async ({ questions }) => ({
      questions,
      excluded: [],
      demographicSectionPresent: false,
    }),
  });

  await assert.rejects(
    () =>
      execute({
        applicationId: "app-pre-cancelled",
        application: { id: "app-pre-cancelled" },
        postingUrl: GREENHOUSE_URL,
        questionCapture: { state: "captured" },
        signal: controller.signal,
      }),
    (error) => error === cancellation
  );
  assert.equal(pageOpens(), 0, "a cancelled request must not launch or mutate the browser");
});

test("configured executor returns to the exact retained Playwright page for final user review", async () => {
  const { launchImpl, actions, pageOpens } = createFakeBrowser({ controls: FORM_CONTROLS });
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    loadAutomationImpl: () => ({ data: { session: { provider: "playwright" } } }),
    launchImpl,
    mayRunImpl: () => ({ allowed: true }),
    candidateConfigGetImpl: () => ({
      profile: { candidate: { first_name: "Morgan" } },
      honesty: {},
      "form-defaults": {},
    }),
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl: async ({ questions }) => ({
      questions,
      excluded: [],
      demographicSectionPresent: false,
    }),
  });

  const input = {
    applicationId: "app-retained",
    application: { id: "app-retained" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  };
  await execute(input);
  const focused = await execute({ ...input, focusSession: true });

  assert.equal(pageOpens(), 1, "review must not create another tab or browser profile");
  assert.equal(focused.state, "awaiting-submit");
  assert.equal(focused.session.focused, true);
  assert.deepEqual(actions.at(-1), { op: "bringToFront" });
});

test("fresh packaged auto configuration fills through bundled Playwright and stops before submit", async () => {
  const { launchImpl, actions, pageOpens } = createFakeBrowser({ controls: FORM_CONTROLS });
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: { CAREERRAT_PACKAGED_DESKTOP: "1" },
    loadAutomationImpl: () => ({ data: { session: { provider: "auto" } } }),
    launchImpl,
    mayRunImpl: () => ({ allowed: true }),
    candidateConfigGetImpl: () => ({
      profile: { candidate: { full_name: "Morgan Hale" } },
      honesty: {},
      "form-defaults": { work_authorization: "Yes" },
    }),
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl: async ({ questions }) => ({
      questions,
      excluded: [],
      demographicSectionPresent: false,
    }),
  });

  const result = await execute({
    applicationId: "app-packaged-fresh",
    application: { id: "app-packaged-fresh" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.available, true);
  assert.equal(result.verified, false, "the executor must never claim the user submitted");
  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.provider, "playwright");
  assert.ok(pageOpens() > 0, "the bundled Playwright path opened the application form");
  assert.deepEqual(
    actions.filter((entry) => entry.index === 3),
    [],
    "the final submit control must remain untouched"
  );
});

test("configured packaged executor resolves both provider and profile from the isolated desktop environment", async () => {
  const { launchImpl } = createFakeBrowser({ controls: FORM_CONTROLS });
  const env = {
    CAREERRAT_HOME: "/private/careerrat-desktop-data",
    CAREERRAT_PACKAGED_DESKTOP: "1",
  };
  const loadCalls = [];
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/staged/careerrat",
    env,
    loadAutomationImpl: (options) => {
      loadCalls.push(options);
      return { data: { session: { provider: "auto", profile_root: "/private/browser" } } };
    },
    launchImpl,
    mayRunImpl: () => ({ allowed: true }),
    candidateConfigGetImpl: () => ({
      profile: { candidate: { full_name: "Morgan Hale" } },
      honesty: {},
      "form-defaults": {},
    }),
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl: async ({ questions }) => ({
      questions,
      excluded: [],
      demographicSectionPresent: false,
    }),
  });

  const result = await execute({
    applicationId: "app-packaged-env",
    application: { id: "app-packaged-env" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(
    loadCalls.length,
    2,
    "provider selection and Playwright profile use one config source"
  );
  assert.equal(
    loadCalls.every((call) => call.root === "/staged/careerrat"),
    true
  );
  assert.equal(
    loadCalls.every((call) => call.env === env),
    true
  );
});

test("configured executor fails the extension provider immediately with an honest reason, not null", async () => {
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    loadAutomationImpl: () => ({ data: { session: { provider: "extension" } } }),
  });
  assert.equal(typeof execute, "function");
  const result = await execute({
    applicationId: "app-1",
    application: {},
    postingUrl: GREENHOUSE_URL,
  });
  assert.equal(result.available, false);
  assert.equal(result.state, "unavailable");
  assert.match(result.reason, /automatic apply isn't available on the .*extension.* provider yet/i);
  // Provider-neutral: no hardcoded replacement-provider recommendation (AGENTS.md
  // Domain-Neutral Rule) — see session.mjs automaticApplyGap().
  assert.doesNotMatch(result.reason, /playwright/i);
});

test("configured executor still dispatches provider orca to the orca executor", async () => {
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    loadAutomationImpl: () => ({ data: { session: { provider: "orca" } } }),
    mayRunImpl: () => ({ allowed: true }),
    runOrcaImpl: async () => {
      throw new Error("Orca is not running");
    },
  });
  assert.equal(typeof execute, "function");
  const result = await execute({
    applicationId: "app-1",
    application: {},
    postingUrl: GREENHOUSE_URL,
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /Orca is not running/);
});

test("createPlaywrightApplyExecutor mirrors createOrcaApplyExecutor's composition shape", async () => {
  const { launchImpl, pageOpens } = createFakeBrowser({ controls: FORM_CONTROLS });
  const execute = createPlaywrightApplyExecutor({
    repoRoot: "/repo",
    env: {},
    launchImpl,
    mayRunImpl: () => ({ allowed: true }),
    // FORM_CONTROLS' First Name is required; a resolvable full_name keeps
    // this composition-shape test isolated from the multi-step loop's
    // unresolved-required-field gate (see the upload test's fuller comment).
    candidateConfigGetImpl: () => ({
      profile: { candidate: { full_name: "Alex Doe" } },
      honesty: {},
      "form-defaults": {},
    }),
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl: async ({ questions }) => ({
      questions,
      excluded: [],
      demographicSectionPresent: false,
    }),
  });

  const result = await execute({
    applicationId: "app-1",
    application: { id: "app-1" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.provider, "playwright");
  assert.ok(pageOpens() > 0);
});

// ---------------------------------------------------------------------------
// resolveSession()'s profileRoot is only populated when the configured
// provider is "playwright" — this executor can be constructed regardless of
// which provider the config names, so it must read session.profile_root
// straight off the loaded config instead of relying on that provider-gated
// field (which would otherwise silently drop a custom root).
// ---------------------------------------------------------------------------

test("createPlaywrightApplyExecutor uses a custom session.profile_root even when the configured provider is not playwright (regression)", async () => {
  const customRoot = mkdtempSync(join(tmpdir(), "careerrat-profile-root-"));
  try {
    const { launchImpl } = createFakeBrowser({ controls: FORM_CONTROLS });
    let capturedProfileDir = null;
    const wrappedLaunch = async (args) => {
      capturedProfileDir = args.profileDir;
      return launchImpl(args);
    };

    const execute = createPlaywrightApplyExecutor({
      repoRoot: "/repo",
      env: {},
      loadAutomationImpl: () => ({
        data: { session: { provider: "extension", profile_root: customRoot } },
      }),
      launchImpl: wrappedLaunch,
      mayRunImpl: () => ({ allowed: true }),
      candidateConfigGetImpl: () => ({ profile: {}, honesty: {}, "form-defaults": {} }),
      loadAnswerMapImpl: async () => new Map(),
      captureQuestionsImpl: async ({ questions }) => ({
        questions,
        excluded: [],
        demographicSectionPresent: false,
      }),
    });

    await execute({
      applicationId: "app-1",
      application: { id: "app-1" },
      postingUrl: GREENHOUSE_URL,
      questionCapture: { state: "captured" },
    });

    assert.equal(capturedProfileDir, join(customRoot, "apply"));
  } finally {
    rmSync(customRoot, { recursive: true, force: true });
  }
});

test("createPlaywrightApplyExecutor isolates its default profile by CareerRat home", async () => {
  async function launchedProfileDir(dataRoot) {
    const { launchImpl } = createFakeBrowser({ controls: FORM_CONTROLS });
    let capturedProfileDir = null;
    const execute = createPlaywrightApplyExecutor({
      repoRoot: "/repo",
      env: { CAREERRAT_HOME: dataRoot },
      loadAutomationImpl: () => ({ data: { session: { provider: "playwright" } } }),
      launchImpl: async (args) => {
        capturedProfileDir = args.profileDir;
        return launchImpl(args);
      },
      mayRunImpl: () => ({ allowed: true }),
      candidateConfigGetImpl: () => ({ profile: {}, honesty: {}, "form-defaults": {} }),
      loadAnswerMapImpl: async () => new Map(),
      captureQuestionsImpl: async ({ questions }) => ({
        questions,
        excluded: [],
        demographicSectionPresent: false,
      }),
    });

    await execute({
      applicationId: "app-1",
      application: { id: "app-1" },
      postingUrl: GREENHOUSE_URL,
      questionCapture: { state: "captured" },
    });
    return capturedProfileDir;
  }

  const first = await launchedProfileDir("/private/candidate-a");
  const second = await launchedProfileDir("/private/candidate-b");

  assert.equal(first, join("/private/candidate-a", "board-profiles", "apply"));
  assert.equal(second, join("/private/candidate-b", "board-profiles", "apply"));
  assert.notEqual(first, second);
});
