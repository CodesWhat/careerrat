// USAJobs (official federal API, https://developer.usajobs.gov/). Needs a free
// key: USAJOBS_API_KEY plus USAJOBS_USER_AGENT (the registered email), which the
// API requires as the User-Agent header. See keyed-credentials.mjs.
//
// Wire in via a config/search-sources.yml entry:
//   { source_type: "board", provider: "usajobs", enabled: true, label: "USAJobs",
//     query: "<title>", location: "<optional place>", max_pages: 1 }

import { feedBody } from "./board-feed.mjs";
import { createContext } from "./career-ops-registry.mjs";
import { requireCredentials } from "./keyed-credentials.mjs";

const SEARCH_URL = "https://data.usajobs.gov/api/search";
const RESULTS_PER_PAGE = 100;
const MAX_PAGES_CAP = 5;

function toIsoDate(value) {
  if (!value) return null;
  // USAJobs dates carry no zone ("2026-10-20T00:00:00.0000"); they are UTC.
  const text = String(value);
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function compText(remuneration) {
  const row = Array.isArray(remuneration) ? remuneration[0] : null;
  if (!row) return "";
  const min = money(row.MinimumRange);
  const max = money(row.MaximumRange);
  if (!min && !max) return "";
  const range = min && max && min !== max ? `${min}-${max}` : String(min || max);
  const interval = String(row.RateIntervalCode || "").trim();
  return `USD ${range}${interval ? ` ${interval.toLowerCase()}` : ""}`;
}

// Exported for tests: map one USAJobs search response to scanner offers.
export function parseUsaJobsResponse(json, entry = {}) {
  const items = json?.SearchResult?.SearchResultItems;
  if (!Array.isArray(items)) {
    throw new Error(
      `usajobs: unexpected API response: expected SearchResult.SearchResultItems, got keys: [${
        json && typeof json === "object" ? Object.keys(json).join(", ") : "null"
      }]`
    );
  }
  const offers = [];
  for (const item of items) {
    const job = item?.MatchedObjectDescriptor;
    const title = typeof job?.PositionTitle === "string" ? job.PositionTitle.trim() : "";
    const url = String(job?.PositionURI || job?.ApplyURI?.[0] || "").trim();
    if (!title || !/^https:\/\//i.test(url)) continue;
    const details = job.UserArea?.Details || {};
    const body = [details.JobSummary, job.QualificationSummary]
      .filter((part) => typeof part === "string" && part.trim())
      .join("\n\n");
    offers.push({
      title,
      url,
      company:
        String(job.OrganizationName || job.DepartmentName || "").trim() || entry.label || "USAJobs",
      location: String(job.PositionLocationDisplay || "").trim(),
      comp: compText(job.PositionRemuneration),
      postedAt: toIsoDate(job.PublicationStartDate),
      ...feedBody(body),
    });
  }
  return offers;
}

export async function fetchUsaJobs(entry = {}, options = {}) {
  const creds = requireCredentials("usajobs", options.env);
  const keyword = String(entry.query || entry.keywords?.join?.(" ") || "").trim();
  if (!keyword) throw new Error("usajobs: the source needs a query (a job title or keyword)");
  const pages = Math.min(Math.max(Number(entry.max_pages) || 1, 1), MAX_PAGES_CAP);
  const ctx = createContext(options.fetchImpl || fetch, options);
  const headers = {
    "Authorization-Key": creds.USAJOBS_API_KEY,
    "User-Agent": creds.USAJOBS_USER_AGENT,
    Accept: "application/json",
  };
  const offers = [];
  for (let page = 1; page <= pages; page += 1) {
    const params = new URLSearchParams({
      Keyword: keyword,
      ResultsPerPage: String(RESULTS_PER_PAGE),
      Page: String(page),
      SortField: "DatePosted",
      SortDirection: "Desc",
    });
    if (entry.location) params.set("LocationName", String(entry.location));
    const json = await ctx.fetchJson(`${SEARCH_URL}?${params}`, { headers, redirect: "error" });
    const rows = parseUsaJobsResponse(json, entry);
    offers.push(...rows);
    const total = Number(json?.SearchResult?.SearchResultCountAll);
    if (
      (json?.SearchResult?.SearchResultItems?.length ?? 0) < RESULTS_PER_PAGE ||
      (Number.isFinite(total) && page * RESULTS_PER_PAGE >= total)
    ) {
      break;
    }
  }
  return offers;
}
