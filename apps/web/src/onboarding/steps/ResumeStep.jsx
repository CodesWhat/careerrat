import { useRef, useState } from "react";
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
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

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
const EXAMPLE_PDF_DATA_URI = `data:application/pdf;base64,${[
  "JVBERi0xLjQKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBv",
  "YmoKPDwKL0YxIDIgMCBSIC9GMiAzIDAgUgo+PgplbmRvYmoKMiAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGlj",
  "YSAvRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZyAvTmFtZSAvRjEgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250",
  "Cj4+CmVuZG9iagozIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhLUJvbGQgL0VuY29kaW5nIC9XaW5BbnNp",
  "RW5jb2RpbmcgL05hbWUgL0YyIC9TdWJ0eXBlIC9UeXBlMSAvVHlwZSAvRm9udAo+PgplbmRvYmoKNCAwIG9iago8",
  "PAovQ29udGVudHMgOCAwIFIgL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXSAvUGFyZW50IDcgMCBSIC9SZXNvdXJj",
  "ZXMgPDwKL0ZvbnQgMSAwIFIgL1Byb2NTZXQgWyAvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0K",
  "Pj4gL1JvdGF0ZSAwIC9UcmFucyA8PAoKPj4gCiAgL1R5cGUgL1BhZ2UKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1Bh",
  "Z2VNb2RlIC9Vc2VOb25lIC9QYWdlcyA3IDAgUiAvVHlwZSAvQ2F0YWxvZwo+PgplbmRvYmoKNiAwIG9iago8PAov",
  "QXV0aG9yIChhbm9ueW1vdXMpIC9DcmVhdGlvbkRhdGUgKEQ6MjAyNjA3MDcxMDM5NDMtMDQnMDAnKSAvQ3JlYXRv",
  "ciAoYW5vbnltb3VzKSAvS2V5d29yZHMgKCkgL01vZERhdGUgKEQ6MjAyNjA3MDcxMDM5NDMtMDQnMDAnKSAvUHJv",
  "ZHVjZXIgKFJlcG9ydExhYiBQREYgTGlicmFyeSAtIFwob3BlbnNvdXJjZVwpKSAKICAvU3ViamVjdCAodW5zcGVj",
  "aWZpZWQpIC9UaXRsZSAodW50aXRsZWQpIC9UcmFwcGVkIC9GYWxzZQo+PgplbmRvYmoKNyAwIG9iago8PAovQ291",
  "bnQgMSAvS2lkcyBbIDQgMCBSIF0gL1R5cGUgL1BhZ2VzCj4+CmVuZG9iago4IDAgb2JqCjw8Ci9GaWx0ZXIgWyAv",
  "QVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDMyMAo+PgpzdHJlYW0KR2FyPyw5aSZZXCUjNDZM",
  "KCUyX10vWls+T0Q2PS1rJU5IJTtgNDdHYD4qTHBGTVchc2BLYUpRVzAuV0BlcVFVPlFEcCVObyJSW2ZOLU5abGwl",
  "XSJjMElEVVVnI2Y4RTBBTChKazhyN1g9Vk9YSkNbVXQkW2tdVlkmaC5UcVljcXRfIz1lcGpnSTE9Tk4nIWYmPz0t",
  "Xy41MiNEIWBXJE85LTQ2I0RNTENpdG87Zks0TW4kJ0RdMldMY3FWYVtxLDBXMWtWV186U3BZSTNAalxTQUZVbT10",
  "am0+IjNCM1Qnb0lCUFEpWCMoWnMpOUkzNCs1JCFnNUxNODpoZXIvJm0sQ20sZzhNcUhBXjt0PGM3RGIyKnQ1ZFlE",
  "JWhdMlk/KlIuQmRJQFU4QUReVyM8YlZVcV1HMjkjKk1KcTpqQWQvfj5lbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA5",
  "CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMTAyIDAwMDAwIG4gCjAwMDAw",
  "MDAyMDkgMDAwMDAgbiAKMDAwMDAwMDMyMSAwMDAwMCBuIAowMDAwMDAwNTE0IDAwMDAwIG4gCjAwMDAwMDA1ODIg",
  "MDAwMDAgbiAKMDAwMDAwMDg0MyAwMDAwMCBuIAowMDAwMDAwOTAyIDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApb",
  "PDllYmU0NjY5YzgwZjIwNjJlNmJjNWE3YmNjNDhjZTA2Pjw5ZWJlNDY2OWM4MGYyMDYyZTZiYzVhN2JjYzQ4Y2Uw",
  "Nj5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0lu",
  "Zm8gNiAwIFIKL1Jvb3QgNSAwIFIKL1NpemUgOQo+PgpzdGFydHhyZWYKMTMxMgolJUVPRgo=",
].join("")}`;
export const EXAMPLE_FILE_ITEM = {
  id: "example-hopes-and-dreams",
  name: "hopes-and-dreams.pdf",
  type: "PDF",
  size: "",
  status: "example",
  detail: "Example file",
  previewKind: "pdf",
  previewUrl: EXAMPLE_PDF_DATA_URI,
  previewText: "Hello World",
};

