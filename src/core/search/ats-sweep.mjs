// search/ats-sweep.mjs — reverse ATS sweep (CR115e): look for matching roles on
// employer boards the candidate never listed.
//
// The sweep scans employer ATS boards from a pluggable slug list and feeds the
// postings through the normal title, location and scoring pipeline, so only
// roles that match the candidate's own targeting survive. No slug data ships in
// this repo and nothing is downloaded: the list is a file the operator
// provides at `config/ats-sweep-slugs.json` or `.txt` (see parseSlugList for the
// formats). Without that file the sweep does nothing. Field-neutral: slugs say
// nothing about industry; the title filter decides relevance.
import { existsSync, readFileSync } from "node:fs";
import { userPath } from "../paths/workspace.mjs";

export const SWEEP_DEFAULT_MAX_BOARDS = 150;
const DAY_MS = 86400000;

// provider -> board URL for a slug, in the shape inferProvider() recognizes.
export const SWEEP_PROVIDERS = Object.freeze({
  greenhouse: (slug) => `https://boards.greenhouse.io/${slug}`,
  lever: (slug) => `https://jobs.lever.co/${slug}`,
  ashby: (slug) => `https://jobs.ashbyhq.com/${slug}`,
  workable: (slug) => `https://apply.workable.com/${slug}`,
  smartrecruiters: (slug) => `https://careers.smartrecruiters.com/${slug}`,
  recruitee: (slug) => `https://${slug}.recruitee.com`,
});

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

// Accepts, per provider, either shape:
//   JSON:  {"greenhouse": ["acme", "globex"], "lever": ["initech"]}
//          or [{"provider": "ashby", "slug": "umbrella"}, ...]
//   text:  one "provider:slug" per line; blank lines and # comments ignored
// Unknown providers and malformed slugs are dropped and counted, never thrown.
export function parseSlugList(text, { format } = {}) {
  const raw = String(text ?? "");
  const rows = [];
  const kind =
    format ||
    (raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[") ? "json" : "text");
  if (kind === "json") {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const item of data) rows.push([item?.provider, item?.slug]);
    } else if (data && typeof data === "object") {
      for (const [provider, slugs] of Object.entries(data)) {
        if (!Array.isArray(slugs)) continue;
        for (const slug of slugs) rows.push([provider, slug]);
      }
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.replace(/#.*$/, "").trim();
      if (!trimmed) continue;
      const at = trimmed.indexOf(":");
      rows.push(at === -1 ? [null, null] : [trimmed.slice(0, at), trimmed.slice(at + 1)]);
    }
  }
  const seen = new Set();
  const slugs = [];
  let dropped = 0;
  for (const [providerRaw, slugRaw] of rows) {
    const provider = String(providerRaw ?? "")
      .trim()
      .toLowerCase();
    const slug = String(slugRaw ?? "")
      .trim()
      .toLowerCase();
    if (!SWEEP_PROVIDERS[provider] || !SLUG_PATTERN.test(slug)) {
      dropped += 1;
      continue;
    }
    const key = `${provider}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slugs.push({ provider, slug });
  }
  return { slugs, dropped };
}

export function sweepSlugFilePath(pathCtx) {
  for (const name of ["config/ats-sweep-slugs.json", "config/ats-sweep-slugs.txt"]) {
    const path = userPath(pathCtx, name);
    if (existsSync(path)) return path;
  }
  return null;
}

// Returns { slugs, dropped, source } or { slugs: [], missing: true }. A file that
// exists but cannot be parsed throws, so a broken list is an error, not a
// silent empty sweep.
export function loadSweepSlugs(pathCtx) {
  const path = sweepSlugFilePath(pathCtx);
  if (!path) return { slugs: [], dropped: 0, source: null, missing: true };
  const parsed = parseSlugList(readFileSync(path, "utf8"), {
    format: path.endsWith(".json") ? "json" : "text",
  });
  return { ...parsed, source: path, missing: false };
}

export function resolveSweepSetting(targeting) {
  const raw = targeting?.search_preferences?.ats_sweep;
  const n = Number(raw?.max_boards);
  return {
    enabled: raw?.enabled !== false,
    maxBoards: Number.isInteger(n) && n > 0 ? n : SWEEP_DEFAULT_MAX_BOARDS,
  };
}

// provider + slug of an existing tracked-company entry, or null.
export function boardIdentityFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const first = parsed.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (/(^|\.)greenhouse\.io$/.test(host) && first) return { provider: "greenhouse", slug: first };
  if (host === "jobs.lever.co" && first) return { provider: "lever", slug: first };
  if (host === "jobs.ashbyhq.com" && first) return { provider: "ashby", slug: first };
  if (host === "apply.workable.com" && first) return { provider: "workable", slug: first };
  if (/^(careers|jobs)\.smartrecruiters\.com$/.test(host) && first) {
    return { provider: "smartrecruiters", slug: first };
  }
  const recruitee = /^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/.exec(host);
  if (recruitee) return { provider: "recruitee", slug: recruitee[1] };
  return null;
}

export function companyNameFromSlug(slug) {
  return String(slug)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Pick this run's boards and shape them like tracked companies.
 * - Boards already tracked are skipped (they are scanned as tracked).
 * - A list longer than `maxBoards` is covered over several runs: the window
 *   advances by one `maxBoards` slice per day, wrapping, with no stored state.
 * @returns {{entries:Array, total:number, skippedTracked:number, window:{start:number,count:number}}}
 */
export function planSweep({
  slugs,
  tracked = [],
  maxBoards = SWEEP_DEFAULT_MAX_BOARDS,
  now = Date.now(),
} = {}) {
  const trackedKeys = new Set(
    tracked
      .map((entry) => boardIdentityFromUrl(entry?.careers_url))
      .filter(Boolean)
      .map((id) => `${id.provider}:${id.slug}`)
  );
  const candidates = (slugs || []).filter(
    ({ provider, slug }) => !trackedKeys.has(`${provider}:${slug}`)
  );
  const skippedTracked = (slugs || []).length - candidates.length;
  const total = candidates.length;
  let picked = candidates;
  let start = 0;
  if (total > maxBoards) {
    start = (Math.floor(now / DAY_MS) * maxBoards) % total;
    picked = Array.from({ length: maxBoards }, (_, i) => candidates[(start + i) % total]);
  }
  return {
    entries: picked.map(({ provider, slug }) => ({
      name: companyNameFromSlug(slug),
      careers_url: SWEEP_PROVIDERS[provider](slug),
      sweep: true,
    })),
    total,
    skippedTracked,
    window: { start, count: picked.length },
  };
}
