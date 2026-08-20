import { ChipInput, Field, TextField } from "../../components/form.jsx";

const ROLE_LANE_PRIORITY_OPTIONS = [
  { value: "primary", label: "Primary" },
  { value: "secondary", label: "Secondary" },
  { value: "stretch", label: "Stretch" },
  { value: "oe", label: "OE" },
];

function normalizeRolePriority(priority, index = 0) {
  if (priority === "adjacent") return "stretch";
  if (ROLE_LANE_PRIORITY_OPTIONS.some((option) => option.value === priority)) return priority;
  return index === 0 ? "primary" : "secondary";
}

function normalizeRoleSignals(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

export function normalizeRoleBuckets(buckets) {
  return (Array.isArray(buckets) ? buckets : [])
    .map((bucket, index) => ({
      name: String(bucket?.name || (index === 0 ? "Primary" : "Secondary")).trim(),
      priority: normalizeRolePriority(bucket?.priority, index),
      titles: normalizeRoleSignals(bucket?.titles),
      notes: String(bucket?.notes || "").trim(),
      fit_signals: normalizeRoleSignals(bucket?.fit_signals),
      down_signals: normalizeRoleSignals(bucket?.down_signals),
    }))
    .filter((bucket) => bucket.name || bucket.titles.length || bucket.notes);
}

export function RoleLaneFields({
  bucket,
  index,
  onChange,
  idPrefix = "targeting-bucket",
  titleTool = null,
}) {
  const id = (field) => `${idPrefix}-${index}-${field}`;
  return (
    <div className="onboarding-targeting__edit-fields">
      <Field label="Lane name" htmlFor={id("name")}>
        <TextField
          id={id("name")}
          value={bucket.name}
          onChange={(value) => onChange({ name: value })}
        />
      </Field>
      <div className="field">
        <span className="field__label">Priority</span>
        <fieldset
          className="onboarding-targeting__priority-row"
          aria-label={`Priority for ${bucket.name}`}
        >
          {ROLE_LANE_PRIORITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={
                option.value === bucket.priority
                  ? "onboarding-targeting__priority-choice onboarding-targeting__priority-choice--active"
                  : "onboarding-targeting__priority-choice"
              }
              onClick={() => onChange({ priority: option.value })}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="field onboarding-targeting__titles-field">
        <div className="onboarding-targeting__field-heading">
          <label className="field__label" htmlFor={id("titles")}>
            Job titles
          </label>
          {titleTool}
        </div>
        <ChipInput
          id={id("titles")}
          values={bucket.titles}
          onChange={(titles) => onChange({ titles })}
          placeholder="e.g. Staff Platform Engineer"
        />
        <span className="field__hint">Press Enter or comma to add another</span>
      </div>
      <Field label="Why this lane" htmlFor={id("notes")}>
        <TextField
          id={id("notes")}
          value={bucket.notes}
          onChange={(value) => onChange({ notes: value })}
          placeholder="Optional"
        />
      </Field>
      <div className="onboarding-targeting__edit-signals">
        <div className="onboarding-targeting__tag-box onboarding-targeting__tag-box--good">
          <span className="onboarding-targeting__tag-symbol">+</span>
          <Field label="Good fit" htmlFor={id("fit")} hint="Specific to this lane">
            <ChipInput
              id={id("fit")}
              values={bucket.fit_signals}
              onChange={(fit_signals) => onChange({ fit_signals })}
              placeholder="e.g. developer tools"
            />
          </Field>
        </div>
        <div className="onboarding-targeting__tag-box onboarding-targeting__tag-box--bad">
          <span className="onboarding-targeting__tag-symbol">−</span>
          <Field label="Bad fit" htmlFor={id("down")} hint="Specific to this lane">
            <ChipInput
              id={id("down")}
              values={bucket.down_signals}
              onChange={(down_signals) => onChange({ down_signals })}
              placeholder="e.g. frontend-only"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
