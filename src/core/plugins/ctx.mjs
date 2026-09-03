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

export function buildPluginContext({ manifest, role, company, jd, targeting } = {}) {
  const reads = Array.isArray(manifest?.reads) ? manifest.reads : [];
  const fetchHosts = Array.isArray(manifest?.fetchHosts)
    ? manifest.fetchHosts.map((h) => String(h).toLowerCase())
    : [];
  const sources = { role, company, jd, targeting };

  const ctx = {};
  for (const key of READ_SOURCE_KEYS) {
    if (reads.includes(key)) ctx[key] = sources[key];
  }

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
    return fetchPublicHttpText(url, { allowedHosts: fetchHosts });
  };

  return Object.freeze(ctx);
}
