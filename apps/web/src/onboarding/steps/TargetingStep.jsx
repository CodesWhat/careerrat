import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../../components/Button.jsx";
import { SuggestionChip } from "../../components/Chip.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { saveCandidateFile, suggestAssist } from "../../lib/api.js";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";
import {
  normalizeRoleBuckets,
  normalizeRoleSignals,
  RoleLaneFields,
  rolePriorityLabel,
} from "./RoleLaneEditor.jsx";

export function assistErrorMessage(err) {
  if (err?.status === 501) {
    return "Roland suggestions are unavailable right now — add or edit roles manually.";
  }
  if (err?.status === 422) return "Roland couldn't produce a suggestion this time — try again.";
  return err instanceof Error ? err.message : "Suggestion failed";
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
  const savedBuckets = normalizeRoleBuckets(savedTargeting.role_buckets);
  const rolandBuckets = normalizeRoleBuckets(draftTargeting.role_buckets);
  const buckets = savedBuckets.length ? savedBuckets : rolandBuckets;
  const topFitSignals = savedTargeting.keep_signals?.length
    ? normalizeRoleSignals(savedTargeting.keep_signals)
    : normalizeRoleSignals(draftTargeting.keep_signals);

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
    ? normalizeRoleSignals(savedTargeting.cut_signals)
    : normalizeRoleSignals(draftTargeting.cut_signals);
  // Nothing saved yet but the resume parse already seeded lanes — this is a
  // confirm-what-Roland-found step, not a blank targeting form.
  const seededFromResumeUnsaved =
    !(savedTargeting.role_buckets?.length > 0) && draftTargeting.role_buckets?.length > 0;

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
  const incompleteRoleLane = roleBuckets.some(
    (bucket) => !normalizeRoleSignals(bucket?.titles).length
  );
  const activeEditIndex =
    editingBucket !== null && roleBuckets[editingBucket] ? editingBucket : null;
  const activeEditBucket = activeEditIndex === null ? null : roleBuckets[activeEditIndex];
  const primaryTitleCount = roleBuckets[0]?.titles?.length ?? 0;
  const autoSuggestRequestedRef = useRef(false);

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
      [field]: normalizeRoleSignals(bucket[field]).filter((value) => value !== signal),
    });
  }

  // Accepting a suggested title creates a whole new secondary lane rather
  // than folding it into an existing one — this is a "another lane you might
  // want" prompt, not a per-lane title add. Reuses the same addBucket/
  // updateBucket shape the manual "Add another lane" button uses.
  function addLaneFromSuggestion(title) {
    const newIndex = roleBuckets.length;
    addBucket();
    updateBucket(newIndex, { name: title, titles: [title] });
    setEditingBucket(null);
    setTitleSuggestions((list) => list.filter((value) => value !== title));
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

  // Auto-fire the same lookup the manual "Find more titles" wand uses, once,
  // as soon as there's a primary lane worth suggesting against. The ref
  // guard (not just the empty-suggestions check) is what keeps StrictMode's
  // double-invoked effect from firing the request twice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once when eligible, guarded by the ref
  useEffect(() => {
    if (autoSuggestRequestedRef.current) return;
    if (!aiEnabled || !primaryTitleCount || titleSuggestions.length) return;
    autoSuggestRequestedRef.current = true;
    handleSuggestTitles();
  }, [aiEnabled, primaryTitleCount]);

  async function handleSaveAndNext() {
    const cleanedBuckets = normalizeRoleBuckets(roleBuckets);
    if (!cleanedBuckets.length || cleanedBuckets.some((bucket) => !bucket.titles.length)) {
      setError("Every role lane needs at least one job title.");
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
            disabled={saving || selectedTitleCount === 0 || incompleteRoleLane}
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
              <p>
                {seededFromResumeUnsaved
                  ? "We pulled these from your resume. Confirm, tweak, or add another lane."
                  : "Keep the lanes that feel right. Add the job titles you already know you want."}
              </p>
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
            {error || incompleteRoleLane ? (
              <InlineAlert message={error || "Every role lane needs at least one job title."} />
            ) : null}
            {assistError ? <InlineAlert message={assistError} /> : null}

            {activeEditBucket ? (
              <section
                className="onboarding-targeting__edit-panel"
                aria-label={`Edit ${activeEditBucket.name}`}
              >
                <div className="onboarding-targeting__lane-header">
                  <div>
                    <span className="onboarding-targeting__priority-pill">
                      {rolePriorityLabel(activeEditBucket.priority)}
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
                <RoleLaneFields
                  bucket={activeEditBucket}
                  index={activeEditIndex}
                  onChange={(patch) => updateBucket(activeEditIndex, patch)}
                  titleTool={
                    aiEnabled ? (
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
                    ) : null
                  }
                />
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
                            {rolePriorityLabel(bucket.priority)}
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

                {titleSuggestions.length ? (
                  <div className="onboarding-targeting__lane-suggestions">
                    <p className="field__label">Other lanes you might want</p>
                    <div className="chip-row">
                      {titleSuggestions.map((s) => (
                        <SuggestionChip
                          key={s}
                          onAccept={() => addLaneFromSuggestion(s)}
                          onDismiss={() =>
                            setTitleSuggestions((list) => list.filter((x) => x !== s))
                          }
                        >
                          {s}
                        </SuggestionChip>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>
            )}
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
