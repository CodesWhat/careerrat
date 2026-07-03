// Form primitives: TextField, NumberField, TextArea, Select, Toggle, and a
// Field wrapper that renders a label plus an inline per-field error (see
// ../settings/error-map.js for how a schema-validation error gets attached to
// a given field id).

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
