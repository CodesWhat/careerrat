import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => ({
  cursor: 0,
  states: [],
  effectDeps: [],
  pendingEffects: [],
  reset() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  clear() {
    this.cursor = 0;
    this.states = [];
    this.effectDeps = [];
    this.pendingEffects = [];
  },
}));

const apiMocks = vi.hoisted(() => ({
  generateSearchPrompts: vi.fn(),
  getRuntimeConfig: vi.fn(),
  getSearchPrompts: vi.fn(),
  saveSearchPrompts: vi.fn(),
}));

const captured = vi.hoisted(() => ({ buttons: [], textAreas: [] }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useState(initialValue) {
      const index = hookHarness.cursor++;
      if (!(index in hookHarness.states)) {
        hookHarness.states[index] =
          typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setValue = (nextValue) => {
        hookHarness.states[index] =
          typeof nextValue === "function" ? nextValue(hookHarness.states[index]) : nextValue;
      };
      return [hookHarness.states[index], setValue];
    },
    useEffect(effect, dependencies) {
      const index = hookHarness.cursor++;
      const previous = hookHarness.effectDeps[index];
      const changed =
        !previous ||
        !dependencies ||
        dependencies.length !== previous.length ||
        dependencies.some((value, dependencyIndex) => !Object.is(value, previous[dependencyIndex]));
      hookHarness.effectDeps[index] = dependencies;
      if (changed) hookHarness.pendingEffects.push(effect);
    },
  };
});

vi.mock("../lib/api.js", () => apiMocks);

vi.mock("../components/Button.jsx", () => ({
  Button: (props) => {
    captured.buttons.push(props);
    return (
      <button type="button" disabled={props.disabled} onClick={props.onClick}>
        {props.children}
      </button>
    );
  },
  IconButton: (props) => (
    <button type="button" aria-label={props.label} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}));

vi.mock("../components/form.jsx", () => ({
  TextArea: (props) => {
    captured.textAreas.push(props);
    return <textarea id={props.id} value={props.value} readOnly />;
  },
}));

import { AiSearchPrompts } from "./AiSearchPrompts.jsx";

const SAVED_PROMPTS = [
  { id: "prompt-1", text: "Find applied AI roles with customer deployment work." },
  { id: "prompt-2", text: "Find identity automation leadership roles." },
];

function childText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childText).join("");
  return node?.props ? childText(node.props.children) : "";
}

function findElements(node, predicate, matches = []) {
  if (!node || typeof node !== "object") return matches;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, matches);
    return matches;
  }
  if (predicate(node)) matches.push(node);
  findElements(node.props?.children, predicate, matches);
  return matches;
}

function renderPrompts(onPromptsState) {
  hookHarness.reset();
  captured.buttons = [];
  captured.textAreas = [];
  const tree = AiSearchPrompts({ onPromptsState });
  const html = renderToStaticMarkup(tree);
  return { tree, html };
}

async function flushEffects() {
  const effects = hookHarness.pendingEffects.splice(0);
  for (const effect of effects) effect();
  // Promise.all(...).then(...).finally(...) needs several microtask turns
  // before both rows and loading have settled in the hook harness.
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

function capturedButton(label, occurrence = 0) {
  const buttons = captured.buttons.filter((props) => childText(props.children) === label);
  expect(buttons.length).toBeGreaterThan(occurrence);
  return buttons[occurrence];
}

beforeEach(() => {
  hookHarness.clear();
  captured.buttons = [];
  captured.textAreas = [];
  vi.clearAllMocks();
  apiMocks.getSearchPrompts.mockResolvedValue({ data: { prompts: SAVED_PROMPTS } });
  apiMocks.getRuntimeConfig.mockResolvedValue({ ai: { available: true } });
  apiMocks.saveSearchPrompts.mockImplementation(async (prompts) => ({
    data: {
      prompts: prompts.map((prompt, index) => ({
        id: prompt.id || `saved-${index + 1}`,
        text: prompt.text,
      })),
    },
  }));
});

describe("AiSearchPrompts embedded prompt editor", () => {
  it("renders one two-line chip surface per saved prompt", async () => {
    const onPromptsState = vi.fn();
    renderPrompts(onPromptsState);
    await flushEffects();

    const { html } = renderPrompts(onPromptsState);
    await flushEffects();

    expect((html.match(/class="jobs__ai-prompt-chip"/g) || []).length).toBe(2);
    expect((html.match(/class="jobs__ai-prompt-chip-text"/g) || []).length).toBe(2);
    expect(html).toContain(SAVED_PROMPTS[0].text);
    expect(html).toContain(SAVED_PROMPTS[1].text);
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 2, dirty: false, loading: false });
  });

  it("opens a chip modal and keeps modal Save local until the footer Save persists", async () => {
    const onPromptsState = vi.fn();
    renderPrompts(onPromptsState);
    await flushEffects();
    let rendered = renderPrompts(onPromptsState);
    await flushEffects();

    const chips = findElements(
      rendered.tree,
      (node) => node.type === "button" && node.props.className === "jobs__ai-prompt-chip"
    );
    expect(chips).toHaveLength(2);
    chips[0].props.onClick();

    rendered = renderPrompts(onPromptsState);
    expect(rendered.html).toContain('role="dialog"');
    expect(rendered.html).toContain('class="packet-viewer-overlay"');
    expect(captured.textAreas).toHaveLength(1);
    captured.textAreas[0].onChange("Updated local prompt text");
    renderPrompts(onPromptsState);
    capturedButton("Save", 1).onClick();

    rendered = renderPrompts(onPromptsState);
    await flushEffects();
    expect(rendered.html).not.toContain('role="dialog"');
    expect(rendered.html).toContain("Updated local prompt text");
    expect(apiMocks.saveSearchPrompts).not.toHaveBeenCalled();
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 2, dirty: true, loading: false });

    capturedButton("Save", 0).onClick();
    await Promise.resolve();
    expect(apiMocks.saveSearchPrompts).toHaveBeenCalledTimes(1);
    expect(apiMocks.saveSearchPrompts).toHaveBeenCalledWith([
      { id: "prompt-1", text: "Updated local prompt text" },
      { id: "prompt-2", text: SAVED_PROMPTS[1].text },
    ]);
  });

  it("opens Add prompt as a blank local row and reports count, dirty, and loading transitions", async () => {
    const onPromptsState = vi.fn();
    renderPrompts(onPromptsState);
    await flushEffects();
    renderPrompts(onPromptsState);
    await flushEffects();

    capturedButton("Add prompt").onClick();
    let rendered = renderPrompts(onPromptsState);
    await flushEffects();

    expect(rendered.html).toContain('role="dialog"');
    expect(captured.textAreas).toHaveLength(1);
    expect(captured.textAreas[0].value).toBe("");
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 2, dirty: true, loading: false });

    captured.textAreas[0].onChange("A third prompt");
    renderPrompts(onPromptsState);
    capturedButton("Save", 1).onClick();
    rendered = renderPrompts(onPromptsState);
    await flushEffects();

    expect(rendered.html).toContain("A third prompt");
    expect(apiMocks.saveSearchPrompts).not.toHaveBeenCalled();
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 3, dirty: true, loading: false });
    expect(onPromptsState).toHaveBeenCalledWith({ count: 0, dirty: false, loading: true });
  });
});
