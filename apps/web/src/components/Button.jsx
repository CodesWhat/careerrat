export function Button({
  variant = "primary",
  type = "button",
  disabled,
  loading = false,
  loadingLabel,
  className = "",
  children,
  ...rest
}) {
  return (
    <button
      type={type}
      className={`btn btn--${variant} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading ? "true" : undefined}
      {...rest}
    >
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : null}
      {loading ? (loadingLabel ?? children) : children}
    </button>
  );
}

export function IconButton({ label, className = "", children, ...rest }) {
  return (
    <button
      type="button"
      className={`icon-btn ${className}`.trim()}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}
