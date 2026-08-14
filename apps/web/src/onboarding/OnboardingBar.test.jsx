// apps/web/src/onboarding/OnboardingBar.test.jsx
// vitest coverage for the W4 chat-first onboarding surface's interview bar
// (commit c1d601e3). Follows this repo's house convention (see
// AskBar.test.jsx / JobDrawer.test.jsx): default "node" vitest environment,
// no jsdom/@testing-library — a hand-rolled hook harness replaces
// useState/useRef via vi.mock("react", ...), the component is invoked as a
// plain function, and the returned React-element tree is walked directly.
// OnboardingBar has no effects of its own beyond useGlobalShortcut (mocked
// wholesale below, same as AskBar.test.jsx), so this harness only needs
// useState/useRef — no effect-cleanup machinery required.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  states: [],
  refs: [],
  reset() {
    this.cursor = 0;
  },
  clear() {
    this.cursor = 0;
    this.states = [];
    this.refs = [];
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useState(initial) {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initial === "function" ? initial() : initial;
      }
      const setValue = (next) => {
        hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
      };
      return [hooks.states[index], setValue];
    },
    useRef(initial) {
      const index = hooks.cursor++;
      if (!(index in hooks.refs)) hooks.refs[index] = { current: initial };
      return hooks.refs[index];
    },
  };
});

const shortcut = vi.hoisted(() => ({ key: null, trigger: null }));
vi.mock("../lib/useGlobalShortcut.js", () => ({
  useGlobalShortcut: (key, onTrigger) => {
    shortcut.key = key;
    shortcut.trigger = onTrigger;
  },
}));

vi.mock("../components/icons.jsx", () => ({
  ArrowUpIcon: () => null,
  UploadIcon: () => null,
}));

import { OnboardingBar } from "./OnboardingBar.jsx";

// ---------------------------------------------------------------------------
// Render + tree-walking helpers (same shape as AskBar.test.jsx's)
// ---------------------------------------------------------------------------

function expand(node) {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
}

function visit(node, predicate, found = []) {
  if (node == null || typeof node === "boolean") return found;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, predicate, found);
    return found;
  }
  if (typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  visit(node.props?.children, predicate, found);
  return found;
}

function hasClass(node, cls) {
  const className = node.props?.className;
  return typeof className === "string" && className.split(" ").includes(cls);
}

function byClass(tree, cls) {
  return visit(tree, (n) => hasClass(n, cls))[0];
}

function byTag(tree, tag) {
  return visit(tree, (n) => n.type === tag)[0];
}

function render(props) {
  hooks.reset();
  return expand(OnboardingBar(props));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  hooks.clear();
  vi.clearAllMocks();
  shortcut.key = null;
  shortcut.trigger = null;
});

// ---------------------------------------------------------------------------
// mode / résumé affordance
// ---------------------------------------------------------------------------

