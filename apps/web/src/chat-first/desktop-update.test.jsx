import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

async function loadDesktopUpdate() {
  return import("./desktop-update.js").catch(() => ({}));
}

describe("desktop update bridge", () => {
  it("is unavailable in the browser app", async () => {
    vi.resetModules();
    delete globalThis.careerratDesktopUpdate;
    const module = await loadDesktopUpdate();
    expect(typeof module.useDesktopUpdate).toBe("function");

    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    expect(captured.available).toBe(false);
    expect(captured.notice.visible).toBe(false);
  });

  it("subscribes before reading state and exposes notice, preference, and force-check actions", async () => {
    vi.resetModules();
    const calls = [];
    let push;
    let resolveInitial;
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          })
      ),
      onUpdate: vi.fn((callback) => {
        calls.push("subscribe");
        push = callback;
        return () => {};
      }),
      setEnabled: vi.fn().mockResolvedValue({ enabled: false }),
      checkNow: vi.fn().mockResolvedValue({
        notify: false,
        enabled: false,
        version: "0.14.0",
        manualResult: "current",
      }),
      skipVersion: vi.fn().mockResolvedValue({ notify: false, enabled: false }),
      openRelease: vi.fn().mockResolvedValue(undefined),
    };
    const module = await loadDesktopUpdate();
    expect(typeof module.useDesktopUpdate).toBe("function");
    expect(calls).toEqual(["subscribe"]);

    push({
      notify: true,
      enabled: true,
      version: "0.14.1",
      manualResult: null,
    });
    resolveInitial({ notify: false, enabled: true, version: null });
    await Promise.resolve();
    await Promise.resolve();

    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    expect(captured.available).toBe(true);
    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "available",
      version: "0.14.1",
    });

    await captured.setEnabled(false);
    expect(globalThis.careerratDesktopUpdate.setEnabled).toHaveBeenCalledWith(false);
    await captured.checkNow();
    expect(globalThis.careerratDesktopUpdate.checkNow).toHaveBeenCalledOnce();

    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(false);
    expect(captured.status).toBe("CareerRat is up to date.");

    delete globalThis.careerratDesktopUpdate;
  });

  it("shows a manually checked skipped version and reports a missing release link", async () => {
    vi.resetModules();
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn((callback) => {
        callback({
          notify: false,
          enabled: false,
          version: "0.14.1",
          releaseUrl: null,
          manualResult: "available",
        });
        return () => {};
      }),
      setEnabled: vi.fn(),
      checkNow: vi.fn(),
      skipVersion: vi.fn(),
      openRelease: vi.fn(),
    };
    const module = await loadDesktopUpdate();
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "available",
      version: "0.14.1",
      canOpenRelease: false,
    });
    expect(captured.status).toContain("release link is unavailable");

    delete globalThis.careerratDesktopUpdate;
  });

  it("applies the authoritative toggle response and accepts later check updates", async () => {
    vi.resetModules();
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn((callback) => {
        callback({ enabled: true });
        return () => {};
      }),
      setEnabled: vi.fn().mockResolvedValue({
        enabled: true,
        error: "Update checks are required by this installation.",
      }),
      checkNow: vi.fn().mockResolvedValue({ enabled: false, manualResult: "current" }),
      skipVersion: vi.fn(),
      openRelease: vi.fn(),
    };
    const module = await loadDesktopUpdate();
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    await captured.setEnabled(false);
    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(true);
    expect(captured.status).toBe("Update checks are required by this installation.");

    await captured.checkNow();
    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(false);

    delete globalThis.careerratDesktopUpdate;
  });
});
