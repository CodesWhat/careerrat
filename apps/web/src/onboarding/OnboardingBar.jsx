import { useRef, useState } from "react";
import { ArrowUpIcon, UploadIcon } from "../components/icons.jsx";

// OnboardingBar — the W4 chat-first onboarding surface's interview bar.
// Per the finalized "Bar reuse" section of the W4 spec: the W3 AskBar.jsx
// (apps/web/src/app-shell/AskBar.jsx) is workspace-agent logic (intent
// preview/action-vs-answer/thread-poll) wrapped around a visual shell that
// this surface doesn't need (no intent preview until setup completes, no
// action/answer split — every reply is just a chat turn). So this is a NEW
// component that reuses the `.ask-bar*` CSS anatomy (`__shell`, `__row`,
// `__input`, `__send`) and ArrowUpIcon — AskBar.jsx itself is untouched, no
// interview mode was added to it. The shell bar's ⌘K focus shortcut and its
// hint are deliberately NOT reused here: during setup this input is the only
// thing on screen and already focused, so the shortcut had nothing to jump
// from, and the hint only taught a browser-shortcut override nobody needed.
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
// The accepted formats used to be spelled out in a mono-caps band above the
// input ("DROP A RÉSUMÉ · PDF DOCX TXT MD"). They live here instead: the file
// picker already filters by `accept`, so on screen it was noise stacked on top
// of a second upload button.
const RESUME_ATTACH_LABEL = "Attach a résumé (PDF, DOCX, TXT, or MD)";

export function OnboardingBar({
  mode = "centered",
  placeholder = "Tell Paul what you're hunting, or paste your résumé text here.",
  value,
  onChange,
  // Optional: lets the caller focus the input (the hero's suggestion chips
  // drop text in and put the cursor there). Falls back to a local ref.
  inputRef: providedInputRef,
  onSend,
  onDropResume,
  disabled = false,
  busy = false,
}) {
  const localInputRef = useRef(null);
  const inputRef = providedInputRef ?? localInputRef;
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [internalValue, setInternalValue] = useState("");
  const text = value ?? internalValue;
  const setText = onChange ?? setInternalValue;

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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop resume affordance; the attach button in the row is the keyboard/click equivalent */}
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
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            className="onboarding-bar__file-input"
            onChange={(e) => handleFiles(e.target.files)}
          />
        ) : null}
        <div className="ask-bar__row">
          {showResumeAffordance ? (
            <button
              type="button"
              className="onboarding-bar__attach"
              aria-label={RESUME_ATTACH_LABEL}
              title={RESUME_ATTACH_LABEL}
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon />
            </button>
          ) : null}
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
