import { useRef, useState } from "react";
import { ArrowUpIcon, UploadIcon } from "../components/icons.jsx";
import { useGlobalShortcut } from "../lib/useGlobalShortcut.js";

// OnboardingBar — the W4 chat-first onboarding surface's interview bar.
// Per the finalized "Bar reuse" section of the W4 spec: the W3 AskBar.jsx
// (apps/web/src/app-shell/AskBar.jsx) is workspace-agent logic (intent
// preview/action-vs-answer/thread-poll) wrapped around a visual shell that
// this surface doesn't need (no intent preview until setup completes, no
// action/answer split — every reply is just a chat turn). So this is a NEW
// component that reuses the `.ask-bar*` CSS anatomy (`__shell`, `__row`,
// `__input`, `__send`, `__kbd`), ArrowUpIcon, and useGlobalShortcut —
// AskBar.jsx itself is untouched, no interview mode was added to it.
//
// `mode` selects the markup's only real variance:
//   - "centered": 3a's opening state — static-positioned inside the hero
//     flex column (`.ask-bar--centered` in app.css strips the shipped bar's
//     fixed-bottom-of-viewport positioning), plus the inline résumé-drop
//     affordance row above the input.
//   - "docked": identical positioning to the shipped AppShell AskBar (fixed,
//     bottom-center) — the same physical bar, just relocated by CSS, per the
//     spec's "docking is a layout change in the onboarding surface, not a
//     new component."
export function OnboardingBar({
  mode = "centered",
  placeholder = "Tell it what you're hunting, or just drop your résumé in.",
  value,
  onChange,
  onSend,
  onDropResume,
  disabled = false,
  busy = false,
}) {
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [internalValue, setInternalValue] = useState("");
  const text = value ?? internalValue;
  const setText = onChange ?? setInternalValue;

  useGlobalShortcut("k", () => {
    inputRef.current?.focus();
  });

  function commit() {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    onSend?.(trimmed);
    setText("");
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    }
  }

  function handleFiles(files) {
    const file = files?.[0];
    if (file) onDropResume?.(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer?.files);
  }

  const showResumeAffordance = mode === "centered" && typeof onDropResume === "function";

  return (
    <div className={`ask-bar${mode === "centered" ? " ask-bar--centered" : ""}`}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop resume affordance; the visible upload button above is the keyboard/click equivalent */}
      <div
        className={`ask-bar__shell${dragOver ? " ask-bar__shell--drag-over" : ""}`}
        onDragOver={
          showResumeAffordance
            ? (e) => {
                e.preventDefault();
                setDragOver(true);
              }
            : undefined
        }
        onDragLeave={showResumeAffordance ? () => setDragOver(false) : undefined}
        onDrop={showResumeAffordance ? handleDrop : undefined}
      >
        {showResumeAffordance ? (
          <button
            type="button"
            className="onboarding-bar__resume-row"
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="onboarding-bar__resume-label">
              <UploadIcon className="onboarding-bar__resume-icon" />
              DROP A RÉSUMÉ · PDF DOCX TXT MD
            </span>
            <span className="onboarding-bar__resume-affordance" aria-hidden="true">
              <UploadIcon />
            </span>
          </button>
        ) : null}
        {showResumeAffordance ? (
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            className="onboarding-bar__file-input"
            onChange={(e) => handleFiles(e.target.files)}
          />
        ) : null}
        <div className="ask-bar__row">
          <input
            ref={inputRef}
            type="text"
            className="ask-bar__input"
            placeholder={placeholder}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {!text.trim() ? (
            <span className="ask-bar__kbd" aria-hidden="true">
              ⌘K
            </span>
          ) : null}
          <button
            type="button"
            className="ask-bar__send"
            aria-label="Send"
            disabled={!text.trim() || busy || disabled}
            onClick={commit}
          >
            <ArrowUpIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
