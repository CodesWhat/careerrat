import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button.jsx";
import { PaperclipIcon } from "../components/icons.jsx";
import { kindLabel } from "../inbox/intake-labels.js";
import { ApiError, createIntake, uploadIntakeFile } from "../lib/api.js";
import { emitIntakeChanged } from "../lib/intake-events.js";

// CaptureBar — the M9 capture surface, now presented as Roland's floating
// assistant instead of a docked paste bar. It is still the INPUT surface only:
// on submit it shows what POST /api/intake's already-classified response says,
// then the item lives on in the /inbox queue.
//
// Paste-capture rule (M9 build brief DoD item, grep-checked): the paste
// handler below is `onPaste` on this component's own <textarea> element,
// never `document.addEventListener("paste", …)` — a global listener would
// leak into every ordinary text input elsewhere in the app (onboarding
// steps, Settings). Same scoping for drop: `onDrop` lives on this
// component's own wrapper div, not `window`.
//
// Binary drops go through POST /api/intake/upload and land in Inbox as
// capture-only file items. Dropping a *text* file (a .txt/.md JD, a dragged
// link) is still handled client-side by reading it into the textarea, so the
// user can inspect/edit before submitting the normal text intake path.
export function CaptureBar() {
  return <CaptureBarView />;
}

export function CaptureBarView({ initiallyOpen = false } = {}) {
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const [open, setOpen] = useState(initiallyOpen);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState(null);
  const [degradeNote, setDegradeNote] = useState(null);
  const [result, setResult] = useState(null);

  function describeCaptureError(err) {
    if (err instanceof ApiError) {
      // 409 NO_DATABASE — the fail-closed hint every /api/data/* route
      // already surfaces for a legacy (pre-migration) workspace; intake is
      // DB-native by construction (migration 002), so this is expected on an
      // un-migrated workspace, not a bug. Show the server's own actionable
      // message verbatim rather than a generic "request failed."
      if (err.status === 409) {
        return (
          err.body?.error ||
          "No database workspace detected — run `rolester data import` (or `rolester data init`) first."
        );
      }
      return err.body?.error || `Capture failed (${err.status}).`;
    }
    return err instanceof Error ? err.message : "Capture failed.";
  }

  async function submit(value) {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    setOpen(true);
    setSubmitting(true);
    setError(null);
    setDegradeNote(null);
    try {
      const { item } = await createIntake({ text: trimmed });
      setText("");
      setResult(item);
      emitIntakeChanged();
    } catch (err) {
      setError(describeCaptureError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadFile(file) {
    if (!file || submitting) return;
    setOpen(true);
    setSubmitting(true);
    setError(null);
    setDegradeNote(null);
    try {
      const { item } = await uploadIntakeFile(file);
      setResult(item);
      emitIntakeChanged();
    } catch (err) {
      setError(describeCaptureError(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(text);
    }
  }

  async function handleFileSelection(e) {
    const file = e.target.files?.[0];
    if (file) await uploadFile(file);
    e.target.value = "";
  }

  // Scoped to this textarea only — see the file header comment. Plain text
  // pastes need no special handling at all (the browser lands them in the
  // field, onChange picks up the result); this only intercepts the one case
  // that can't work today: a screenshot/image paste with no backend route to
  // receive it.
  function handlePaste(e) {
    const files = Array.from(e.clipboardData?.files || []);
    const hasText = !!e.clipboardData?.getData("text/plain");
    if (files.length && !hasText) {
      e.preventDefault();
      void uploadFile(files[0]);
    }
  }

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("could not read file"));
      reader.readAsText(file);
    });
  }

  async function handleDrop(e) {
    e.preventDefault();
    setOpen(true);
    setDragActive(false);
    setDegradeNote(null);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      if (file.type.startsWith("text/") || /\.(txt|md|markdown)$/i.test(file.name)) {
        try {
          const content = await readAsText(file);
          setText((prev) => (prev ? `${prev}\n${content}` : content));
        } catch {
          setDegradeNote("Couldn't read that file as text — try pasting it instead.");
        }
      } else {
        await uploadFile(file);
      }
      return;
    }

    const dropped = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (dropped) setText((prev) => (prev ? `${prev}\n${dropped}` : dropped));
  }

  // Drag/drop has no interactive-role equivalent; the bar's real controls
  // (textarea, Button) underneath are each independently keyboard/screen-
  // reader operable — drop is a mouse-only convenience layered on top, same
  // as ResumeStep's own dropzone pattern.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag/drop wrapper, see comment above
    <section
      className={`capture-assistant${open ? " capture-assistant--open" : ""}${dragActive ? " capture-assistant--drag-active" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOpen(true);
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
    >
      {open ? (
        <div className="capture-assistant__panel" role="dialog" aria-label="Talk to Roland">
          <header className="capture-assistant__header">
            <span className="capture-assistant__mini-headshot" aria-hidden="true">
              <img src="/assets/logo.png" alt="" />
            </span>
            <span className="capture-assistant__intro">
              <strong>Roland</strong>
            </span>
            <button
              type="button"
              className="capture-assistant__close"
              onClick={() => setOpen(false)}
              aria-label="Close Roland intake"
            >
              ×
            </button>
          </header>

          {result ? (
            <CaptureResult item={result} onDismiss={() => setResult(null)} />
          ) : (
            <div className="capture-assistant__composer">
              <div className="capture-assistant__input-row">
                <textarea
                  ref={textareaRef}
                  className="capture-assistant__input"
                  rows={4}
                  placeholder="Add a job posting, recruiter email, status update, or drop a file/link..."
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onPaste={handlePaste}
                  onKeyDown={handleKeyDown}
                  aria-keyshortcuts="Enter Shift+Enter"
                  disabled={submitting}
                />
              </div>
              <div className="capture-assistant__footer">
                <input
                  ref={fileInputRef}
                  className="capture-assistant__file-input"
                  type="file"
                  onChange={handleFileSelection}
                  aria-label="Attach a file to Roland"
                />
                <div className="capture-assistant__actions">
                  <button
                    type="button"
                    className="capture-assistant__upload"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={submitting}
                  >
                    <PaperclipIcon />
                    <span>Attach</span>
                  </button>
                  <Button
                    className="capture-assistant__send"
                    aria-label="Send to Roland"
                    onClick={() => submit(text)}
                    disabled={submitting || !text.trim()}
                  >
                    {submitting ? "Capturing…" : "Send"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {error ? (
            <div className="capture-assistant__note capture-assistant__note--error">{error}</div>
          ) : null}
          {degradeNote && !result ? (
            <div className="capture-assistant__note capture-assistant__note--warn">
              {degradeNote}
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        className="capture-assistant__launcher"
        aria-label="Open Roland intake"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="capture-assistant__headshot" aria-hidden="true">
          <img src="/assets/logo.png" alt="" />
        </span>
        <span className="capture-assistant__launcher-copy">
          <strong>Talk to Roland</strong>
          <small>Drop jobs, emails, docs</small>
        </span>
      </button>
    </section>
  );
}

// The "immediate feedback with the classify result inline" surface — POST
// /api/intake is awaited server-side end to end (classifyAndPropose runs
// before the response goes out), so `item` here already carries the full
// classification, the deterministic trackerMatch, and the resolved dispatch
// — nothing further to poll for before showing this.
function CaptureResult({ item, onDismiss }) {
  const needsUser = item.status === "needs_you";
  // M10: read straight off the API response (src/core/intake/dispatch-summary.mjs,
  // computed server-side once) — no more client-side formatDispatchSummary mirror.
  const dispatchSummary = item.dispatchSummary;
  return (
    <div className="capture-result">
      <div className="capture-result__row">
        <span className="badge badge--muted">{kindLabel(item.kind)}</span>
        {item.trackerMatch?.matched ? <span className="badge badge--ok">Tracker match</span> : null}
        <span className="capture-result__spacer" />
        <Link className="capture-result__link" to="/inbox" onClick={onDismiss}>
          Open Inbox
        </Link>
        <button
          type="button"
          className="capture-assistant__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      <p className="capture-result__action">
        {item.classification?.proposedAction || "Captured — classifying…"}
      </p>
      {item.trackerMatch?.matched ? (
        <p className="capture-result__match">{item.trackerMatch.summary}</p>
      ) : null}
      {needsUser ? (
        <p className="capture-result__needs-you">
          Needs you: {item.classification?.needsUserReason || "review manually in the Inbox."}
        </p>
      ) : dispatchSummary ? (
        <p className="capture-result__dispatch">Will: {dispatchSummary}</p>
      ) : null}
    </div>
  );
}
