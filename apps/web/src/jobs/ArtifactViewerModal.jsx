// apps/web/src/jobs/ArtifactViewerModal.jsx — the full-page overlay for
// viewing one packet artifact (resume / cover letter / answers), opened from
// PacketDocumentsCard's chips and from the drawer's existing Artifacts card
// (Phase C). Same fixed-overlay pattern as ResumeStep's
// onboarding-resume__document-viewer (apps/web/src/onboarding/steps/
// ResumeStep.jsx) — including the same Electron gotcha: this overlay's
// toolbar paints over the frameless-window drag strip, so its close button
// needs -webkit-app-region: no-drag or the desktop app's window-drag eats
// its clicks (works fine in a plain browser, which has no drag regions).
import { useEffect, useRef } from "react";
import { IconButton } from "../components/Button.jsx";

const VIEWER_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function trapViewerTab({ dialog, event, activeElement }) {
  if (!dialog || event?.key !== "Tab") return;
  const focusable = Array.from(dialog.querySelectorAll(VIEWER_FOCUSABLE));
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

export function handleArtifactViewerKeyDown({ event, onClose, dialog, activeElement }) {
  if (event?.key === "Escape") {
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    onClose?.();
    return;
  }
  trapViewerTab({ dialog, event, activeElement });
}

export function ArtifactViewerModal({ title, artifact, onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!artifact) return undefined;
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement;
    dialog?.focus();
    function onKeyDown(event) {
      handleArtifactViewerKeyDown({
        event,
        onClose,
        dialog,
        activeElement: document.activeElement,
      });
    }
    // Capture gives the top-layer viewer first refusal before the drawer's
    // own bubbling key handler can close the whole stack.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus?.();
    };
  }, [artifact, onClose]);

  if (!artifact) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only backdrop, same convention as job-drawer-overlay
    // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop, same convention as job-drawer-overlay
    <div className="packet-viewer-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop's click-to-close from firing; not itself an interactive control */}
      <div
        ref={dialogRef}
        className="packet-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="packet-viewer__toolbar">
          <strong className="packet-viewer__title">{title}</strong>
          <IconButton label="Close" className="packet-viewer__close" onClick={onClose}>
            ×
          </IconButton>
        </div>
        <div className="packet-viewer__stage">
          {artifact.binary && artifact.url ? (
            <object
              className="packet-viewer__object"
              data={artifact.url}
              type="application/pdf"
              aria-label={title}
            >
              <iframe src={artifact.url} title={title} />
            </object>
          ) : artifact.html ? (
            // Server-rendered markdown->html (markdownToHtml, src/core/documents/export.mjs)
            // over the app's own tailored artifact content — same-origin, not
            // user-supplied HTML.
            <div
              className="packet-viewer__markdown"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted server-rendered artifact markdown, not user input
              dangerouslySetInnerHTML={{ __html: artifact.html }}
            />
          ) : artifact.text ? (
            <pre className="packet-viewer__markdown packet-viewer__plain">{artifact.text}</pre>
          ) : (
            <p className="field__hint">Nothing to preview yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
