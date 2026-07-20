// Form primitives: TextField, NumberField, TextArea, Select, Toggle, and a
// Field wrapper that renders a label plus an inline per-field error (see
// ../settings/error-map.js for how a schema-validation error gets attached to
// a given field id). ChipInput is the M8 onboarding wizard's addition — a
// free-text "type, press Enter/comma to add" tag editor (target titles,
// keep/cut signals, tracked companies) rendered as a Chip row, never a
// giant table. Comma-commit is opt-out via commitOnComma={false} for fields
// whose values can themselves contain a comma (e.g. "Austin, TX").

import { useState } from "react";
import { Chip } from "./Chip.jsx";

export function Field({ label, htmlFor, error, hint, children, className = "" }) {
  const classes = className ? `field ${className}` : "field";

  return (
    <div className={classes}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="field__error">{error}</span>
      ) : hint ? (
        <span className="field__hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function TextField({ id, value, onChange, type = "text", ...rest }) {
  return (
    <input
      id={id}
      className="text-input"
      type={type}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

export function NumberField({ id, value, onChange, ...rest }) {
  return (
    <input
      id={id}
      className="text-input"
      type="number"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      {...rest}
    />
  );
}

export function TextArea({ id, value, onChange, rows = 3, ...rest }) {
  return (
    <textarea
      id={id}
      className="text-area"
      rows={rows}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

export function Select({ id, value, onChange, options, ...rest }) {
  return (
    <select
      id={id}
      className="select-input"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// ChipInput — `values` is the source of truth (a plain string array, owned
// by the caller); this component only ever appends/removes whole entries,
// never edits one in place. Enter or "," commits the current draft as a new
// chip; duplicates (case-insensitive) are silently ignored rather than
// erroring, matching how a casual re-type of an existing title should feel.
function normalizeChipSuggestion(suggestion) {
  if (typeof suggestion === "string") {
    return {
      label: suggestion,
      value: suggestion,
      emoji: "",
      aliases: [],
    };
  }
  return {
    label: String(suggestion?.label || suggestion?.value || "").trim(),
    value: String(suggestion?.value || suggestion?.label || "").trim(),
    emoji: String(suggestion?.emoji || "").trim(),
    aliases: Array.isArray(suggestion?.aliases)
      ? suggestion.aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
      : [],
  };
}

export function filterChipSuggestions({ draft, values = [], suggestions = [], limit = 6 } = {}) {
  const needle = String(draft || "")
    .trim()
    .toLowerCase();
  if (!needle) return [];

  const selected = new Set(
    values.map((value) =>
      String(value || "")
        .trim()
        .toLowerCase()
    )
  );
  return suggestions
    .map(normalizeChipSuggestion)
    .filter((suggestion) => {
      if (!suggestion.value || selected.has(suggestion.value.toLowerCase())) return false;
      const haystack = [suggestion.label, suggestion.value, ...suggestion.aliases]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    })
    .slice(0, limit);
}

export function ChipInput({
  id,
  values = [],
  onChange,
  placeholder,
  suggestions = [],
  suggestionLimit = 6,
  commitOnComma = true,
}) {
  const [draft, setDraft] = useState("");
  const filteredSuggestions = filterChipSuggestions({
    draft,
    values,
    suggestions,
    limit: suggestionLimit,
  });

  // explicitValue is only ever meant to be a string (a suggestion's value,
  // or the current draft) — never pass this function directly as an event
  // handler. React's onBlur/onKeyDown hand a SyntheticEvent as the first
  // arg, and `String(event)` stringifies to the literal "[object Object]",
  // which used to slip through as a real chip. Guard by type instead of
  // truthiness so any non-string call falls back to the draft state, and
  // whitespace-only drafts are ignored rather than committed.
  function commit(explicitValue) {
    const raw = typeof explicitValue === "string" ? explicitValue : draft;
    const trimmed = raw.trim();
    setDraft("");
    if (!trimmed) return;
    const exists = values.some((v) => v.toLowerCase() === trimmed.toLowerCase());
    if (exists) return;
    onChange([...values, trimmed]);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" || (commitOnComma && e.key === ",")) {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div>
      <div className="chip-row" style={{ marginBottom: values.length ? 8 : 0 }}>
        {values.map((value, i) => (
          // values is a plain string list with no stable id; duplicates are
          // already prevented.
          // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
          <Chip key={`${value}-${i}`} onRemove={() => onChange(values.filter((_, j) => j !== i))}>
            {value}
          </Chip>
        ))}
      </div>
      <input
        id={id}
        className="text-input"
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit()}
        placeholder={placeholder}
      />
      {filteredSuggestions.length ? (
        <div className="chip-suggestion-list" role="listbox" aria-label="Suggestions">
          {filteredSuggestions.map((suggestion) => (
            <button
              key={suggestion.value}
              type="button"
              className="chip-suggestion"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(suggestion.value)}
            >
              {suggestion.emoji ? <span aria-hidden="true">{suggestion.emoji}</span> : null}
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// The literal confirm-first-vs-autonomous switch (form-defaults.auto_submit)
// is rendered with this control — the clearest "real form control" proof
// point in the M7 brief.
export function Toggle({ id, checked, onChange, label }) {
  return (
    <label className="toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle__track">
        <span className="toggle__thumb" />
      </span>
      {label ? <span className="toggle__label">{label}</span> : null}
    </label>
  );
}
