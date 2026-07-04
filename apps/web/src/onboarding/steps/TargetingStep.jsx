import { useEffect, useState } from "react";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { SuggestionChip } from "../../components/Chip.jsx";
import { ChipInput, Field, Select, TextField } from "../../components/form.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { previewBoards, saveCandidateFile, suggestAssist } from "../../lib/api.js";

const PREVIEW_DEBOUNCE_MS = 400;
const PRIORITY_OPTIONS = [
  { value: "primary", label: "primary" },
  { value: "secondary", label: "secondary" },
  { value: "stretch", label: "stretch" },
  { value: "oe", label: "oe" },
];

function assistErrorMessage(err) {
  if (err?.status === 501) return "No AI key configured — add one in the AI key step.";
  if (err?.status === 422) return "Roland couldn't produce a suggestion this time — try again.";
  return err instanceof Error ? err.message : "Suggestion failed";
}

function normalizeBuckets(buckets) {
  return (Array.isArray(buckets) ? buckets : [])
    .map((bucket, index) => ({
      name: bucket?.name || (index === 0 ? "Primary" : "Secondary"),
      priority: ["primary", "secondary", "stretch", "oe"].includes(bucket?.priority)
        ? bucket.priority
        : index === 0
          ? "primary"
          : "secondary",
      titles: Array.isArray(bucket?.titles) ? bucket.titles.filter(Boolean) : [],
      notes: bucket?.notes || "",
    }))
    .filter((bucket) => bucket.name || bucket.titles.length || bucket.notes);
}

function firstPreviewTitle(buckets) {
  for (const bucket of buckets) {
    const title = bucket.titles?.find(Boolean);
    if (title) return title;
  }
  return "";
}

// Step 4 — Targeting. Roland-suggest chips are staged, never auto-committed
// (SuggestionChip's accept/dismiss) — the actual persistence still goes
// through the same Save & continue button every other field uses, matching
// SettingsPage.jsx's handleSectionSave convention. The board-URL preview
// calls the additive POST /api/boards/preview (src/cli/boards-route.mjs) —
// read-only here on purpose; "add to my search sources" is deferred to the
// Finish step so it isn't silently wiped by write-config's wholesale
// search-sources.yml regen (see that route's own header comment).
export function TargetingStep({ state, draftSeeds, aiEnabled, goNext, goBack, showToast }) {
  const savedTargeting = state?.data?.targeting ?? {};
  const draftTargeting = draftSeeds?.targeting ?? {};
  const savedBuckets = normalizeBuckets(savedTargeting.role_buckets);
  const seededBuckets = savedBuckets.length
    ? savedBuckets
    : normalizeBuckets(draftTargeting.role_buckets);
  const [roleBuckets, setRoleBuckets] = useState(
    seededBuckets.length
      ? seededBuckets
      : [{ name: "Primary", priority: "primary", titles: [], notes: "" }]
  );
  const [keepSignals, setKeepSignals] = useState(
    savedTargeting.keep_signals?.length
      ? savedTargeting.keep_signals
      : (draftTargeting.keep_signals ?? [])
  );
  const [cutSignals, setCutSignals] = useState(savedTargeting.cut_signals ?? []);

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
  const previewTitle = firstPreviewTitle(roleBuckets);

  // Debounced, deterministic board-URL preview — no AI cost, safe to refetch
  // on every keystroke's settle.
  useEffect(() => {
    if (!previewTitle) {
      setPreview(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      previewBoards({ keywords: previewTitle, location, remote, minimumBase, windowHours: 24 })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [previewTitle, location, remote, minimumBase]);

  function updateBucket(index, patch) {
    setRoleBuckets((buckets) =>
      buckets.map((bucket, i) => (i === index ? { ...bucket, ...patch } : bucket))
    );
  }

  function addBucket() {
    setRoleBuckets((buckets) => [
      ...buckets,
      { name: "Secondary", priority: "secondary", titles: [], notes: "" },
    ]);
  }

  function removeBucket(index) {
    setRoleBuckets((buckets) => buckets.filter((_, i) => i !== index));
  }

  function addTitleToFirstBucket(title) {
    setRoleBuckets((buckets) => {
      const next = buckets.length
        ? buckets
        : [{ name: "Primary", priority: "primary", titles: [], notes: "" }];
      return next.map((bucket, index) =>
        index === 0 && !bucket.titles.some((t) => t.toLowerCase() === title.toLowerCase())
          ? { ...bucket, titles: [...bucket.titles, title] }
          : bucket
      );
    });
  }

  async function handleSuggestTitles() {
    setSuggestingTitles(true);
    setAssistError(null);
    try {
      const existingTitles = roleBuckets.flatMap((bucket) => bucket.titles);
      const res = await suggestAssist("titles", {
        profileSummary: summary,
        titles: existingTitles,
      });
      setTitleSuggestions(
        (res.suggestions || []).filter(
          (s) => !existingTitles.some((t) => t.toLowerCase() === s.toLowerCase())
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
      const cleanedBuckets = normalizeBuckets(roleBuckets).filter((bucket) => bucket.titles.length);
      await saveCandidateFile("targeting", {
        role_buckets: cleanedBuckets.map((bucket) => ({
          name: bucket.name,
          priority: bucket.priority,
          titles: bucket.titles,
          ...(bucket.notes ? { notes: bucket.notes } : {}),
        })),
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

      <div>
        <p className="field__label" style={{ margin: "0 0 8px" }}>
          Search tracks
        </p>
        {roleBuckets.map((bucket, index) => (
          <div
            // Draft buckets have no stable id until saved.
            // biome-ignore lint/suspicious/noArrayIndexKey: editable draft rows
            key={index}
            style={{ borderTop: index ? "1px solid var(--border)" : 0, paddingTop: index ? 12 : 0 }}
          >
            <div className="field-row">
              <Field label="Track name" htmlFor={`targeting-bucket-name-${index}`}>
                <TextField
                  id={`targeting-bucket-name-${index}`}
                  value={bucket.name}
                  onChange={(value) => updateBucket(index, { name: value })}
                />
              </Field>
              <Field label="Priority" htmlFor={`targeting-bucket-priority-${index}`}>
                <Select
                  id={`targeting-bucket-priority-${index}`}
                  value={bucket.priority}
                  onChange={(value) => updateBucket(index, { priority: value })}
                  options={PRIORITY_OPTIONS}
                />
              </Field>
            </div>
            <Field
              label="Titles"
              htmlFor={`targeting-bucket-titles-${index}`}
              hint="Press Enter or , to add a title"
            >
              <ChipInput
                id={`targeting-bucket-titles-${index}`}
                values={bucket.titles}
                onChange={(titles) => updateBucket(index, { titles })}
                placeholder="e.g. Forward Deployed Engineer"
              />
            </Field>
            <Field label="Notes" htmlFor={`targeting-bucket-notes-${index}`}>
              <TextField
                id={`targeting-bucket-notes-${index}`}
                value={bucket.notes}
                onChange={(value) => updateBucket(index, { notes: value })}
              />
            </Field>
            {roleBuckets.length > 1 ? (
              <Button variant="secondary" onClick={() => removeBucket(index)}>
                Remove track
              </Button>
            ) : null}
          </div>
        ))}
        <div style={{ marginTop: 10 }}>
          <Button variant="secondary" onClick={addBucket}>
            Add track
          </Button>
        </div>
      </div>
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
                    addTitleToFirstBucket(s);
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

      {previewTitle ? (
        <div>
          <p className="field__label" style={{ margin: "0 0 6px" }}>
            Saved-search preview (based on "{previewTitle}")
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
