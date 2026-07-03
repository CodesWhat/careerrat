// Form primitives: TextField, NumberField, TextArea, Select, Toggle, and a
// Field wrapper that renders a label plus an inline per-field error (see
// ../settings/error-map.js for how a schema-validation error gets attached to
// a given field id). ChipInput is the M8 onboarding wizard's addition — a
// free-text "type, press Enter/comma to add" tag editor (target titles,
// keep/cut signals, tracked companies) rendered as a Chip row, never a
// giant table.

import { useState } from "react";
import { Chip } from "./Chip.jsx";

export function Field({ label, htmlFor, error, hint, children }) {
  return (
    <div className="field">
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
export function ChipInput({ id, values, onChange, placeholder }) {
  const [draft, setDraft] = useState("");

  function commit() {
    const trimmed = draft.trim();
    setDraft("");
    if (!trimmed) return;
    const exists = values.some((v) => v.toLowerCase() === trimmed.toLowerCase());
    if (exists) return;
    onChange([...values, trimmed]);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" || e.key === ",") {
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
        onBlur={commit}
        placeholder={placeholder}
      />
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
