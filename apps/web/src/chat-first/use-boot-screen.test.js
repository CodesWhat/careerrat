import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_SCREEN_MIN_VISIBLE_MS,
  resetBootScreenClock,
  useMinimumBootScreen,
} from "./use-boot-screen.js";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  effectDeps: [],
  pendingEffects: [],
  states: [],
  resetRender() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  clear() {
    this.cursor = 0;
    this.effectDeps = [];
    this.pendingEffects = [];
    this.states = [];
  },
}));

function dependenciesChanged(previous, next) {
  return (
    !previous ||
    !next ||
    previous.length !== next.length ||
    next.some((value, index) => !Object.is(value, previous[index]))
  );
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useEffect(effect, dependencies) {
      const index = hooks.cursor++;
      if (dependenciesChanged(hooks.effectDeps[index], dependencies)) {
        hooks.effectDeps[index] = dependencies;
        hooks.pendingEffects.push(effect);
      }
    },
    useState(initialValue) {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setValue = (nextValue) => {
        hooks.states[index] =
          typeof nextValue === "function" ? nextValue(hooks.states[index]) : nextValue;
      };
      return [hooks.states[index], setValue];
    },
  };
});

function BootScreenHook({ active }) {
  hooks.resetRender();
  return useMinimumBootScreen(active);
}

function BootScreenInstances({ activeA, activeB }) {
  hooks.resetRender();
  return {
    a: useMinimumBootScreen(activeA),
    b: useMinimumBootScreen(activeB),
  };
}

function flushEffects() {
  const effects = hooks.pendingEffects.splice(0);
  for (const effect of effects) effect();
}

beforeEach(() => {
  resetBootScreenClock();
  hooks.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMinimumBootScreen", () => {
  it("returns true immediately when active re-enters after the hold has elapsed", async () => {
    expect(BootScreenHook({ active: true })).toBe(true);
    flushEffects();

    expect(BootScreenHook({ active: false })).toBe(true);
    flushEffects();
    await vi.advanceTimersByTimeAsync(BOOT_SCREEN_MIN_VISIBLE_MS);
    expect(BootScreenHook({ active: false })).toBe(false);

    expect(BootScreenHook({ active: true })).toBe(true);
  });

  it("shares the first instance clock with a later instance's remaining hold", async () => {
    expect(BootScreenHook({ active: true })).toBe(true);
    flushEffects();
    await vi.advanceTimersByTimeAsync(100);

    expect(BootScreenInstances({ activeA: false, activeB: true }).b).toBe(true);
    flushEffects();
    await vi.advanceTimersByTimeAsync(50);

    expect(BootScreenInstances({ activeA: false, activeB: false }).b).toBe(true);
    flushEffects();
    await vi.advanceTimersByTimeAsync(249);
    expect(BootScreenInstances({ activeA: false, activeB: false }).b).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(BootScreenInstances({ activeA: false, activeB: false }).b).toBe(false);
  });

  it("adds no hold when a later instance hands off after the shared minimum elapsed", async () => {
    expect(BootScreenHook({ active: true })).toBe(true);
    flushEffects();
    await vi.advanceTimersByTimeAsync(600);

    expect(BootScreenInstances({ activeA: false, activeB: true }).b).toBe(true);
    flushEffects();
    await vi.advanceTimersByTimeAsync(0);

    expect(BootScreenInstances({ activeA: false, activeB: false }).b).toBe(true);
    flushEffects();
    await vi.advanceTimersByTimeAsync(0);
    expect(BootScreenInstances({ activeA: false, activeB: false }).b).toBe(false);
  });
});
