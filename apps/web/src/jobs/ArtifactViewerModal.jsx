// apps/web/src/jobs/ArtifactViewerModal.jsx — the full-page overlay for
// viewing one packet artifact (resume / cover letter / answers), opened from
// PacketDocumentsCard's chips and from the drawer's existing Artifacts card
// (Phase C). Same fixed-overlay pattern as ResumeStep's
// onboarding-resume__document-viewer (apps/web/src/onboarding/steps/
// ResumeStep.jsx) — including the same Electron gotcha: this overlay's
// toolbar paints over the frameless-window drag strip, so its close button
// needs -webkit-app-region: no-drag or the desktop app's window-drag eats
// its clicks (works fine in a plain browser, which has no drag regions).
import { IconButton } from "../components/Button.jsx";

export function ArtifactViewerModal({ title, artifact, onClose }) {
  if (!artifact) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only backdrop, same convention as job-drawer-overlay
    // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop, same convention as job-drawer-overlay
    <div className="packet-viewer-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop's click-to-close from firing; not itself an interactive control */}
      <div
        className="packet-viewer"
        role="dialog"
        aria-label={title}
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
          ) : (
            <p className="field__hint">Nothing to preview yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
