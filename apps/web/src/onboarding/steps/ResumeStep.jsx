import { useRef, useState } from "react";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { Field, TextArea, TextField } from "../../components/form.jsx";
import { UploadIcon } from "../../components/icons.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import {
  extractResumeAi,
  extractResumeDocx,
  parseResumeText,
  saveCandidateFile,
  saveEvidenceSeed,
} from "../../lib/api.js";

// .txt/.md keep using the existing zero-AI deterministic parse
// (POST /api/onboard/resume); pdf/image go through the AI extraction route
// (POST /api/onboard/resume-ai) — see onboard-route.mjs's own split.
const DOCX_EXTENSIONS = new Set(["docx"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown"]);
const BINARY_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "webp"]);
const LOCAL_ACCEPT = ".docx,.txt,.md,.markdown";
const AI_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp";
const DOCX_FALLBACK_COPY =
  "We could not read usable text from that DOCX. The original file was saved; paste text or upload PDF, TXT, or Markdown.";

const PROFILE_FIELDS = [
  "full_name",
  "email",
  "phone",
  "location",
  "linkedin",
  "github",
  "portfolio",
];

function extOf(filename) {
  const parts = String(filename || "").split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("could not read file"));
    reader.readAsText(file);
  });
}

function unsupportedFileMessage(ext) {
  return `Unsupported file type "${ext || "file"}" — use .docx, .txt, .md, .markdown, .pdf, .png, .jpg, .jpeg, or .webp, or paste your resume text below.`;
}

function documentFormatsFromState(state) {
  const raw = state?.data?.["form-defaults"]?.document_formats || {};
  const defaultPacketFormat = raw.default_packet_format || raw.standard || "pdf";
  const requiredExportFormats = Array.isArray(raw.required_export_formats)
    ? raw.required_export_formats
    : Array.isArray(raw.board_required)
      ? raw.board_required
      : [];
  return {
    defaultPacketFormat,
    requiredExportFormats,
  };
}

export function getResumeUploadMode(filename, { aiEnabled = false } = {}) {
  const ext = extOf(filename);
  if (DOCX_EXTENSIONS.has(ext)) return "docx";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (BINARY_EXTENSIONS.has(ext)) return aiEnabled ? "ai" : "ai-unavailable";
  return "unsupported";
}

export async function parseResumeFileForReview(
  file,
  { aiEnabled = false, readText = readAsText } = {}
) {
  const mode = getResumeUploadMode(file?.name, { aiEnabled });
  if (mode === "docx") {
    const seed = await extractResumeDocx(file);
    return { reviewTitle: "Review & edit", seed };
  }
  if (mode === "text") {
    const text = await readText(file);
    const seed = await parseResumeText(text, { save: true });
    return { reviewTitle: "Review & edit", seed };
  }
  if (mode === "ai") {
    const seed = await extractResumeAi(file);
    return { reviewTitle: "Review & edit", seed };
  }
  const ext = extOf(file?.name);
  const err = new Error(
    mode === "ai-unavailable" ? "AI key required" : unsupportedFileMessage(ext)
  );
  err.status = mode === "ai-unavailable" ? 501 : 400;
  err.body = mode === "unsupported" ? { error: unsupportedFileMessage(ext) } : undefined;
  throw err;
}

export function describeResumeUploadError(err, { mode = "unsupported", ext = "" } = {}) {
  const body = err?.body && typeof err.body === "object" ? err.body : {};
  if (mode === "docx" && (err?.status === 422 || body.code === "DOCX_TEXT_UNUSABLE")) {
    return { message: DOCX_FALLBACK_COPY, showPaste: true };
  }
  if (mode === "ai-unavailable") {
    return {
      message:
        "Add an AI key in the previous step to extract a PDF/image resume — or paste your resume text below.",
      showPaste: true,
    };
  }
  if (err?.status === 501) {
    return {
      message: "No AI key configured — paste your resume text below instead.",
      showPaste: true,
    };
  }
  if (err?.status === 422) {
    return {
      message:
        "Couldn't extract a usable profile from that file after a retry — paste your resume text below instead.",
      showPaste: true,
    };
  }
  if (err?.status === 413) {
    return {
      message: "That file is larger than the 5MB cap — try a smaller file, or paste text below.",
      showPaste: true,
    };
  }
  if (err?.status === 400 && body.error) {
    return { message: body.error, showPaste: true };
  }
  if (mode === "unsupported") {
    return { message: unsupportedFileMessage(ext), showPaste: true };
  }
  return {
    message: err instanceof Error ? err.message : "Resume upload failed",
    showPaste: true,
  };
}

