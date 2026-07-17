// AiSearchPrompts.jsx — "AI search prompts" panel on the Jobs > Search tab.
// Generate-first (Scott's product decision, not career-ops' hand-write-it-
// yourself model): Rolester generates plain-English AI-search-assistant
// prompts from the candidate's stored targeting/profile
// (src/core/search/search-prompts.mjs), and the user edits/adds/removes rows
// from there. Generation is EXPLICIT-ONLY (the Regenerate button) — these
// prompts feed the AI web-search lane, not the free board sweep, so
// auto-firing a metered AI call on tab mount spent money without user intent
// (Scott, 2026-07-14: free searches are board API calls, no AI needed).

import { useEffect, useState } from "react";
import { Button } from "../components/Button.jsx";
import { TextArea } from "../components/form.jsx";
import { MagicWandIcon } from "../components/icons.jsx";
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

  return (
    <section className="jobs__panel jobs__ai-prompts" aria-label="AI search prompts">
      <header className="jobs__panel-header">
        <h2>
          <span className="jobs__panel-icon" aria-hidden="true">
            <MagicWandIcon />
          </span>
          <span>AI search prompts</span>
        </h2>
        <Button variant="secondary" disabled={!aiEnabled || generating} onClick={handleGenerate}>
          {generating ? "Regenerating…" : "Regenerate"}
        </Button>
      </header>

      {error ? <InlineAlert message={error} /> : null}
      {!aiEnabled ? (
        <p className="jobs__ai-prompts-hint">
          Configure an AI key in Settings to generate prompts automatically.
        </p>
      ) : null}

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
                onChange={(value) => updateRow(row.id, value)}
              />
              <button
                type="button"
                className="jobs__ai-prompts-remove"
                aria-label="Remove prompt"
                onClick={() => removeRow(row.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="jobs__empty">
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
    </section>
  );
}
