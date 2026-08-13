// apps/web/src/jobs/PacketDocumentsCard.jsx — the Jobs drawer's "Documents"
// section (Phase C): Generate (POST /api/packet/generate), Export
// (POST /api/packet/export), and a per-artifact view link that opens
// ArtifactViewerModal. Both AI-spending/file-writing actions are
// explicit-click only — nothing here ever auto-fires from a prop change.
//
// KNOWN GAP (not fixed here — src/core/packet/* is out of scope for this
// task): generatePacket/exportPacketArtifacts (src/core/packet/generate.mjs,
// exports.mjs) stamp artifacts.resumeSource/resumePdf/resumeDocx (and the
// coverLetter/answers equivalents) — never the plain artifacts.resume/
// coverLetter/answers keys that GET /api/packet (and isGatedIn/hasResume in
// packet-route.mjs) actually reads. A freshly-generated-then-exported packet
// therefore still reads as "not generated" here; the legacy SSR /packet page
// (src/core/onboarding/packet-page.mjs) has the identical gap. Artifacts
// stamped by the OLDER tailor-application flow (appRegisterArtifact, which
// does write the plain key) view correctly.
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { exportPacketDocuments, generatePacketDocuments, getPacket } from "../lib/api.js";
import { errorState, withRetryAction } from "../lib/errorCopy.js";

const ARTIFACT_KINDS = [
  { key: "resume", label: "Resume" },
  { key: "coverLetter", label: "Cover letter" },
  { key: "answers", label: "Answers" },
];

export function PacketDocumentsCard({ applicationId, gate, onView }) {
  const [packet, setPacket] = useState(null);
  const [busy, setBusy] = useState(null); // "generate" | "export" | null
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [exportedFiles, setExportedFiles] = useState(null);

  const loadPacket = useCallback(async () => {
    try {
      const res = await getPacket(applicationId);
      setPacket(res);
    } catch (_err) {
      // Best-effort: an unreadable packet just means the chips stay
      // "Not generated yet" — never a hard error for a plain view load.
    }
  }, [applicationId]);

  useEffect(() => {
    setPacket(null);
    setError(null);
    setNotice(null);
    setExportedFiles(null);
    loadPacket();
  }, [loadPacket]);

  async function handleGenerate() {
    if (String(gate || "").toLowerCase() !== "keep") return;
    setBusy("generate");
    setError(null);
    setNotice(null);
    try {
      const res = await generatePacketDocuments({ applicationId, formats: ["pdf"] });
      const gapCount = Array.isArray(res?.data?.gaps) ? res.data.gaps.length : 0;
      setNotice(
        `Packet ${res?.data?.status || "generated"}: ${gapCount} gap${gapCount === 1 ? "" : "s"}.`
      );
      await loadPacket();
    } catch (err) {
      setError(withRetryAction(errorState(err, "Packet action failed"), handleGenerate));
    } finally {
      setBusy(null);
    }
  }

  async function handleExport() {
    setBusy("export");
    setError(null);
    setNotice(null);
    try {
      const res = await exportPacketDocuments({ applicationId, formats: ["pdf"] });
      setExportedFiles(res?.data?.userFacing || null);
      await loadPacket();
    } catch (err) {
      setError(withRetryAction(errorState(err, "Packet action failed"), handleExport));
    } finally {
      setBusy(null);
    }
  }

  const artifacts = packet?.artifacts || {};
  const canGenerate = String(gate || "").toLowerCase() === "keep";
  const exportedEntries = exportedFiles
    ? Object.entries(exportedFiles).flatMap(([kind, files]) =>
        (files || []).map((file) => ({ kind, ...file }))
      )
    : [];

  return (
    <Card title="Documents">
      <p className="field__hint">
        Generate a tailored resume, cover letter, and short answers, then export them for
        submission.
      </p>
      {!canGenerate ? (
        <p className="field__hint">A KEEP evaluation is required before tailoring documents.</p>
      ) : null}
      {error ? (
        <InlineAlert message={error.message} action={error.action} detail={error.detail} />
      ) : null}
      {notice ? <p className="field__hint">{notice}</p> : null}
      <div className="job-drawer__inline-actions">
        <Button disabled={!canGenerate || busy === "generate"} onClick={handleGenerate}>
          {busy === "generate" ? "Generating…" : "Generate documents"}
        </Button>
        <Button variant="secondary" disabled={busy === "export"} onClick={handleExport}>
          {busy === "export" ? "Exporting…" : "Export"}
        </Button>
      </div>
      <ul className="job-drawer__list">
        {ARTIFACT_KINDS.map(({ key, label }) => (
          <li key={key}>
            <span className="field__label">{label}:</span>{" "}
            {artifacts[key] ? (
              <button
                type="button"
                className="job-drawer__link-button"
                onClick={() => onView({ title: `${label}: preview`, artifact: artifacts[key] })}
              >
                View
              </button>
            ) : (
              "Not generated yet"
            )}
          </li>
        ))}
      </ul>
      {exportedEntries.length ? (
        <div>
          <span className="field__label">Exported files</span>
          <ul className="job-drawer__list">
            {exportedEntries.map((file) => (
              <li key={`${file.kind}-${file.path}`}>{file.path}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
