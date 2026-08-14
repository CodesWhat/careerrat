import { useEffect, useState } from "react";
import { logoImageUrl } from "../lib/api.js";

// CompanyAvatar — M10 promotion of CompaniesStep.jsx's local, unexported
// avatar helper (onboarding/steps/CompaniesStep.jsx:11-30) into a shared
// primitive. Every new M10 surface that shows a company (Jobs rows, the Jobs
// drawer header, Calendar entries) needs identical logo+initials-fallback
// rendering — duplicating the pattern per call site risks the initials
// algorithm silently drifting between them (M10 design doc §4). Onboarding's
// CompaniesStep now imports this instead of defining its own copy.
//
// Degrade path: GET /api/logos/img?domain= or ?name= always 404s rather
// than erroring on any miss (bad input, upstream failure — see logo-route.mjs)
// — the <img onError> below is the actual "no logo" branch, by design.
function initials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function CompanyAvatar({ name, domain, size }) {
  const [failed, setFailed] = useState(false);

  // A row recycled onto a different company (e.g. list virtualization, or a
  // drawer re-opened for a different id) must not keep showing the PREVIOUS
  // company's broken-image state — reset whenever the lookup changes, even
  // though the effect body itself doesn't read it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: domain/name drive the reset, not the effect body
  useEffect(() => {
    setFailed(false);
  }, [domain, name]);

  const style = size
    ? { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }
    : undefined;

  if ((domain || name) && !failed) {
    return (
      <span className="avatar" style={style}>
        <img src={logoImageUrl({ domain, name })} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className="avatar" style={style}>
      {initials(name)}
    </span>
  );
}
