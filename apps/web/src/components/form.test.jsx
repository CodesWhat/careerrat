import { beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => ({
  cursor: 0,
  states: [],
  reset() {
    this.cursor = 0;
  },
  clear() {
    this.cursor = 0;
    this.states = [];
  },
}));

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
  };
});

import { ChipInput, filterChipSuggestions } from "./form.jsx";

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

function renderChipInput(props) {
  hookHarness.reset();
  const tree = ChipInput(props);
  const input = findElement(tree, (node) => node.type === "input");
  expect(input).toBeDefined();
  return input.props;
}

beforeEach(() => {
  hookHarness.clear();
});

describe("filterChipSuggestions", () => {
  it("matches typed text against labels and aliases while hiding already selected values", () => {
    const suggestions = [
      { emoji: "🏠", label: "Remote unavailable", value: "Remote unavailable", aliases: ["wfh"] },
      { emoji: "🧳", label: "Heavy travel", value: "Heavy travel", aliases: ["travel"] },
      { emoji: "🛂", label: "Visa sponsorship unavailable", value: "Visa sponsorship unavailable" },
    ];

    expect(filterChipSuggestions({ draft: "wfh", values: [], suggestions })).toEqual([
      suggestions[0],
    ]);
    expect(
      filterChipSuggestions({ draft: "travel", values: ["Heavy travel"], suggestions })
    ).toEqual([]);
    expect(filterChipSuggestions({ draft: "visa", values: [], suggestions })).toEqual([
      expect.objectContaining({
        emoji: "🛂",
        label: "Visa sponsorship unavailable",
        value: "Visa sponsorship unavailable",
      }),
    ]);
  });
});

describe("ChipInput commit behavior", () => {
  it("commits the trimmed draft on comma by default", () => {
    const onChange = vi.fn();
    let input = renderChipInput({ id: "skills", values: [], onChange });
    input.onChange({ target: { value: "  Platform engineering  " } });
    input = renderChipInput({ id: "skills", values: [], onChange });
    const preventDefault = vi.fn();

    input.onKeyDown({ key: ",", preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(["Platform engineering"]);
    expect(renderChipInput({ id: "skills", values: [], onChange }).value).toBe("");
  });

  it("keeps comma in the draft when commitOnComma is false", () => {
    const onChange = vi.fn();
    const props = { id: "relocation", values: [], onChange, commitOnComma: false };
    let input = renderChipInput(props);
    input.onChange({ target: { value: "Austin" } });
    input = renderChipInput(props);
    const preventDefault = vi.fn();

    input.onKeyDown({ key: ",", preventDefault });
    input.onChange({ target: { value: "Austin," } });
    input = renderChipInput(props);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("Austin,");
  });

  it("commits the trimmed draft on blur", () => {
    const onChange = vi.fn();
    const props = { id: "cities", values: ["New York, NY"], onChange };
    let input = renderChipInput(props);
    input.onChange({ target: { value: "  Boston, MA  " } });
    input = renderChipInput(props);

    input.onBlur({ type: "blur" });

    expect(onChange).toHaveBeenCalledWith(["New York, NY", "Boston, MA"]);
    expect(renderChipInput(props).value).toBe("");
  });

  it.each(["blur", "Enter"])("does not commit a whitespace-only draft on %s", (action) => {
    const onChange = vi.fn();
    const props = { id: "empty-chip", values: [], onChange };
    let input = renderChipInput(props);
    input.onChange({ target: { value: "   " } });
    input = renderChipInput(props);

    if (action === "blur") input.onBlur({ type: "blur" });
    else input.onKeyDown({ key: "Enter", preventDefault: vi.fn() });

    expect(onChange).not.toHaveBeenCalled();
    expect(renderChipInput(props).value).toBe("");
  });

  it("falls back to the draft when blur supplies a non-string event value", () => {
    const onChange = vi.fn();
    const props = { id: "guarded-chip", values: [], onChange };
    let input = renderChipInput(props);
    input.onChange({ target: { value: "Draft value" } });
    input = renderChipInput(props);

    input.onBlur({ explicitValue: { accidental: true } });

    expect(onChange).toHaveBeenCalledWith(["Draft value"]);
    expect(onChange).not.toHaveBeenCalledWith(["[object Object]"]);
  });
});
