// LinkedIn postings are never applied to through a LinkedIn session. CareerRat
// looks for the employer's own application link and applies there. With no such
// link (or an Easy Apply only job), it opens the page for the person and stops.
// These helpers are pure so the driver, the intake resolver and the agent share
// one definition of "this is a LinkedIn link" and "this is the employer's link".

import { validatePublicHttpUrl } from "../net/public-http-fetch.mjs";

const LINK_FIELDS = ["applyUrl", "externalApplyUrl", "link", "url", "sourceUrl"];

export function isLinkedInUrl(value) {
  try {
    const host = new URL(String(value || "")).hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

// LinkedIn wraps the employer's link as /jobs/view/externalApply/<id>?url=<encoded>.
// Returns the decoded employer URL, or null when this is not such a wrapper.
export function unwrapLinkedInExternalApply(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (!isLinkedInUrl(parsed.href)) return null;
  if (!/\/externalApply\//iu.test(parsed.pathname)) return null;
  const inner = parsed.searchParams.get("url");
  if (!inner) return null;
  return publicEmployerUrl(inner);
}

function publicEmployerUrl(value) {
  const checked = validatePublicHttpUrl(String(value || "").trim());
  if (!checked.ok) return null;
  const url = new URL(checked.url);
  if (url.protocol !== "https:" || isLinkedInUrl(url.href)) return null;
  return url.toString();
}

// The employer's own application link from what is already saved on the job.
export function employerApplyLink(application) {
  for (const field of LINK_FIELDS) {
    const raw = application?.[field];
    if (!raw) continue;
    const unwrapped = unwrapLinkedInExternalApply(raw);
    if (unwrapped) return unwrapped;
    if (isLinkedInUrl(raw)) continue;
    const direct = publicEmployerUrl(raw);
    if (direct) return direct;
  }
  return null;
}

// Find the employer link for a LinkedIn posting. Saved fields first, then the
// posting's public page through the intake resolver (no login, no clicks).
// Returns { employerUrl } or { employerUrl: null }.
export async function resolveEmployerApplyLink({
  application,
  linkedinUrl,
  resolveJobUrlImpl,
  signal,
} = {}) {
  const saved = employerApplyLink(application);
  if (saved) return { employerUrl: saved };
  if (typeof resolveJobUrlImpl !== "function" || !linkedinUrl) return { employerUrl: null };
  try {
    const resolved = await resolveJobUrlImpl(linkedinUrl, { signal, employerLinkLookup: true });
    const candidate =
      unwrapLinkedInExternalApply(resolved?.url) || publicEmployerUrl(resolved?.url);
    return { employerUrl: candidate };
  } catch {
    return { employerUrl: null };
  }
}
