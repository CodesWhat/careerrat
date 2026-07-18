import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  connectManagedAi: vi.fn(),
  getAiSettings: vi.fn(),
  getOnboardState: vi.fn(),
  getUsageSummary: vi.fn(),
  saveCandidateFile: vi.fn(),
  validateAndSaveAiKey: vi.fn(),
}));

function sameDeps(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

function createHookRenderer(Component, onRuntime) {
  const slots = [];
  let hookIndex = 0;
  let output;
  let rendering = false;
  let rerenderRequested = false;

  const runtime = {
    useState(initialValue) {
      const index = hookIndex++;
      if (!(index in slots)) {
        slots[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      return [
        slots[index],
        (nextValue) => {
          slots[index] = typeof nextValue === "function" ? nextValue(slots[index]) : nextValue;
          if (rendering) rerenderRequested = true;
          else render();
        },
      ];
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      const prior = slots[index];
      if (prior && sameDeps(prior.deps, deps)) return;
      slots[index] = { deps };
      effect();
    },
    useMemo(factory, deps) {
      const index = hookIndex++;
      const prior = slots[index];
      if (!prior || !sameDeps(prior.deps, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
  };
  onRuntime(runtime);

  function render() {
    rendering = true;
    do {
      rerenderRequested = false;
      hookIndex = 0;
      output = Component();
    } while (rerenderRequested);
    rendering = false;
  }

  render();
  return {
    get output() {
      return output;
    },
  };
}

function renderedText(value) {
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  return renderedText(value.props?.children);
}

function findElement(root, predicate) {
  const seen = new Set();
  let match;
  function visit(value) {
    if (match || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value.props && predicate(value)) {
      match = value;
      return;
    }
    if (value.props) {
      for (const propValue of Object.values(value.props)) visit(propValue);
    }
  }
  visit(root);
  return match;
}

async function mountSettings({ getToken }) {
  vi.resetModules();
  let runtime;
  vi.doMock("react", () => ({
    useEffect: (...args) => runtime.useEffect(...args),
    useMemo: (...args) => runtime.useMemo(...args),
    useState: (...args) => runtime.useState(...args),
  }));
  vi.doMock("../auth/clerkControls.jsx", () => ({
    useRolesterUser: () => ({ getToken }),
  }));
  vi.doMock("../lib/api.js", () => ({
    ApiError: class ApiError extends Error {},
    ...api,
  }));

  const { SettingsPage } = await import("./SettingsPage.jsx");
  return createHookRenderer(SettingsPage, (value) => {
    runtime = value;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getOnboardState.mockResolvedValue({ data: {} });
  api.getAiSettings.mockResolvedValue({ route: "none", keyPresent: false });
  api.getUsageSummary.mockResolvedValue({ summary: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("react");
  vi.doUnmock("../auth/clerkControls.jsx");
  vi.doUnmock("../lib/api.js");
});

describe("SettingsPage managed AI reconnect", () => {
  it("gets a Clerk token, reconnects managed AI, and surfaces success", async () => {
    vi.useFakeTimers();
    const getToken = vi.fn(async () => "obviously-fake-jwt");
    api.connectManagedAi.mockResolvedValue({ ok: true, route: "proxy" });
    api.getAiSettings
      .mockResolvedValueOnce({ route: "none", keyPresent: false })
      .mockResolvedValueOnce({ route: "proxy", keyPresent: false });
    const renderer = await mountSettings({ getToken });
    await vi.waitFor(() =>
      expect(
        findElement(renderer.output, (element) =>
          renderedText(element).includes("Reconnect managed AI")
        )
      ).toBeTruthy()
    );

    const button = findElement(
      renderer.output,
      (element) => renderedText(element) === "Reconnect managed AI" && element.props.onClick
    );
    await button.props.onClick();

    expect(getToken).toHaveBeenCalledOnce();
    expect(api.connectManagedAi).toHaveBeenCalledWith("obviously-fake-jwt");
    expect(api.getAiSettings).toHaveBeenCalledTimes(2);
    expect(
      findElement(renderer.output, (element) => element.props.message === "Managed AI connected.")
    ).toBeTruthy();
  });

  it("surfaces a reconnect failure", async () => {
    const getToken = vi.fn(async () => "obviously-fake-jwt");
    api.connectManagedAi.mockResolvedValue({ ok: false });
    const renderer = await mountSettings({ getToken });
    await vi.waitFor(() =>
      expect(
        findElement(renderer.output, (element) => renderedText(element) === "Reconnect managed AI")
      ).toBeTruthy()
    );

    const button = findElement(
      renderer.output,
      (element) => renderedText(element) === "Reconnect managed AI" && element.props.onClick
    );
    await button.props.onClick();

    expect(getToken).toHaveBeenCalledOnce();
    expect(api.connectManagedAi).toHaveBeenCalledWith("obviously-fake-jwt");
    expect(
      findElement(
        renderer.output,
        (element) => element.props.message === "Could not connect managed AI."
      )
    ).toBeTruthy();
  });
});
