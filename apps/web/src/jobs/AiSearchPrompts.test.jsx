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

const captured = vi.hoisted(() => ({ buttons: [], iconButtons: [], textAreas: [] }));

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
  IconButton: (props) => {
    captured.iconButtons.push(props);
    return (
      <button type="button" aria-label={props.label} onClick={props.onClick}>
        {props.children}
      </button>
    );
  },
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
  captured.iconButtons = [];
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

function capturedIconButton(label) {
  const button = captured.iconButtons.find((props) => props.label === label);
  expect(button).toBeDefined();
  return button;
}

async function loadPrompts(onPromptsState) {
  renderPrompts(onPromptsState);
  await flushEffects();
  const rendered = renderPrompts(onPromptsState);
  await flushEffects();
  return rendered;
}

function modalTree(rendered) {
  const modal = findElements(
    rendered.tree,
    (node) => typeof node.type === "function" && node.type.name === "AiSearchPromptsModal"
  )[0];
  expect(modal).toBeDefined();
  return modal.type(modal.props);
}

beforeEach(() => {
  hookHarness.clear();
  captured.buttons = [];
  captured.iconButtons = [];
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

describe("AiSearchPrompts manager", () => {
  it("labels the only card control for zero, loaded, and dirty prompt states", async () => {
    apiMocks.getSearchPrompts.mockResolvedValueOnce({ data: { prompts: [] } });
    const onPromptsState = vi.fn();
    let rendered = await loadPrompts(onPromptsState);

    expect(rendered.html).toContain(">AI prompts</button>");
    expect(rendered.html).not.toContain("AI prompts (0)");
    expect(captured.buttons).toHaveLength(1);
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 0, dirty: false, loading: false });

    hookHarness.clear();
    vi.clearAllMocks();
    apiMocks.getSearchPrompts.mockResolvedValue({ data: { prompts: SAVED_PROMPTS } });
    apiMocks.getRuntimeConfig.mockResolvedValue({ ai: { available: true } });
    rendered = await loadPrompts(onPromptsState);

    expect(rendered.html).toContain(">AI prompts (2)</button>");
    expect(captured.buttons).toHaveLength(1);
    capturedButton("AI prompts (2)").onClick();
    renderPrompts(onPromptsState);
    captured.textAreas[0].onChange("Edited first prompt");
    rendered = renderPrompts(onPromptsState);
    await flushEffects();

    expect(rendered.html).toContain(">AI prompts (2) •</button>");
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 2, dirty: true, loading: false });
  });

  it("opens the overlay with one textarea per prompt and preserves unsaved edits across close", async () => {
    const onPromptsState = vi.fn();
    let rendered = await loadPrompts(onPromptsState);

    capturedButton("AI prompts (2)").onClick();
    rendered = renderPrompts(onPromptsState);

    expect(rendered.html).toContain('class="packet-viewer-overlay"');
    expect(rendered.html).toContain('role="dialog"');
    expect(rendered.html).toContain('class="packet-viewer__title">AI search prompts</strong>');
    expect(rendered.html).toContain(">Regenerate</button>");
    expect(rendered.html).toContain('aria-label="Close"');
    expect(rendered.html).toContain(">Add prompt</button>");
    expect(rendered.html).toContain(">Save</button>");
    expect(captured.textAreas).toHaveLength(2);
    expect(captured.textAreas.map((row) => row.value)).toEqual(
      SAVED_PROMPTS.map((prompt) => prompt.text)
    );

    captured.textAreas[0].onChange("Unsaved prompt edit");
    rendered = renderPrompts(onPromptsState);
    await flushEffects();
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 2, dirty: true, loading: false });

    capturedIconButton("Close").onClick();
    rendered = renderPrompts(onPromptsState);
    expect(rendered.html).not.toContain('role="dialog"');
    expect(rendered.html).toContain(">AI prompts (2) •</button>");
    expect(apiMocks.saveSearchPrompts).not.toHaveBeenCalled();

    capturedButton("AI prompts (2) •").onClick();
    rendered = renderPrompts(onPromptsState);
    expect(captured.textAreas).toHaveLength(2);
    expect(captured.textAreas[0].value).toBe("Unsaved prompt edit");
    expect(apiMocks.saveSearchPrompts).not.toHaveBeenCalled();
  });

  it("adds blank rows, removes individual rows, and reports nonblank count transitions", async () => {
    const onPromptsState = vi.fn();
    let rendered = await loadPrompts(onPromptsState);

    capturedButton("AI prompts (2)").onClick();
    rendered = renderPrompts(onPromptsState);
    const removeButtons = findElements(
      modalTree(rendered),
      (node) => node.type === "button" && node.props["aria-label"] === "Remove prompt"
    );
    expect(removeButtons).toHaveLength(2);
    removeButtons[0].props.onClick();

    rendered = renderPrompts(onPromptsState);
    await flushEffects();
    expect(captured.textAreas).toHaveLength(1);
    expect(captured.textAreas[0].value).toBe(SAVED_PROMPTS[1].text);
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 1, dirty: true, loading: false });

    capturedButton("Add prompt").onClick();
    rendered = renderPrompts(onPromptsState);
    await flushEffects();
    expect(captured.textAreas).toHaveLength(2);
    expect(captured.textAreas[1].value).toBe("");
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 1, dirty: true, loading: false });

    captured.textAreas[1].onChange("New nonblank prompt");
    rendered = renderPrompts(onPromptsState);
    await flushEffects();
    expect(rendered.html).toContain(">AI prompts (2) •</button>");
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 2, dirty: true, loading: false });
  });

  it("persists all nonblank rows from the modal footer Save and clears dirty state", async () => {
    let resolveSave;
    apiMocks.saveSearchPrompts.mockImplementationOnce(
      (prompts) =>
        new Promise((resolve) => {
          resolveSave = () => resolve({ data: { prompts } });
        })
    );
    const onPromptsState = vi.fn();
    let rendered = await loadPrompts(onPromptsState);

    expect(onPromptsState).toHaveBeenCalledWith({ count: 0, dirty: false, loading: true });
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 2, dirty: false, loading: false });

    capturedButton("AI prompts (2)").onClick();
    renderPrompts(onPromptsState);
    captured.textAreas[0].onChange("Persist this edit");
    renderPrompts(onPromptsState);
    const savePromise = capturedButton("Save").onClick();

    expect(apiMocks.saveSearchPrompts).toHaveBeenCalledTimes(1);
    expect(apiMocks.saveSearchPrompts).toHaveBeenCalledWith([
      { id: "prompt-1", text: "Persist this edit" },
      { id: "prompt-2", text: SAVED_PROMPTS[1].text },
    ]);
    rendered = renderPrompts(onPromptsState);
    expect(rendered.html).toContain(">Saving…</button>");

    resolveSave();
    await savePromise;
    rendered = renderPrompts(onPromptsState);
    await flushEffects();

    expect(rendered.html).toContain(">AI prompts (2)</button>");
    expect(rendered.html).not.toContain("AI prompts (2) •");
    expect(onPromptsState).toHaveBeenLastCalledWith({ count: 2, dirty: false, loading: false });
  });
});
