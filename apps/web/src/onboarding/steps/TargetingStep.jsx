import { useEffect, useState } from "react";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { SuggestionChip } from "../../components/Chip.jsx";
import { ChipInput, Field } from "../../components/form.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { previewBoards, saveCandidateFile, suggestAssist } from "../../lib/api.js";

const PREVIEW_DEBOUNCE_MS = 400;

function assistErrorMessage(err) {
  if (err?.status === 501) return "No AI key configured — add one in the AI key step.";
  if (err?.status === 422) return "Roland couldn't produce a suggestion this time — try again.";
  return err instanceof Error ? err.message : "Suggestion failed";
}

// Step 4 — Targeting. Roland-suggest chips are staged, never auto-committed
// (SuggestionChip's accept/dismiss) — the actual persistence still goes
// through the same Save & continue button every other field uses, matching
// SettingsPage.jsx's handleSectionSave convention. The board-URL preview
// calls the additive POST /api/boards/preview (src/cli/boards-route.mjs) —
// read-only here on purpose; "add to my search sources" is deferred to the
// Finish step so it isn't silently wiped by write-config's wholesale
// search-sources.yml regen (see that route's own header comment).
export function TargetingStep({ state, aiEnabled, goNext, goBack, showToast }) {
  const initialBucket = state?.data?.targeting?.role_buckets?.[0];
  const [titles, setTitles] = useState(initialBucket?.titles ?? []);
  const [keepSignals, setKeepSignals] = useState(state?.data?.targeting?.keep_signals ?? []);
  const [cutSignals, setCutSignals] = useState(state?.data?.targeting?.cut_signals ?? []);

  const [titleSuggestions, setTitleSuggestions] = useState([]);
  const [keywordSuggestions, setKeywordSuggestions] = useState([]);
  const [suggestingTitles, setSuggestingTitles] = useState(false);
  const [suggestingKeywords, setSuggestingKeywords] = useState(false);
  const [assistError, setAssistError] = useState(null);

  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const profile = state?.data?.profile ?? {};
  const summary = profile.candidate?.headline || profile.candidate?.domain || "";
  const location = profile.location?.home ?? "";
  const remote = !!profile.location?.remote;
  const minimumBase = profile.compensation?.minimum_base ?? null;

  // Debounced, deterministic board-URL preview — no AI cost, safe to refetch
  // on every keystroke's settle.
  useEffect(() => {
    if (!titles.length) {
      setPreview(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      previewBoards({ keywords: titles[0], location, remote, minimumBase, windowHours: 24 })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [titles, location, remote, minimumBase]);

  async function handleSuggestTitles() {
    setSuggestingTitles(true);
    setAssistError(null);
    try {
      const res = await suggestAssist("titles", { profileSummary: summary, titles });
      setTitleSuggestions(
        (res.suggestions || []).filter(
          (s) => !titles.some((t) => t.toLowerCase() === s.toLowerCase())
        )
      );
    } catch (err) {
      setAssistError(assistErrorMessage(err));
    } finally {
      setSuggestingTitles(false);
    }
  }

  async function handleSuggestKeywords() {
    setSuggestingKeywords(true);
    setAssistError(null);
    try {
      const res = await suggestAssist("keywords", {
        profileSummary: summary,
        currentKeywords: keepSignals,
      });
      setKeywordSuggestions(
        (res.suggestions || []).filter(
          (s) => !keepSignals.some((k) => k.toLowerCase() === s.toLowerCase())
        )
      );
    } catch (err) {
      setAssistError(assistErrorMessage(err));
    } finally {
      setSuggestingKeywords(false);
    }
  }

  async function handleSaveAndNext() {
    setSaving(true);
    setError(null);
    try {
      await saveCandidateFile("targeting", {
        role_buckets: titles.length ? [{ name: "Primary", priority: "primary", titles }] : [],
        keep_signals: keepSignals,
        cut_signals: cutSignals,
      });
      showToast("Saved.");
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Targeting">
      {error ? <InlineAlert message={error} /> : null}
      {assistError ? <InlineAlert message={assistError} /> : null}

      <Field
        label="Target titles"
        htmlFor="targeting-titles"
        hint="Press Enter or , to add a title"
      >
        <ChipInput
          id="targeting-titles"
          values={titles}
          onChange={setTitles}
          placeholder="e.g. Forward Deployed Engineer"
        />
      </Field>
      {aiEnabled ? (
        <div>
          <Button variant="secondary" onClick={handleSuggestTitles} disabled={suggestingTitles}>
            {suggestingTitles ? "Asking Roland…" : "Ask Roland for title suggestions"}
          </Button>
          {titleSuggestions.length ? (
            <div className="chip-row" style={{ marginTop: 8 }}>
              {titleSuggestions.map((s) => (
                <SuggestionChip
                  key={s}
                  onAccept={() => {
                    setTitles((t) => (t.includes(s) ? t : [...t, s]));
                    setTitleSuggestions((list) => list.filter((x) => x !== s));
                  }}
                  onDismiss={() => setTitleSuggestions((list) => list.filter((x) => x !== s))}
                >
                  {s}
                </SuggestionChip>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <Field label="Keep signals" htmlFor="targeting-keep" hint="Press Enter or , to add">
        <ChipInput id="targeting-keep" values={keepSignals} onChange={setKeepSignals} />
      </Field>
      {aiEnabled ? (
        <div>
          <Button variant="secondary" onClick={handleSuggestKeywords} disabled={suggestingKeywords}>
            {suggestingKeywords ? "Asking Roland…" : "Ask Roland for keyword suggestions"}
          </Button>
          {keywordSuggestions.length ? (
            <div className="chip-row" style={{ marginTop: 8 }}>
              {keywordSuggestions.map((s) => (
                <SuggestionChip
                  key={s}
                  onAccept={() => {
                    setKeepSignals((k) => (k.includes(s) ? k : [...k, s]));
                    setKeywordSuggestions((list) => list.filter((x) => x !== s));
                  }}
                  onDismiss={() => setKeywordSuggestions((list) => list.filter((x) => x !== s))}
                >
                  {s}
                </SuggestionChip>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <Field label="Cut signals" htmlFor="targeting-cut" hint="Press Enter or , to add">
        <ChipInput id="targeting-cut" values={cutSignals} onChange={setCutSignals} />
      </Field>

      {titles.length ? (
        <div>
          <p className="field__label" style={{ margin: "0 0 6px" }}>
            Saved-search preview (based on "{titles[0]}")
          </p>
          <div className="board-preview">
            {preview?.hiringCafe ? (
              <a
                className="board-preview__url"
                href={preview.hiringCafe.url}
                target="_blank"
                rel="noreferrer"
              >
                hiring.cafe — {preview.hiringCafe.url}
              </a>
            ) : null}
            {preview?.linkedin ? (
              <a
                className="board-preview__url"
                href={preview.linkedin.url}
                target="_blank"
                rel="noreferrer"
              >
                LinkedIn — {preview.linkedin.url}
              </a>
            ) : null}
          </div>
          <p className="field__hint">
            You can add the LinkedIn saved search to your sources on the Finish step (it needs the
            authenticated-search consent gate either way).
          </p>
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
