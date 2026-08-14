// apps/web/src/jobs/InterviewDossierCard.jsx — the Jobs drawer's interview-prep
// dossier section (ISSUE-030): the dashboard's Focus card already surfaces a
// built dossier (dashboard-data.js's focusAppContext), but the drawer itself
// (both a direct /jobs?open= visit and the Focus card's "Prep this
// interview"/"Open dossier" CTAs) had nowhere to build or read one. On mount
// this reads back any already-built dossier (GET /api/interview-prep?id=);
// a DOSSIER_NOT_FOUND 404 is the expected "not built yet" state, never an
// error banner. Building/rebuilding is an explicit-click AI-spend action —
// same discipline as PacketDocumentsCard's Generate/Export — nothing here
// ever auto-fires from a prop change. The dossier's markdown is rendered as
// plain preformatted text (not dangerouslySetInnerHTML): the build/read
// routes retain raw markdown as the persisted source and return a safely
// escaped server-rendered HTML view for the full-page reader. The compact
// drawer card keeps its plain preformatted source treatment.
import { useCallback, useEffect, useState } from "react";
import { Button, IconButton } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { buildInterviewDossier, getInterviewDossier } from "../lib/api.js";
import { errorState, withRetryAction } from "../lib/errorCopy.js";

function isNotBuiltYet(err) {
  return err?.body?.code === "DOSSIER_NOT_FOUND" || err?.status === 404;
}

function formatGeneratedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  return d.toLocaleString();
}

export function InterviewDossierCard({ applicationId, fullPage = false, onClose }) {
  const [dossier, setDossier] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadDossier = useCallback(async () => {
    // Cleared here (not just by the mount effect below) so a retry click
    // — this same function, wired as the error's action.onRetry — doesn't
    // leave a stale banner showing through a successful reload.
    setError(null);
    try {
      const res = await getInterviewDossier(applicationId);
      setDossier(res?.data?.dossier || null);
    } catch (err) {
      if (!isNotBuiltYet(err)) {
        setError(withRetryAction(errorState(err, "Interview prep failed"), loadDossier));
      }
      setDossier(null);
    } finally {
      setLoaded(true);
    }
  }, [applicationId]);

  useEffect(() => {
    setDossier(null);
    setError(null);
    setLoaded(false);
    loadDossier();
  }, [loadDossier]);

  useEffect(() => {
    if (!fullPage || !onClose) return undefined;
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    globalThis.addEventListener?.("keydown", handleKeyDown);
    return () => globalThis.removeEventListener?.("keydown", handleKeyDown);
  }, [fullPage, onClose]);

  async function handleBuild() {
    setBusy(true);
    setError(null);
    try {
      const res = await buildInterviewDossier({ applicationId });
      setDossier(res?.data?.dossier || null);
    } catch (err) {
      setError(withRetryAction(errorState(err, "Interview prep failed"), handleBuild));
    } finally {
      setBusy(false);
    }
  }

  const content = loaded ? (
    <>
      {error ? (
        <InlineAlert message={error.message} action={error.action} detail={error.detail} />
      ) : null}
      {dossier ? (
        <>
          <p className="field__hint">
            {dossier.round ? `${dossier.round} · ` : ""}
            {formatGeneratedAt(dossier.generatedAt) || "Prepared"}
          </p>
          {fullPage && dossier.html ? (
            <div
              className="packet-viewer__markdown interview-dossier-viewer__document"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: markdownToHtml escapes the persisted dossier before the API returns it
              dangerouslySetInnerHTML={{ __html: dossier.html }}
            />
          ) : (
            <div className="job-drawer__dossier">{dossier.markdown}</div>
          )}
          <Button variant="secondary" disabled={busy} onClick={handleBuild}>
            {busy ? "Rebuilding…" : "Rebuild"}
          </Button>
        </>
      ) : (
        <>
          <p className="field__hint">
            Build a prep dossier for this interview: company and role research, likely questions,
            and evidence-grounded talking points, generated from the captured job description and
            your evidence bank.
          </p>
          <Button disabled={busy} onClick={handleBuild}>
            {busy ? "Building…" : "Build prep dossier"}
          </Button>
        </>
      )}
    </>
  ) : (
    <p className="field__hint">Loading interview dossier…</p>
  );

  if (fullPage) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a mouse convenience; the dialog has a labeled close control and Escape handling
      // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop itself is intentionally mouse-only
      <div className="packet-viewer-overlay" onClick={onClose}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop click propagation; this isn't an interactive control */}
        <div
          className="packet-viewer interview-dossier-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="Interview prep dossier"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="packet-viewer__toolbar">
            <strong className="packet-viewer__title">
              {dossier?.title || "Interview prep dossier"}
            </strong>
            <IconButton autoFocus label="Close" className="packet-viewer__close" onClick={onClose}>
              ×
            </IconButton>
          </div>
          <div className="packet-viewer__stage">
            <div className="interview-dossier-viewer__body">{content}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!loaded) return null;

  return <Card title="Interview prep dossier">{content}</Card>;
}
