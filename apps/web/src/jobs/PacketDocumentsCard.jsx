// apps/web/src/jobs/PacketDocumentsCard.jsx — the Jobs drawer's "Documents"
// section (Phase C): Generate (POST /api/packet/generate), Export
// (POST /api/packet/export), and a per-artifact view link that opens
// ArtifactViewerModal. Both AI-spending/file-writing actions are
// explicit-click only — nothing here ever auto-fires from a prop change.
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

function isDeferredAnswersGap(gap) {
  return (
    String(gap?.kind || "").toLowerCase() === "answers" &&
    /no application questions captured/i.test(String(gap?.message || ""))
  );
}

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
      const gaps = Array.isArray(res?.data?.gaps) ? res.data.gaps : [];
      if (gaps.length > 0 && gaps.every(isDeferredAnswersGap)) {
        setNotice(
          "Résumé and cover letter are ready. Answers will be added when the application form exposes its questions."
        );
      } else {
        setNotice(
          `Packet ${res?.data?.status || "generated"}: ${gaps.length} gap${gaps.length === 1 ? "" : "s"}.`
        );
      }
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
  const answersDeferred =
    !artifacts.answers &&
    Array.isArray(packet?.packet?.gaps) &&
    packet.packet.gaps.some(isDeferredAnswersGap);
  const canGenerate = String(gate || "").toLowerCase() === "keep";
  const exportedEntries = exportedFiles
    ? Object.entries(exportedFiles).flatMap(([kind, files]) =>
        (files || []).map((file) => ({ kind, ...file }))
      )
    : [];

  return (
    <Card title="Documents">
      <p className="field__hint">
        Generate a tailored résumé and cover letter now. Application answers are added after the
        employer's form exposes its questions.
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
            ) : key === "answers" && answersDeferred ? (
              "Waiting for application questions"
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
