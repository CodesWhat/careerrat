import { useEffect } from "react";

// Shared focus-management contract for our fixed-overlay dialogs
// (role="dialog"/"alertdialog", aria-modal="true"): move focus in on open,
// trap Tab/Shift-Tab inside the dialog node, let Escape close it (only when
// the caller supplies onClose: a dialog with no close control, like
// EngineDownCover, gets a no-op Escape instead of one that silently doesn't
// exist), and restore focus to whatever had it before the dialog opened.
// Lifted out of ArtifactViewerModal (apps/web/src/jobs/ArtifactViewerModal.jsx),
// which was the first place this got built and is now just a caller of it.

const DIALOG_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusDialogOnOpen({ dialog }) {
  dialog?.focus();
}

export function restoreDialogFocus({ previouslyFocused }) {
  if (previouslyFocused?.isConnected) previouslyFocused.focus?.();
}

export function trapDialogTab({ dialog, event, activeElement }) {
  if (!dialog || event?.key !== "Tab") return;
  const focusable = Array.from(dialog.querySelectorAll(DIALOG_FOCUSABLE));
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const outside = !dialog.contains(activeElement);
  if (event.shiftKey && (activeElement === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeElement === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

export function handleDialogKeyDown({ event, onClose, dialog, activeElement }) {
  if (event?.key === "Escape") {
    if (!onClose) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    onClose();
    return;
  }
  trapDialogTab({ dialog, event, activeElement });
}

// `active` gates the whole effect so a caller that keeps the component
// mounted while closed (SubmitGateModal, EngineDownCover both toggle on an
// `open` prop rather than unmounting) doesn't move focus or install a
// listener while hidden.
export function useDialogFocus({ active, dialogRef, onClose }) {
  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement;
    focusDialogOnOpen({ dialog });
    function onKeyDown(event) {
      handleDialogKeyDown({
        event,
        onClose,
        dialog,
        activeElement: document.activeElement,
      });
    }
    // Capture gives the dialog first refusal before any bubbling handler
    // further out (e.g. a drawer's own keydown listener) can act on the key.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreDialogFocus({ previouslyFocused });
    };
  }, [active, onClose, dialogRef]);
}
