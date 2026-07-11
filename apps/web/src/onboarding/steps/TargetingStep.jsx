import { useState } from "react";
import { Button, IconButton } from "../../components/Button.jsx";
import { SuggestionChip } from "../../components/Chip.jsx";
import { ChipInput, Field, TextField } from "../../components/form.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { saveCandidateFile, suggestAssist } from "../../lib/api.js";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

const PRIORITY_OPTIONS = [
  { value: "primary", label: "Primary" },
  { value: "secondary", label: "Secondary" },
  { value: "stretch", label: "Stretch" },
  { value: "oe", label: "OE" },
];

function normalizePriority(priority, index) {
  if (priority === "adjacent") return "stretch";
  if (["primary", "secondary", "stretch", "oe"].includes(priority)) return priority;
  return index === 0 ? "primary" : "secondary";
}

export function assistErrorMessage(err) {
  if (err?.status === 501) {
    return "Roland suggestions are unavailable right now — add or edit roles manually.";
  }
  if (err?.status === 422) return "Roland couldn't produce a suggestion this time — try again.";
  return err instanceof Error ? err.message : "Suggestion failed";
}

function normalizeBuckets(buckets) {
  return (Array.isArray(buckets) ? buckets : [])
    .map((bucket, index) => ({
      name: bucket?.name || (index === 0 ? "Primary" : "Secondary"),
      priority: normalizePriority(bucket?.priority, index),
      titles: Array.isArray(bucket?.titles) ? bucket.titles.filter(Boolean) : [],
      notes: bucket?.notes || "",
      fit_signals: normalizeSignals(bucket?.fit_signals),
      down_signals: normalizeSignals(bucket?.down_signals),
    }))
    .filter((bucket) => bucket.name || bucket.titles.length || bucket.notes);
}

