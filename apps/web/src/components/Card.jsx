// Card — surface + border + shadow only. NEVER a left-edge accent strip (the
// repo's standing global UI rule — see project memory
// "no-left-accent-strips-on-cards"): state is conveyed via badge/icon/text
// color, not a colored border-left or inset box-shadow.
export function Card({ title, actions, children, className = "" }) {
  return (
    <section className={`card ${className}`.trim()}>
      {title || actions ? (
        <header className="card__header">
          {title ? <h3 className="card__title">{title}</h3> : <span />}
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  );
}
