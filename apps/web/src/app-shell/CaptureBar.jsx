import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button.jsx";
import { UploadIcon } from "../components/icons.jsx";
import { kindLabel } from "../inbox/intake-labels.js";
import { ApiError, createIntake } from "../lib/api.js";
import { emitIntakeChanged } from "../lib/intake-events.js";

// CaptureBar — the M9 "docked capture bar": a persistent paste/drop/type
// surface mounted in AppShell.jsx alongside <main>, visible on every route
// (including the still-stubbed M10 ones). This is the INPUT surface only —
// per the M9 design memo it never renders a growing transcript of its own;
// on submit it shows what POST /api/intake's already-classified response
// says, then the item lives on in the /inbox queue.
//
// Paste-capture rule (M9 build brief DoD item, grep-checked): the paste
// handler below is `onPaste` on this component's own <textarea> element,
// never `document.addEventListener("paste", …)` — a global listener would
// leak into every ordinary text input elsewhere in the app (onboarding
// steps, Settings). Same scoping for drop: `onDrop` lives on this
// component's own wrapper div, not `window`.
//
// File-drop honesty note: intake-route.mjs's POST /api/intake only accepts
// `{ text, inputKind }` — unlike onboard-route.mjs's resume-ai route, M9's
// backend has no raw-bytes upload endpoint for intake (the M9 design memo's
// "workspace/intake/uploads/" file-drop path was scoped but not built in the
// committed backend). Dropping a *text* file (a .txt/.md JD, a dragged link)
// is handled here by reading it client-side and populating the textarea; a
// PDF/image/binary drop degrades to an honest inline message rather than
// silently doing nothing or inventing an upload call that doesn't exist.
export function CaptureBar() {
  const textareaRef = useRef(null);
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

  function handleKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit(text);
    }
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
      setDegradeNote(
        "Image/file pastes aren't wired up to intake yet — paste the text instead (a JD body, an email, a link)."
      );
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
        setDegradeNote(
          `File drops aren't wired up to intake yet — "${file.name}" wasn't captured. Paste the text instead.`
        );
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
    <div
      className={`capture-bar${dragActive ? " capture-bar--drag-active" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
    >
      {result ? (
        <CaptureResult item={result} onDismiss={() => setResult(null)} />
      ) : (
        <div className="capture-bar__row">
          <span className="capture-bar__icon" aria-hidden="true">
            <UploadIcon />
          </span>
          <textarea
            ref={textareaRef}
            className="capture-bar__input"
            rows={1}
            placeholder="Paste a job posting, recruiter email, status update, or drop a link… (⌘/Ctrl+Enter to send)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            disabled={submitting}
          />
          <Button onClick={() => submit(text)} disabled={submitting || !text.trim()}>
            {submitting ? "Capturing…" : "Capture"}
          </Button>
        </div>
      )}
      {error ? <div className="capture-bar__note capture-bar__note--error">{error}</div> : null}
      {degradeNote && !result ? (
        <div className="capture-bar__note capture-bar__note--warn">{degradeNote}</div>
      ) : null}
    </div>
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
          className="capture-bar__dismiss"
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