describe("OnboardingBar — mode", () => {
  it("centered mode carries the ask-bar--centered modifier class", () => {
    const tree = render({ mode: "centered" });
    expect(byClass(tree, "ask-bar--centered")).toBeTruthy();
  });

  it("docked mode does not carry the centered modifier", () => {
    const tree = render({ mode: "docked" });
    expect(byClass(tree, "ask-bar--centered")).toBeUndefined();
  });

  it("keeps the hero chip as the centered upload affordance and adds recovery in docked mode", () => {
    const centered = render({ mode: "centered", onDropResume: vi.fn() });
    expect(byClass(centered, "onboarding-bar__attach")).toBeUndefined();

    const docked = render({ mode: "docked", onDropResume: vi.fn() });
    expect(byClass(docked, "onboarding-bar__attach")).toBeTruthy();
  });

  it("wires the hidden file input in both modes when résumé handling is available", () => {
    const centered = render({ mode: "centered", onDropResume: vi.fn() });
    expect(byClass(centered, "onboarding-bar__file-input")).toBeTruthy();

    const docked = render({ mode: "docked", onDropResume: vi.fn() });
    expect(byClass(docked, "onboarding-bar__file-input")).toBeTruthy();

    const noHandler = render({ mode: "centered" });
    expect(byClass(noHandler, "onboarding-bar__file-input")).toBeUndefined();
  });

  it("never registers a global shortcut — ⌘K belongs to the app-shell bar only", () => {
    render({ mode: "centered" });
    expect(shortcut.key).toBe(null);
    render({ mode: "docked" });
    expect(shortcut.key).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// send / commit
// ---------------------------------------------------------------------------

describe("OnboardingBar — sending", () => {
  it("Enter commits the trimmed text via onSend and clears the input", () => {
    const onSend = vi.fn();
    let tree = render({ onSend });
    let input = byTag(tree, "input");
    input.props.onChange({ target: { value: "  hello there  " } });
    tree = render({ onSend });
    input = byTag(tree, "input");
    // Re-render carries forward the internal state set above.
    input.props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault: vi.fn() });
    expect(onSend).toHaveBeenCalledWith("hello there");

    tree = render({ onSend });
    input = byTag(tree, "input");
    expect(input.props.value).toBe("");
  });

  it("Shift+Enter does not commit (lets a newline through)", () => {
    const onSend = vi.fn();
    let tree = render({ onSend });
    let input = byTag(tree, "input");
    input.props.onChange({ target: { value: "line one" } });
    tree = render({ onSend });
    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", shiftKey: true, preventDefault: vi.fn() });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("the send button commits on click and is disabled while empty", () => {
    const onSend = vi.fn();
    let tree = render({ onSend });
    let button = visit(tree, (n) => n.type === "button" && n.props["aria-label"] === "Send")[0];
    expect(button.props.disabled).toBe(true);

    const input = byTag(tree, "input");
    input.props.onChange({ target: { value: "hi" } });
    tree = render({ onSend });
    button = visit(tree, (n) => n.type === "button" && n.props["aria-label"] === "Send")[0];
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    expect(onSend).toHaveBeenCalledWith("hi");
  });

  it("commit is a no-op (never calls onSend) when busy or disabled", () => {
    const onSend = vi.fn();
    let tree = render({ onSend, busy: true });
    let input = byTag(tree, "input");
    input.props.onChange({ target: { value: "hi" } });
    tree = render({ onSend, busy: true });
    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    expect(onSend).not.toHaveBeenCalled();

    hooks.clear();
    tree = render({ onSend, disabled: true });
    input = byTag(tree, "input");
    input.props.onChange({ target: { value: "hi" } });
    tree = render({ onSend, disabled: true });
    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("controlled value/onChange overrides internal state when provided", () => {
    const onChange = vi.fn();
    const tree = render({ value: "controlled text", onChange });
    const input = byTag(tree, "input");
    expect(input.props.value).toBe("controlled text");
    input.props.onChange({ target: { value: "next" } });
    expect(onChange).toHaveBeenCalledWith("next");
  });

  it("never renders the ⌘K hint, empty input or not", () => {
    let tree = render({});
    expect(byClass(tree, "ask-bar__kbd")).toBeUndefined();

    const input = byTag(tree, "input");
    input.props.onChange({ target: { value: "s" } });
    tree = render({});
    expect(byClass(tree, "ask-bar__kbd")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// résumé drop affordance
// ---------------------------------------------------------------------------

describe("OnboardingBar — résumé drop", () => {
  it("clicking the resume row's affordance triggers the hidden file input", () => {
    const onDropResume = vi.fn();
    const tree = render({ mode: "centered", onDropResume });
    // The hidden <input type="file"> ref is wired via useRef — simulate the
    // click affordance by directly invoking onDropResume through the
    // captured file input's onChange (the actual DOM click->change chain
    // isn't meaningfully testable without jsdom; this harness verifies the
    // wiring instead).
    const fileInput = visit(tree, (n) => n.type === "input" && n.props.type === "file")[0];
    expect(fileInput).toBeTruthy();
    fileInput.props.onChange({ target: { files: [{ name: "resume.pdf" }] } });
    expect(onDropResume).toHaveBeenCalledWith({ name: "resume.pdf" });
  });

  it("drag-over/leave toggle the drag-over class, and drop calls onDropResume with the first file", () => {
    const onDropResume = vi.fn();
    let tree = render({ mode: "centered", onDropResume });
    let shell = byClass(tree, "ask-bar__shell");
    expect(hasClass(shell, "ask-bar__shell--drag-over")).toBe(false);

    shell.props.onDragOver({ preventDefault: vi.fn() });
    tree = render({ mode: "centered", onDropResume });
    shell = byClass(tree, "ask-bar__shell");
    expect(hasClass(shell, "ask-bar__shell--drag-over")).toBe(true);

    const file = { name: "resume.docx" };
    shell.props.onDrop({ preventDefault: vi.fn(), dataTransfer: { files: [file] } });
    expect(onDropResume).toHaveBeenCalledWith(file);

    tree = render({ mode: "centered", onDropResume });
    shell = byClass(tree, "ask-bar__shell");
    expect(hasClass(shell, "ask-bar__shell--drag-over")).toBe(false);

    shell.props.onDragOver({ preventDefault: vi.fn() });
    tree = render({ mode: "centered", onDropResume });
    shell = byClass(tree, "ask-bar__shell");
    shell.props.onDragLeave();
    tree = render({ mode: "centered", onDropResume });
    shell = byClass(tree, "ask-bar__shell");
    expect(hasClass(shell, "ask-bar__shell--drag-over")).toBe(false);
  });

  it("a drop with no files is a safe no-op", () => {
    const onDropResume = vi.fn();
    const tree = render({ mode: "centered", onDropResume });
    const shell = byClass(tree, "ask-bar__shell");
    expect(() =>
      shell.props.onDrop({ preventDefault: vi.fn(), dataTransfer: { files: [] } })
    ).not.toThrow();
    expect(onDropResume).not.toHaveBeenCalled();
  });

  it("docked mode keeps drag-and-drop recovery available after the first chat turn", () => {
    const tree = render({ mode: "docked", onDropResume: vi.fn() });
    const shell = byClass(tree, "ask-bar__shell");
    expect(shell.props.onDragOver).toBeTypeOf("function");
    expect(shell.props.onDragLeave).toBeTypeOf("function");
    expect(shell.props.onDrop).toBeTypeOf("function");
  });

  it("the docked attach button opens its file picker", () => {
    const providedFileInputRef = { current: { click: vi.fn() } };
    const tree = render({
      mode: "docked",
      onDropResume: vi.fn(),
      fileInputRef: providedFileInputRef,
    });
    const attach = byClass(tree, "onboarding-bar__attach");
    expect(attach.props["aria-label"]).toBe("Attach résumé");
    attach.props.onClick();
    expect(providedFileInputRef.current.click).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// no intent-preview machinery (spec: "no intent-preview states until setup
// completes" — OnboardingBar must never render ask-bar preview/option rows)
// ---------------------------------------------------------------------------

describe("OnboardingBar — no intent-preview machinery", () => {
  it("never renders an option row or a preview panel, regardless of input", () => {
    let tree = render({});
    expect(visit(tree, (n) => n.props?.role === "option")).toHaveLength(0);

    const input = byTag(tree, "input");
    input.props.onChange({ target: { value: "sweep my boards" } });
    tree = render({});
    expect(visit(tree, (n) => n.props?.role === "option")).toHaveLength(0);
    expect(byClass(tree, "ask-bar__progress")).toBeUndefined();
    expect(byClass(tree, "ask-bar__answer")).toBeUndefined();
  });
});