export function documentFormatPreferenceText({ docxBoardRequired = false } = {}) {
  return docxBoardRequired ? "PDF standard; DOCX when a board requires it." : "PDF standard.";
}

export function saveDocumentFormatPreferences({ docxBoardRequired = false } = {}) {
  return saveCandidateFile("form-defaults", {
    document_formats: {
      default_packet_format: "pdf",
      required_export_formats: docxBoardRequired ? ["docx"] : [],
    },
  });
}

// Step 3 — Resume drop. Collapses M1's separate "resume" + "profile" +
// "evidence seed" screens into one review/edit step (the extraction already
// returns evidenceSeed.claims alongside profileSeed — no reason to make
// evidence its own screen, per the M8 design doc).
export function ResumeStep({ state, aiEnabled, setDraftSeeds, goNext, goBack, showToast }) {
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null); // "ai" | "text" | null
  const [sections, setSections] = useState(null);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const initialDocumentFormats = documentFormatsFromState(state);
  const [docxBoardRequired, setDocxBoardRequired] = useState(() =>
    initialDocumentFormats.requiredExportFormats.includes("docx")
  );
  const [formatSaving, setFormatSaving] = useState(false);

  const [profileFields, setProfileFields] = useState(() => {
    const candidate = state?.data?.profile?.candidate ?? {};
    const initial = {};
    for (const key of PROFILE_FIELDS) initial[key] = candidate[key] ?? "";
    return initial;
  });
  const [claims, setClaims] = useState([]);
  const [saving, setSaving] = useState(false);

  function applySeed(result) {
    setSource(result.source === "ai" ? "ai" : result.source === "docx" ? "docx" : "text");
    setSections(result.sections ?? null);
    const seedCandidate = result.profileSeed?.candidate ?? {};
    setProfileFields((prev) => {
      const next = { ...prev };
      for (const key of PROFILE_FIELDS) {
        if (seedCandidate[key]) next[key] = seedCandidate[key];
      }
      return next;
    });
    const seedClaims = result.evidenceSeed?.claims ?? [];
    setClaims(seedClaims.map((c) => ({ ...c, selected: true })));
    if (result.targetingSeed) {
      setDraftSeeds?.((prev) => ({ ...prev, targeting: result.targetingSeed }));
    }
  }

  async function handleFile(file) {
    if (!file) return;
    const ext = extOf(file.name);
    const mode = getResumeUploadMode(file.name, { aiEnabled });
    setError(null);
    setBusy(true);
    try {
      const { seed } = await parseResumeFileForReview(file, { aiEnabled });
      applySeed(seed);
    } catch (err) {
      const described = describeResumeUploadError(err, { mode, ext });
      setError(described.message);
      if (described.showPaste) setShowPaste(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleParsePaste() {
    if (!pasteText.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const result = await parseResumeText(pasteText, { save: true });
      applySeed(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume parse failed");
    } finally {
      setBusy(false);
    }
  }

  function updateClaim(index, field, value) {
    setClaims((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
  }
  function toggleClaim(index) {
    setClaims((prev) => prev.map((c, i) => (i === index ? { ...c, selected: !c.selected } : c)));
  }

  async function handleSaveAndNext() {
    setSaving(true);
    setError(null);
    try {
      const candidatePatch = {};
      for (const key of PROFILE_FIELDS) {
        if (profileFields[key]?.trim()) candidatePatch[key] = profileFields[key].trim();
      }
      if (Object.keys(candidatePatch).length) {
        await saveCandidateFile("profile", { candidate: candidatePatch });
      }
      const selected = claims
        .filter((c) => c.selected && c.claim?.trim())
        .map(({ claim, evidence }) => ({ claim, evidence }));
      if (selected.length) {
        await saveEvidenceSeed(selected);
      }
      if (Object.keys(candidatePatch).length || selected.length) showToast("Saved.");
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDocumentFormats() {
    setFormatSaving(true);
    setError(null);
    try {
      await saveDocumentFormatPreferences({ docxBoardRequired });
      showToast("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setFormatSaving(false);
    }
  }

  const accept = aiEnabled ? `${LOCAL_ACCEPT},${AI_ACCEPT}` : LOCAL_ACCEPT;
  const savedPreference = documentFormatPreferenceText({ docxBoardRequired });

  return (
    <Card title="Drop your resume">
      <p className="field__hint" style={{ margin: 0 }}>
        DOCX, TXT, and Markdown are parsed locally. PDF and images use your connected AI key.
      </p>
      {error ? <InlineAlert message={error} /> : null}

      <button
        type="button"
        className={`dropzone${dragActive ? " dropzone--active" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        disabled={busy}
      >
        <span className="dropzone__icon">
          <UploadIcon />
        </span>
        <span>{busy ? "Reading…" : "Drag a file here, or click to choose one"}</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      <div>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setShowPaste((s) => !s)}
        >
          {showPaste ? "Hide paste box" : "Or paste your resume text"}
        </button>
        {showPaste ? (
          <div style={{ marginTop: 10 }}>
            <TextArea
              id="resume-paste"
              rows={8}
              value={pasteText}
              onChange={setPasteText}
              placeholder="Paste plain-text or markdown resume…"
            />
            <div style={{ marginTop: 8 }}>
              <Button
                variant="secondary"
                onClick={handleParsePaste}
                disabled={busy || !pasteText.trim()}
              >
                Parse pasted text
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <p className="field__label" style={{ margin: 0 }}>
          Packet format
        </p>
        <p className="field__hint" style={{ margin: 0 }}>
          PDF is the standard packet format.
        </p>
        <div className="chip-row">
          <span className="chip">PDF standard</span>
          <label className="chip" htmlFor="resume-docx-required">
            <input
              id="resume-docx-required"
              type="checkbox"
              checked={docxBoardRequired}
              onChange={(event) => setDocxBoardRequired(event.target.checked)}
            />
            DOCX board-required
          </label>
        </div>
        <p className="field__hint" style={{ margin: 0 }}>
          Saved preference: {savedPreference}
        </p>
        <div>
          <Button variant="secondary" onClick={handleSaveDocumentFormats} disabled={formatSaving}>
            {formatSaving ? "Saving…" : "Save format preference"}
          </Button>
        </div>
      </div>

      {source ? (
        <div>
          <h4 style={{ margin: "4px 0" }}>Review & edit</h4>
          <p className="field__hint" style={{ margin: "0 0 10px" }}>
            {source === "ai"
              ? "Extracted by AI — "
              : source === "docx"
                ? "Parsed locally from DOCX — "
                : "Parsed — "}
            {sections
              ? `${sections.experience ?? 0} experience, ${sections.education ?? 0} education, ` +
                `${sections.skills ?? 0} skills, ${sections.projects ?? 0} project section(s) found.`
              : null}{" "}
            Edit anything below before saving.
          </p>
          <div className="field-row">
            {PROFILE_FIELDS.map((key) => (
              <Field key={key} label={key.replace(/_/g, " ")} htmlFor={`resume-${key}`}>
                <TextField
                  id={`resume-${key}`}
                  value={profileFields[key]}
                  onChange={(v) => setProfileFields((f) => ({ ...f, [key]: v }))}
                />
              </Field>
            ))}
          </div>

          {claims.length ? (
            <div style={{ marginTop: 14 }}>
              <p className="field__label" style={{ margin: "0 0 6px" }}>
                Evidence claims — uncheck any you don't want saved yet
              </p>
              {claims.map((claim, i) => (
                <div className="claim-row" key={claim.id ?? i}>
                  <input
                    type="checkbox"
                    checked={!!claim.selected}
                    onChange={() => toggleClaim(i)}
                    aria-label="Include this claim"
                  />
                  <div className="claim-row__fields">
                    <TextField
                      value={claim.claim}
                      onChange={(v) => updateClaim(i, "claim", v)}
                      aria-label="Claim"
                    />
                    <TextField
                      value={claim.evidence}
                      onChange={(v) => updateClaim(i, "evidence", v)}
                      aria-label="Evidence"
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="wizard-actions">
        <Button variant="secondary" onClick={goBack}>
          Back
        </Button>
        <Button onClick={handleSaveAndNext} disabled={saving}>
          {saving ? "Saving…" : "Save & continue"}
        </Button>
      </div>
    </Card>
  );
}
