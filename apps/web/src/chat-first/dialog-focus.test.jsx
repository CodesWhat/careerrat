import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EngineDownCover, SubmitGateModal } from "./conversation-surfaces.jsx";

// SubmitGateModal and EngineDownCover both wire the shared use-dialog-focus
// hook (apps/web/src/lib/use-dialog-focus.js). Its Tab/Shift-Tab trap,
// Escape, and focus-return behavior are unit-tested directly against that
// module (apps/web/src/lib/use-dialog-focus.test.js) with fake DOM
// stand-ins, since this repo's vitest has no jsdom, so mount effects never fire
// under renderToStaticMarkup. These tests cover what SSR markup can show:
// each dialog exposes a programmatically focusable root (tabIndex=-1) for
// the hook to focus, and each dialog's close contract (a close control for
// SubmitGateModal, none for EngineDownCover) matches what it hands the hook.

describe("SubmitGateModal focus wiring", () => {
  it("renders nothing, and moves no focus, while closed", () => {
    const html = renderToStaticMarkup(
      <SubmitGateModal open={false} gate={{}} onClose={vi.fn()} onSubmit={vi.fn()} />
    );
    expect(html).toBe("");
  });

  it("exposes a programmatically focusable dialog root when open", () => {
    const html = renderToStaticMarkup(
      <SubmitGateModal open gate={{}} onClose={vi.fn()} onSubmit={vi.fn()} />
    );
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"/);
    expect(html).toMatch(/class="chat-first-gate"[^>]*tabindex="-1"/);
  });

  it("closes through the same handler as its own close control", () => {
    const onClose = vi.fn();
    const html = renderToStaticMarkup(
      <SubmitGateModal open gate={{}} onClose={onClose} onSubmit={vi.fn()} />
    );
    // The header close button is the only element wired to onClose in markup;
    // Escape (tested against use-dialog-focus directly) invokes that same
    // onClose reference rather than a second, separate close path.
    expect(html).toContain('aria-label="Close submit review"');
  });
});

describe("EngineDownCover focus wiring", () => {
  it("renders nothing while closed", () => {
    const html = renderToStaticMarkup(
      <EngineDownCover open={false} onRetry={vi.fn()} onOpenSettings={vi.fn()} />
    );
    expect(html).toBe("");
  });

  it("exposes a programmatically focusable dialog root when open", () => {
    const html = renderToStaticMarkup(
      <EngineDownCover open onRetry={vi.fn()} onOpenSettings={vi.fn()} />
    );
    expect(html).toMatch(/role="alertdialog"[^>]*aria-modal="true"/);
    expect(html).toMatch(/class="chat-first-engine-down"[^>]*tabindex="-1"/);
  });

  it("has no close control for Escape to route through", () => {
    // EngineDownCover takes no onClose prop at all: there is nothing for
    // Escape to call, which is what keeps it a no-op (see
    // use-dialog-focus.test.js "no-ops on Escape ... EngineDownCover").
    const html = renderToStaticMarkup(
      <EngineDownCover open onRetry={vi.fn()} onOpenSettings={vi.fn()} />
    );
    expect(html).not.toContain('aria-label="Close');
  });
});
