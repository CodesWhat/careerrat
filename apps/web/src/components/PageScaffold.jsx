// PageScaffold — title + optional actions slot + content region. Glanceable,
// collapsible drill-in is the house style; never a giant dense table (the
// repo's standing "no-giant-tables" UI rule).
export function PageScaffold({ title, subtitle, actions, children }) {
  return (
    <div className="page-scaffold">
      <header className="page-scaffold__header">
        <div>
          <h1 className="page-scaffold__title">{title}</h1>
          {subtitle ? <p className="page-scaffold__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-scaffold__actions">{actions}</div> : null}
      </header>
      <div className="page-scaffold__content">{children}</div>
    </div>
  );
}
