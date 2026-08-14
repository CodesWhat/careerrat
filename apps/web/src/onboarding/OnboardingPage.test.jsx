// apps/web/src/onboarding/OnboardingPage.test.jsx
// vitest coverage for OnboardingPage's own state machine — the
// loading/gate/picker/interview phase gate (unchanged) plus the
// forceEngineScreen flag that wires InterviewSurface's ENGINE chip
// (after its own confirm dialog — see InterviewSurface.test.jsx's
// "engine re-entry chip" coverage) to a "revisit" EngineScreen visit that
// doesn't touch the underlying phase. Same hand-rolled hook harness
// convention as EngineScreen.test.jsx (default "node" vitest environment,
// no jsdom, useState/useEffect only — this component has no useCallback/
// useRef of its own).

import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  effects: [],
  state: [],
  reset() {
    this.cursor = 0;
    this.effects = [];
  },
  clear() {
    this.cursor = 0;
    this.effects = [];
    this.state = [];
  },
  useState(initial) {
    const index = this.cursor++;
    if (!(index in this.state))
      this.state[index] = typeof initial === "function" ? initial() : initial;
    return [
      this.state[index],
      (next) => {
        this.state[index] = typeof next === "function" ? next(this.state[index]) : next;
      },
    ];
  },
  useEffect(effect) {
    this.effects.push(effect);
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useEffect: (effect) => hooks.useEffect(effect),
    useState: (initial) => hooks.useState(initial),
  };
});

const api = vi.hoisted(() => ({
  initOnboard: vi.fn(),
  getInstalledAiRuntimes: vi.fn(),
}));
vi.mock("../lib/api.js", () => api);

const captured = vi.hoisted(() => ({ engineScreen: null, interviewSurface: null }));
vi.mock("./EngineScreen.jsx", () => ({
  EngineScreen: (props) => {
    captured.engineScreen = props;
    return "engine-screen";
  },
}));
vi.mock("./InterviewSurface.jsx", () => ({
  InterviewSurface: (props) => {
    captured.interviewSurface = props;
    return "interview-surface";
  },
}));

import { OnboardingPage } from "./OnboardingPage.jsx";

function render() {
  hooks.reset();
  return expand(OnboardingPage());
}

// The mocked EngineScreen/InterviewSurface components just return plain
// strings, but OnboardingPage's JSX still wraps them as
// { type: EngineScreen, props } elements — expand() resolves any
// function-typed node by invoking it (mirrors EngineScreen.test.jsx /
// InterviewSurface.test.jsx's own expand() helper) so tree ends up as the
// mock's return string rather than an unresolved element.
function expand(node) {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
}

async function runEffects() {
  for (const effect of hooks.effects) effect();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const CLAUDE = { id: "claude", name: "Claude Code", ready: true };
const CODEX = { id: "codex", name: "Codex", ready: true };

function runtimeState(runtimes, { selectedId = null, providerFallback = false } = {}) {
  return { selectedId, providerFallback, runtimes };
}

beforeEach(() => {
  hooks.clear();
  vi.clearAllMocks();
  api.initOnboard.mockResolvedValue({ ok: true });
  captured.engineScreen = null;
  captured.interviewSurface = null;
});

// ---------------------------------------------------------------------------
// Unchanged gate/picker/interview phase resolution
// ---------------------------------------------------------------------------

describe("OnboardingPage — engine phase gate (unchanged)", () => {
  it("initializes the canonical candidate store before probing engines", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE], { selectedId: "claude" }));

    render();
    await runEffects();

    expect(api.initOnboard).toHaveBeenCalledTimes(1);
    expect(api.initOnboard.mock.invocationCallOrder[0]).toBeLessThan(
      api.getInstalledAiRuntimes.mock.invocationCallOrder[0]
    );
  });

  it("does not enter setup when the canonical candidate store cannot initialize", async () => {
    api.initOnboard.mockRejectedValue(new Error("database unavailable"));

    render();
    await runEffects();
    const tree = render();

    expect(api.getInstalledAiRuntimes).not.toHaveBeenCalled();
    expect(JSON.stringify(tree)).toContain("couldn’t start setup");
    expect(JSON.stringify(tree)).toContain("Try again");
  });

  it("an already-selected runtime skips straight to the interview and wires onRequestEngineScreen", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE], { selectedId: "claude" }));
    render();
    await runEffects();
    const tree = render();

    expect(tree).toBe("interview-surface");
    expect(captured.interviewSurface.runtime).toEqual(CLAUDE);
    expect(typeof captured.interviewSurface.onRequestEngineScreen).toBe("function");
  });

  it("zero ready runtimes lands on the gate", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([{ ...CLAUDE, ready: false }]));
    render();
    await runEffects();
    const tree = render();

    expect(tree).toBe("engine-screen");
    expect(captured.engineScreen.mode).toBe("gate");
  });

  it("two or more ready runtimes with nothing selected lands on the picker, not an interview skip", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE, CODEX]));
    render();
    await runEffects();
    const tree = render();

    expect(tree).toBe("engine-screen");
    expect(captured.engineScreen.mode).toBe("picker");
  });
});

// ---------------------------------------------------------------------------
// Engine re-entry (forceEngineScreen) — InterviewSurface's ENGINE chip
// ---------------------------------------------------------------------------

describe("OnboardingPage — engine re-entry (forceEngineScreen)", () => {
  it("calling InterviewSurface's onRequestEngineScreen swaps it for a 'revisit' EngineScreen", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE], { selectedId: "claude" }));
    render();
    await runEffects();
    let tree = render();
    expect(tree).toBe("interview-surface");

    captured.interviewSurface.onRequestEngineScreen();
    tree = render();

    expect(tree).toBe("engine-screen");
    expect(captured.engineScreen.mode).toBe("revisit");
    expect(typeof captured.engineScreen.onBack).toBe("function");
  });

  it("EngineScreen's onBack returns to the interview with no engine write (no extra runtime refetch)", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE], { selectedId: "claude" }));
    render();
    await runEffects();
    render();
    captured.interviewSurface.onRequestEngineScreen();
    let tree = render();
    expect(tree).toBe("engine-screen");
    expect(api.getInstalledAiRuntimes).toHaveBeenCalledTimes(1); // mount load only

    captured.engineScreen.onBack();
    tree = render();

    expect(tree).toBe("interview-surface");
    expect(captured.interviewSurface.runtime).toEqual(CLAUDE);
    // A pure "keep current" back never re-hits the runtime probe.
    expect(api.getInstalledAiRuntimes).toHaveBeenCalledTimes(1);
  });

  it("EngineScreen's onReady (a different engine was picked) refreshes runtime state and returns to the interview with the new runtime", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE, CODEX], { selectedId: "claude" })
    );
    render();
    await runEffects();
    render();
    captured.interviewSurface.onRequestEngineScreen();
    let tree = render();
    expect(tree).toBe("engine-screen");

    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE, CODEX], { selectedId: "codex" })
    );
    await captured.engineScreen.onReady();
    tree = render();

    expect(tree).toBe("interview-surface");
    expect(captured.interviewSurface.runtime).toEqual(CODEX);
    expect(api.getInstalledAiRuntimes).toHaveBeenCalledTimes(2);
  });
});
