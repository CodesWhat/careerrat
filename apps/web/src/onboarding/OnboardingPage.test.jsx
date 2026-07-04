import { describe, expect, it } from "vitest";
import { refreshThenAdvance } from "./OnboardingPage.jsx";

describe("refreshThenAdvance", () => {
  it("refreshes derived onboarding state before advancing to the next step", async () => {
    const calls = [];
    let updater = null;
    await refreshThenAdvance({
      load: async () => {
        calls.push("load");
      },
      setStepIndex: (fn) => {
        calls.push("advance");
        updater = fn;
      },
      stepCount: 7,
    });

    expect(calls).toEqual(["load", "advance"]);
    expect(updater(5)).toBe(6);
    expect(updater(6)).toBe(6);
  });
});
