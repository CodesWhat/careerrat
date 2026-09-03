// Board-wide aggregator feed for Remotive (https://remotive.com/api/remote-jobs).
//
// Ported from career-ops-hq/career-ops (MIT License, Copyright (c) 2026 Santiago
// Fernández de Valderrama — github.com/career-ops-hq/career-ops) providers/remotive.mjs.
// Same feed + field mapping; adapted to careerrat's (entry, fetchImpl) → offers[]
// contract (the sourced-scanner offer shape) instead of career-ops' {id, fetch}
// Provider object.
//
// Response shape: { jobs: [...] }. The full feed (no ?search=) is fetched so the
// entry's own title_filter/location_filter can gate on the candidate's configured
// keep signals — Remotive's own ?search= is a narrow substring match that misses
// reasonable title variants.
//
// Wire in via a config/search-sources.yml entry:
//   { source_type: "board", provider: "remotive", enabled: true, label: "Remotive" }
// scanBoards() (sourced-scanner.mjs) applies the entry's title_filter/location_filter
// downstream, same as every other sourced-scan lane.

const FEED_URL = "https://remotive.com/api/remote-jobs";

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
 * Fetch and normalize postings from the Remotive public feed.
 * @param {{ label?: string, name?: string }} entry - The search-sources entry being processed.
 * @param {(url: string) => Promise<any>} fetchImpl - HTTP fetch implementation.
 * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt: string|null}>>}
 */
export async function fetchRemotive(entry = {}, fetchImpl = fetch) {
  const json = await fetchJsonBody(FEED_URL, fetchImpl);
  if (!json || !Array.isArray(json.jobs)) {
    throw new Error(
      `remotive: unexpected API response: expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(", ") : "null"}]`
    );
  }

  return json.jobs
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
          : entry.label || entry.name || "Remotive",
      location:
        typeof job.candidate_required_location === "string"
          ? job.candidate_required_location.trim()
          : "",
      postedAt: toIsoDate(job.publication_date),
    }));
}
