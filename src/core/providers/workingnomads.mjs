// Board-wide aggregator feed for Working Nomads (https://www.workingnomads.com/api/exposed_jobs/).
//
// Ported from santifer/career-ops (MIT License, Copyright (c) 2026 Santiago
// Fernández de Valderrama — github.com/santifer/career-ops) providers/workingnomads.mjs.
// Same feed + field mapping; adapted to careerrat's (entry, fetchImpl) → offers[]
// contract (the sourced-scanner offer shape) instead of career-ops' {id, fetch}
// Provider object.
//
// Response shape: a JSON array of postings.
//
// Wire in via a config/search-sources.yml entry:
//   { source_type: "board", provider: "workingnomads", enabled: true, label: "Working Nomads" }
// scanBoards() (sourced-scanner.mjs) applies the entry's title_filter/location_filter
// downstream, same as every other sourced-scan lane.

const FEED_URL = "https://www.workingnomads.com/api/exposed_jobs/";

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
 * Fetch and normalize postings from the Working Nomads public feed.
 * @param {{ label?: string, name?: string }} entry - The search-sources entry being processed.
 * @param {(url: string) => Promise<any>} fetchImpl - HTTP fetch implementation.
 * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt: string|null}>>}
 */
export async function fetchWorkingNomads(entry = {}, fetchImpl = fetch) {
  const data = await fetchJsonBody(FEED_URL, fetchImpl);
  if (!Array.isArray(data)) {
    throw new Error(
      `workingnomads: unexpected API response — expected a JSON array, got ${data === null ? "null" : typeof data}`
    );
  }

  return data
    .filter(
      (job) =>
        job &&
        typeof job === "object" &&
        typeof job.title === "string" &&
        job.title.trim() !== "" &&
        typeof job.url === "string" &&
        /^https?:\/\//i.test(job.url.trim())
    )
    .map((job) => ({
      title: job.title.trim(),
      url: job.url.trim(),
      company:
        typeof job.company_name === "string" && job.company_name.trim()
          ? job.company_name.trim()
          : entry.label || entry.name || "Working Nomads",
      location: typeof job.location === "string" ? job.location.trim() : "",
      postedAt: toIsoDate(job.pub_date),
    }));
}
