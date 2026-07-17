import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  cancelDesktopSignIn: vi.fn(),
  claimDesktopSignIn: vi.fn(),
  getDesktopSignInStatus: vi.fn(),
  startDesktopSignIn: vi.fn(),
}));

const reactRuntime = vi.hoisted(() => {
  let current = null;
  return {
    activate(runtime) {
      current = runtime;
    },
    useCallback(callback) {
      current.nextHook();
      return callback;
    },
    useEffect(effect) {
      return current.useEffect(effect);
    },
    useRef(initialValue) {
      return current.useRef(initialValue);
    },
    useState(initialValue) {
      return current.useState(initialValue);
    },
  };
});

vi.mock("react", () => ({
  useCallback: reactRuntime.useCallback,
  useEffect: reactRuntime.useEffect,
  useRef: reactRuntime.useRef,
  useState: reactRuntime.useState,
}));

vi.mock("../lib/api.js", () => api);

import { useDesktopGoogleSignIn } from "./useDesktopGoogleSignIn.js";

function renderHook() {
  const slots = [];
  const cleanups = [];
  let hookIndex = 0;
  let mounted = true;
  let result;

  const runtime = {
    nextHook() {
      hookIndex += 1;
    },
    useEffect(effect) {
      const index = hookIndex;
      hookIndex += 1;
      if (!(index in slots)) {
        slots[index] = true;
        cleanups[index] = effect();
      }
    },
    useRef(initialValue) {
      const index = hookIndex;
      hookIndex += 1;
      if (!(index in slots)) slots[index] = { current: initialValue };
      return slots[index];
    },
    useState(initialValue) {
      const index = hookIndex;
      hookIndex += 1;
      if (!(index in slots)) {
        slots[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setValue = (nextValue) => {
        slots[index] = typeof nextValue === "function" ? nextValue(slots[index]) : nextValue;
        if (mounted) render();
      };
      return [slots[index], setValue];
    },
  };

  function render() {
    hookIndex = 0;
    reactRuntime.activate(runtime);
    // biome-ignore lint/correctness/useHookAtTopLevel: this function is the test's custom hook renderer
    result = useDesktopGoogleSignIn();
    reactRuntime.activate(null);
  }

  render();
  return {
    get current() {
      return result;
    },
    unmount() {
      mounted = false;
      for (const cleanup of cleanups) cleanup?.();
    },
  };
}

describe("useDesktopGoogleSignIn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.cancelDesktopSignIn.mockResolvedValue({ ok: true });
    globalThis.window = {
      location: {
        origin: "http://localhost:7777",
        replace: vi.fn(),
      },
      open: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.window;
  });

  it("starts a sign-in, opens the system-browser URL, and waits", async () => {
    api.startDesktopSignIn.mockResolvedValue({
      ok: true,
      nonce: "nonce-1",
      signInUrl: "http://localhost:7777/app/desktop-sign-in?nonce=nonce-1",
    });
    const hook = renderHook();

    await hook.current.start();

    expect(window.open).toHaveBeenCalledWith(
      "http://localhost:7777/app/desktop-sign-in?nonce=nonce-1",
      "_blank",
      "noopener,noreferrer"
    );
    expect(hook.current.phase).toBe("waiting");
    expect(hook.current.isWaiting).toBe(true);
    expect(api.getDesktopSignInStatus).not.toHaveBeenCalled();
  });

  it("polls pending to fulfilled, claims once, and adopts the encoded jwt", async () => {
    api.startDesktopSignIn.mockResolvedValue({
      ok: true,
      nonce: "nonce-2",
      signInUrl: "http://localhost:7777/app/desktop-sign-in?nonce=nonce-2",
    });
    api.getDesktopSignInStatus
      .mockResolvedValueOnce({ ok: true, status: "pending" })
      .mockResolvedValueOnce({ ok: true, status: "fulfilled" });
    api.claimDesktopSignIn.mockResolvedValue({ ok: true, jwt: "header payload?/signature" });
    const hook = renderHook();

    await hook.current.start();
    await vi.advanceTimersByTimeAsync(3000);

    expect(api.getDesktopSignInStatus).toHaveBeenCalledTimes(2);
    expect(api.getDesktopSignInStatus).toHaveBeenNthCalledWith(1, "nonce-2");
    expect(api.claimDesktopSignIn).toHaveBeenCalledOnce();
    expect(api.claimDesktopSignIn).toHaveBeenCalledWith("nonce-2");
    expect(window.location.replace).toHaveBeenCalledWith(
      "http://localhost:7777/app/onboarding?__clerk_db_jwt=header%20payload%3F%2Fsignature"
    );
    expect(hook.current.phase).toBe("adopting");
  });

  it.each([
    ["expired", "That sign-in link expired. Try again."],
    ["failed", "Sign-in was cancelled. Try again."],
  ])("turns terminal %s polling status into an error", async (status, message) => {
    api.startDesktopSignIn.mockResolvedValue({
      ok: true,
      nonce: `nonce-${status}`,
      signInUrl: `http://localhost:7777/app/desktop-sign-in?nonce=nonce-${status}`,
    });
    api.getDesktopSignInStatus.mockResolvedValue({ ok: true, status });
    const hook = renderHook();

    await hook.current.start();
    await vi.advanceTimersByTimeAsync(1500);

    expect(hook.current.phase).toBe("error");
    expect(hook.current.error).toBe(message);
    expect(api.claimDesktopSignIn).not.toHaveBeenCalled();
  });

  it("cancels best-effort, clears polling, and enters cancelled", async () => {
    api.startDesktopSignIn.mockResolvedValue({
      ok: true,
      nonce: "nonce-cancel",
      signInUrl: "http://localhost:7777/app/desktop-sign-in?nonce=nonce-cancel",
    });
    const hook = renderHook();
    await hook.current.start();

    hook.current.cancel();
    await vi.advanceTimersByTimeAsync(6000);

    expect(api.cancelDesktopSignIn).toHaveBeenCalledOnce();
    expect(api.cancelDesktopSignIn).toHaveBeenCalledWith("nonce-cancel");
    expect(api.getDesktopSignInStatus).not.toHaveBeenCalled();
    expect(hook.current.phase).toBe("cancelled");
    expect(hook.current.isWaiting).toBe(false);
  });

  it("stops polling when unmounted during waiting", async () => {
    api.startDesktopSignIn.mockResolvedValue({
      ok: true,
      nonce: "nonce-unmount",
      signInUrl: "http://localhost:7777/app/desktop-sign-in?nonce=nonce-unmount",
    });
    const hook = renderHook();
    await hook.current.start();

    hook.unmount();
    await vi.advanceTimersByTimeAsync(6000);

    expect(api.getDesktopSignInStatus).not.toHaveBeenCalled();
    expect(api.claimDesktopSignIn).not.toHaveBeenCalled();
  });
});
