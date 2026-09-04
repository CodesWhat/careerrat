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
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    expect(captured.available).toBe(false);
    expect(captured.notice.visible).toBe(false);
  });

  it("subscribes before reading state and exposes the downloaded update action", async () => {
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
        supported: true,
        enabled: false,
        phase: "current",
        version: "0.16.3",
      }),
      skipVersion: vi.fn().mockResolvedValue({ notify: false, enabled: false }),
      restartAndInstall: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const module = await loadDesktopUpdate();
    expect(calls).toEqual(["subscribe"]);

    push({
      supported: true,
      notify: true,
      enabled: true,
      phase: "ready",
      version: "0.16.4",
      progress: 100,
    });
    resolveInitial({ supported: true, phase: "idle", enabled: true });
    await Promise.resolve();
    await Promise.resolve();

    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }
    renderToStaticMarkup(<Consumer />);

    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "ready",
      version: "0.16.4",
      primaryLabel: "Restart and install",
    });

    await captured.notice.onPrimary();
    expect(globalThis.careerratDesktopUpdate.restartAndInstall).toHaveBeenCalledOnce();
    await captured.setEnabled(false);
    await captured.checkNow();
    expect(globalThis.careerratDesktopUpdate.checkNow).toHaveBeenCalledOnce();

    renderToStaticMarkup(<Consumer />);
    expect(captured.status).toBe("CareerRat is up to date.");

    delete globalThis.careerratDesktopUpdate;
  });

  it("shows download progress and people-shaped recovery without raw native errors", async () => {
    vi.resetModules();
    let push;
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn((callback) => {
        push = callback;
        return () => {};
      }),
      setEnabled: vi.fn(),
      checkNow: vi.fn(),
      skipVersion: vi.fn(),
      restartAndInstall: vi.fn(),
    };
    const module = await loadDesktopUpdate();
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }

    push({ supported: true, phase: "downloading", version: "0.16.4", progress: 37 });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "downloading",
      message: "Downloading CareerRat 0.16.4… 37%",
    });
    expect(captured.notice.primaryLabel).toBeNull();

    push({
      supported: true,
      phase: "error",
      errorKind: "verification",
      message: "CareerRat couldn't verify that update, so it wasn't installed. Try again later.",
    });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "error",
      primaryLabel: "Try again",
    });
    expect(captured.status).not.toMatch(/sha|yaml|squirrel|shipit/i);

    delete globalThis.careerratDesktopUpdate;
  });

  it("keeps a dismissed download hidden through later progress but shows when ready", async () => {
    vi.resetModules();
    let push;
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn((callback) => {
        push = callback;
        return () => {};
      }),
      setEnabled: vi.fn(),
      checkNow: vi.fn(),
      skipVersion: vi.fn(),
      restartAndInstall: vi.fn(),
    };
    const module = await loadDesktopUpdate();
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }

    push({ supported: true, phase: "downloading", version: "0.16.4", progress: 21 });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice.visible).toBe(true);

    await captured.notice.onDismiss();
    push({ supported: true, phase: "downloading", version: "0.16.4", progress: 64 });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice.visible).toBe(false);

    push({
      supported: true,
      enabled: true,
      notify: true,
      phase: "ready",
      version: "0.16.4",
      progress: 100,
    });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({ visible: true, kind: "ready" });
    expect(globalThis.careerratDesktopUpdate.skipVersion).not.toHaveBeenCalled();

    delete globalThis.careerratDesktopUpdate;
  });

  it("applies setEnabled's own response directly so a server-side rejection isn't hidden, while blocking an unrelated external push mid-call", async () => {
    vi.resetModules();
    let push;
    let resolveSetEnabled;
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn((callback) => {
        push = callback;
        return () => {};
      }),
      setEnabled: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveSetEnabled = resolve;
          })
      ),
      checkNow: vi.fn(),
      skipVersion: vi.fn(),
      restartAndInstall: vi.fn(),
    };
    const module = await loadDesktopUpdate();
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }

    push({ supported: true, phase: "idle", enabled: false });
    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(false);

    const setEnabledPromise = captured.setEnabled(true);
    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(true);

    // An unrelated external push arrives while the call is in flight. It must
    // not clobber the optimistic, in-flight preference.
    push({ supported: true, phase: "idle", enabled: false, version: "0.16.4" });
    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(true);

    // The server rejects/coerces the toggle back to false for this very call.
    resolveSetEnabled({ enabled: false });
    await setEnabledPromise;
    renderToStaticMarkup(<Consumer />);
    expect(captured.enabled).toBe(false);

    delete globalThis.careerratDesktopUpdate;
  });

  it("moves to an installing phase when Restart and install is accepted, blocking a second click and a later external push from reviving the button", async () => {
    vi.resetModules();
    let push;
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn((callback) => {
        push = callback;
        return () => {};
      }),
      setEnabled: vi.fn(),
      checkNow: vi.fn(),
      skipVersion: vi.fn(),
      restartAndInstall: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const module = await loadDesktopUpdate();
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }

    push({ supported: true, enabled: true, notify: true, phase: "ready", version: "0.16.4" });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "ready",
      primaryLabel: "Restart and install",
    });

    const onPrimary = captured.notice.onPrimary;
    await onPrimary();
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "installing",
      message: "Restarting to install…",
      primaryLabel: null,
    });
    expect(captured.notice.onPrimary).toBeUndefined();

    // A second click reuses the same handler reference obtained while the
    // update was still "ready". It must not call the bridge again.
    await onPrimary();
    expect(globalThis.careerratDesktopUpdate.restartAndInstall).toHaveBeenCalledOnce();

    // A stale external push reporting the old "ready" phase must not revive
    // the button while the install is proceeding.
    push({ supported: true, enabled: true, notify: true, phase: "ready", version: "0.16.4" });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "installing",
      primaryLabel: null,
    });
    expect(captured.notice.onPrimary).toBeUndefined();

    delete globalThis.careerratDesktopUpdate;
  });

  it("surfaces a real error pushed mid-install instead of leaving the notice stuck", async () => {
    vi.resetModules();
    let push;
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn((callback) => {
        push = callback;
        return () => {};
      }),
      setEnabled: vi.fn(),
      checkNow: vi.fn(),
      skipVersion: vi.fn(),
      restartAndInstall: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const module = await loadDesktopUpdate();
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }

    push({ supported: true, enabled: true, notify: true, phase: "ready", version: "0.16.4" });
    renderToStaticMarkup(<Consumer />);
    await captured.notice.onPrimary();
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({ kind: "installing" });

    // A legitimate error push must still surface with its retry action, not
    // get stripped by the installing guard.
    push({
      supported: true,
      phase: "error",
      errorKind: "install",
      message: "CareerRat couldn't finish the update. Try again. Your current version still works.",
    });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "error",
      primaryLabel: "Try again",
    });
    expect(captured.notice.onPrimary).toBeTypeOf("function");

    delete globalThis.careerratDesktopUpdate;
  });

  it("releases the installing latch after a rejected restart so later pushes still apply", async () => {
    vi.resetModules();
    let push;
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn((callback) => {
        push = callback;
        return () => {};
      }),
      setEnabled: vi.fn(),
      checkNow: vi.fn().mockResolvedValue({ supported: true, enabled: true, phase: "ready" }),
      skipVersion: vi.fn(),
      restartAndInstall: vi
        .fn()
        .mockResolvedValueOnce({ accepted: true })
        .mockResolvedValueOnce({ accepted: false }),
    };
    const module = await loadDesktopUpdate();
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }

    push({ supported: true, enabled: true, notify: true, phase: "ready", version: "0.16.4" });
    renderToStaticMarkup(<Consumer />);
    await captured.notice.onPrimary();
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({ kind: "installing" });

    // A direct checkNow response is authoritative: it can move the phase
    // back to "ready", which is what makes restartAndInstall callable again.
    await captured.checkNow();
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({ kind: "ready" });

    await captured.notice.onPrimary();
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({ kind: "error" });

    // A later authoritative push must still apply; the installing latch
    // must not have survived the rejected restart.
    push({ supported: true, enabled: true, phase: "current" });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({ kind: "current" });

    delete globalThis.careerratDesktopUpdate;
  });

  it("explains unsupported Windows updates without pretending to check", async () => {
    vi.resetModules();
    let push;
    globalThis.careerratDesktopUpdate = {
      getState: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn((callback) => {
        push = callback;
        return () => {};
      }),
      setEnabled: vi.fn(),
      checkNow: vi.fn(),
      skipVersion: vi.fn(),
      restartAndInstall: vi.fn(),
    };
    const module = await loadDesktopUpdate();
    let captured;
    function Consumer() {
      captured = module.useDesktopUpdate();
      return null;
    }
    push({
      supported: false,
      enabled: true,
      phase: "unsupported",
      message:
        "CareerRat can't install updates inside the Windows app yet because a signed Windows installer isn't publicly available yet. See Windows release status for availability.",
      downloadUrl: "https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md",
      manual: false,
    });
    renderToStaticMarkup(<Consumer />);

    expect(captured.available).toBe(true);
    expect(captured.supported).toBe(false);
    expect(captured.status).toMatch(/installer isn't publicly available yet/i);
    expect(captured.status).not.toMatch(/download the current version|run the installer/i);
    expect(captured.downloadUrl).toBe(
      "https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md"
    );
    expect(captured.notice.visible).toBe(false);

    push({ manual: true });
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice).toMatchObject({
      visible: true,
      kind: "unsupported",
      primaryLabel: "Windows release status",
      primaryHref: "https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md",
    });

    await captured.notice.onDismiss();
    renderToStaticMarkup(<Consumer />);
    expect(captured.notice.visible).toBe(false);
    expect(captured.status).toMatch(/installer isn't publicly available yet/i);

    delete globalThis.careerratDesktopUpdate;
  });
});
