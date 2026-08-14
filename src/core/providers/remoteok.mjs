// Board-wide aggregator feed for RemoteOK (https://remoteok.com/api).
//
// Ported from santifer/career-ops (MIT License, Copyright (c) 2026 Santiago
// Fernández de Valderrama — github.com/santifer/career-ops) providers/remoteok.mjs.
// Same feed + field mapping; adapted to careerrat's (entry, fetchImpl) → offers[]
// contract (the sourced-scanner offer shape) instead of career-ops' {id, fetch}
// Provider object. Fresh installs get at least one working deterministic source
// even before any tracked_companies/RSS sources are configured — see AGENTS.md's
// deterministic-first-search contract.
//
// Response shape: a JSON array. Index 0 is a {last_updated, legal} metadata row
// (not a job posting) and is always skipped; every remaining row is one posting.
//
// Wire in via a config/search-sources.yml entry:
//   { source_type: "board", provider: "remoteok", enabled: true, label: "RemoteOK" }
// scanBoards() (sourced-scanner.mjs) applies the entry's title_filter/location_filter
// downstream, same as every other sourced-scan lane.
//
// RemoteOK's API ToS asks for a link-back credit when republishing its listings —
// not applicable to private/local scanning, but don't redistribute this feed
// publicly without one.

const FEED_URL = "https://remoteok.com/api";

async function fetchJsonBody(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (typeof res === "string") return JSON.parse(res);
  if (res && typeof res.json === "function") return await res.json();
  return res;
}

function toIsoDate(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Fetch and normalize postings from the RemoteOK public feed.
 * @param {{ label?: string, name?: string }} entry - The search-sources entry being processed.
 * @param {(url: string) => Promise<any>} fetchImpl - HTTP fetch implementation.
 * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt: string|null}>>}
 */
export async function fetchRemoteOk(entry = {}, fetchImpl = fetch) {
  const data = await fetchJsonBody(FEED_URL, fetchImpl);
  if (!Array.isArray(data)) {
    throw new Error(
      `remoteok: unexpected API response — expected a JSON array, got ${data === null ? "null" : typeof data}`
    );
  }

  return data
    .filter(
      (job) =>
        job &&
        typeof job === "object" &&
        typeof job.position === "string" &&
        job.position.trim() !== "" &&
        typeof job.url === "string" &&
        /^https?:\/\//i.test(job.url.trim())
    )
    .map((job) => ({
      title: job.position.trim(),
      url: job.url.trim(),
      company:
        typeof job.company === "string" && job.company.trim()
          ? job.company.trim()
          : entry.label || entry.name || "RemoteOK",
      location: typeof job.location === "string" ? job.location.trim() : "",
      postedAt: toIsoDate(job.epoch != null ? job.epoch * 1000 : job.date),
    }));
}
