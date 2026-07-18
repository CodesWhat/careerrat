// AiSearchPrompts.jsx — "AI search prompts" control on the Jobs > Search
// tab's AI Web Search SearchModeCard (Scott, 2026-07-18: the earlier
// embedded header row + Regenerate button + four prompt chips + Add prompt +
// Save took over the card and looked awful). The card body now shows a
// single secondary button — "AI prompts (N)" — and everything else (the
// prompt list, Regenerate, Add prompt, Remove, and the real persisting Save)
// lives behind AiSearchPromptsModal, opened by that one button. Generate-
// first (Scott's product decision, not career-ops' hand-write-it-yourself
// model): Rolester generates plain-English AI-search-assistant prompts from
// the candidate's stored targeting/profile (src/core/search/search-
// prompts.mjs), and the user edits/adds/removes rows from there. Generation
// is EXPLICIT-ONLY (the Regenerate button) — these prompts feed the AI
// web-search lane, not the free board sweep, so auto-firing a metered AI
// call on tab mount spent money without user intent (Scott, 2026-07-14: free
// searches are board API calls, no AI needed).
//
// Each prompt is a textarea row inside the modal (the pre-chip design,
// restored) — full text editable in place, no separate per-prompt modal.
// Closing the manager modal does NOT discard unsaved edits: rows/dirty state
// lives in this component, not the modal, so unmounting the modal just hides
// the surface — the same "dirty means edited since the last persist" contract
// as before.

import { useEffect, useState } from "react";
import { Button, IconButton } from "../components/Button.jsx";
import { TextArea } from "../components/form.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  generateSearchPrompts,
  getRuntimeConfig,
  getSearchPrompts,
  saveSearchPrompts,
} from "../lib/api.js";

let draftCounter = 0;
function nextDraftId() {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

function normalizeRows(prompts) {
  return (Array.isArray(prompts) ? prompts : []).map((prompt) => ({
    id: prompt?.id || nextDraftId(),
    text: String(prompt?.text || ""),
    source: prompt?.source || "generated",
  }));
}

function errorMessage(err, fallback) {
  return err instanceof Error ? err.message : fallback;
}

// "AI prompts (3)" / "AI prompts" (0 omits the parenthetical), with a
// trailing dot when there are unsaved edits — same subtle-suffix idiom as a
// plain dirty marker, no new badge/chrome on the card.
function toggleLabel(count, dirty) {
  const label = count ? `AI prompts (${count})` : "AI prompts";
  return dirty ? `${label} •` : label;
}

// `onPromptsState` is an optional callback for the Search tab's AI Web
// Search launcher card (JobsPage.jsx) — it has no other way to know how many
// saved (non-blank) prompts exist or whether there are unsaved edits, and
// duplicating the getSearchPrompts() fetch there would just race this
// component's own copy. Fired after every rows/dirty/loading change; pass a
// referentially-stable callback (e.g. via useCallback) to avoid re-firing on
// every parent render.
export function AiSearchPrompts({ onPromptsState } = {}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  useEffect(() => {
    onPromptsState?.({
      count: rows.filter((row) => row.text.trim()).length,
      dirty,
      loading,
    });
  }, [rows, dirty, loading, onPromptsState]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSearchPrompts(), getRuntimeConfig()])
      .then(([promptsBody, runtimeConfig]) => {
        if (cancelled) return;
        setRows(normalizeRows(promptsBody?.data?.prompts));
        setAiEnabled(runtimeConfig?.ai?.available === true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err, "Could not load search prompts."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const body = await generateSearchPrompts();
      setRows(normalizeRows(body?.data?.prompts));
      setDirty(false);
    } catch (err) {
      setError(errorMessage(err, "Could not generate search prompts."));
    } finally {
      setGenerating(false);
    }
  }

  function updateRow(id, text) {
    setDirty(true);
    setRows((current) => current.map((row) => (row.id === id ? { ...row, text } : row)));
  }

  function removeRow(id) {
    setDirty(true);
    setRows((current) => current.filter((row) => row.id !== id));
  }

  function addRow() {
    setDirty(true);
    setRows((current) => [...current, { id: nextDraftId(), text: "", source: "user" }]);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const posted = rows
        .filter((row) => row.text.trim())
        .map((row) =>
          row.id.startsWith("draft-") ? { text: row.text } : { id: row.id, text: row.text }
        );
      const body = await saveSearchPrompts(posted);
      setRows(normalizeRows(body?.data?.prompts));
      setDirty(false);
    } catch (err) {
      setError(errorMessage(err, "Could not save search prompts."));
    } finally {
      setSaving(false);
    }
  }

  const count = rows.filter((row) => row.text.trim()).length;

  return (
    <>
      <Button variant="secondary" onClick={() => setManagerOpen(true)}>
        {toggleLabel(count, dirty)}
      </Button>

      {managerOpen ? (
        <AiSearchPromptsModal
          rows={rows}
          loading={loading}
          generating={generating}
          saving={saving}
          dirty={dirty}
          error={error}
          aiEnabled={aiEnabled}
          onGenerate={handleGenerate}
          onUpdateRow={updateRow}
          onRemoveRow={removeRow}
          onAddRow={addRow}
          onSave={handleSave}
          onClose={() => setManagerOpen(false)}
        />
      ) : null}
    </>
  );
}