function normalizeSignals(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

function uniqueSignals(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function seedRoleBuckets({ savedTargeting, draftTargeting }) {
  const savedBuckets = normalizeBuckets(savedTargeting.role_buckets);
  const rolandBuckets = normalizeBuckets(draftTargeting.role_buckets);
  const buckets = savedBuckets.length ? savedBuckets : rolandBuckets;
  const topFitSignals = savedTargeting.keep_signals?.length
    ? normalizeSignals(savedTargeting.keep_signals)
    : normalizeSignals(draftTargeting.keep_signals);

  return buckets.map((bucket, index) => ({
    ...bucket,
    fit_signals: bucket.fit_signals.length ? bucket.fit_signals : index === 0 ? topFitSignals : [],
  }));
}

function countTitles(buckets) {
  return buckets.reduce((count, bucket) => count + (bucket.titles?.length ?? 0), 0);
}

function fallbackBuckets() {
  return [
    {
      name: "Primary",
      priority: "primary",
      titles: [],
      notes: "",
      fit_signals: [],
      down_signals: [],
    },
  ];
}

function priorityLabel(priority) {
  return PRIORITY_OPTIONS.find((option) => option.value === priority)?.label ?? "Primary";
}

function SummarySignalRow({ tone, symbol, label, signals, emptyLabel, onRemove }) {
  return (
    <div
      className={`onboarding-targeting__tag-box onboarding-targeting__tag-box--${tone} onboarding-targeting__summary-signal-row`}
    >
      <span className="onboarding-targeting__tag-symbol">{symbol}</span>
      <div className="onboarding-targeting__tag-copy">
        <strong>{label}</strong>
        {signals.length ? (
          <div className="onboarding-targeting__summary-pill-list">
            {signals.map((signal) => (
              <span className="onboarding-targeting__signal-pill" key={signal}>
                <span className="onboarding-targeting__signal-pill-label">{signal}</span>
                <button
                  type="button"
                  className="onboarding-targeting__signal-pill-remove"
                  onClick={() => onRemove(signal)}
                  aria-label={`Remove ${signal} from ${label}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <small>{emptyLabel}</small>
        )}
      </div>
    </div>
  );
}

// Step 3 — Targeting. This is a review step for the role lanes Roland inferred
// from the resume, not a raw targeting.yml editor. Save still writes the same
// candidate targeting fields the rest of Rolester consumes.
export function TargetingStep({
  state,
  draftSeeds,
  aiEnabled,
  goNext,
  goBack,
  onProgressSelect,
  showToast,
  initialEditingBucket = null,
}) {
  const savedTargeting = state?.data?.targeting ?? {};
  const draftTargeting = draftSeeds?.targeting ?? {};
  const seededBuckets = seedRoleBuckets({ savedTargeting, draftTargeting });
  const compatibilityCutSignals = savedTargeting.cut_signals?.length
    ? normalizeSignals(savedTargeting.cut_signals)
    : normalizeSignals(draftTargeting.cut_signals);

  const [roleBuckets, setRoleBuckets] = useState(
    seededBuckets.length ? seededBuckets : fallbackBuckets()
  );

  const [titleSuggestions, setTitleSuggestions] = useState([]);
  const [suggestingTitles, setSuggestingTitles] = useState(false);
  const [assistError, setAssistError] = useState(null);
  const [editingBucket, setEditingBucket] = useState(initialEditingBucket);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const profile = state?.data?.profile ?? {};
  const summary = profile.candidate?.headline || profile.candidate?.domain || "";
  const selectedTitleCount = countTitles(roleBuckets);
  const activeEditIndex =
    editingBucket !== null && roleBuckets[editingBucket] ? editingBucket : null;
  const activeEditBucket = activeEditIndex === null ? null : roleBuckets[activeEditIndex];

  function updateBucket(index, patch) {
    setRoleBuckets((buckets) =>
      buckets.map((bucket, i) => (i === index ? { ...bucket, ...patch } : bucket))
    );
  }

  function addBucket() {
    setRoleBuckets((buckets) => [
      ...buckets,
      {
        name: "Another lane",
        priority: "secondary",
        titles: [],
        notes: "",
        fit_signals: [],
        down_signals: [],
      },
    ]);
    setEditingBucket(roleBuckets.length);
  }

  function removeBucket(index) {
    setRoleBuckets((buckets) => {
      const next = buckets.filter((_, i) => i !== index);
      return next.length ? next : fallbackBuckets();
    });
    setEditingBucket(null);
  }

  function removeBucketSignal(index, field, signal) {
    const bucket = roleBuckets[index];
    if (!bucket) return;
    updateBucket(index, {
      [field]: normalizeSignals(bucket[field]).filter((value) => value !== signal),
    });
  }

  function addTitleToFirstBucket(title) {
    setRoleBuckets((buckets) => {
      const next = buckets.length ? buckets : fallbackBuckets();
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

  async function handleSaveAndNext() {
    const cleanedBuckets = normalizeBuckets(roleBuckets).filter((bucket) => bucket.titles.length);
    if (!cleanedBuckets.length) {
      setError("Add at least one role title so Roland knows what to search.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await saveCandidateFile("targeting", {
        role_buckets: cleanedBuckets.map((bucket) => ({
          name: bucket.name,
          priority: bucket.priority,
          titles: bucket.titles,
          ...(bucket.notes ? { notes: bucket.notes } : {}),
          ...(bucket.fit_signals?.length ? { fit_signals: bucket.fit_signals } : {}),
          ...(bucket.down_signals?.length ? { down_signals: bucket.down_signals } : {}),
        })),
        keep_signals: uniqueSignals(cleanedBuckets.flatMap((bucket) => bucket.fit_signals)),
        cut_signals: compatibilityCutSignals,
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
    <OnboardingShell
      activeIndex={3}
      className="onboarding-shell--targeting"
      onProgressSelect={onProgressSelect}
      actions={
        <>
          <OnboardingNavButton direction="back" label="Back" onClick={goBack} />
          <OnboardingNavButton
            direction="next"
            label="Continue"
            onClick={handleSaveAndNext}
            disabled={saving || selectedTitleCount === 0}
          />
        </>
      }
    >
      <div className="onboarding-step-stack onboarding-step-stack--targeting">
        <div className="onboarding-step-label">Step 3</div>
        <section
          className="onboarding-step-card onboarding-targeting"
          aria-labelledby="onboarding-targeting-title"
        >
          <section
            className="onboarding-step-card__media onboarding-targeting__media"
            aria-label="Roland role picks"
          >
            <div className="onboarding-targeting__mark" aria-hidden="true">
              🎯
            </div>
            <div className="onboarding-targeting__media-copy">
              <h1 id="onboarding-targeting-title">Choose your roles</h1>
              <p>Keep the lanes that feel right. Add the job titles you already know you want.</p>
            </div>
          </section>

          <div
            className={
              "onboarding-step-card__content onboarding-step-card__content--dense onboarding-step-card__content--scroll onboarding-targeting__content" +
              (activeEditBucket
                ? " onboarding-targeting__content--editing"
                : " onboarding-targeting__content--lanes")
            }
          >
            {error ? <InlineAlert message={error} /> : null}
            {assistError ? <InlineAlert message={assistError} /> : null}

            {activeEditBucket ? (
              <section
                className="onboarding-targeting__edit-panel"
                aria-label={`Edit ${activeEditBucket.name}`}
              >
                <div className="onboarding-targeting__lane-header">
                  <div>
                    <span className="onboarding-targeting__priority-pill">
                      {priorityLabel(activeEditBucket.priority)}
                    </span>
                    <h2>Edit {activeEditBucket.name}</h2>
                  </div>
                  <div className="onboarding-local-actions">
                    <Button variant="secondary" onClick={() => setEditingBucket(null)}>
                      Done
                    </Button>
                    {roleBuckets.length > 1 ? (
                      <button
                        type="button"
                        className="onboarding-targeting__remove"
                        onClick={() => removeBucket(activeEditIndex)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="onboarding-targeting__edit-fields">
                  <Field label="Lane name" htmlFor={`targeting-bucket-name-${activeEditIndex}`}>
                    <TextField
                      id={`targeting-bucket-name-${activeEditIndex}`}
                      value={activeEditBucket.name}
                      onChange={(value) => updateBucket(activeEditIndex, { name: value })}
                    />
                  </Field>
                  <div className="field">
                    <span className="field__label">Priority</span>
                    <fieldset
                      className="onboarding-targeting__priority-row"
                      aria-label={`Priority for ${activeEditBucket.name}`}
                    >
                      {PRIORITY_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={
                            option.value === activeEditBucket.priority
                              ? "onboarding-targeting__priority-choice onboarding-targeting__priority-choice--active"
                              : "onboarding-targeting__priority-choice"
                          }
                          onClick={() => updateBucket(activeEditIndex, { priority: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </fieldset>
                  </div>
                  <div className="field onboarding-targeting__titles-field">
                    <div className="onboarding-targeting__field-heading">
                      <label
                        className="field__label"
                        htmlFor={`targeting-bucket-titles-${activeEditIndex}`}
                      >
                        Job titles
                      </label>
                      {aiEnabled ? (
                        <span className="onboarding-targeting__tool-wrap">
                          <IconButton
                            label={suggestingTitles ? "Finding more titles" : "Find more titles"}
                            className="onboarding-targeting__field-tool"
                            onClick={handleSuggestTitles}
                            disabled={suggestingTitles}
                            title=""
                          >
                            <span
                              className="onboarding-targeting__field-tool-glyph"
                              aria-hidden="true"
                            >
                              ✨
                            </span>
                          </IconButton>
                          <span className="onboarding-targeting__tool-tip" role="tooltip">
                            {suggestingTitles ? "Finding titles..." : "Find more titles"}
                          </span>
                        </span>
                      ) : null}
                    </div>
                    <ChipInput
                      id={`targeting-bucket-titles-${activeEditIndex}`}
                      values={activeEditBucket.titles}
                      onChange={(titles) => updateBucket(activeEditIndex, { titles })}
                      placeholder="e.g. Staff Platform Engineer"
                    />
                    <span className="field__hint">Press Enter or comma to add another</span>
                  </div>
                  <Field
                    label="Why this lane"
                    htmlFor={`targeting-bucket-notes-${activeEditIndex}`}
                  >
                    <TextField
                      id={`targeting-bucket-notes-${activeEditIndex}`}
                      value={activeEditBucket.notes}
                      onChange={(value) => updateBucket(activeEditIndex, { notes: value })}
                      placeholder="Optional"
                    />
                  </Field>
                  <div className="onboarding-targeting__edit-signals">
                    <div className="onboarding-targeting__tag-box onboarding-targeting__tag-box--good">
                      <span className="onboarding-targeting__tag-symbol">+</span>
                      <Field
                        label="Good fit"
                        htmlFor={`targeting-bucket-fit-${activeEditIndex}`}
                        hint="Specific to this lane"
                      >
                        <ChipInput
                          id={`targeting-bucket-fit-${activeEditIndex}`}
                          values={activeEditBucket.fit_signals}
                          onChange={(fit_signals) => updateBucket(activeEditIndex, { fit_signals })}
                          placeholder="e.g. developer tools"
                        />
                      </Field>
                    </div>
                    <div className="onboarding-targeting__tag-box onboarding-targeting__tag-box--bad">
                      <span className="onboarding-targeting__tag-symbol">−</span>
                      <Field
                        label="Bad fit"
                        htmlFor={`targeting-bucket-down-${activeEditIndex}`}
                        hint="Specific to this lane"
                      >
                        <ChipInput
                          id={`targeting-bucket-down-${activeEditIndex}`}
                          values={activeEditBucket.down_signals}
                          onChange={(down_signals) =>
                            updateBucket(activeEditIndex, { down_signals })
                          }
                          placeholder="e.g. frontend-only"
                        />
                      </Field>
                    </div>
                  </div>
                </div>
              </section>
            ) : (
              <section
                className="onboarding-targeting__lanes onboarding-targeting__lanes--anchored"
                aria-label="Selected role lanes"
              >
                {roleBuckets.map((bucket, index) => (
                  <article
                    // Draft buckets have no stable id until saved.
                    // biome-ignore lint/suspicious/noArrayIndexKey: editable draft rows
                    key={index}
                    className="onboarding-targeting__summary-card onboarding-targeting__summary-card--role"
                  >
                    <div className="onboarding-targeting__summary-main">
                      <div className="onboarding-targeting__lane-header">
                        <div>
                          <span className="onboarding-targeting__priority-pill onboarding-targeting__priority-pill--corner">
                            {priorityLabel(bucket.priority)}
                          </span>
                          <h2>{bucket.name}</h2>
                        </div>
                        <IconButton
                          label={`Edit ${bucket.name}`}
                          className="onboarding-targeting__edit"
                          onClick={() => setEditingBucket(index)}
                        >
                          <span className="onboarding-targeting__edit-emoji" aria-hidden="true">
                            ✏️
                          </span>
                        </IconButton>
                      </div>
                      <ul
                        className="onboarding-targeting__title-list"
                        aria-label={`${bucket.name} titles`}
                      >
                        {bucket.titles.map((title) => (
                          <li key={title} className="chip">
                            <span className="chip__label">{title}</span>
                          </li>
                        ))}
                      </ul>
                      {bucket.notes ? (
                        <p className="onboarding-targeting__lane-note">{bucket.notes}</p>
                      ) : null}
                      <div className="onboarding-targeting__summary-signals onboarding-targeting__signal-grid">
                        <SummarySignalRow
                          tone="good"
                          symbol="+"
                          label="Good fit"
                          signals={bucket.fit_signals}
                          emptyLabel="Add good fits"
                          onRemove={(signal) => removeBucketSignal(index, "fit_signals", signal)}
                        />
                        <SummarySignalRow
                          tone="bad"
                          symbol="−"
                          label="Bad fit"
                          signals={bucket.down_signals}
                          emptyLabel="Add bad fits"
                          onRemove={(signal) => removeBucketSignal(index, "down_signals", signal)}
                        />
                      </div>
                    </div>
                  </article>
                ))}
                <div className="onboarding-targeting__lane-actions onboarding-targeting__lane-actions--bottom">
                  <Button
                    variant="secondary"
                    className="onboarding-targeting__add-lane"
                    onClick={addBucket}
                  >
                    <span className="onboarding-targeting__add-icon" aria-hidden="true">
                      +
                    </span>
                    Add another lane
                  </Button>
                </div>
              </section>
            )}

            {titleSuggestions.length ? (
              <div className="chip-row">
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
        </section>
      </div>
    </OnboardingShell>
  );
}
