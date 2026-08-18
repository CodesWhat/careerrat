import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Every test dynamically imports the component AFTER setting or clearing
// `globalThis.careerratDesktopUpdate`, then resets the module cache first. The
// module reads `globalThis.careerratDesktopUpdate` once, at module-evaluation
// time (mirrors SetupReadinessCard.test.jsx's "shared dismissal" test, which
// isolates module-level store state the same way).

describe("UpdateAvailableDock: browser dev surface (no bridge)", () => {
  it("renders nothing when globalThis.careerratDesktopUpdate does not exist", async () => {
    vi.resetModules();
    delete globalThis.careerratDesktopUpdate;
    const { UpdateAvailableDock } = await import("./UpdateAvailableDock.jsx");

    const markup = renderToStaticMarkup(<UpdateAvailableDock />);
    expect(markup).toBe("");
  });
});

describe("UpdateAvailableDock: desktop bridge present", () => {
  it("renders the docked nudge row once the bridge reports an update", async () => {
    vi.resetModules();
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: (cb) => {
        // Synchronous push, same as main.mjs's pushUpdateNoticeToRenderer
        // firing right after the subscription is registered.
        cb({
          notify: true,
          enabled: true,
          version: "0.10.0",
          releaseUrl: "https://github.com/CodesWhat/careerrat/releases/tag/v0.10.0",
          dmgUrl: "https://example.com/CareerRat-0.10.0-arm64.dmg",
        });
        return () => {};
      },
      skipVersion: vi.fn().mockResolvedValue(undefined),
      openRelease: vi.fn().mockResolvedValue(undefined),
    };

    const { UpdateAvailableDock } = await import("./UpdateAvailableDock.jsx");
    const markup = renderToStaticMarkup(<UpdateAvailableDock />);

    expect(markup).toContain('class="ask-bar__nudge"');
    expect(markup).toContain("Update ready");
    expect(markup).toContain("0.10.0");
    expect(markup).toMatch(/<button[^>]*>Download update<\/button>/);
    expect(markup).toMatch(/<button[^>]*aria-label="Dismiss"[^>]*>/);

    delete globalThis.careerratDesktopUpdate;
  });

  it("does not render when the bridge reports no update available", async () => {
    vi.resetModules();
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: (cb) => {
        cb({ notify: false, enabled: true, version: null, releaseUrl: null, dmgUrl: null });
        return () => {};
      },
      skipVersion: vi.fn(),
      openRelease: vi.fn(),
    };

    const { UpdateAvailableDock } = await import("./UpdateAvailableDock.jsx");
    const markup = renderToStaticMarkup(<UpdateAvailableDock />);
    expect(markup).toBe("");

    delete globalThis.careerratDesktopUpdate;
  });

  it("dismiss hides the notice and persists the skip through the bridge", async () => {
    vi.resetModules();
    const skipVersion = vi.fn().mockResolvedValue(undefined);
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: (cb) => {
        cb({
          notify: true,
          enabled: true,
          version: "0.10.0",
          releaseUrl: "https://example.com/release",
          dmgUrl: null,
        });
        return () => {};
      },
      skipVersion,
      openRelease: vi.fn().mockResolvedValue(undefined),
    };

    const { useDesktopUpdateNotice } = await import("./UpdateAvailableDock.jsx");

    let captured;
    function Consumer() {
      captured = useDesktopUpdateNotice();
      return null;
    }

    renderToStaticMarkup(<Consumer />);
    expect(captured.available).toBe(true);
    expect(captured.version).toBe("0.10.0");

    captured.dismiss();
    expect(skipVersion).toHaveBeenCalledWith("0.10.0");

    renderToStaticMarkup(<Consumer />);
    expect(captured.available).toBe(false);

    delete globalThis.careerratDesktopUpdate;
  });

  it("openRelease delegates to the bridge, not a second open path", async () => {
    vi.resetModules();
    const openRelease = vi.fn().mockResolvedValue(undefined);
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: (cb) => {
        cb({
          notify: true,
          enabled: true,
          version: "0.10.0",
          releaseUrl: "https://example.com/release",
          dmgUrl: null,
        });
        return () => {};
      },
      skipVersion: vi.fn(),
      openRelease,
    };

    const { useDesktopUpdateNotice } = await import("./UpdateAvailableDock.jsx");

    let captured;
    function Consumer() {
      captured = useDesktopUpdateNotice();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    captured.openRelease();
    expect(openRelease).toHaveBeenCalledTimes(1);

    delete globalThis.careerratDesktopUpdate;
  });
});