// The full prompt manager — list/generate/add/remove/save — behind the
// card's single "AI prompts" button. Same overlay/toolbar/close scaffold as
// ArtifactViewerModal.jsx (packet-viewer-overlay / packet-viewer__toolbar /
// __title / __close), including its close button's -webkit-app-region:
// no-drag (that class already carries the rule — see app.css), since this
// overlay paints over the frameless window's drag strip the same way.
function AiSearchPromptsModal({
  rows,
  loading,
  generating,
  saving,
  dirty,
  error,
  aiEnabled,
  onGenerate,
  onUpdateRow,
  onRemoveRow,
  onAddRow,
  onSave,
  onClose,
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only backdrop, same convention as ArtifactViewerModal
    // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop, same convention as ArtifactViewerModal
    <div className="packet-viewer-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop's click-to-close from firing; not itself an interactive control */}
      <div
        className="jobs__ai-prompts-modal"
        role="dialog"
        aria-label="AI search prompts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="packet-viewer__toolbar">
          <strong className="packet-viewer__title">AI search prompts</strong>
          <span className="jobs__ai-prompts-modal-toolbar-actions">
            <Button variant="secondary" disabled={!aiEnabled || generating} onClick={onGenerate}>
              {generating ? "Regenerating…" : "Regenerate"}
            </Button>
            <IconButton label="Close" className="packet-viewer__close" onClick={onClose}>
              ×
            </IconButton>
          </span>
        </div>

        {error ? <InlineAlert message={error} /> : null}
        {!aiEnabled ? (
          <p className="jobs__ai-prompts-hint">
            Configure an AI key in Settings to generate prompts automatically.
          </p>
        ) : null}

        <div className="jobs__ai-prompts-modal-body">
          {loading ? (
            <p className="jobs__ai-prompts-hint">Loading…</p>
          ) : rows.length ? (
            <div className="jobs__ai-prompts-list">
              {rows.map((row) => (
                <div className="jobs__ai-prompts-row" key={row.id}>
                  <TextArea
                    id={`ai-prompt-${row.id}`}
                    rows={2}
                    value={row.text}
                    onChange={(value) => onUpdateRow(row.id, value)}
                  />
                  <button
                    type="button"
                    className="jobs__ai-prompts-remove"
                    aria-label="Remove prompt"
                    onClick={() => onRemoveRow(row.id)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="jobs__ai-prompts-empty">
              {generating
                ? "Generating prompts…"
                : "No AI search prompts yet. Regenerate builds them from your targeting."}
            </div>
          )}
        </div>

        <div className="jobs__ai-prompts-actions">
          <Button variant="secondary" onClick={onAddRow}>
            Add prompt
          </Button>
          <Button disabled={saving || !dirty} onClick={onSave}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
