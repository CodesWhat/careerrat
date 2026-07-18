// AiSearchPrompts.jsx — "AI search prompts" control embedded directly in the
// AI Web Search SearchModeCard on the Jobs > Search tab (Scott, 2026-07-18:
// the prompts are part of the AI search card, not a standalone section below
// it). Generate-first (Scott's product decision, not career-ops' hand-write-
// it-yourself model): Rolester generates plain-English AI-search-assistant
// prompts from the candidate's stored targeting/profile
// (src/core/search/search-prompts.mjs), and the user edits/adds/removes rows
// from there. Generation is EXPLICIT-ONLY (the Regenerate button) — these
// prompts feed the AI web-search lane, not the free board sweep, so
// auto-firing a metered AI call on tab mount spent money without user intent
// (Scott, 2026-07-14: free searches are board API calls, no AI needed).
//
// Each prompt renders as a compact chip (full text lives on the row, clamped
// to two lines) — clicking a chip opens AiSearchPromptModal for the full
// view/edit/remove surface. The modal's Save/Remove only commit the edit
// into local row state (same as the old inline TextArea's onChange/Remove
// did) — the card's own Save button below the chip list still owns the
// actual saveSearchPrompts() persist, exactly as before. That keeps the
// existing dirty/onPromptsState contract intact: `dirty` still means
// "edited since the last persist", not "edited since the last modal close".

import { useEffect, useState } from "react";
import { Button, IconButton } from "../components/Button.jsx";
import { TextArea } from "../components/form.jsx";
import { MagicWandIcon, PencilIcon } from "../components/icons.jsx";
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
  const [editingId, setEditingId] = useState(null);

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
    const id = nextDraftId();
    setRows((current) => [...current, { id, text: "", source: "user" }]);
    setEditingId(id);
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

  const editingRow = editingId ? rows.find((row) => row.id === editingId) || null : null;

  return (
    <div className="jobs__ai-prompts-embedded">
      <div className="jobs__ai-prompts-embedded-head">
        <span className="jobs__ai-prompts-embedded-label">
          <MagicWandIcon />
          <span>AI search prompts</span>
        </span>
        <Button variant="secondary" disabled={!aiEnabled || generating} onClick={handleGenerate}>
          {generating ? "Regenerating…" : "Regenerate"}
        </Button>
      </div>

      {error ? <InlineAlert message={error} /> : null}
      {!aiEnabled ? (
        <p className="jobs__ai-prompts-hint">
          Configure an AI key in Settings to generate prompts automatically.
        </p>
      ) : null}

      {loading ? (
        <p className="jobs__ai-prompts-hint">Loading…</p>
      ) : rows.length ? (
        <div className="jobs__ai-prompts-chips">
          {rows.map((row) => (
            <button
              type="button"
              className="jobs__ai-prompt-chip"
              key={row.id}
              onClick={() => setEditingId(row.id)}
            >
              <span className="jobs__ai-prompt-chip-text">
                {row.text.trim() || "Empty prompt — click to write one"}
              </span>
              <span className="jobs__ai-prompt-chip-action" aria-hidden="true">
                <PencilIcon />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="jobs__ai-prompts-empty">
          {generating
            ? "Generating prompts…"
            : "No AI search prompts yet. Regenerate builds them from your targeting."}
        </div>
      )}

      <div className="jobs__ai-prompts-actions">
        <Button variant="secondary" onClick={addRow}>
          Add prompt
        </Button>
        <Button disabled={saving || !dirty} onClick={handleSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      {editingRow ? (
        <AiSearchPromptModal
          row={editingRow}
          onCancel={() => setEditingId(null)}
          onRemove={() => {
            removeRow(editingRow.id);
            setEditingId(null);
          }}
          onSave={(text) => {
            updateRow(editingRow.id, text);
            setEditingId(null);
          }}
        />
      ) : null}
    </div>
  );
}

// See or edit a single prompt's full text — the compact chip list above only
// shows a two-line clamp. Same overlay/toolbar/close scaffold as
// ArtifactViewerModal.jsx (packet-viewer-overlay / packet-viewer__toolbar /
// __title / __close), including its close button's -webkit-app-region:
// no-drag (that class already carries the rule — see app.css), since this
// overlay paints over the frameless window's drag strip the same way.
function AiSearchPromptModal({ row, onCancel, onRemove, onSave }) {
  const [text, setText] = useState(row.text);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only backdrop, same convention as ArtifactViewerModal
    // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop, same convention as ArtifactViewerModal
    <div className="packet-viewer-overlay" onClick={onCancel}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop's click-to-close from firing; not itself an interactive control */}
      <div
        className="jobs__ai-prompt-modal"
        role="dialog"
        aria-label="Edit AI search prompt"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="packet-viewer__toolbar">
          <strong className="packet-viewer__title">AI search prompt</strong>
          <IconButton label="Close" className="packet-viewer__close" onClick={onCancel}>
            ×
          </IconButton>
        </div>
        <div className="jobs__ai-prompt-modal-body">
          <TextArea id={`ai-prompt-modal-${row.id}`} rows={7} value={text} onChange={setText} />
        </div>
        <div className="jobs__ai-prompt-modal-actions">
          <button type="button" className="jobs__ai-prompt-modal-remove" onClick={onRemove}>
            Remove prompt
          </button>
          <span className="jobs__ai-prompt-modal-buttons">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={() => onSave(text)}>Save</Button>
          </span>
        </div>
      </div>
    </div>
  );
}
