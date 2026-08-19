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
});