const PROFILE_FIELDS = [
  "full_name",
  "email",
  "phone",
  "location",
  "linkedin",
  "github",
  "portfolio",
];
const SECTION_KEYS = ["experience", "education", "skills", "projects", "other"];

function extOf(filename) {
  const parts = String(filename || "").split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function fileTypeLabel(file) {
  return (extOf(file?.name) || "file").toUpperCase();
}

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileItemId(file, index) {
  return `${file?.name || "file"}-${file?.size || 0}-${file?.lastModified || 0}-${index}`;
}

function previewKindForFile(file) {
  const ext = extOf(file?.name);
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "document";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "metadata";
}

function filePreviewUrl(file) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function mergeSections(current, next) {
  if (!current) return next ?? null;
  if (!next) return current;
  const merged = { ...current };
  for (const key of SECTION_KEYS) {
    merged[key] = (Number(current[key]) || 0) + (Number(next[key]) || 0);
  }
  return merged;
}

function mergeClaims(current, incoming) {
  const existing = Array.isArray(current) ? current : [];
  const seen = new Set(
    existing.map(
      (claim) => `${String(claim.claim || "").trim()}::${String(claim.evidence || "").trim()}`
    )
  );
  const additions = [];
  for (const claim of incoming) {
    const key = `${String(claim.claim || "").trim()}::${String(claim.evidence || "").trim()}`;
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    additions.push({ ...claim, selected: true });
  }
  return [...existing, ...additions];
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

function ResumeFileRow({ item, selected, onPreview, onRemove }) {
  return (
    <li
      className={`onboarding-resume__file onboarding-resume__file--${item.status}${selected ? " onboarding-resume__file--selected" : ""}`}
    >
      <button
        type="button"
        className="onboarding-resume__file-preview"
        onClick={() => onPreview(item)}
        aria-label={`Open document preview for ${item.name}`}
      >
        <span className="onboarding-resume__file-type" aria-hidden="true">
          {item.type}
        </span>
        <span className="onboarding-resume__file-main">
          <span className="onboarding-resume__file-name">{item.name}</span>
          <span className="onboarding-resume__file-meta">
            {item.size ? `${item.size} · ` : ""}
            {item.detail}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="onboarding-resume__file-remove"
        onClick={() => onRemove(item.id)}
        aria-label={`Remove ${item.name}`}
      >
        ×
      </button>
    </li>
  );
}

export function ResumeDocumentViewer({ item, onClose }) {
  if (!item) return null;
  const previewUrl = item.previewUrl || null;
  const isPdf = item.previewKind === "pdf" && previewUrl;
  const isImage = item.previewKind === "image" && previewUrl;
  const bodyText =
    item.previewText ||
    (item.previewKind === "document"
      ? "DOCX preview will render here after extraction. The original file is still saved."
      : "Preview will render here when Rolester can display this file type.");

  return (
    <section
      className="onboarding-resume__document-viewer"
      role="dialog"
      aria-label="Resume document viewer"
    >
      <div className="onboarding-resume__document-toolbar">
        <div className="onboarding-resume__document-title">
          <span>{item.type || "File"} preview</span>
          <strong>{item.name}</strong>
        </div>
        <button
          type="button"
          className="onboarding-resume__document-close"
          onClick={onClose}
          aria-label="Close document preview"
        >
          ×
        </button>
      </div>
      <div className="onboarding-resume__document-stage">
        {isPdf ? (
          <object
            className="onboarding-resume__document-object"
            data={previewUrl}
            type="application/pdf"
            aria-label={`PDF preview of ${item.name}`}
          >
            <iframe src={previewUrl} title={`PDF preview of ${item.name}`} />
          </object>
        ) : isImage ? (
          <img
            className="onboarding-resume__document-image"
            src={previewUrl}
            alt={`Preview of ${item.name}`}
          />
        ) : (
          <div className="onboarding-resume__document-page">
            <span>{item.type || "FILE"}</span>
            <strong>{item.name}</strong>
            <p>{bodyText}</p>
          </div>
        )}
      </div>
    </section>
  );
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
    mode === "ai-unavailable" ? "Managed AI required" : unsupportedFileMessage(ext)
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
        "Managed AI is needed to extract PDF/image resumes. Paste your resume text below for now.",
      showPaste: true,
    };
  }
  if (err?.status === 501) {
    return {
      message: "Managed AI is unavailable right now — paste your resume text below instead.",
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

// Step 3 — Resume drop. Collapses M1's separate "resume" + "profile" +
// "evidence seed" screens into one review/edit step (the extraction already
// returns evidenceSeed.claims alongside profileSeed — no reason to make
// evidence its own screen, per the M8 design doc).
export function ResumeStep({
  state,
  aiEnabled,
  setDraftSeeds,
  goNext,
  goBack,
  onProgressSelect,
  showToast,
  initialTextMode = false,
}) {
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null); // "ai" | "text" | null
  const [sections, setSections] = useState(null);
  const [textMode, setTextMode] = useState(initialTextMode);
  const [pasteText, setPasteText] = useState("");
  const [uploadItems, setUploadItems] = useState([]);
  const [showExampleFile, setShowExampleFile] = useState(true);
  const [previewItem, setPreviewItem] = useState(null);

  const [profileFields, setProfileFields] = useState(() => {
    const candidate = state?.data?.profile?.candidate ?? {};
    const initial = {};
    for (const key of PROFILE_FIELDS) initial[key] = candidate[key] ?? "";
    return initial;
  });
  const [claims, setClaims] = useState([]);
  const [saving, setSaving] = useState(false);

  function applySeed(result, { appendClaims = false, appendSections = false } = {}) {
    setSource(result.source === "ai" ? "ai" : result.source === "docx" ? "docx" : "text");
    setSections((prev) =>
      appendSections ? mergeSections(prev, result.sections) : (result.sections ?? null)
    );
    const seedCandidate = result.profileSeed?.candidate ?? {};
    setProfileFields((prev) => {
      const next = { ...prev };
      for (const key of PROFILE_FIELDS) {
        if (seedCandidate[key]) next[key] = seedCandidate[key];
      }
      return next;
    });
    const seedClaims = result.evidenceSeed?.claims ?? [];
    setClaims((prev) =>
      appendClaims
        ? mergeClaims(prev, seedClaims)
        : seedClaims.map((c) => ({ ...c, selected: true }))
    );
    if (result.targetingSeed) {
      setDraftSeeds?.((prev) => ({ ...prev, targeting: result.targetingSeed }));
    }
  }

  async function handleFiles(files) {
    const fileList = Array.from(files || []).filter(Boolean);
    if (!fileList.length) return;

    const batchId = Date.now();
    const hadExistingItems = uploadItems.length > 0;
    const nextItems = fileList.map((file, index) => ({
      id: `${fileItemId(file, index)}-${batchId}`,
      name: file.name || "Untitled file",
      type: fileTypeLabel(file),
      size: formatFileSize(file.size),
      status: "queued",
      detail: "Queued",
      previewKind: previewKindForFile(file),
      previewUrl: filePreviewUrl(file),
    }));
    setUploadItems((items) => [...items, ...nextItems]);
    setShowExampleFile(false);
    setPreviewItem(null);
    setError(null);
    setBusy(true);

    for (const [index, file] of fileList.entries()) {
      const itemId = nextItems[index].id;
      const ext = extOf(file.name);
      const mode = getResumeUploadMode(file.name, { aiEnabled });
      setUploadItems((items) =>
        items.map((item) =>
          item.id === itemId ? { ...item, status: "reading", detail: "Reading..." } : item
        )
      );

      try {
        const { seed } = await parseResumeFileForReview(file, { aiEnabled });
        applySeed(seed, {
          appendClaims: true,
          appendSections: hadExistingItems || fileList.length > 1 || index > 0,
        });
        setUploadItems((items) =>
          items.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  status: "done",
                  detail:
                    seed.source === "ai"
                      ? "Extracted"
                      : seed.source === "docx"
                        ? "Parsed DOCX"
                        : "Parsed",
                }
              : item
          )
        );
      } catch (err) {
        const described = describeResumeUploadError(err, { mode, ext });
        setError(described.message);
        if (described.showPaste) setTextMode(true);
        setUploadItems((items) =>
          items.map((item) =>
            item.id === itemId ? { ...item, status: "error", detail: "Needs review" } : item
          )
        );
      }
    }

    setBusy(false);
  }

  function handlePreviewItem(item) {
    setPreviewItem(item);
  }

  function handleRemoveItem(itemId) {
    if (itemId === EXAMPLE_FILE_ITEM.id) {
      setShowExampleFile(false);
    } else {
      setUploadItems((items) => items.filter((item) => item.id !== itemId));
    }
    setPreviewItem((item) => (item?.id === itemId ? null : item));
  }

  async function handleAddTextAsFile() {
    if (!pasteText.trim()) return;
    const text = pasteText.trim();
    setError(null);
    setBusy(true);
    try {
      const result = await parseResumeText(text, { save: true });
      applySeed(result, {
        appendClaims: true,
        appendSections: uploadItems.length > 0,
      });
      const nextItem = {
        id: `pasted-resume-${Date.now()}`,
        name: `pasted-resume-${uploadItems.length + 1}.txt`,
        type: "TXT",
        size: `${text.length} chars`,
        status: "done",
        detail: "Added from text",
        previewKind: "text",
        previewText: text,
      };
      setUploadItems((items) => [...items, nextItem]);
      setShowExampleFile(false);
      setPreviewItem(nextItem);
      setPasteText("");
      setTextMode(false);
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

  const accept = aiEnabled ? `${LOCAL_ACCEPT},${AI_ACCEPT}` : LOCAL_ACCEPT;
  const visibleFileItems = uploadItems.length
    ? uploadItems
    : showExampleFile
      ? [EXAMPLE_FILE_ITEM]
      : [];

  return (
    <OnboardingShell
      activeIndex={2}
      className="onboarding-shell--resume"
      onProgressSelect={onProgressSelect}
      actions={
        <>
          <OnboardingNavButton direction="back" label="Back" onClick={goBack} />
          <OnboardingNavButton
            direction="next"
            label="Continue"
            onClick={handleSaveAndNext}
            disabled={saving}
          />
        </>
      }
    >
      <div className="onboarding-step-stack onboarding-step-stack--resume">
        <div className="onboarding-step-label">Step 2</div>
        <section
          className="onboarding-step-card onboarding-resume onboarding-step-card--compact"
          aria-labelledby="onboarding-resume-title"
        >
          <div className="onboarding-step-card__media onboarding-resume__title-side">
            <div className="onboarding-targeting__mark" aria-hidden="true">
              📄
            </div>
            <div className="onboarding-targeting__media-copy">
              <h1 id="onboarding-resume-title">Upload your resume</h1>
              <p>AI reads it in the black box and autofills* the rest.</p>
              <p className="onboarding-resume__footnote">*maybe</p>
            </div>
          </div>
          <div className="onboarding-step-card__content onboarding-step-card__content--dense onboarding-step-card__content--scroll onboarding-resume__action-side">
            <section className="onboarding-resume__upload-panel" aria-label="Upload resume">
              {textMode ? (
                <div className="onboarding-resume__text-entry">
                  <div className="onboarding-resume__text-entry-header">
                    <strong>Paste resume text</strong>
                    <button
                      type="button"
                      className="onboarding-resume__entry-switch"
                      onClick={() => setTextMode(false)}
                    >
                      Use file upload
                    </button>
                  </div>
                  <TextArea
                    id="resume-paste"
                    className="text-area textarea"
                    rows={6}
                    value={pasteText}
                    onChange={setPasteText}
                    placeholder="Paste resume text..."
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className={`dropzone onboarding-resume__dropzone${dragActive ? " dropzone--active" : ""}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragActive(false);
                    handleFiles(e.dataTransfer.files);
                  }}
                  disabled={busy}
                >
                  <span className="dropzone__icon">
                    <UploadIcon />
                  </span>
                  <span>{busy ? "Analyzing…" : "Drop files here"}</span>
                  <small>Click to select</small>
                  <span className="onboarding-resume__formats">
                    <span>DOCX</span>
                    <span>TXT</span>
                    <span>MD</span>
                    <span>PDF</span>
                    <span>PNG/JPG</span>
                  </span>
                </button>
              )}
            </section>
            <input
              ref={fileInputRef}
              type="file"
              accept={accept}
              multiple
              style={{ display: "none" }}
              onChange={(e) => handleFiles(e.target.files)}
            />
            <section className="onboarding-resume__files-panel" aria-label="Resume files">
              <div className="onboarding-resume__files-header">Files</div>
              {visibleFileItems.length ? (
                <ul
                  className="onboarding-resume__file-list"
                  aria-label={uploadItems.length ? "Selected resume files" : "Example resume files"}
                >
                  {visibleFileItems.map((item) => (
                    <ResumeFileRow
                      key={item.id}
                      item={item}
                      selected={previewItem?.id === item.id}
                      onPreview={handlePreviewItem}
                      onRemove={handleRemoveItem}
                    />
                  ))}
                </ul>
              ) : null}
              {error ? <InlineAlert message={error} /> : null}
            </section>

            <section
              className="onboarding-step-card__section onboarding-resume__paste-section"
              aria-label="Resume paste"
            >
              <button
                type="button"
                className="btn btn--secondary onboarding-resume__paste-toggle"
                onClick={textMode ? handleAddTextAsFile : () => setTextMode(true)}
                disabled={textMode ? busy || !pasteText.trim() : false}
              >
                {textMode ? "Add text as file" : "Add resume text"}
              </button>
            </section>

            {source ? (
              <section className="onboarding-step-card__section" aria-label="Review and edit">
                <h4 style={{ margin: "4px 0" }}>Review & edit</h4>
                <p className="field__hint">
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
                  <div className="onboarding-step-card__section">
                    <p className="field__label">
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
              </section>
            ) : null}
            {previewItem ? (
              <ResumeDocumentViewer item={previewItem} onClose={() => setPreviewItem(null)} />
            ) : null}
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
