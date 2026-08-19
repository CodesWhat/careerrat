import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

describe("DesktopUpdateSettings: browser dev surface (no bridge)", () => {
  it("renders nothing when globalThis.careerratDesktopUpdate does not exist", async () => {
    vi.resetModules();
    delete globalThis.careerratDesktopUpdate;
    const { DesktopUpdateSettings } = await import("./DesktopUpdateSettings.jsx");

    const markup = renderToStaticMarkup(<DesktopUpdateSettings />);
    expect(markup).toBe("");
  });

  it("setEnabled is a safe no-op when a consumer calls the hook directly with no bridge", async () => {
    // useDesktopUpdateSetting is exported on its own, so a consumer can call
    // it without the `available` guard DesktopUpdateSettings itself applies.
    vi.resetModules();
    delete globalThis.careerratDesktopUpdate;
    const { useDesktopUpdateSetting } = await import("./DesktopUpdateSettings.jsx");

    let captured;
    function Consumer() {
      captured = useDesktopUpdateSetting();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    expect(captured.available).toBe(false);
    expect(captured.saving).toBe(false);
    expect(() => captured.setEnabled(false)).not.toThrow();
  });
});

describe("DesktopUpdateSettings: desktop bridge present", () => {
  it("renders the toggle, defaulting to enabled before the bridge answers", async () => {
    vi.resetModules();
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn(() => new Promise(() => {})), // never resolves in this test
      setEnabled: vi.fn().mockResolvedValue(undefined),
    };

    const { DesktopUpdateSettings } = await import("./DesktopUpdateSettings.jsx");
    const markup = renderToStaticMarkup(<DesktopUpdateSettings />);

    expect(markup).toContain("Desktop app");
    expect(markup).toContain("Check for updates");
    expect(markup).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);

    delete globalThis.careerratDesktopUpdate;
  });

  it("setEnabled proxies through the bridge, not a second persistence path", async () => {
    vi.resetModules();
    const setEnabled = vi.fn().mockResolvedValue(undefined);
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn(() => new Promise(() => {})),
      setEnabled,
    };

    const { useDesktopUpdateSetting } = await import("./DesktopUpdateSettings.jsx");

    let captured;
    function Consumer() {
      captured = useDesktopUpdateSetting();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    expect(captured.available).toBe(true);
    expect(captured.enabled).toBe(true);

    captured.setEnabled(false);
    expect(setEnabled).toHaveBeenCalledWith(false);

    delete globalThis.careerratDesktopUpdate;
  });

  it("does not let a stale initial getState response override a toggle the user already flipped", async () => {
    // Ordering 1: the user interacts before the initial load answers.
    vi.resetModules();
    let resolveGetState;
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveGetState = resolve;
          })
      ),
      setEnabled: vi.fn().mockResolvedValue(undefined),
    };

    const { useDesktopUpdateSetting } = await import("./DesktopUpdateSettings.jsx");

    let captured;
    function Consumer() {
      captured = useDesktopUpdateSetting();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    captured.setEnabled(false);

    resolveGetState({ enabled: true }); // stale "on" payload resolves late
    await Promise.resolve();
    await Promise.resolve();

    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(false);

    delete globalThis.careerratDesktopUpdate;
  });

  it("applies the initial getState response when it resolves before any interaction", async () => {
    // Ordering 2: the initial load answers before the user ever touches the toggle.
    vi.resetModules();
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue({ enabled: false }),
      setEnabled: vi.fn().mockResolvedValue(undefined),
    };

    const { useDesktopUpdateSetting } = await import("./DesktopUpdateSettings.jsx");
    await Promise.resolve();
    await Promise.resolve();

    let captured;
    function Consumer() {
      captured = useDesktopUpdateSetting();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    expect(captured.enabled).toBe(false);

    delete globalThis.careerratDesktopUpdate;
  });

  it("rolls back the toggle and shows an error when the bridge rejects", async () => {
    vi.resetModules();
    const setEnabled = vi.fn().mockRejectedValue(new Error("ipc down"));
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn(() => new Promise(() => {})), // never resolves, stays on the default
      setEnabled,
    };

    const { DesktopUpdateSettings, useDesktopUpdateSetting } = await import(
      "./DesktopUpdateSettings.jsx"
    );

    let captured;
    function Consumer() {
      captured = useDesktopUpdateSetting();
      return null;
    }
    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(true);

    captured.setEnabled(false);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(true); // rolled back, not stuck on the rejected value
    expect(captured.error).toBeTruthy();

    const markup = renderToStaticMarkup(<DesktopUpdateSettings />);
    expect(markup).toContain(captured.error);

    delete globalThis.careerratDesktopUpdate;
  });
});
