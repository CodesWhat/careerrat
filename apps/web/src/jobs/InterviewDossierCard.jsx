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
// routes only ever return raw markdown, never server-rendered HTML (unlike
// the packet-artifact/job-description routes), so there is nothing safe to
// inject — React's own text-child escaping plus CSS white-space handles it.
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { buildInterviewDossier, getInterviewDossier } from "../lib/api.js";

function describeDossierError(err) {
  return (
    err?.body?.error?.message ||
    (typeof err?.body?.error === "string" ? err.body.error : null) ||
    (err instanceof Error ? err.message : "Interview prep failed")
  );
}

function isNotBuiltYet(err) {
  return err?.body?.code === "DOSSIER_NOT_FOUND" || err?.status === 404;
}

function formatGeneratedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  return d.toLocaleString();
}

export function InterviewDossierCard({ applicationId }) {
  const [dossier, setDossier] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadDossier = useCallback(async () => {
    try {
      const res = await getInterviewDossier(applicationId);
      setDossier(res?.data?.dossier || null);
    } catch (err) {
      if (!isNotBuiltYet(err)) setError(describeDossierError(err));
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

  async function handleBuild() {
    setBusy(true);
    setError(null);
    try {
      const res = await buildInterviewDossier({ applicationId });
      setDossier(res?.data?.dossier || null);
    } catch (err) {
      setError(describeDossierError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  return (
    <Card title="Interview prep dossier">
      {error ? <InlineAlert message={error} /> : null}
      {dossier ? (
        <>
          <p className="field__hint">
            {dossier.round ? `${dossier.round} · ` : ""}
            {formatGeneratedAt(dossier.generatedAt) || "Prepared"}
          </p>
          <div className="job-drawer__dossier">{dossier.markdown}</div>
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
    </Card>
  );
}
