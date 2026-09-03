// ctx.mjs — builds the bounded context object a bundled plugin's run(ctx) sees.
//
// Two guarantees this file exists to hold: a plugin can only read the slices its
// own manifest declared in `reads` (the closed set: role, company, jd, targeting),
// and a plugin can only fetch hosts its own manifest declared in `fetchHosts`.
// Candidate PII (profile, evidence, honesty, form defaults, comp) is never passed
// in here, so it is structurally unreachable from a plugin regardless of what a
// manifest claims — buildPluginContext only ever reads its own four named
// parameters, never a caller's full workspace state.

import { fetchPublicHttpText } from "../net/public-http-fetch.mjs";

const READ_SOURCE_KEYS = ["role", "company", "jd", "targeting"];

// `signal` is the runner's per-run AbortController signal (runner.mjs's
// deadline for the dynamic import + run(ctx) together). It is optional here
// — a caller building a context outside the runner (e.g. a test) simply
// gets no ctx.signal and no abort check, matching today's behavior.
export function buildPluginContext({ manifest, role, company, jd, targeting, signal } = {}) {
  const reads = Array.isArray(manifest?.reads) ? manifest.reads : [];
  const fetchHosts = Array.isArray(manifest?.fetchHosts)
    ? manifest.fetchHosts.map((h) => String(h).toLowerCase())
    : [];
  const sources = { role, company, jd, targeting };

  const ctx = {};
  for (const key of READ_SOURCE_KEYS) {
    if (reads.includes(key)) ctx[key] = sources[key];
  }
  if (signal) ctx.signal = signal;

  // Rejects a disallowed host before any network attempt is made — the
  // repo's public HTTP fetch also enforces fetchHosts (including across
  // redirects, via its allowedHosts option), so this is belt-and-suspenders
  // rather than the only guard, but it's the one that keeps a bad call from
  // ever reaching resolvePublicHttpTarget/DNS at all.
  ctx.fetch = async (url) => {
    let hostname;
    try {
      hostname = new URL(String(url)).hostname.toLowerCase();
    } catch {
      return { ok: false, code: "invalid_url", reason: "invalid URL", url: String(url) };
    }
    if (!fetchHosts.includes(hostname)) {
      return {
        ok: false,
        code: "host_not_allowed",
        reason: `host "${hostname}" is not in this plugin's allowed fetch hosts`,
        url: String(url),
      };
    }
    // A run that already timed out (or was otherwise cancelled) rejects a
    // fetch immediately, with no network attempt — the deadline this signal
    // came from already expired, so there is nothing left to wait on.
    if (signal?.aborted) {
      return {
        ok: false,
        code: "fetch_aborted",
        reason: "plugin run was aborted before this fetch could start",
        url: String(url),
      };
    }
    return fetchPublicHttpText(url, { allowedHosts: fetchHosts, signal });
  };

  return Object.freeze(ctx);
}
