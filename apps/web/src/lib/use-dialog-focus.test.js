import { describe, expect, it, vi } from "vitest";
import {
  focusDialogOnOpen,
  handleDialogKeyDown,
  restoreDialogFocus,
  trapDialogTab,
} from "./use-dialog-focus.js";

// Fakes the slice of a DOM node this module touches (focus/contains/
// querySelectorAll) rather than mounting into a real DOM, since this repo's
// vitest setup has no jsdom, and ArtifactViewerModal.test.jsx (the module
// this hook was lifted out of) already tests the same behavior this way.
function fakeDialog(focusableEls) {
  return {
    focus: vi.fn(),
    contains: (el) => focusableEls.includes(el),
    querySelectorAll: () => focusableEls,
  };
}

function fakeElement() {
  return { focus: vi.fn() };
}

function tabEvent({ shiftKey = false } = {}) {
  return { key: "Tab", shiftKey, preventDefault: vi.fn() };
}

describe("focusDialogOnOpen", () => {
  it("moves focus into the dialog on mount", () => {
    const dialog = fakeDialog([]);
    focusDialogOnOpen({ dialog });
    expect(dialog.focus).toHaveBeenCalledOnce();
  });

  it("tolerates a not-yet-attached dialog ref", () => {
    expect(() => focusDialogOnOpen({ dialog: null })).not.toThrow();
  });
});

describe("restoreDialogFocus", () => {
  it("returns focus to the previously focused element on unmount", () => {
    const previouslyFocused = fakeElement();
    previouslyFocused.isConnected = true;
    restoreDialogFocus({ previouslyFocused });
    expect(previouslyFocused.focus).toHaveBeenCalledOnce();
  });

  it("does not refocus an element that left the document", () => {
    const previouslyFocused = fakeElement();
    previouslyFocused.isConnected = false;
    restoreDialogFocus({ previouslyFocused });
    expect(previouslyFocused.focus).not.toHaveBeenCalled();
  });
});

describe("trapDialogTab", () => {
  it("wraps Tab from the last focusable element to the first", () => {
    const first = fakeElement();
    const last = fakeElement();
    const dialog = fakeDialog([first, last]);
    const event = tabEvent();

    trapDialogTab({ dialog, event, activeElement: last });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();
    expect(last.focus).not.toHaveBeenCalled();
  });

  it("wraps Shift-Tab from the first focusable element to the last", () => {
    const first = fakeElement();
    const last = fakeElement();
    const dialog = fakeDialog([first, last]);
    const event = tabEvent({ shiftKey: true });

    trapDialogTab({ dialog, event, activeElement: first });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
    expect(first.focus).not.toHaveBeenCalled();
  });

  it("leaves focus alone when Tab moves between two interior elements", () => {
    const first = fakeElement();
    const middle = fakeElement();
    const last = fakeElement();
    const dialog = fakeDialog([first, middle, last]);
    const event = tabEvent();

    trapDialogTab({ dialog, event, activeElement: middle });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(first.focus).not.toHaveBeenCalled();
    expect(last.focus).not.toHaveBeenCalled();
  });

  it("pulls focus back in when nothing inside the dialog is focusable", () => {
    const dialog = fakeDialog([]);
    const event = tabEvent();

    trapDialogTab({ dialog, event, activeElement: fakeElement() });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(dialog.focus).toHaveBeenCalledOnce();
  });

  it("ignores non-Tab keys", () => {
    const first = fakeElement();
    const dialog = fakeDialog([first]);
    const event = { key: "a", preventDefault: vi.fn() };

    trapDialogTab({ dialog, event, activeElement: first });

    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("handleDialogKeyDown", () => {
  it("closes a dialog with a close control on Escape (SubmitGateModal)", () => {
    const onClose = vi.fn();
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    handleDialogKeyDown({ event, onClose });

    expect(onClose).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("no-ops on Escape for a dialog with no close control (EngineDownCover)", () => {
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(() => handleDialogKeyDown({ event })).not.toThrow();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("delegates non-Escape keys to the tab trap", () => {
    const first = fakeElement();
    const last = fakeElement();
    const dialog = fakeDialog([first, last]);
    const event = tabEvent();

    handleDialogKeyDown({ event, dialog, activeElement: last });

    expect(first.focus).toHaveBeenCalledOnce();
  });
});
